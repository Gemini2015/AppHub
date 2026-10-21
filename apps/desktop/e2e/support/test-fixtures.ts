import { expect, test as base } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { launchApp, type RunningApp } from './electron-app';

/**
 * Playwright 测试 fixture：每个用例独立启动/关闭一个 Electron 实例，
 * 并分配独立的 APPHUB_USER_DATA_DIR。
 *
 * 单 worker 运行（playwright.config.ts 已设置 workers: 1）：
 * Electron + 本地静态服务器 + 安装写盘对并行不友好，串行更稳定也更好复现。
 */
export const test = base.extend<{
  runningApp: RunningApp;
  electronApp: ElectronApplication;
  window: Page;
}>({
  // eslint-disable-next-line no-empty-pattern
  runningApp: async ({}, use, testInfo) => {
    const running = await launchApp();
    try {
      await use(running);
    } finally {
      await running.close(testInfo);
    }
  },
  electronApp: async ({ runningApp }, use) => {
    await use(runningApp.app);
  },
  window: async ({ runningApp }, use) => {
    await use(runningApp.window);
  },
});

export { expect } from '@playwright/test';
