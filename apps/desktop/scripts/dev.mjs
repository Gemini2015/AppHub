#!/usr/bin/env node
/**
 * 开发模式：
 *   1) 启动 Vite dev server（127.0.0.1:APPHUB_DEV_PORT ?? 5173，strictPort）
 *   2) esbuild watch 主进程 / preload
 *   3) 启动 Electron（APPHUB_DEV_SERVER_URL 指向 Vite）
 *   4) main/preload 变更后自动重启 Electron；Ctrl+C 优雅清理
 *
 * 环境变量：
 *   APPHUB_DEV_PORT        Vite 端口（默认 5173）
 *   APPHUB_DEV_SERVER_URL  可强制指定 dev server URL（默认由 vite resolvedUrls 得出）
 *   APPHUB_USER_DATA_DIR   覆盖 Electron userData（便于与正式数据隔离）
 */
import { context as esbuildContext } from 'esbuild';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { createServer } from 'vite';
import {
  desktopRoot,
  preloadBuildOptions,
  mainBuildOptions,
  VITE_CONFIG,
} from './build.mjs';

const require = createRequire(import.meta.url);
/** electron 包的 main 导出就是可执行文件路径。 */
const electronBinary = require('electron');

const HOST = '127.0.0.1';
const PORT = Number(process.env.APPHUB_DEV_PORT ?? 5173);

let electronChild = null;
let electronPid = 0;
let restartTimer = null;
let restarting = false;
let shuttingDown = false;
let viteServer = null;
let mainCtx = null;
let preloadCtx = null;

function log(message) {
  console.log(`[dev] ${message}`);
}

function isWindows() {
  return process.platform === 'win32';
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 杀掉 Electron 进程树（Windows 下 taskkill 更可靠）。 */
function killElectron() {
  const child = electronChild;
  electronChild = null;
  electronPid = 0;
  if (!child) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    child.once('exit', finish);
    if (isWindows()) {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      killer.once('exit', finish);
      killer.once('error', finish);
    } else {
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
    }
    setTimeout(finish, 5000);
  });
}

function spawnElectron(devServerUrl) {
  const env = {
    ...process.env,
    APPHUB_DEV_SERVER_URL: devServerUrl,
  };
  // 某些 CI/终端环境会继承 ELECTRON_RUN_AS_NODE=1，导致 electron 以纯 Node 模式运行、无法弹窗。
  delete env.ELECTRON_RUN_AS_NODE;
  if (!env.APPHUB_USER_DATA_DIR) {
    env.APPHUB_USER_DATA_DIR = path.join(desktopRoot, '.tmp', 'dev-user-data');
  }
  const args = ['.', ...process.argv.slice(2)];
  log(`启动 Electron（dev server: ${devServerUrl}）`);
  const child = spawn(electronBinary, args, {
    cwd: desktopRoot,
    stdio: 'inherit',
    env,
  });
  electronChild = child;
  electronPid = child.pid ?? 0;
  child.once('error', (err) => {
    console.error(`[dev] Electron 启动失败：${err?.message ?? err}`);
  });
  child.once('exit', (code, signal) => {
    if (electronChild === child) {
      electronChild = null;
      electronPid = 0;
    }
    if (shuttingDown || restarting) return;
    log(`Electron 已退出（code=${code ?? 'null'}, signal=${signal ?? 'null'}），关闭 dev server`);
    void shutdown(0);
  });
}

async function restartElectron(devServerUrlRef) {
  if (shuttingDown) return;
  if (restarting) return;
  restarting = true;
  try {
    await killElectron();
    await delay(80);
    spawnElectron(devServerUrlRef());
  } finally {
    restarting = false;
  }
}

function scheduleRestart(getDevServerUrl) {
  if (shuttingDown) return;
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    void restartElectron(getDevServerUrl);
  }, 200);
}

async function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
  log('正在清理（关闭 Electron / esbuild / vite）…');
  try {
    await killElectron();
  } catch {
    /* ignore */
  }
  try {
    await mainCtx?.dispose();
  } catch {
    /* ignore */
  }
  try {
    await preloadCtx?.dispose();
  } catch {
    /* ignore */
  }
  try {
    await viteServer?.close();
  } catch {
    /* ignore */
  }
  log('已停止');
  process.exit(exitCode);
}

async function main() {
  process.on('SIGINT', () => void shutdown(0));
  process.on('SIGTERM', () => void shutdown(0));
  process.on('uncaughtException', (err) => {
    console.error('[dev] 未捕获异常：', err);
  });
  process.on('unhandledRejection', (err) => {
    console.error('[dev] 未处理的 Promise 拒绝：', err);
  });

  viteServer = await createServer({
    configFile: VITE_CONFIG,
    mode: 'development',
    server: { host: HOST, port: PORT, strictPort: true },
    logLevel: 'info',
  });
  await viteServer.listen();

  const resolvedUrl = viteServer.resolvedUrls?.local?.[0] ?? `http://${HOST}:${PORT}/`;
  const devServerUrl = process.env.APPHUB_DEV_SERVER_URL?.trim() || resolvedUrl;
  log(`Vite dev server: ${devServerUrl}`);

  const restartPlugin = {
    name: 'apphub:restart-electron',
    setup(build) {
      build.onEnd((result) => {
        if (result.errors.length > 0) {
          console.error('[dev] esbuild 构建失败，保持上一个 Electron 实例');
          return;
        }
        scheduleRestart(() => devServerUrl);
      });
    },
  };

  mainCtx = await esbuildContext(mainBuildOptions({ mode: 'development', plugins: [restartPlugin] }));
  preloadCtx = await esbuildContext(preloadBuildOptions({ mode: 'development', plugins: [restartPlugin] }));
  // watch() 会立即执行一次构建；首次 onEnd 触发 spawnElectron。
  await Promise.all([mainCtx.watch(), preloadCtx.watch()]);
}

main().catch((err) => {
  console.error(`[dev] 启动失败：${err?.message ?? err}`);
  if (process.env.APPHUB_BUILD_DEBUG) console.error(err);
  process.exitCode = 1;
  void shutdown(1);
});
