import { app, BrowserWindow } from 'electron';
import type { Event as ElectronEvent } from 'electron';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { CoreManager } from './core-manager';
import { registerIpcHandlers } from './ipc';
import type { IpcSenderLike } from './ipc';
import { createLogger } from './logger';
import type { AppHubLogger } from './logger';
import { createSecretBox } from './secret-box';
import { SelectionRegistry } from './selection-registry';
import { createSenderPolicy } from './sender';
import type { SenderPolicy } from './sender';
import { createMainWindow } from './window';

/**
 * Electron 主进程入口。
 *
 * 职责（docs/ARCHITECTURE.md §5.3）：
 *  - app 生命周期、单实例锁、userData 覆盖（APPHUB_USER_DATA_DIR，必须在 ready 前 setPath）；
 *  - 装配 core（CoreManager）/ safeStorage 加密 / selection registry / IPC；
 *  - 创建安全窗口（Security 基线见 window.ts）；
 *  - 退出时优雅关闭 core、记录日志。
 *
 * 环境变量：
 *  - APPHUB_USER_DATA_DIR：覆盖 Electron userData（测试/多实例隔离）；
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
  const userData = app.getPath('userData');
  logger = createLogger({
    logDir: path.join(userData, 'logs'),
    console: DEV_SERVER_URL !== undefined || !app.isPackaged,
  });
  logger.info('AppHub 启动', {
    version: app.getVersion(),
    electron: process.versions['electron'] ?? '',
    platform: process.platform,
    arch: process.arch,
    dev: DEV_SERVER_URL !== undefined,
    userData,
  });
  if (USER_DATA_OVERRIDE) {
    logger.info('已通过 APPHUB_USER_DATA_DIR 覆盖数据目录', { userData });
  }

  const secretBox = createSecretBox({ logger });
  coreManager = new CoreManager({ dataDir: userData, logger, secretBox });
  await coreManager.prepare();

  selectionRegistry = new SelectionRegistry({ logger });

  const appRoot = path.join(__dirname, '..');
  const preloadFile = path.join(appRoot, 'preload', 'index.cjs');
  const rendererIndexFile = path.join(appRoot, 'renderer', 'index.html');

  senderPolicy = createSenderPolicy({ devServerUrl: DEV_SERVER_URL, appIndexFile: rendererIndexFile });

  const getWebContents = (): IpcSenderLike[] =>
    BrowserWindow.getAllWindows()
      .filter((window) => !window.isDestroyed())
      .map((window) => window.webContents as unknown as IpcSenderLike);

  disposeIpc = registerIpcHandlers({
    ctx: {
      logger,
      coreManager,
      selectionRegistry,
      senderPolicy,
      isTrustedSender: (sender) =>
        mainWindow !== null && !mainWindow.isDestroyed() && sender.id === mainWindow.webContents.id,
      getWebContents,
    },
  });

  booted = true;
  openMainWindow(preloadFile, rendererIndexFile);
  logger.info('主进程初始化完成', { devServerUrl: DEV_SERVER_URL ?? '(file://)', rendererIndexFile });
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
