import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import type {
  ApiResult,
  AppHubApi,
  ChannelDetailDTO,
  ChannelSummaryDTO,
  CreateChannelRequestDTO,
  HostStatusDTO,
} from '../shared/ipc';
import { TMP_DIR } from './support/paths';
import { getFreePort } from './support/port';
import { expect, test } from './support/test-fixtures';
import { TESTID, TIMEOUTS, waitForShell } from './support/ui';

/**
 * 本机 Host（provider = local-host）Electron E2E。
 *
 * 覆盖：创建向导 local-host 表单 → 创建后自动 host.start → Host 面板运行中 →
 * 本机地址可被 Node 侧 fetch 读取 channel.json → 停止后不可达 → 重启恢复 →
 * 频道列表 Host 徽标；局域网地址可达性（无网卡环境显式记录原因跳过）；
 * 私密频道能力链接可访问、篡改 accessKey 返回 404。
 *
 * 边界：
 *  - 原生目录选择框（local-host-browse-root）无法由 Playwright 驱动，这里直接填写
 *    rootDir 文本框（即 pickDirectory 的替代路径），原生 dialog 分支由主进程单测覆盖；
 *  - 端口一律用 getFreePort()，避免与开发机默认 8787 或上一次运行冲突；
 *  - 默认 bindHost=0.0.0.0（局域网可访问），只在"本机地址"上做确定性断言，
 *    局域网地址单独用例、无网卡时 skip（Playwright 报告会显示 skip 与原因）。
 */

/** 在 e2e/.tmp 下创建本次用例专用的本地仓库目录。 */
async function createTempRepoDir(label: string): Promise<string> {
  await fs.mkdir(TMP_DIR, { recursive: true });
  return fs.mkdtemp(path.join(TMP_DIR, `local-host-${label}-`));
}

function readApi(window: Page): AppHubApi {
  const api = (window as unknown as { apphub?: AppHubApi }).apphub;
  if (!api) throw new Error('window.apphub 缺失：preload 未注入');
  return api;
}

/** 在 renderer 上下文里执行 IPC 调用（回调内只引用浏览器全局 window，不捕获 Node 侧变量）。 */
async function createChannelViaApi(
  window: Page,
  request: CreateChannelRequestDTO,
): Promise<ChannelDetailDTO> {
  const result = await window.evaluate(
    async (input: CreateChannelRequestDTO): Promise<ApiResult<ChannelDetailDTO>> => {
      const api = (window as unknown as { apphub?: AppHubApi }).apphub;
      if (!api) throw new Error('window.apphub 缺失：preload 未注入');
      return api.channels.create(input);
    },
    request,
  );
  expect(result.ok, `通过 IPC 创建频道失败：${JSON.stringify(result)}`).toBe(true);
  if (!result.ok) throw new Error(`创建频道失败：${result.error.code} ${result.error.message}`);
  return result.value;
}

async function hostStatus(window: Page, channelId: string): Promise<HostStatusDTO> {
  const result = await window.evaluate(
    async (id: string): Promise<ApiResult<HostStatusDTO>> => {
      const api = (window as unknown as { apphub?: AppHubApi }).apphub;
      if (!api) throw new Error('window.apphub 缺失：preload 未注入');
      return api.host.status(id);
    },
    channelId,
  );
  expect(result.ok, `读取 Host 状态失败：${JSON.stringify(result)}`).toBe(true);
  if (!result.ok) throw new Error(`host.status 失败：${result.error.code} ${result.error.message}`);
  return result.value;
}

async function hostStart(window: Page, channelId: string): Promise<HostStatusDTO> {
  const result = await window.evaluate(
    async (id: string): Promise<ApiResult<HostStatusDTO>> => {
      const api = (window as unknown as { apphub?: AppHubApi }).apphub;
      if (!api) throw new Error('window.apphub 缺失：preload 未注入');
      return api.host.start(id);
    },
    channelId,
  );
  expect(result.ok, `启动 Host 失败：${JSON.stringify(result)}`).toBe(true);
  if (!result.ok) throw new Error(`host.start 失败：${result.error.code} ${result.error.message}`);
  return result.value;
}

async function hostStop(window: Page, channelId: string): Promise<void> {
  await window.evaluate(
    async (id: string): Promise<ApiResult<HostStatusDTO>> => {
      const api = (window as unknown as { apphub?: AppHubApi }).apphub;
      if (!api) throw new Error('window.apphub 缺失：preload 未注入');
      return api.host.stop(id);
    },
    channelId,
  );
}

