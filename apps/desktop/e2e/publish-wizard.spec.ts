import path from 'node:path';
import type {
  ApiResult,
  AppHubApi,
  ChannelDetailDTO,
  CreateChannelRequestDTO,
} from '../shared/ipc';
import { loadFixture } from './support/fixture';
import { expect, test } from './support/test-fixtures';
import { channelCard, TESTID, TIMEOUTS, waitForShell } from './support/ui';

/**
 * 发布向导基础交互 E2E。
 *
 * 前置：需要一个「自有频道」（role=owner，canPublish=true）才能看到发布入口。
 * 这里通过 `window.apphub.channels.create`（真实 IPC → core → 本地 storage → 静态服务器）
 * 预置一个 owned 频道，再用 UI 走向导交互。
 *
 * 边界（与 task-6 说明一致）：
 *  - 原生文件选择对话框（publish.pick）无法由 Playwright 驱动，因此不点"选择文件"，
 *    即到不了最终提交步骤；真实发布链路由 tests/integration 覆盖（无 UI、可注入 zip/files）。
 *  - 本用例只验证：发布入口出现 → 向导打开 → 第 1 步版本号校验拦截 → 修正后错误消失。
 */
test.describe('发布向导基础交互', () => {
  test('自有频道可打开发布向导，版本号非法被拦截、修正后恢复', async ({ window }) => {
    const fixture = loadFixture();
    await waitForShell(window);

    // 1) 通过真实 IPC 创建 owned 频道（local provider → 静态服务器目录）
    const request: CreateChannelRequestDTO = {
      name: 'E2E 自有频道',
      description: '发布向导 E2E 预置频道',
      visibility: 'public',
      owner: { name: 'AppHub QA' },
      storage: {
        provider: 'local',
        rootDir: path.join(fixture.ownedRepoDir, 'owned-e2e'),
        publicBaseUrl: fixture.ownedPublicBaseUrl,
      },
    };
    const created = await window.evaluate(
      async (input: CreateChannelRequestDTO): Promise<ApiResult<ChannelDetailDTO>> => {
        const api = (window as unknown as { apphub?: AppHubApi }).apphub;
        if (!api) throw new Error('window.apphub 缺失：preload 未注入');
        return api.channels.create(input);
      },
      request,
    );
    expect(created.ok, `创建自有频道失败：${JSON.stringify(created)}`).toBe(true);
    if (!created.ok) throw new Error(`创建自有频道失败：${created.error.code} ${created.error.message}`);
    const channelId = created.value.summary.id;

    // 2) 重新加载 renderer 以刷新频道列表（数据在主进程侧已持久化）
    await window.reload();
    await waitForShell(window);

    const card = channelCard(window, channelId);
    await expect(card).toBeVisible({ timeout: TIMEOUTS.op });
    await card.click();
    await expect(window.getByTestId(TESTID.channelDetail)).toBeVisible();

    // 3) 打开发布向导
    const openButton = window.getByTestId(TESTID.publishOpenButton);
    await expect(openButton).toBeVisible({ timeout: TIMEOUTS.op });
    await openButton.click();
    const wizard = window.getByTestId(TESTID.publishWizard);
    await expect(wizard).toBeVisible();

    const versionInput = window.getByTestId(TESTID.publishVersion);
    await expect(versionInput).toBeVisible({ timeout: TIMEOUTS.ui });

    // 4) 第 1 步：填 App 名称 + 非法版本号 → 点「下一步」应被校验拦截
    //    （publish-submit 在第 3 步；第 2 步需要原生 pick，故 E2E 只覆盖第 1 步校验）
    const displayNameInput = window.getByTestId(TESTID.publishDisplayName);
    await expect(displayNameInput).toBeVisible({ timeout: TIMEOUTS.ui });
    await displayNameInput.fill('Wizard Demo App');
    await versionInput.fill('not-semver');
    await window.getByTestId(TESTID.publishNext).click();

    // 表单字段错误使用 role=alert 渲染（Form.tsx），不会与静态标签「版本号（semver）」混淆
    const fieldError = wizard.getByRole('alert');
    await expect(fieldError.first()).toBeVisible({ timeout: TIMEOUTS.ui });
    await expect(fieldError.first()).toContainText(/版本号|semver|格式/i);
    // 仍停留在第 1 步：版本输入可见、后续步骤的入口选择不可见
    await expect(versionInput).toBeVisible();
    await expect(window.getByTestId(TESTID.publishEntry)).toBeHidden();

    // 5) 改为合法 semver → 校验提示消失（ui-dev 约定 onChange 清除字段错误）
    await versionInput.fill('1.0.1');
    await expect(fieldError).toHaveCount(0, { timeout: 10_000 });
    await expect(versionInput).toHaveValue('1.0.1');
    await expect(wizard).toBeVisible();
  });
});
