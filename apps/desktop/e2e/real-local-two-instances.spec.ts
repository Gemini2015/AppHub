import { promises as fs } from 'node:fs';
import path from 'node:path';
import { findChannelIdByName, hostStatus, hostStop } from './support/app-api';
import { waitForInstalledVersion } from './support/app-state';
import { launchApp, type RunningApp } from './support/electron-app';
import { TMP_DIR } from './support/paths';
import { getFreePort } from './support/port';
import { expect, test } from './support/test-fixtures';
import { TESTID, TIMEOUTS, waitForShell } from './support/ui';

/**
 * Phase 9：**真实双实例**端到端链路。
 *
 * A 实例（owner）走 UI 创建 local-host 频道 → Host 自动启动 → 走 UI 发布 v1.0.0
 * （files 模式、选择文件夹、显式 appId=`twoinst` 且 displayName≠appId，覆盖 appId 回归）；
 * B 实例（subscriber，独立 userData）走 UI 订阅 Host 地址 → 安装 → 磁盘 size/MD5 校验；
 * 修改源目录后 A 从 App 详情发布 v1.1.0 → B 刷新频道 → 更新 → 磁盘校验新版本；
 * 全链路断言 channel.json 始终只有 1 个 App 且 appId 保持 `twoinst`。
 *
 * 关键实现说明：
 *  - 原生文件选择对话框：仅当主进程 env `APPHUB_E2E=1` 时注入伪造对话框；
 *    owner 实例启动时设 `APPHUB_E2E_PICK_FOLDER=<sourceDir>`（launchApp 已自动设 APPHUB_E2E=1），
 *    因此点击「选择文件夹」不会弹原生框，而是返回该目录。生产行为不变。
 *  - 双实例：`launchApp()` 默认用独立 `APPHUB_USER_DATA_DIR`，Electron single-instance lock
 *    按 userData 区分，两个实例可同时运行。
 *  - 必须 files 模式；zip 双实例链路留待后续。
 */
