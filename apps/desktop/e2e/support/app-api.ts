import type { Page } from '@playwright/test';
import type {
  ApiResult,
  AppHubApi,
  ChannelDetailDTO,
  ChannelSummaryDTO,
  CreateChannelRequestDTO,
  HostStatusDTO,
  SystemInfoDTO,
} from '../../shared/ipc';

/**
 * E2E 公共 IPC 助手（在 renderer 上下文里调用真实 `window.apphub`）。
 *
 * 约定：`window.evaluate` 的回调会被序列化到渲染进程执行，**不能捕获 Node 侧变量**
 * （包括外层函数、常量、Playwright 的 Page 对象）；所有入参必须通过 evaluate 的第二个参数传递，
 * 回调内只允许引用浏览器全局（window）。
 */

function unwrapApi<T>(result: ApiResult<T>, label: string): T {
  if (!result.ok) {
    throw new Error(`${label}失败：${result.error.code} ${result.error.message}`);
  }
  return result.value;
}

/** 通过真实 IPC 创建频道（不经过 UI 向导）。 */
export async function createChannelViaApi(
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
  return unwrapApi(result, '通过 IPC 创建频道');
}

export async function listChannels(window: Page): Promise<ChannelSummaryDTO[]> {
  const result = await window.evaluate(
    async (): Promise<ApiResult<ChannelSummaryDTO[]>> => {
      const api = (window as unknown as { apphub?: AppHubApi }).apphub;
      if (!api) throw new Error('window.apphub 缺失：preload 未注入');
      return api.channels.list();
    },
  );
  return unwrapApi(result, '读取频道列表');
}

export async function findChannelIdByName(window: Page, name: string): Promise<string> {
  const channels = await listChannels(window);
  const found = channels.find((channel) => channel.name === name);
  if (!found) throw new Error(`频道列表中没有找到名称为「${name}」的频道`);
  return found.id;
}

export async function hostStatus(window: Page, channelId: string): Promise<HostStatusDTO> {
  const result = await window.evaluate(
    async (id: string): Promise<ApiResult<HostStatusDTO>> => {
      const api = (window as unknown as { apphub?: AppHubApi }).apphub;
      if (!api) throw new Error('window.apphub 缺失：preload 未注入');
      return api.host.status(id);
    },
    channelId,
  );
  return unwrapApi(result, '读取 Host 状态');
}

export async function hostStart(window: Page, channelId: string): Promise<HostStatusDTO> {
  const result = await window.evaluate(
    async (id: string): Promise<ApiResult<HostStatusDTO>> => {
      const api = (window as unknown as { apphub?: AppHubApi }).apphub;
      if (!api) throw new Error('window.apphub 缺失：preload 未注入');
      return api.host.start(id);
    },
    channelId,
  );
  return unwrapApi(result, '启动 Host');
}

export async function hostStop(window: Page, channelId: string): Promise<void> {
  const result = await window.evaluate(
    async (id: string): Promise<ApiResult<HostStatusDTO>> => {
      const api = (window as unknown as { apphub?: AppHubApi }).apphub;
      if (!api) throw new Error('window.apphub 缺失：preload 未注入');
      return api.host.stop(id);
    },
    channelId,
  );
  unwrapApi(result, '停止 Host');
}

export async function getSystemInfo(window: Page): Promise<SystemInfoDTO> {
  const result = await window.evaluate(
    async (): Promise<ApiResult<SystemInfoDTO>> => {
      const api = (window as unknown as { apphub?: AppHubApi }).apphub;
      if (!api) throw new Error('window.apphub 缺失：preload 未注入');
      return api.system.info();
    },
  );
  return unwrapApi(result, '读取系统信息');
}
