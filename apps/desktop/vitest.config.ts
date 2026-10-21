import react from '@vitejs/plugin-react';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const rendererSetup = path.join(desktopRoot, 'src', 'renderer', 'test', 'setup.ts');

/**
 * desktop 测试配置，两个 project：
 *  - main：主进程 / preload / shared 契约（node 环境）
 *  - renderer：React UI（jsdom + React Testing Library，setup 由 ui-dev 提供）
 *
 * 说明：renderer 的 setupFiles 在 ui-dev 创建 setup 之前不存在；
 * 这里用 existsSync 兜底，保证 ui-dev 就绪前主进程测试可以独立跑通，
 * setup 文件出现后会自动启用（不做任何测试跳过）。
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'main',
          environment: 'node',
          include: ['src/main/**/*.test.ts', 'shared/**/*.test.ts'],
          // 主进程测试会创建临时目录/文件，给宽裕一点超时
          testTimeout: 20_000,
          hookTimeout: 20_000,
        },
      },
      {
        plugins: [react()],
        test: {
          name: 'renderer',
          environment: 'jsdom',
          include: ['src/renderer/**/*.test.{ts,tsx}'],
          setupFiles: existsSync(rendererSetup) ? [rendererSetup] : [],
          testTimeout: 20_000,
          // ui-dev 尚未提交测试时不让整个 test 命令失败（不跳过任何已存在的测试）
          passWithNoTests: true,
        },
      },
    ],
  },
});
