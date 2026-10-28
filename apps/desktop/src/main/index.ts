import { app, BrowserWindow, dialog } from 'electron';
import type { Event as ElectronEvent } from 'electron';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { AppError } from '@apphub/protocol';
import { CoreManager } from './core-manager';
import {
  handleStartupDataDirFailure,
  migrateAppHubData,
  migrateLegacyAppHubData,
  resolveAppDataDir,
  validateTargetDataDir,
  writeDataDirConfig,
} from './data-dir';
import type { DataDirInfo } from './data-dir';
import { registerIpcHandlers } from './ipc';
import type { IpcSenderLike } from './ipc';
import { createLogger } from './logger';
import type { AppHubLogger } from './logger';
import { createSecretBox } from './secret-box';
import { createE2ESelectionDialog, SelectionRegistry } from './selection-registry';
import { createSenderPolicy } from './sender';
import type { SenderPolicy } from './sender';
import { createMainWindow } from './window';
import type { ChangeDataDirResultDTO } from '../../shared/ipc';

/**
 * Electron 主进程入口。
 *
 * 职责（docs/ARCHITECTURE.md §5.3）：
 *  - app 生命周期、单实例锁、userData 覆盖（APPHUB_USER_DATA_DIR，必须在 ready 前 setPath）；
 *  - 数据目录解析（env > apphub-bootstrap.json > Electron userData）与运行时切换（迁移+重启）；
 *  - 装配 core（CoreManager）/ safeStorage 加密 / selection registry / IPC；
 *  - 创建安全窗口（Security 基线见 window.ts）；
 *  - 退出时优雅关闭 core、记录日志。
 *
 * 环境变量：
 *  - APPHUB_USER_DATA_DIR：覆盖 Electron userData（测试/多实例隔离；同时意味着数据目录只读不可切换）；
 *  - APPHUB_DEV_SERVER_URL：开发模式加载 Vite dev server（由 scripts/dev.mjs 设置）。
 */

const DEV_SERVER_URL = process.env.APPHUB_DEV_SERVER_URL?.trim() || undefined;
const USER_DATA_OVERRIDE = process.env.APPHUB_USER_DATA_DIR?.trim() || undefined;

app.setName('AppHub');
if (process.platform === 'win32') {
  app.setAppUserModelId('dev.apphub.desktop');
}

// userData 覆盖必须在 ready 之前设置；同步建目录，避免 Electron 首次写盘时目录不存在。
if (USER_DATA_OVERRIDE) {
  const overriddenUserData = path.resolve(USER_DATA_OVERRIDE);
  app.setPath('userData', overriddenUserData);
  try {
    mkdirSync(overriddenUserData, { recursive: true });
  } catch {
    /* 目录创建失败会在 CoreManager.prepare 里给出可读错误 */
  }
}

let mainWindow: BrowserWindow | null = null;
let logger: AppHubLogger | null = null;
let coreManager: CoreManager | null = null;
let selectionRegistry: SelectionRegistry | null = null;
let senderPolicy: SenderPolicy | null = null;
let disposeIpc: (() => void) | null = null;
let quitting = false;
let booted = false;

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  // 已有实例：立即退出（第二个实例只会把参数交给第一个实例）
  app.quit();
} else {
  app.on('second-instance', () => {
    focusMainWindow();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', handleBeforeQuit);

  // 兜底：任何新建的 webContents 都不允许 window.open / <webview>
  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      logger?.warn('已阻止 window.open', { url: truncateUrl(url) });
      return { action: 'deny' };
    });
    contents.on('will-attach-webview', (event) => {
      event.preventDefault();
      logger?.warn('已阻止 <webview> 挂载');
    });
  });

  process.on('uncaughtException', (err) => {
    logger?.error('主进程未捕获异常', { message: err instanceof Error ? err.message : String(err) });
    if (!logger) console.error('[main] uncaughtException:', err);
  });
  process.on('unhandledRejection', (reason) => {
    logger?.error('主进程未处理的 Promise 拒绝', {
      message: reason instanceof Error ? reason.message : String(reason),
    });
    if (!logger) console.error('[main] unhandledRejection:', reason);
  });

  app
    .whenReady()
    .then(bootstrap)
    .catch((err) => {
      console.error('[main] 启动失败：', err);
      app.exit(1);
    });

  app.on('activate', () => {
    // macOS：点击 Dock 图标且没有窗口时重新创建
    if (booted && BrowserWindow.getAllWindows().length === 0) {
      openMainWindow();
    }
  });
}

