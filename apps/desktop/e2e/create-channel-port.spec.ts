import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createChannelViaApi } from './support/app-api';
import { TMP_DIR } from './support/paths';
import { expect, test } from './support/test-fixtures';
import { TESTID, TIMEOUTS, waitForShell } from './support/ui';

/**
 * Phase 6：local-host 端口自动避让 E2E。
 *
 * 背景：创建频道向导默认 provider = local-host；向导挂载时读取 `host.list()` 中
 * 现有 local-host 频道的 `configuredPort`（含已停止），从 8787 起推荐最小未占用端口。
 *
 * 做法：用真实 IPC 预创建 1~2 个 **stopped** 的 local-host 频道（指定 configuredPort
 * = 8787 / 8788，rootDir 为 e2e/.tmp 下临时目录；不启动 Host，因此不占用系统端口），
 * 然后打开创建向导断言推荐值/hint/手动覆盖/重复端口校验。
 *
 * 边界：端口真正被系统占用（非 AppHub 频道）不属于"避让"范围（向导只避让 AppHub 已知端口）；
 * 这里不提交创建，避免真实 probe 与端口监听带来的副作用。
 */

async function createTempRepoDir(label: string): Promise<string> {
  await fs.mkdir(TMP_DIR, { recursive: true });
  return fs.mkdtemp(path.join(TMP_DIR, `port-${label}-`));
}

/** 通过 IPC 预创建一个 stopped 的 local-host 频道（只登记 configuredPort，不启动 Host）。 */
async function seedLocalHostChannel(
  window: Parameters<typeof createChannelViaApi>[0],
  name: string,
  port: number,
): Promise<void> {
  const rootDir = await createTempRepoDir(`p${port}`);
  await createChannelViaApi(window, {
    name,
    visibility: 'public',
    storage: { provider: 'local-host', rootDir, port, bindHost: '0.0.0.0' },
  });
}

/** 打开创建向导并进入「存储配置」步骤（默认 provider 已是 local-host）。 */
async function openWizardStorageStep(window: Parameters<typeof createChannelViaApi>[0]): Promise<void> {
  await window.getByTestId(TESTID.createChannelButton).click();
  await expect(window.getByTestId(TESTID.createChannelForm)).toBeVisible();
  await window.getByTestId(TESTID.createChannelName).fill(`端口避让 E2E ${Date.now()}`);
  await window.getByTestId(TESTID.createChannelNext).click();
  await expect(window.getByTestId(TESTID.storageProviderSelect)).toBeVisible({ timeout: TIMEOUTS.op });
}

test.describe('创建向导：local-host 端口自动避让', () => {
  test('已有 8787 时推荐 8788，并展示已用端口 hint', async ({ window }) => {
    await waitForShell(window);
    await seedLocalHostChannel(window, '已用端口 8787', 8787);
    await openWizardStorageStep(window);

    const portInput = window.getByTestId(TESTID.localHostPort);
    // host.list 是异步加载的：推荐值会从初始 8787 更新为 8788
    await expect(portInput).toHaveValue('8788', { timeout: TIMEOUTS.op });

    // hint 需限定在向导表单内：页面上的频道卡片标题也含"已用端口"字样
    const hint = window
      .getByTestId(TESTID.createChannelForm)
      .getByText(/已自动避开已使用端口/)
      .first();
    await expect(hint).toBeVisible();
    await expect(hint).toContainText('8787');
    await expect(hint).toContainText(/推荐 8788/);
    await expect(window.getByTestId(TESTID.localHostBindHost)).toHaveValue('0.0.0.0');
  });

  test('已有 8787/8788 时推荐 8789', async ({ window }) => {
    await waitForShell(window);
    await seedLocalHostChannel(window, '已用端口 8787', 8787);
    await seedLocalHostChannel(window, '已用端口 8788', 8788);
    await openWizardStorageStep(window);

    const portInput = window.getByTestId(TESTID.localHostPort);
    await expect(portInput).toHaveValue('8789', { timeout: TIMEOUTS.op });

    const hint = window
      .getByTestId(TESTID.createChannelForm)
      .getByText(/已自动避开已使用端口/)
      .first();
    await expect(hint).toContainText('8787');
    await expect(hint).toContainText('8788');
    await expect(hint).toContainText(/推荐 8789/);
  });

  test('手动修改后切 provider 不被覆盖；填重复端口提交出现 inline error', async ({ window }) => {
    await waitForShell(window);
    await seedLocalHostChannel(window, '已用端口 8787', 8787);
    await openWizardStorageStep(window);

    const providerSelect = window.getByTestId(TESTID.storageProviderSelect);
    const portInput = window.getByTestId(TESTID.localHostPort);
    const nextButton = window.getByTestId(TESTID.createChannelNext);
    await expect(portInput).toHaveValue('8788', { timeout: TIMEOUTS.op });

    // 1) 手动改端口 → 标记 touched
    await portInput.fill('9911');
    await expect(portInput).toHaveValue('9911');

    // 2) 切换 provider 再切回 local-host：手动值不被自动推荐覆盖
    await providerSelect.selectOption('local');
    await expect(providerSelect).toHaveValue('local');
    await providerSelect.selectOption('local-host');
    await expect(providerSelect).toHaveValue('local-host');
    await expect(portInput).toHaveValue('9911');

    // 3) 填回已被占用的 8787 → 点「下一步」被校验拦截，出现推荐提示
    await portInput.fill('8787');
    await nextButton.click();
    const portError = window.getByText(/已被现有 local-host 频道使用|推荐 8788/).first();
    await expect(portError).toBeVisible({ timeout: TIMEOUTS.ui });
    await expect(portError).toContainText(/8787/);
    // 仍在「存储配置」步骤（没有进入第 3 步确认页）
    await expect(providerSelect).toBeVisible();
    await expect(window.getByTestId(TESTID.createChannelSubmit)).toBeHidden();
  });
});
