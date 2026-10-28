#!/usr/bin/env node
/**
 * 打包脚本：完整构建后调用 electron-builder。
 *
 * 默认（无额外参数）使用 `--dir` 只产出可运行目录（Windows: release/win-unpacked），
 * 不制作安装器，避免下载 NSIS 等耗时工具；新增的 `pnpm dist:win` 会透传
 * `--win nsis zip --publish never`，产出安装器与免安装 zip。
 *
 * electron-builder 离线环境下若缺少 electron 缓存会失败，这里给出可读错误。
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { buildAll, desktopRoot } from './build.mjs';

const require = createRequire(import.meta.url);

async function resolveElectronBuilderBin() {
  const pkgPath = require.resolve('electron-builder/package.json');
  const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
  const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.['electron-builder'];
  if (!bin) throw new Error('electron-builder 包中没有找到 CLI bin 入口');
  return path.join(path.dirname(pkgPath), bin);
}

async function main() {
  console.log('[package] 构建生产产物…');
  const { sizes } = await buildAll();
  for (const line of sizes) console.log(`  - ${line}`);

  const binPath = await resolveElectronBuilderBin();
  // 无参数时保持旧的 `--dir` 行为；`pnpm dist:win` 会透传 --win nsis zip 等参数。
  const passthrough = process.argv.slice(2);
  const builderArgs = passthrough.length > 0 ? passthrough : ['--dir'];
  const args = [binPath, ...builderArgs];
  console.log(
    `[package] electron-builder ${builderArgs.join(' ')}（输出目录：${path.join(desktopRoot, 'release')}）`,
  );

  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: desktopRoot, stdio: 'inherit', env: process.env });
    child.once('error', (err) => reject(new Error(`无法启动 electron-builder：${err.message}`)));
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `electron-builder 退出码 ${code}。常见原因：\n` +
              '  - 离线环境缺少 electron 缓存（设置 ELECTRON_MIRROR / 预置缓存后重试）；\n' +
              '  - 目标平台工具链缺失（Windows 打包 NSIS 需下载 nsis 工具）；\n' +
              '  - 可先用 `pnpm --filter @apphub/desktop build` 验证构建。',
          ),
        );
    });
  });

  console.log('[package] 完成。');
}

main().catch((err) => {
  console.error(`[package] 失败：${err?.message ?? err}`);
  if (process.env.APPHUB_BUILD_DEBUG) console.error(err);
  process.exitCode = 1;
});
