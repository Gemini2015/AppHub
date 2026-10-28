import { expect, test } from './support/test-fixtures';
import { TESTID, TIMEOUTS, waitForShell } from './support/ui';

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

  // Phase 10：E2E 环境固定「不支持自动更新」，且不会发起更新网络请求。
  test('E2E 环境自动更新为 unsupported（e2e）且检查接口返回 UNSUPPORTED', async ({ window }) => {
    await waitForShell(window);

    interface UpdateState {
      supported: boolean;
      unsupportedReason?: string;
      status: string;
      currentVersion: string;
    }
    const stateResult = (await window.evaluate(async () => {
      const api = (window as unknown as {
        apphub?: { updates?: { state?: () => Promise<unknown> } };
      }).apphub;
      if (!api?.updates?.state) {
        return { ok: false, error: { code: 'INTERNAL', message: 'window.apphub.updates.state 缺失' } };
      }
      return api.updates.state();
    })) as { ok: boolean; value?: UpdateState; error?: { code?: string; message?: string } };
    expect(stateResult.ok, `updates.state 失败：${JSON.stringify(stateResult.error ?? {})}`).toBe(
      true,
    );
    expect(stateResult.value?.supported).toBe(false);
    expect(stateResult.value?.unsupportedReason).toBe('e2e');
    expect(stateResult.value?.status).toBe('unsupported');
    expect(stateResult.value?.currentVersion).toMatch(/^\d+\.\d+\.\d+/);

    // check() 在不支持环境直接返回 UNSUPPORTED（不发起网络、不弹对话框）
    const checkResult = (await window.evaluate(async () => {
      const api = (window as unknown as {
        apphub?: { updates?: { check?: () => Promise<unknown> } };
      }).apphub;
      return api?.updates?.check?.();
    })) as { ok: boolean; error?: { code?: string; message?: string } };
    expect(checkResult.ok).toBe(false);
    expect(checkResult.error?.code).toBe('UNSUPPORTED');

    // 设置页：更新卡片展示禁用态与原因（不出现 Banner；Banner 只在 available/downloading/downloaded 时渲染）
    await window.getByTestId(TESTID.navSettings).click();
    const updateStatus = window.getByTestId(TESTID.updateStatus);
    await expect(updateStatus).toHaveText('当前环境不支持自动更新', { timeout: TIMEOUTS.ui });
    await expect(window.getByTestId(TESTID.updateCheckButton)).toBeDisabled();
    const settings = window.locator('[data-testid="update-status"]');
    await expect(settings).toBeVisible();
    await expect(window.getByText('E2E 测试模式下自动更新已禁用')).toBeVisible();
    await expect(window.getByText(/不会发起更新检查网络请求/)).toBeVisible();
    await expect(window.getByTestId(TESTID.updateBanner)).toHaveCount(0);
    await expect(window.getByTestId(TESTID.updateDialog)).toHaveCount(0);
  });
});