test.describe('双实例真实链路：A 发布 → Host → B 订阅/安装/更新', () => {
  test('UI 创建 local-host → 发布 v1.0.0（appId=twoinst）→ 订阅安装 → 默认递增发布 v1.1.0 → 刷新更新', async ({}, testInfo) => {
    await fs.mkdir(TMP_DIR, { recursive: true });
    const workDir = await fs.mkdtemp(path.join(TMP_DIR, 'real-flow-'));
    const sourceDir = path.join(workDir, 'source');
    const ownerRepoDir = path.join(workDir, 'owner-repo');

    // ---- 源文件 v1.0.0（Node 侧计算 size/MD5，作为订阅者磁盘校验依据）----
    const v1Files = {
      'TwoInst.exe': 'TwoInst v1.0.0 payload\n',
      'resources/config.ini': '[app]\nname=Two Instance Demo\nversion=1.0.0\n',
    };
    await writeSourceFiles(sourceDir, v1Files);
    const v1Expected = await expectedFiles(sourceDir, v1Files);

    let owner: RunningApp | undefined;
    let subscriber: RunningApp | undefined;
    let channelId: string | undefined;
    let channelUrl = '';

    try {
      // ---- A：owner 实例（注入 folder pick）----
      owner = await launchApp({ extraEnv: { APPHUB_E2E_PICK_FOLDER: sourceDir } });
      await waitForShell(owner.window);
      const port = await getFreePort();
      const channelName = `双实例频道 ${Date.now()}`;

      // 1) UI 创建 local-host 频道（默认 provider 即 local-host）
      await owner.window.getByTestId(TESTID.createChannelButton).click();
      await expect(owner.window.getByTestId(TESTID.createChannelForm)).toBeVisible();
      await owner.window.getByTestId(TESTID.createChannelName).fill(channelName);
      await owner.window.getByTestId(TESTID.createChannelNext).click();
      await expect(owner.window.getByTestId(TESTID.storageProviderSelect)).toHaveValue('local-host');
      await owner.window.getByTestId(TESTID.localHostRootDir).fill(ownerRepoDir);
      await owner.window.getByTestId(TESTID.localHostPort).fill(String(port));
      await expect(owner.window.getByTestId(TESTID.localHostBindHost)).toHaveValue('0.0.0.0');
      await owner.window.getByTestId(TESTID.createChannelNext).click();
      await owner.window.getByTestId(TESTID.createChannelSubmit).click();
      await expect(owner.window.getByTestId(TESTID.channelDetail)).toBeVisible({
        timeout: TIMEOUTS.op,
      });

      channelId = await findChannelIdByName(owner.window, channelName);
      await expect(owner.window.getByTestId(TESTID.hostStatus)).toHaveText(/运行中/, {
        timeout: TIMEOUTS.op,
      });
      const host = await hostStatus(owner.window, channelId);
      expect(host.running).toBe(true);
      expect(host.port).toBe(port);
      channelUrl = host.urls.localChannelUrl;
      expect(channelUrl).toBe(`http://127.0.0.1:${port}/channel.json`);
      // Host 侧 HTTP 可读（Node 侧独立请求）
      expect((await fetchChannel(channelUrl)).apps).toHaveLength(0);

      // 2) A 走 UI 发布 v1.0.0（选择文件夹，显式 appId=twoinst，displayName 与之不同）
      await owner.window.getByTestId(TESTID.publishOpenButton).click();
      await expect(owner.window.getByTestId(TESTID.publishWizard)).toBeVisible();
      await owner.window.getByTestId(TESTID.publishDisplayName).fill('Two Instance Demo');
      const appIdInput = owner.window.getByTestId(TESTID.publishAppId);
      await appIdInput.fill('twoinst');
      await expect(appIdInput).toHaveValue('twoinst');
      // 新 App：版本号应由发布向导默认填为 1.0.0
      await expect(owner.window.getByTestId(TESTID.publishVersion)).toHaveValue('1.0.0');
      await owner.window.getByTestId(TESTID.publishNext).click();

      await expect(owner.window.getByTestId(TESTID.publishPickFolder)).toBeVisible();
      await owner.window.getByTestId(TESTID.publishPickFolder).click();
      // inspected 完成后会渲染文件列表与入口选择；文案需限定在向导内（底层页面也可能出现"N 个文件"）
      await expect(
        owner.window.getByTestId(TESTID.publishWizard).getByText(/2 个文件/).first(),
      ).toBeVisible({ timeout: TIMEOUTS.op });
      await expect(owner.window.getByTestId(TESTID.publishEntry)).toHaveValue('TwoInst.exe', {
        timeout: TIMEOUTS.op,
      });
      await owner.window.getByTestId(TESTID.publishNext).click();
      await expect(owner.window.getByTestId(TESTID.publishSubmit)).toBeVisible();
      await owner.window.getByTestId(TESTID.publishSubmit).click();
      await expect(owner.window.getByText('发布成功')).toBeVisible({ timeout: TIMEOUTS.op });
      await owner.window.getByRole('button', { name: '完成' }).click();
      await expect(owner.window.getByTestId(TESTID.publishWizard)).toBeHidden();

      // 3) 远端 channel.json：只有 1 个 App、appId=twoinst、latest=1.0.0
      await expect
        .poll(async () => (await fetchChannel(channelUrl!)).apps.length, { timeout: TIMEOUTS.op })
        .toBe(1);
      const channelV1 = await fetchChannel(channelUrl);
      expect(channelV1.apps[0]?.appId).toBe('twoinst');
      expect(channelV1.apps[0]?.latest.windows).toBe('1.0.0');

      // ---- B：subscriber 实例（独立 userData）----
      subscriber = await launchApp();
      await waitForShell(subscriber.window);
      await expect(subscriber.window.getByTestId(TESTID.navChannels)).toBeVisible();
      await subscriber.window.getByTestId(TESTID.subscribeChannelButton).click();
      await expect(subscriber.window.getByTestId(TESTID.subscribeDialog)).toBeVisible();
      await subscriber.window.getByTestId(TESTID.subscribeUrlInput).fill(channelUrl);
      await subscriber.window.getByTestId(TESTID.subscribeSubmit).click();

      // 4) B 进入频道详情 → App 详情 → 安装（真实 HTTP 下载 + 校验）
      await expect(subscriber.window.getByTestId(TESTID.channelDetail)).toBeVisible({
        timeout: TIMEOUTS.op,
      });
      const appCard = subscriber.window.locator(
        `[data-testid="${TESTID.appCard}"][data-app-id="twoinst"]`,
      );
      await expect(appCard).toBeVisible({ timeout: TIMEOUTS.op });
      await appCard.click();
      await expect(subscriber.window.getByTestId(TESTID.appDetail)).toBeVisible();
      await expect(subscriber.window.getByTestId(TESTID.installStatus)).toHaveText(/未安装/);
      await subscriber.window.getByTestId(TESTID.installButton).click();
      await expect(subscriber.window.getByTestId(TESTID.installStatus)).toHaveText(/已安装/, {
        timeout: TIMEOUTS.op,
      });

      const installedV1 = await waitForInstalledVersion(subscriber.userDataDir, {
        channelId: channelId!,
        appId: 'twoinst',
        version: '1.0.0',
        entry: 'TwoInst.exe',
        files: v1Expected,
      });
      expect(installedV1.versionDir.replace(/\\/g, '/')).toContain(
        `/library/${channelId}/twoinst/versions/1.0.0`,
      );

      // ---- 源目录升级为 v1.1.0 ----
      const v2Files = {
        'TwoInst.exe': 'TwoInst v1.1.0 payload (changed)\n',
        'resources/config.ini': '[app]\nname=Two Instance Demo\nversion=1.1.0\n',
      };
      await writeSourceFiles(sourceDir, v2Files);
      const v2Expected = await expectedFiles(sourceDir, v2Files);

      // 5) A 从 App 详情「发布新版本」→ v1.1.0（已有 App 不应出现 appId 输入）
      await owner.window.getByRole('button', { name: /返回频道列表/ }).click();
      await owner.window.locator(
        `[data-testid="${TESTID.channelCard}"][data-channel-id="${channelId}"]`,
      ).click();
      const ownerAppCard = owner.window.locator(
        `[data-testid="${TESTID.appCard}"][data-app-id="twoinst"]`,
      );
      await expect(ownerAppCard).toBeVisible({ timeout: TIMEOUTS.op });
      await ownerAppCard.click();
      await expect(owner.window.getByTestId(TESTID.appDetail)).toBeVisible();
      await expect(owner.window.getByTestId(TESTID.publishNewVersionButton)).toBeVisible();
      await owner.window.getByTestId(TESTID.publishNewVersionButton).click();
      await expect(owner.window.getByTestId(TESTID.publishWizard)).toBeVisible();
      // 已有 App：appId 只读展示、没有可编辑的 publish-app-id 输入
      await expect(owner.window.getByTestId(TESTID.publishAppId)).toHaveCount(0);
      // 已有 App：默认版本在 1.0.0 基础上递增 minor 为 1.1.0
      await expect(owner.window.getByTestId(TESTID.publishVersion)).toHaveValue('1.1.0');
      await owner.window.getByTestId(TESTID.publishNext).click();
      await owner.window.getByTestId(TESTID.publishPickFolder).click();
      await expect(
        owner.window.getByTestId(TESTID.publishWizard).getByText(/2 个文件/).first(),
      ).toBeVisible({ timeout: TIMEOUTS.op });
      await expect(owner.window.getByTestId(TESTID.publishEntry)).toHaveValue('TwoInst.exe', {
        timeout: TIMEOUTS.op,
      });
      await owner.window.getByTestId(TESTID.publishNext).click();
      await owner.window.getByTestId(TESTID.publishSubmit).click();
      await expect(owner.window.getByText('发布成功')).toBeVisible({ timeout: TIMEOUTS.op });
      await owner.window.getByRole('button', { name: '完成' }).click();
      await expect(owner.window.getByTestId(TESTID.publishWizard)).toBeHidden();

      // 6) 远端 channel.json：仍只有 1 个 App、appId 不变、latest=1.1.0
      await expect
        .poll(async () => (await fetchChannel(channelUrl)).apps[0]?.latest.windows, {
          timeout: TIMEOUTS.op,
        })
        .toBe('1.1.0');
      const channelV2 = await fetchChannel(channelUrl);
      expect(channelV2.apps).toHaveLength(1);
      expect(channelV2.apps[0]?.appId).toBe('twoinst');
      expect(channelV2.apps[0]?.latest.windows).toBe('1.1.0');

      // 7) B 返回频道详情 → 刷新 → 打开 App → 出现「更新」→ 更新到 v1.1.0
      await subscriber.window.getByRole('button', { name: '返回频道详情' }).click();
      await expect(subscriber.window.getByTestId(TESTID.channelDetail)).toBeVisible();
      await subscriber.window.getByTestId(TESTID.channelRefreshButton).click();
      // 刷新完成后频道卡片展示的 latest 应变为 1.1.0（以数据为准，不依赖按钮瞬时文案）
      await expect(appCard).toContainText('1.1.0', { timeout: TIMEOUTS.op });
      await appCard.click();
      await expect(subscriber.window.getByTestId(TESTID.appDetail)).toBeVisible();
      await expect(subscriber.window.getByTestId(TESTID.updateButton)).toBeVisible({
        timeout: TIMEOUTS.op,
      });
      await subscriber.window.getByTestId(TESTID.updateButton).click();
      await expect(subscriber.window.getByTestId(TESTID.installStatus)).toHaveText(/已安装 v1\.1\.0/, {
        timeout: TIMEOUTS.op,
      });

      const installedV2 = await waitForInstalledVersion(subscriber.userDataDir, {
        channelId: channelId!,
        appId: 'twoinst',
        version: '1.1.0',
        entry: 'TwoInst.exe',
        files: v2Expected,
      });
      expect(installedV2.versionDir.replace(/\\/g, '/')).toContain('/versions/1.1.0');

      // 8) B 本地库只有 twoinst
      await subscriber.window.getByTestId(TESTID.navLibrary).click();
      const installedCards = subscriber.window.getByTestId(TESTID.installedAppCard);
      await expect(installedCards).toHaveCount(1);
      await expect(installedCards.first()).toHaveAttribute('data-app-id', 'twoinst');
    } finally {
      // 清理：停止 Host（若仍在运行）→ 关闭两个实例（失败时落日志）→ 删除临时目录
      if (owner && channelId) {
        await hostStop(owner.window, channelId).catch(() => undefined);
      }
      if (subscriber) await subscriber.close(testInfo);
      if (owner) await owner.close(testInfo);
      await fs.rm(workDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
    }
  });
});

interface ChannelJson {
  apps: { appId: string; latest: Record<string, string> }[];
}

async function fetchChannel(url: string): Promise<ChannelJson> {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  expect(response.status, `GET ${url} 应返回 200`).toBe(200);
  return (await response.json()) as ChannelJson;
}

async function writeSourceFiles(
  sourceDir: string,
  files: Record<string, string>,
): Promise<void> {
  await fs.rm(sourceDir, { recursive: true, force: true });
  for (const [relativePath, content] of Object.entries(files)) {
    const target = path.join(sourceDir, ...relativePath.split('/'));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, 'utf8');
  }
}

async function expectedFiles(
  sourceDir: string,
  files: Record<string, string>,
): Promise<{ path: string; size: number; md5: string }[]> {
  const { createHash } = await import('node:crypto');
  const out: { path: string; size: number; md5: string }[] = [];
  for (const relativePath of Object.keys(files)) {
    const data = await fs.readFile(path.join(sourceDir, ...relativePath.split('/')));
    out.push({
      path: relativePath,
      size: data.length,
      md5: createHash('md5').update(data).digest('hex'),
    });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}
