import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const rendererRoot = path.join(desktopRoot, 'src', 'renderer');
const rendererOutDir = path.join(desktopRoot, 'out', 'renderer');

/**
 * 渲染进程构建配置（ui-dev 的 React 应用从 src/renderer/index.html 起步）。
 *
 * - base './'：生产环境通过 file:// 加载 out/renderer/index.html，资源必须用相对路径；
 * - outDir 指到 desktop/out/renderer（desktop 根目录外，需显式 emptyOutDir）；
 * - 生产 target 固定 chrome128（Electron 38 内置 Chromium 128），避免为旧浏览器降级。
 */
export default defineConfig({
  root: rendererRoot,
  base: './',
  plugins: [react()],
  build: {
    outDir: rendererOutDir,
    emptyOutDir: true,
    target: 'chrome128',
    sourcemap: false,
    modulePreload: false,
    assetsInlineLimit: 8 * 1024,
  },
  server: {
    host: '127.0.0.1',
    port: Number(process.env.APPHUB_DEV_PORT ?? 5173),
    strictPort: true,
    // Electron 里不需要浏览器自动打开
    open: false,
  },
});
