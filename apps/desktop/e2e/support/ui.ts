import { expect, type Page } from '@playwright/test';

/**
 * UI 选择器契约（与 ui-dev 约定）与通用等待助手。
 *
 * 这里的 data-testid 列表是 QA 与 UI 之间的稳定接口：
 *  - UI 文案/布局可以自由变化，但这些 testid 必须保留；
 *  - 新增 E2E 场景时优先补充 testid，不要依赖易变的文本选择器。
 */

export const TESTID = {
  appRoot: 'app-root',
  navChannels: 'nav-channels',
  navLibrary: 'nav-library',
  navSettings: 'nav-settings',

  createChannelButton: 'create-channel-button',
  subscribeChannelButton: 'subscribe-channel-button',

  channelCard: 'channel-card',
  appCard: 'app-card',
  installedAppCard: 'installed-app-card',

  subscribeDialog: 'subscribe-dialog',
  subscribeUrlInput: 'subscribe-url-input',
  subscribeSubmit: 'subscribe-submit',

  createChannelForm: 'create-channel-form',
  createChannelName: 'create-channel-name',
  createChannelNext: 'create-channel-next',
  createChannelSubmit: 'create-channel-submit',
  storageProviderSelect: 'storage-provider-select',

  channelDetail: 'channel-detail',
  appDetail: 'app-detail',

  installButton: 'install-button',
  updateButton: 'update-button',
  verifyButton: 'verify-button',
  uninstallButton: 'uninstall-button',
  installStatus: 'install-status',

  libraryPage: 'library-page',
  libraryEmpty: 'library-empty',
  libraryCheckUpdates: 'library-check-updates',

  publishOpenButton: 'publish-open-button',
  publishWizard: 'publish-wizard',
  publishDisplayName: 'publish-display-name',
  publishVersion: 'publish-version',
  publishEntry: 'publish-entry',
  publishNext: 'publish-next',
  publishSubmit: 'publish-submit',

  dialogError: 'dialog-error',
  confirmOk: 'confirm-ok',
  uninstallConfirmOk: 'uninstall-confirm-ok',
} as const;

export const TIMEOUTS = {
  /** 普通 UI 渲染/导航。 */
  ui: 15_000,
  /** 网络/存储操作（订阅、刷新、发布、安装）。 */
  op: 120_000,
} as const;

/** 等待应用外壳（React 根节点）可见，即 renderer 已完成首屏渲染。 */
export async function waitForShell(page: Page): Promise<void> {
  await page.locator(`[data-testid="${TESTID.appRoot}"]`).waitFor({ state: 'visible', timeout: 60_000 });
}

/** 切换到频道页。 */
export async function openChannels(page: Page): Promise<void> {
  await page.getByTestId(TESTID.navChannels).click();
  await expect(page.getByTestId(TESTID.navChannels)).toBeVisible();
}

/** 切换到本地库页。 */
export async function openLibrary(page: Page): Promise<void> {
  await page.getByTestId(TESTID.navLibrary).click();
  await expect(page.getByTestId(TESTID.libraryPage)).toBeVisible({ timeout: TIMEOUTS.ui });
}

/** 按 data-channel-id 精确匹配频道卡片（避免同名频道/文案变化导致误判）。 */
export function channelCard(page: Page, channelId: string) {
  return page.locator(`[data-testid="${TESTID.channelCard}"][data-channel-id="${channelId}"]`);
}

/** 按 data-app-id 精确匹配 App 卡片。 */
export function appCard(page: Page, appId: string) {
  return page.locator(`[data-testid="${TESTID.appCard}"][data-app-id="${appId}"]`);
}

/** 按 data-app-id 精确匹配本地库卡片。 */
export function installedAppCard(page: Page, appId: string) {
  return page.locator(`[data-testid="${TESTID.installedAppCard}"][data-app-id="${appId}"]`);
}

/** 等待页面内出现匹配文本（多命中取第一个）。 */
export async function waitForText(page: Page, pattern: RegExp, timeout: number = TIMEOUTS.ui): Promise<void> {
  await expect(page.getByText(pattern).first()).toBeVisible({ timeout });
}
