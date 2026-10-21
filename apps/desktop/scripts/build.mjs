#!/usr/bin/env node
/**
 * 生产构建：
 *   1) esbuild 打包主进程  -> out/main/index.cjs
 *   2) esbuild 打包 preload -> out/preload/index.cjs
 *   3) vite 构建渲染进程    -> out/renderer/
 *   4) 向 out/renderer/index.html 注入 CSP（file:// 加载时 onHeadersReceived 不一定生效，
 *      meta 是生产环境 CSP 的兜底；main 里的响应头策略见 src/main/window.ts）
 *
 * 也可以作为模块被 start.mjs / package.mjs 复用：`import { buildAll } from './build.mjs'`。
 */
import { build as esbuild, context as esbuildContext } from 'esbuild';
import { build as viteBuild } from 'vite';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const outDir = path.join(desktopRoot, 'out');
export const MAIN_OUT = path.join(outDir, 'main', 'index.cjs');
export const PRELOAD_OUT = path.join(outDir, 'preload', 'index.cjs');
export const RENDERER_OUT = path.join(outDir, 'renderer');
export const RENDERER_INDEX = path.join(RENDERER_OUT, 'index.html');

const MAIN_ENTRY = path.join(desktopRoot, 'src', 'main', 'index.ts');
const PRELOAD_ENTRY = path.join(desktopRoot, 'src', 'preload', 'index.ts');
export const VITE_CONFIG = path.join(desktopRoot, 'vite.renderer.config.mjs');

/**
 * 生产环境 CSP（与 src/main/window.ts 的 PROD_CSP 保持一致）。
 * - 渲染进程只能加载打包产物，禁止任何远端 fetch（所有网络访问都在主进程）；
 * - 图片允许 https:（频道图标 iconUrl），data:/blob: 供本地预览；
 * - object-src/base-uri/form-action/frame-ancestors 全部锁死。
 */
export const PROD_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "media-src 'self'",
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "worker-src 'self' blob:",
].join('; ');

/** 主进程 / preload 的公共 esbuild 配置。 */
function nodeBundleOptions({ entry, outfile, mode, plugins }) {
  return {
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    // Electron 由运行时提供；其余（含 workspace TS 源码与第三方依赖）全部打进 bundle。
    external: ['electron'],
    sourcemap: 'linked',
    legalComments: 'none',
    logLevel: 'warning',
    define: {
      'process.env.NODE_ENV': JSON.stringify(mode === 'development' ? 'development' : 'production'),
    },
    plugins: plugins ?? [],
  };
}

export function mainBuildOptions({ mode = 'production', plugins } = {}) {
  return nodeBundleOptions({ entry: MAIN_ENTRY, outfile: MAIN_OUT, mode, plugins });
}

export function preloadBuildOptions({ mode = 'production', plugins } = {}) {
  return nodeBundleOptions({ entry: PRELOAD_ENTRY, outfile: PRELOAD_OUT, mode, plugins });
}

/** esbuild watch 模式用（dev.mjs 调用）。 */
export async function createWatchContexts({ plugins } = {}) {
  const mainCtx = await esbuildContext(mainBuildOptions({ mode: 'development', plugins }));
  const preloadCtx = await esbuildContext(preloadBuildOptions({ mode: 'development', plugins }));
  return { mainCtx, preloadCtx };
}

export async function buildMain() {
  await mkdir(path.dirname(MAIN_OUT), { recursive: true });
  await esbuild(mainBuildOptions());
}

export async function buildPreload() {
  await mkdir(path.dirname(PRELOAD_OUT), { recursive: true });
  await esbuild(preloadBuildOptions());
}

export async function buildRenderer() {
  await viteBuild({ configFile: VITE_CONFIG, mode: 'production', logLevel: 'info' });
  await injectCspMeta();
  await assertFile(RENDERER_INDEX, '工具链没有产出 out/renderer/index.html');
}

/**
 * 把 CSP <meta> 注入到构建后的 index.html（只在缺失时注入，避免和渲染层自己写的重复）。
 */
export async function injectCspMeta() {
  let html;
  try {
    html = await readFile(RENDERER_INDEX, 'utf8');
  } catch (err) {
    throw new Error(
      `[build] 无法读取 ${path.relative(desktopRoot, RENDERER_INDEX)}：${err?.message ?? err}\n` +
        '      渲染进程（src/renderer/index.html）可能尚未创建，请确认 ui-dev 的产物已就绪。',
    );
  }
  if (/http-equiv=["']?Content-Security-Policy/i.test(html)) return;
  const meta = `    <meta http-equiv="Content-Security-Policy" content="${PROD_CSP}" />\n`;
  if (/<head(\s[^>]*)?>/i.test(html)) {
    html = html.replace(/<head(\s[^>]*)?>/i, (match) => `${match}\n${meta}`);
  } else {
    html = `${meta}${html}`;
  }
  await writeFile(RENDERER_INDEX, html, 'utf8');
}

async function assertFile(file, message) {
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size === 0) throw new Error('空文件');
  } catch {
    throw new Error(`[build] ${message}`);
  }
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/**
 * 完整构建。默认包含 renderer；`build.mjs` 支持 `--no-renderer` 以便在
 * renderer 尚未就绪时先自测 main/preload。
 */
export async function buildAll({ renderer = true } = {}) {
  await rm(path.join(outDir, 'main'), { recursive: true, force: true });
  await rm(path.join(outDir, 'preload'), { recursive: true, force: true });
  await Promise.all([buildMain(), buildPreload()]);
  if (renderer) await buildRenderer();

  const artifacts = [MAIN_OUT, PRELOAD_OUT];
  if (renderer) artifacts.push(RENDERER_INDEX);
  for (const file of artifacts) await assertFile(file, `缺少构建产物：${path.relative(desktopRoot, file)}`);
  const sizes = [];
  for (const file of artifacts) {
    const info = await stat(file);
    sizes.push(`${path.relative(desktopRoot, file)} (${formatSize(info.size)})`);
  }
  return { artifacts, sizes };
}

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const renderer = !process.argv.includes('--no-renderer');
  buildAll({ renderer })
    .then(({ sizes }) => {
      console.log('[build] 构建完成：');
      for (const line of sizes) console.log(`  - ${line}`);
    })
    .catch((err) => {
      console.error(`[build] 失败：${err?.message ?? err}`);
      if (process.env.APPHUB_BUILD_DEBUG) console.error(err);
      process.exitCode = 1;
    });
}