async function bootstrap(): Promise<void> {
  // Electron 当前 userData（APPHUB_USER_DATA_DIR 覆盖时它已经是 env 目录）：
  // 引导配置与日志都放这里；AppHub 数据默认在 <userData>/AppHubData 子目录。
  const electronUserData = app.getPath('userData');
  logger = createLogger({
    logDir: path.join(electronUserData, 'logs'),
    console: DEV_SERVER_URL !== undefined || !app.isPackaged,
  });
  logger.info('AppHub 启动', {
    version: app.getVersion(),
    electron: process.versions['electron'] ?? '',
    platform: process.platform,
    arch: process.arch,
    dev: DEV_SERVER_URL !== undefined,
    userData: electronUserData,
  });
  if (USER_DATA_OVERRIDE) {
    logger.info('已通过 APPHUB_USER_DATA_DIR 覆盖 Electron userData（AppHub 数据位于该目录根）', {
      userData: electronUserData,
    });
  }
  const appDataDirEnv = process.env.APPHUB_DATA_DIR?.trim() || undefined;
  if (appDataDirEnv) {
    logger.info('已通过 APPHUB_DATA_DIR 指定 AppHub 数据目录（不影响 Electron userData；设置中不可修改）', {
      dataDir: appDataDirEnv,
    });
  }

  // 数据目录：APPHUB_DATA_DIR > APPHUB_USER_DATA_DIR > bootstrap.json > <userData>/AppHubData
  const resolvedDataDir = resolveAppDataDir({
    electronUserDataDir: electronUserData,
    env: process.env,
    logger,
  });
  logger.info('数据目录已解析', {
    dataDir: resolvedDataDir.dataDir,
    source: resolvedDataDir.source,
    envVar: resolvedDataDir.envVar,
    defaultDataDir: resolvedDataDir.defaultDataDir,
    editable: resolvedDataDir.editable,
    legacyMigration: resolvedDataDir.legacyMigration !== undefined,
  });

  // 旧版兼容：Phase6 及更早版本的数据直接位于 userData 根，启动时 move 到 AppHubData。
  let effectiveDataDir = resolvedDataDir.dataDir;
  if (resolvedDataDir.legacyMigration) {
    const legacy = resolvedDataDir.legacyMigration;
    try {
      const migration = await migrateLegacyAppHubData(legacy.baseDataDir, legacy.defaultDataDir, logger);
      effectiveDataDir = legacy.defaultDataDir;
      if (migration.migrated) {
        logger.info('已将旧版数据目录迁移到 AppHubData', {
          entries: migration.entries,
          from: legacy.baseDataDir,
          to: legacy.defaultDataDir,
        });
      } else {
        logger.info('默认数据目录已有数据，跳过旧版迁移', { reason: migration.reason });
      }
    } catch (err) {
      // 迁移失败：本次会话回退到旧版 userData 根目录（数据仍可用），下次启动重试。
      logger.error('迁移旧版数据目录失败，本次回退到 userData 根目录（下次启动重试）', {
        code: err instanceof AppError ? err.code : 'INTERNAL',
        message: err instanceof Error ? err.message : String(err),
        baseDataDir: legacy.baseDataDir,
        defaultDataDir: legacy.defaultDataDir,
      });
      effectiveDataDir = legacy.baseDataDir;
    }
  }

  const secretBox = createSecretBox({ logger });
  coreManager = new CoreManager({ dataDir: effectiveDataDir, logger, secretBox });
  try {
    await coreManager.prepare();
  } catch (err) {
    // 自定义数据目录在启动期不可用（移动盘拔出/权限变化/目录被删除）时，
    // 不能让用户永远进不了 UI：弹窗提供“恢复默认并重启 / 退出”。
    handleStartupPrepareFailure(electronUserData, { ...resolvedDataDir, dataDir: effectiveDataDir }, err);
    return;
  }

  // E2E 测试钩子：仅 APPHUB_E2E=1 时注入伪造文件选择对话框，生产环境返回 null、行为不变。
  const e2eSelectionDialog = createE2ESelectionDialog(process.env);
  selectionRegistry = new SelectionRegistry({
    logger,
    ...(e2eSelectionDialog ? { dialog: e2eSelectionDialog } : {}),
  });

  const appRoot = path.join(__dirname, '..');
  const preloadFile = path.join(appRoot, 'preload', 'index.cjs');
  const rendererIndexFile = path.join(appRoot, 'renderer', 'index.html');

  senderPolicy = createSenderPolicy({ devServerUrl: DEV_SERVER_URL, appIndexFile: rendererIndexFile });

  const getWebContents = (): IpcSenderLike[] =>
    BrowserWindow.getAllWindows()
      .filter((window) => !window.isDestroyed())
      .map((window) => window.webContents as unknown as IpcSenderLike);

  const dataDirInfo: DataDirInfo = {
    dataDir: effectiveDataDir,
    defaultDataDir: resolvedDataDir.defaultDataDir,
    source: resolvedDataDir.source,
    editable: resolvedDataDir.editable,
  };

  disposeIpc = registerIpcHandlers({
    ctx: {
      logger,
      coreManager,
      selectionRegistry,
      senderPolicy,
      dataDirInfo,
      changeDataDir: (newPath) =>
        changeAppDataDir(
          {
            electronUserDataDir: electronUserData,
            currentDataDir: effectiveDataDir,
            defaultDataDir: resolvedDataDir.defaultDataDir,
            editable: resolvedDataDir.editable,
          },
          newPath,
        ),
      isTrustedSender: (sender) =>
        mainWindow !== null && !mainWindow.isDestroyed() && sender.id === mainWindow.webContents.id,
      getWebContents,
    },
  });

  booted = true;
  openMainWindow(preloadFile, rendererIndexFile);
  logger.info('主进程初始化完成', {
    devServerUrl: DEV_SERVER_URL ?? '(file://)',
    rendererIndexFile,
    dataDir: effectiveDataDir,
    dataDirSource: resolvedDataDir.source,
    defaultDataDir: resolvedDataDir.defaultDataDir,
  });
}

