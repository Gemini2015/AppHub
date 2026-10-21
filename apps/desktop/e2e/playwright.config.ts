import { defineConfig } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DESKTOP_DIR, PLAYWRIGHT_REPORT_DIR, TEST_RESULTS_DIR } from './support/paths';

/**
 * AppHub Electron E2E（Playwright）配置。
 *
 * 前置条件：先构建桌面端
 *   pnpm --filter @apphub/desktop build
 * 然后运行：
 *   pnpm --filter @apphub/desktop test:e2e
 * 或从仓库根目录：
 *   pnpm test:e2e
 *
 * 说明：
 *  - 不启动浏览器：Electron 自带 Chromium，无需 `playwright install`；
 *  - workers=1：Electron + 本地写盘 + 单实例锁，串行最稳；
 *  - globalSetup/Teardown 见同目录文件；fixture 通过 e2e/.tmp/fixture.json 传给测试；
 *  - 产物统一写到 e2e/.tmp/（已被根 .gitignore 的 `.tmp/` 规则忽略）。
 */
const e2eDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  testDir: e2eDir,
  testMatch: /.*\.spec\.ts$/,
  testIgnore: ['**/support/**', '**/.probe-tmp/**'],

  globalSetup: path.join(e2eDir, 'global-setup.ts'),
  globalTeardown: path.join(e2eDir, 'global-teardown.ts'),

  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  forbidOnly: Boolean(process.env.CI),

  timeout: 180_000,
  expect: { timeout: 15_000 },

  reporter: [
    ['list'],
    ['html', { outputFolder: PLAYWRIGHT_REPORT_DIR, open: 'never' }],
  ],
  outputDir: TEST_RESULTS_DIR,

  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    actionTimeout: 30_000,
  },

  metadata: {
    desktopDir: DESKTOP_DIR,
    app: 'AppHub',
  },
});
