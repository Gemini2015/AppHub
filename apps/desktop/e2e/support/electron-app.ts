import { _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { existsSync, promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import {
  DESKTOP_DIR,
  DESKTOP_MAIN_ENTRY,
  DESKTOP_RENDERER_ENTRY,
  USER_DATA_ROOT,
} from './paths';

/**
 * 启动/关闭 Electron 应用。
 *
 * 关键环境事实（踩过的坑，务必保留）：
 *  - 某些宿主环境（如本仓库的 DSH Desktop 宿主、部分 CI runner）会导出
 *    `ELECTRON_RUN_AS_NODE=1`，被 Electron 继承后 `electron.exe` 会以纯 Node 运行，
 *    `require('electron')` 返回的不是 Electron API，`_electron.launch` 会直接
 *    “Process failed to launch!” 而没有任何窗口。这里在子进程 env 中强制删除该变量。
 *  - 每个测试使用独立的 APPHUB_USER_DATA_DIR（主进程负责 setPath('userData', ...)），
 *    保证用例之间互不影响、可并行/重跑。
 */

const require = createRequire(import.meta.url);

export interface LaunchOptions {
  /** 自定义 userData 目录；缺省在 e2e/.tmp/user-data/ 下新建。 */
  userDataDir?: string;
  /** 追加/覆盖环境变量。 */
  extraEnv?: Record<string, string>;
  /** 覆盖应用目录（默认 apps/desktop）。 */
  appDir?: string;
  /** 追加的 Chromium/Electron 参数（例如 Linux CI 上的 --no-sandbox）。 */
  extraArgs?: string[];
}

export interface RunningApp {
  app: ElectronApplication;
  window: Page;
  userDataDir: string;
  /** 主进程 stdout/stderr（失败时打印，便于定位白屏/启动崩溃）。 */
  mainLogs: string[];
  close(testInfo?: { status?: string; title?: string }): Promise<void>;
}

/** 检查桌面端构建产物是否就绪，给出可操作的中文错误（而不是 60 秒后超时）。 */
export function requireDesktopBuild(): void {
  const missing: string[] = [];
  if (!existsSync(DESKTOP_MAIN_ENTRY)) missing.push(DESKTOP_MAIN_ENTRY);
  if (!existsSync(DESKTOP_RENDERER_ENTRY)) missing.push(DESKTOP_RENDERER_ENTRY);
  if (missing.length > 0) {
    throw new Error(
      [
        'Electron E2E 无法启动：桌面端构建产物不存在。',
        `缺失：${missing.join('、')}`,
        '请先执行：pnpm --filter @apphub/desktop build',
        '（pnpm test:e2e 依赖构建产物；e2e 脚本不会隐式 build，避免掩盖构建失败。）',
      ].join('\n'),
    );
  }
}

function resolveElectronExecutable(): string {
  const resolved = require('electron') as unknown;
  if (typeof resolved !== 'string') {
    throw new Error(
      '无法解析 Electron 可执行文件（require("electron") 未返回路径）。请确认 apps/desktop 的 electron devDependency 已安装。',
    );
  }
  if (!existsSync(resolved)) {
    throw new Error(`Electron 可执行文件不存在：${resolved}。请重新安装依赖（不要在此处 pnpm install）。`);
  }
  return resolved;
}

/** 构造子进程环境变量：剔除会破坏 Electron 的宿主变量。 */
export function buildElectronEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  // 关键修复：宿主注入 ELECTRON_RUN_AS_NODE 时 Electron 会退化成 Node。
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  return { ...env, APPHUB_E2E: '1', ...extra };
}

function makeUserDataDir(): string {
  const unique = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return path.join(USER_DATA_ROOT, `run-${unique}`);
}

export async function launchApp(options: LaunchOptions = {}): Promise<RunningApp> {
  requireDesktopBuild();

  const userDataDir = options.userDataDir ?? makeUserDataDir();
  await fs.mkdir(userDataDir, { recursive: true });

  const appDir = options.appDir ?? DESKTOP_DIR;
  const mainLogs: string[] = [];
  // Linux CI（root 用户 / 无 user namespace）常需要 --no-sandbox；通过环境变量传入，避免改代码
  const envExtraArgs = (process.env.APPHUB_E2E_ELECTRON_ARGS ?? '')
    .split(/\s+/)
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  const env = buildElectronEnv({
    APPHUB_USER_DATA_DIR: userDataDir,
    ...options.extraEnv,
  });

  const app = await electron.launch({
    executablePath: resolveElectronExecutable(),
    args: [appDir, ...envExtraArgs, ...(options.extraArgs ?? [])],
    env,
    timeout: 60_000,
  });

  const child = app.process();
  const capture = (chunk: Buffer | string): void => {
    const text = chunk.toString().trim();
    if (text.length > 0) {
      mainLogs.push(text);
      if (process.env.APPHUB_E2E_DEBUG === '1') console.log(`[electron-main] ${text}`);
    }
  };
  child.stdout?.on('data', capture);
  child.stderr?.on('data', capture);

  const window = await app.firstWindow({ timeout: 60_000 }).catch(async (error: unknown) => {
    // 首窗失败是最常见的 CI 故障：把主进程日志一起抛出，避免只看到 60s 超时
    const reason = error instanceof Error ? error.message : String(error);
    await app.close().catch(() => undefined);
    throw new Error(
      [
        `Electron 启动后未出现窗口：${reason}`,
        `userDataDir：${userDataDir}`,
        `appDir：${appDir}`,
        mainLogs.length > 0 ? `主进程日志：\n${mainLogs.join('\n')}` : '主进程没有输出日志。',
        '排查建议：确认 out/main/index.cjs 与 out/renderer/index.html 存在且为最新构建；确认没有残留 single-instance 锁。',
      ].join('\n'),
    );
  });
  await window.waitForLoadState('domcontentloaded');

  return {
    app,
    window,
    userDataDir,
    mainLogs,
    close: async (testInfo) => {
      try {
        await app.close();
      } catch {
        // 应用可能已崩溃/退出，忽略关闭错误，避免掩盖真正的失败原因。
      }
      if (testInfo?.status && testInfo.status !== 'passed') {
        console.error(`\n[E2E] 失败用例：${testInfo.title ?? ''}`);
        console.error(`[E2E] userDataDir：${userDataDir}`);
        if (mainLogs.length > 0) console.error(`[E2E] 主进程日志：\n${mainLogs.join('\n')}`);
      }
      if (process.env.APPHUB_E2E_KEEP_USER_DATA !== '1') {
        await fs.rm(userDataDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
      }
    },
  };
}