/**
 * 启动期数据目录准备失败：
 *  - source==='custom'：弹窗让用户选择“恢复默认数据目录并重启 / 退出”（避免永久无法进入 UI）；
 *  - source==='default'/'env'：维持原错误路径，直接退出（由环境变量/磁盘自行修复）。
 */
function handleStartupPrepareFailure(
  electronUserDataDir: string,
  resolved: DataDirInfo,
  error: unknown,
): void {
  try {
    handleStartupDataDirFailure({
      source: resolved.source,
      dataDir: resolved.dataDir,
      electronUserDataDir,
      error,
      logger: logger ?? undefined,
      handlers: {
        showRecoveryDialog: (message, detail) =>
          dialog.showMessageBoxSync({
            type: 'error',
            title: 'AppHub 数据目录不可用',
            message,
            detail,
            buttons: ['恢复默认数据目录并重启', '退出'],
            defaultId: 1,
            cancelId: 1,
          }),
        writeDefaultConfig: (userDataDir) => writeDataDirConfig(userDataDir, null),
        relaunch: () => app.relaunch(),
        exit: (code) => flushLoggerThenExit(code),
      },
    });
  } catch (err) {
    logger?.error('处理启动期数据目录失败时发生异常', {
      message: err instanceof Error ? err.message : String(err),
    });
    flushLoggerThenExit(1);
  }
}

/**
 * 先尽力把日志落盘再退出：showMessageBoxSync 会阻塞事件循环，直接 app.exit 可能丢失
 * 启动失败诊断日志（打包后没有控制台输出）。最多等待 800ms，避免日志写入异常卡住退出。
 */
function flushLoggerThenExit(code: number): void {
  const current = logger;
  if (!current) {
    app.exit(code);
    return;
  }
  let finished = false;
  const finish = (): void => {
    if (finished) return;
    finished = true;
    app.exit(code);
  };
  const timer = setTimeout(finish, 800);
  void current
    .flush()
    .catch(() => undefined)
    .finally(() => {
      clearTimeout(timer);
      finish();
    });
}

interface ChangeAppDataDirContext {
  electronUserDataDir: string;
  currentDataDir: string;
  defaultDataDir: string;
  editable: boolean;
}

