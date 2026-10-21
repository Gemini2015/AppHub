import { promises as fs } from 'node:fs';
import { waitForInstalledVersion, waitForPathMissing } from './support/app-state';
import { loadFixture } from './support/fixture';
import { expect, test } from './support/test-fixtures';
import {
  appCard,
  installedAppCard,
  openLibrary,
  TESTID,
  TIMEOUTS,
  waitForShell,
} from './support/ui';

/**
 * 核心 E2E：订阅预置频道 → 查看 App → 安装 → 校验 → 卸载。
 *
 * 断言策略：
 *  - UI 层：使用 data-testid 契约（与 ui-dev 约定），不依赖易变中文文案的精确措辞；
 *  - 磁盘层：按 docs/ARCHITECTURE.md §4.2 的本地库目录约定，直接校验每个文件的
 *    size + MD5（与频道清单一致），证明"安装"不是只更新了 UI 状态；
 *  - 卸载后同时断言 UI 空状态与版本目录被删除。
 */
test.describe('公开频道：订阅 → 安装 → 校验 → 卸载', () => {
  test('订阅预置频道、安装 App、校验本地文件、卸载清理', async ({ window, runningApp }) => {
    const fixture = loadFixture();
    await waitForShell(window);

    // 1) 订阅（成功后 UI 会自动跳转到频道详情页）
    await window.getByTestId(TESTID.subscribeChannelButton).click();
    await expect(window.getByTestId(TESTID.subscribeDialog)).toBeVisible();
    await window.getByTestId(TESTID.subscribeUrlInput).fill(fixture.channelUrl);
    await window.getByTestId(TESTID.subscribeSubmit).click();

    await expect(window.getByTestId(TESTID.channelDetail)).toBeVisible({ timeout: TIMEOUTS.op });
    await expect(window.getByTestId(TESTID.subscribeDialog)).toBeHidden();
    await expect(window.getByText(fixture.channelName).first()).toBeVisible();

    // 2) 频道详情 → App 卡片
    const cardApp = appCard(window, fixture.appId);
    await expect(cardApp).toBeVisible({ timeout: TIMEOUTS.op });
    await expect(window.getByText(fixture.appDisplayName).first()).toBeVisible();

    await cardApp.click();
    await expect(window.getByTestId(TESTID.appDetail)).toBeVisible();
    await expect(window.getByTestId(TESTID.installStatus)).toHaveText(/未安装/);

    // 3) 安装（真实下载 + 校验 + 落盘）
    await window.getByTestId(TESTID.installButton).click();
    await expect(window.getByTestId(TESTID.installStatus)).toHaveText(/已安装/, {
      timeout: TIMEOUTS.op,
    });
    await expect(window.getByTestId(TESTID.uninstallButton)).toBeVisible();

    // 4) 磁盘校验：本地库目录结构 + 所有文件 size/MD5
    const installed = await waitForInstalledVersion(runningApp.userDataDir, {
      channelId: fixture.channelId,
      appId: fixture.appId,
      version: fixture.appVersion,
      entry: fixture.entry,
      files: fixture.files,
    });
    const normalizedVersionDir = installed.versionDir.replace(/\\/g, '/');
    expect(normalizedVersionDir).toContain(
      `/library/${fixture.channelId}/${fixture.appId}/versions/${fixture.appVersion}`,
    );

    // 5) 本地库页 → 校验按钮
    await openLibrary(window);
    await expect(window.getByTestId(TESTID.libraryPage)).toBeVisible();
    const installedCard = installedAppCard(window, fixture.appId);
    await expect(installedCard).toBeVisible();
    // LibraryView 的卡片操作按钮没有独立 testid（只有 card 容器有），按可访问名定位
    await installedCard.getByRole('button', { name: '校验' }).click();
    const verifyResult = window.getByTestId('verify-result');
    await expect(verifyResult).toBeVisible({ timeout: TIMEOUTS.op });
    await expect(verifyResult).toContainText(/校验通过/);
    await expect(verifyResult).toContainText(new RegExp(`${fixture.files.length}\\s*个文件`));

    // 6) 卸载（页面内确认框，不是原生 dialog）
    await installedCard.getByRole('button', { name: '卸载' }).click();
    const uninstallConfirm = window.getByTestId(TESTID.uninstallConfirmOk);
    await expect(uninstallConfirm).toBeVisible({ timeout: TIMEOUTS.ui });
    await uninstallConfirm.click();
    await expect(window.getByTestId(TESTID.libraryEmpty)).toBeVisible({ timeout: TIMEOUTS.op });
    await expect(installedCard).toBeHidden();
    await waitForPathMissing(installed.appRoot, TIMEOUTS.op);

    // 7) 入口文件确实不在磁盘上（避免只更新索引而残留文件）
    expect(await pathExists(installed.entryPath)).toBe(false);
  });

  test('订阅不可达地址时显示可读错误而不是白屏', async ({ window }) => {
    await waitForShell(window);
    await window.getByTestId(TESTID.subscribeChannelButton).click();
    await expect(window.getByTestId(TESTID.subscribeDialog)).toBeVisible();

    // 端口 1 在本机必然拒绝连接：走真实网络错误路径（离线可跑，不依赖外网）
    await window.getByTestId(TESTID.subscribeUrlInput).fill('http://127.0.0.1:1/channel.json');
    await window.getByTestId(TESTID.subscribeSubmit).click();

    const error = window.getByTestId(TESTID.dialogError);
    await expect(error).toBeVisible({ timeout: TIMEOUTS.op });
    await expect(error).toContainText(/NETWORK|网络|失败|错误|ECONNREFUSED/i);
    // 应用外壳仍在（错误被 UI 捕获，而不是 renderer 崩溃）
    await expect(window.getByTestId(TESTID.appRoot)).toBeVisible();
  });
});

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}
