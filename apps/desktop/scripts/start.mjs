#!/usr/bin/env node
/**
 * 生产模式启动：先完整构建（main/preload/renderer），再启动 Electron。
 *
 * 环境变量：
 *   APPHUB_USER_DATA_DIR  覆盖 userData 目录（测试/多实例隔离，建议指向临时目录）
 *
 * 额外参数会透传给 Electron，例如 `pnpm start -- --disable-gpu`。
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { buildAll, desktopRoot } from './build.mjs';

const require = createRequire(import.meta.url);
/** electron 包的 main 导出就是可执行文件路径。 */
const electronBinary = require('electron');

const extraArgs = process.argv.slice(2);

let child = null;
let shuttingDown = false;

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (child && child.exitCode === null) {
    try {
      child.kill();
    } catch {
      /* ignore */
    }
  }
  process.exit(code);
}

async function main() {
  console.log('[start] 构建生产产物…');
  const { sizes } = await buildAll();
  for (const line of sizes) console.log(`  - ${line}`);

  const env = { ...process.env };
  // 某些 CI/终端环境（以及 Electron 内部的子进程）会继承 ELECTRON_RUN_AS_NODE=1，
  // 这会让 electron 以纯 Node 模式运行而无法创建窗口，启动脚本必须显式去掉。
  delete env.ELECTRON_RUN_AS_NODE;
  if (!env.APPHUB_USER_DATA_DIR) {
    // 保留 Electron 默认 userData；这里只提示，避免 cwd 变化导致数据目录不一致。
    console.log('[start] 未设置 APPHUB_USER_DATA_DIR，将使用 Electron 默认 userData 目录');
  } else {
    console.log(`[start] APPHUB_USER_DATA_DIR=${env.APPHUB_USER_DATA_DIR}`);
  }

  console.log('[start] 启动 Electron…');
  child = spawn(electronBinary, ['.', ...extraArgs], {
    cwd: desktopRoot,
    stdio: 'inherit',
    env,
  });
  child.once('error', (err) => {
    console.error(`[start] Electron 启动失败：${err?.message ?? err}`);
    shutdown(1);
  });
  child.once('exit', (code) => {
    console.log(`[start] Electron 已退出（code=${code ?? 'null'}）`);
    shutdown(code ?? 0);
  });
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

main().catch((err) => {
  console.error(`[start] 失败：${err?.message ?? err}`);
  if (process.env.APPHUB_BUILD_DEBUG) console.error(err);
  shutdown(1);
});