async function findChannelIdByName(window: Page, name: string): Promise<string> {
  const list = await window.evaluate(
    async (): Promise<ApiResult<ChannelSummaryDTO[]>> => {
      const api = (window as unknown as { apphub?: AppHubApi }).apphub;
      if (!api) throw new Error('window.apphub 缺失：preload 未注入');
      return api.channels.list();
    },
  );
  expect(list.ok, `读取频道列表失败：${JSON.stringify(list)}`).toBe(true);
  if (!list.ok) throw new Error(`channels.list 失败：${list.error.code} ${list.error.message}`);
  const found = list.value.find((channel) => channel.name === name);
  expect(found, `频道列表中没有找到名称为「${name}」的频道`).toBeDefined();
  return found!.id;
}

/** 测试进程（Node 侧）真实 HTTP 请求；连接失败返回 'error'。 */
async function fetchStatus(url: string): Promise<number | 'error'> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    return response.status;
  } catch {
    return 'error';
  }
}

async function fetchJson(url: string): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // 非 JSON 时保留文本，便于失败信息排查
  }
  return { status: response.status, body };
}

test.describe('本机 Host（local-host）', () => {
  test('创建 local-host 频道 → Host 自动启动 → 本机地址可订阅 → 停止/重启', async ({ window }) => {
    await waitForShell(window);
    const port = await getFreePort();
    const rootDir = await createTempRepoDir('public');
    const channelName = `E2E Host ${Date.now()}`;

    // 1) 走创建向导：basic info → 存储配置选 local-host → 填 rootDir/端口 → 确认创建
    await window.getByTestId(TESTID.createChannelButton).click();
    await expect(window.getByTestId(TESTID.createChannelForm)).toBeVisible();
    await window.getByTestId(TESTID.createChannelName).fill(channelName);
    await window.getByTestId(TESTID.createChannelNext).click();

    const providerSelect = window.getByTestId(TESTID.storageProviderSelect);
    await expect(providerSelect).toBeVisible({ timeout: TIMEOUTS.ui });
    await providerSelect.selectOption('local-host');

    const rootInput = window.getByTestId(TESTID.localHostRootDir);
    await expect(rootInput).toBeVisible();
    await rootInput.fill(rootDir);
    await window.getByTestId(TESTID.localHostPort).fill(String(port));
    // 默认对局域网开放（0.0.0.0），这是本机 Host 的主要使用场景
    await expect(window.getByTestId(TESTID.localHostBindHost)).toHaveValue('0.0.0.0');

    await window.getByTestId(TESTID.createChannelNext).click();
    await window.getByTestId(TESTID.createChannelSubmit).click();

    // 2) 创建成功后自动跳转频道详情；向导中的 host.start 已尽力自动执行
    await expect(window.getByTestId(TESTID.channelDetail)).toBeVisible({ timeout: TIMEOUTS.op });
    const channelId = await findChannelIdByName(window, channelName);
    await expect(window.getByTestId(TESTID.hostPanel)).toBeVisible({ timeout: TIMEOUTS.op });
    await expect(window.getByTestId(TESTID.hostStatus)).toHaveText(/运行中/, {
      timeout: TIMEOUTS.op,
    });

    const started = await hostStatus(window, channelId);
    expect(started.running).toBe(true);
    expect(started.port).toBe(port);
    expect(started.bindHost).toBe('0.0.0.0');
    // 首选地址 = host-url 展示地址
    await expect(window.getByTestId(TESTID.hostUrl)).toHaveText(started.urls.channelUrl);
    expect(started.urls.localChannelUrl).toBe(`http://127.0.0.1:${port}/channel.json`);
    // 无局域网网卡时首选地址回退到回环地址
    if (started.urls.lanChannelUrls.length === 0) {
      expect(started.urls.channelUrl).toBe(started.urls.localChannelUrl);
    } else {
      for (const url of started.urls.lanChannelUrls) {
        expect(url).toMatch(/^http:\/\/\d{1,3}(?:\.\d{1,3}){3}:\d+\/channel\.json$/);
      }
    }

    // 3) Node 侧（测试进程，等价于"另一台设备/浏览器"）真实 HTTP 读取 channel.json
    const localResponse = await fetchJson(started.urls.localChannelUrl);
    expect(localResponse.status).toBe(200);
    expect((localResponse.body as { id?: string }).id).toBe(channelId);

    // 4) 频道列表出现 Host 徽标（运行中）
    await window.getByRole('button', { name: /返回频道列表/ }).click();
    const card = window.locator(
      `[data-testid="${TESTID.channelCard}"][data-channel-id="${channelId}"]`,
    );
    await expect(card).toBeVisible({ timeout: TIMEOUTS.op });
    await expect(card.getByTestId(TESTID.channelHostBadge)).toHaveText(/运行中/);
    await card.click();
    await expect(window.getByTestId(TESTID.channelDetail)).toBeVisible();

    // 5) 停止 Host → HTTP 不可达 → Host 面板显示已停止
    await window.getByTestId(TESTID.hostStopButton).click();
    await expect(window.getByTestId(TESTID.hostStatus)).toHaveText(/已停止/, {
      timeout: TIMEOUTS.op,
    });
    await expect
      .poll(() => fetchStatus(started.urls.localChannelUrl), {
        timeout: 15_000,
        message: 'Host 停止后本机地址应不可访问',
      })
      .toBe('error');
    await expect
      .poll(() => fetchStatus(started.urls.channelUrl), {
        timeout: 15_000,
        message: 'Host 停止后首选地址应不可访问',
      })
      .toBe('error');

    // 6) 重新启动 → HTTP 恢复
    await window.getByTestId(TESTID.hostStartButton).click();
    await expect(window.getByTestId(TESTID.hostStatus)).toHaveText(/运行中/, {
      timeout: TIMEOUTS.op,
    });
    await expect
      .poll(async () => (await fetchJson(started.urls.localChannelUrl)).status, { timeout: 15_000 })
      .toBe(200);
    await expect(window.getByTestId(TESTID.hostUrl)).toHaveText(started.urls.channelUrl);

    // 收尾：停止 Host（不依赖应用退出清理）
    await hostStop(window, channelId);
  });

  test('局域网地址可达（无局域网 IPv4 网卡时显式 skip 并记录原因）', async ({ window }) => {
    await waitForShell(window);
    const port = await getFreePort();
    const rootDir = await createTempRepoDir('lan');
    // 走 IPC 预置（本用例关注 LAN URL 可达性，创建向导流程已在上一用例覆盖）
    const created = await createChannelViaApi(window, {
      name: `E2E LAN Host ${Date.now()}`,
      visibility: 'public',
      storage: { provider: 'local-host', rootDir, port, bindHost: '0.0.0.0' },
    });
    const status = await hostStart(window, created.summary.id);
    const lanUrls = status.urls.lanChannelUrls;

    test.skip(
      lanUrls.length === 0,
      '本机没有非 internal 的 IPv4 网卡（如隔离 CI 容器），无法验证局域网地址可达性；已跳过该断言（非静默）。',
    );

    const attempts: { url: string; status: number | 'error' }[] = [];
    for (const url of lanUrls) {
      attempts.push({ url, status: await fetchStatus(url) });
    }
    expect(
      attempts.some((attempt) => attempt.status === 200),
      `局域网地址均不可达（可能是防火墙/网络策略）：${JSON.stringify(attempts)}`,
    ).toBe(true);

    await hostStop(window, created.summary.id);
  });

  test('私密 local-host 频道：能力链接可访问，篡改 accessKey 返回 404', async ({ window }) => {
    await waitForShell(window);
    const port = await getFreePort();
    const rootDir = await createTempRepoDir('private');
    const created = await createChannelViaApi(window, {
      name: `E2E Private Host ${Date.now()}`,
      visibility: 'private',
      storage: {
        provider: 'local-host',
        rootDir,
        port,
        bindHost: '0.0.0.0',
        // 让首选订阅地址确定落在回环，便于测试进程直接 fetch
        advertiseHost: '127.0.0.1',
      },
    });
    const channelId = created.summary.id;
    const started = await hostStart(window, channelId);
    const capabilityUrl = started.urls.channelUrl;

    // 1) 能力链接包含 _private/<channelId>/<accessKey>/channel.json
    expect(capabilityUrl).toContain(`/_private/${channelId}/`);
    expect(capabilityUrl.endsWith('/channel.json')).toBe(true);
    const segments = new URL(capabilityUrl).pathname.split('/').filter(Boolean);
    expect(segments[0]).toBe('_private');
    expect(segments[1]).toBe(channelId);
    const accessKey = segments[2]!;
    expect(accessKey.length).toBeGreaterThanOrEqual(16);

    // 2) UI 展示的首选订阅地址就是能力链接
    await window.reload();
    await waitForShell(window);
    const card = window.locator(
      `[data-testid="${TESTID.channelCard}"][data-channel-id="${channelId}"]`,
    );
    await expect(card).toBeVisible({ timeout: TIMEOUTS.op });
    await card.click();
    await expect(window.getByTestId(TESTID.hostPanel)).toBeVisible({ timeout: TIMEOUTS.op });
    await expect(window.getByTestId(TESTID.hostUrl)).toHaveText(capabilityUrl);

    // 3) 能力链接可读取 channel.json（visibility=private）
    const capabilityResponse = await fetchJson(capabilityUrl);
    expect(capabilityResponse.status).toBe(200);
    expect((capabilityResponse.body as { visibility?: string }).visibility).toBe('private');

    // 4) 公开路径（无 _private 前缀）404
    const origin = new URL(capabilityUrl).origin;
    expect((await fetchJson(`${origin}/channel.json`)).status).toBe(404);

    // 5) 篡改 accessKey → 404
    const tamperedUrl = capabilityUrl.replace(accessKey, 'a'.repeat(32));
    expect(tamperedUrl).not.toBe(capabilityUrl);
    expect((await fetchJson(tamperedUrl)).status).toBe(404);

    await hostStop(window, channelId);
  });
});
