import { expect, test } from './support/test-fixtures';
import { waitForShell } from './support/ui';

/**
 * 冒烟用例：证明 Electron 能真实启动、renderer 首屏可用、window.apphub 已注入。
 *
 * 这条用例不依赖 core/storage 业务实现，是最早能跑通、也最能区分
 * "应用起不来" vs "业务链路有问题" 的哨兵。
 */
test.describe('应用启动冒烟', () => {
  test('窗口标题、应用外壳与主导航可见', async ({ window, runningApp }) => {
    await waitForShell(window);

    // 窗口标题包含 AppHub（desktop-dev 的 BrowserWindow 标题 / renderer index.html <title>）
    await expect
      .poll(async () => (await window.title()).toLowerCase(), {
        message: '窗口标题应包含 AppHub',
        timeout: 20_000,
      })
      .toContain('apphub');

    await expect(window.getByTestId('nav-channels')).toBeVisible();
    await expect(window.getByTestId('nav-library')).toBeVisible();
    await expect(window.getByTestId('nav-settings')).toBeVisible();

    // APPHUB_USER_DATA_DIR 生效：每个用例使用独立目录（隔离性由 desktop main 保证）
    expect(runningApp.userDataDir).toContain('e2e');
  });

  test('preload 已注入 window.apphub，且 system.info 可用', async ({ window }) => {
    await waitForShell(window);
    const result = await window.evaluate(async () => {
      const api = (window as unknown as { apphub?: { system?: { info?: () => Promise<unknown> } } }).apphub;
      if (!api?.system?.info) return { ok: false, error: { code: 'INTERNAL', message: 'window.apphub.system.info 缺失' } };
      return api.system.info();
    });
    const parsed = result as { ok: boolean; value?: { appName?: string; dataDir?: string }; error?: { code?: string; message?: string } };
    expect(parsed.ok, `system.info 调用失败：${JSON.stringify(parsed.error ?? {})}`).toBe(true);
    expect(parsed.value?.appName?.toLowerCase()).toContain('apphub');
    expect(typeof parsed.value?.dataDir).toBe('string');
    expect(parsed.value?.dataDir?.length).toBeGreaterThan(0);
  });
});