let dataDirChangeInProgress = false;

/** 延迟重启：先让 IPC 响应返回，再重启进程（relaunch 在退出后启动新实例，避免单实例锁竞争）。 */
function scheduleRelaunch(): void {
  setTimeout(() => {
    try {
      app.relaunch();
    } catch (err) {
      logger?.error('重启 App 失败', { message: err instanceof Error ? err.message : String(err) });
    }
    app.exit(0);
  }, 150);
}

/**
 * 修改数据目录：校验目标 → 关闭 core（停止本机 Host）→ 迁移 AppHub 数据 → 写引导配置 → 重启。
 * 迁移失败时也会重启（此时引导配置未变更），避免 App 停留在 core 已关闭的不可用状态。
 */
async function changeAppDataDir(
  context: ChangeAppDataDirContext,
  newPath: string,
): Promise<ChangeDataDirResultDTO> {
  if (!context.editable) {
    throw new AppError(
      'UNSUPPORTED',
      '数据目录由 APPHUB_USER_DATA_DIR 环境变量固定，无法在设置中修改；请移除该环境变量后重启 App',
    );
  }
  if (dataDirChangeInProgress) {
    throw new AppError('CONFLICT', '数据目录正在变更中，请稍候');
  }

  // 先校验（失败时不动 core，用户可继续使用）
  const target = await validateTargetDataDir({
    currentDataDir: context.currentDataDir,
    targetPath: newPath,
    defaultDataDir: context.defaultDataDir,
  });
  dataDirChangeInProgress = true;

  const manager = coreManager;
  try {
    if (!manager) throw new AppError('STATE', '核心服务尚未初始化，无法修改数据目录');
    // 关闭 core：停止本机 Host、释放已打开的文件/句柄
    await manager.close();
    const copied = await migrateAppHubData(context.currentDataDir, target.targetDataDir, { logger: logger ?? undefined });
    if (target.isDefault) {
      writeDataDirConfig(context.electronUserDataDir, null);
    } else {
      writeDataDirConfig(context.electronUserDataDir, target.targetDataDir);
    }
    logger?.info('数据目录已切换，准备重启 App', {
      from: context.currentDataDir,
      to: target.targetDataDir,
      source: target.isDefault ? 'default' : 'custom',
      copied,
    });
    scheduleRelaunch();
    return {
      previousDataDir: context.currentDataDir,
      newDataDir: target.targetDataDir,
      restarting: true,
    };
  } catch (err) {
    const appError = AppError.from(err, 'IO');
    logger?.error('修改数据目录失败，将重启 App 恢复原数据目录', {
      code: appError.code,
      message: appError.message,
    });
    // 引导配置尚未（成功）修改，重启后会回到原数据目录，避免核心服务处于已关闭状态。
    scheduleRelaunch();
    throw appError;
  }
}

function openMainWindow(
  preloadFile = path.join(__dirname, '..', 'preload', 'index.cjs'),
  rendererIndexFile = path.join(__dirname, '..', 'renderer', 'index.html'),
): void {
  if (!logger) return;
  const window = createMainWindow({
    preloadFile,
    rendererIndexFile,
    devServerUrl: DEV_SERVER_URL,
    logger,
  });
  mainWindow = window;
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null;
  });
}

function focusMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  withLog(() => mainWindow?.show());
  withLog(() => mainWindow?.focus());
}

function withLog(action: () => void): void {
  try {
    action();
  } catch (err) {
    logger?.warn('窗口操作失败', { message: err instanceof Error ? err.message : String(err) });
  }
}

function handleBeforeQuit(event: ElectronEvent): void {
  if (quitting) return;
  // 先阻止退出，等 core / 日志优雅关闭后再真正退出
  event.preventDefault();
  quitting = true;
  void (async () => {
    try {
      disposeIpc?.();
      disposeIpc = null;
      selectionRegistry?.clear();
      await coreManager?.close();
      logger?.info('AppHub 退出');
      await logger?.close();
    } catch (err) {
      console.error('[main] 退出清理失败：', err);
    } finally {
      app.quit();
    }
  })();
}

function truncateUrl(url: string): string {
  if (typeof url !== 'string') return '';
  return url.length > 200 ? `${url.slice(0, 200)}…` : url;
}
