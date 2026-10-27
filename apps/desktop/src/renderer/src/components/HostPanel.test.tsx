import { describe, expect, it, vi } from 'vitest';
import { HostPanel } from './HostPanel';
import {
  CHANNEL_ID,
  HOST_LAN_URL,
  HOST_LOCAL_URL,
  createMockApi,
  fail,
  makeHostStatus,
  makeRunningHostStatus,
  ok,
} from '../../test/mock-api';
import { renderWithApi, screen, userEvent, waitFor } from '../../test/render';
import type { HostStatusDTO } from '../types';

function renderHostPanel(
  api: ReturnType<typeof createMockApi>,
  props: { dataVersion?: number; onChanged?: ReturnType<typeof vi.fn> } = {},
) {
  const onChanged = props.onChanged ?? vi.fn();
  renderWithApi(
    <HostPanel channelId={CHANNEL_ID} dataVersion={props.dataVersion ?? 0} onChanged={onChanged} />,
    api,
  );
  return { onChanged };
}

function statusApi(status: HostStatusDTO, extra: Partial<ReturnType<typeof createMockApi>['host']> = {}) {
  return createMockApi({
    host: {
      status: vi.fn().mockResolvedValue(ok(status)),
      ...extra,
    },
  });
}

describe('本机 Host 面板', () => {
  it('非 local-host 频道（UNSUPPORTED）静默不渲染面板', async () => {
    const api = createMockApi();
    renderHostPanel(api);

    await waitFor(() => expect(api.host.status).toHaveBeenCalledWith(CHANNEL_ID));
    expect(screen.queryByTestId('host-panel')).not.toBeInTheDocument();
  });

  it('运行中状态展示端口、访问范围、启动时间与首选订阅地址', async () => {
    const api = statusApi(makeRunningHostStatus({ visibility: 'private' }));
    renderHostPanel(api);

    const panel = await screen.findByTestId('host-panel');
    expect(panel).toBeInTheDocument();
    expect(screen.getByTestId('host-status')).toHaveTextContent('运行中');
    expect(panel).toHaveTextContent('8787');
    expect(panel).toHaveTextContent('局域网可访问（0.0.0.0）');
    expect(screen.getByTestId('host-url')).toHaveTextContent(HOST_LAN_URL);
    expect(panel).toHaveTextContent(HOST_LOCAL_URL);
    // 私密频道提示能力链接
    expect(panel).toHaveTextContent('私密频道：链接即授权');
    // 运行中可停止，不可编辑配置
    expect(screen.getByTestId('host-stop-button')).toBeInTheDocument();
    expect(screen.queryByTestId('host-edit-config')).not.toBeInTheDocument();
  });

  it('停止状态显示启动按钮与未运行提示，点击启动后更新为运行中', async () => {
    const api = statusApi(makeHostStatus(), {
      start: vi.fn().mockResolvedValue(ok(makeRunningHostStatus())),
    });
    const { onChanged } = renderHostPanel(api);
    const user = userEvent.setup();

    await screen.findByTestId('host-panel');
    expect(screen.getByTestId('host-status')).toHaveTextContent('已停止');
    expect(screen.getByTestId('host-start-button')).toBeInTheDocument();
    expect(screen.getByTestId('host-edit-config')).toBeInTheDocument();
    expect(screen.getByText(/Host 未运行/)).toBeInTheDocument();

    await user.click(screen.getByTestId('host-start-button'));

    await waitFor(() => expect(api.host.start).toHaveBeenCalledWith(CHANNEL_ID));
    await waitFor(() => expect(screen.getByTestId('host-status')).toHaveTextContent('运行中'));
    expect(screen.getByTestId('host-stop-button')).toBeInTheDocument();
    expect(await screen.findByText(/本机 Host 已启动/)).toBeInTheDocument();
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('运行中点击停止后回到已停止并恢复编辑入口', async () => {
    const api = statusApi(makeRunningHostStatus(), {
      stop: vi.fn().mockResolvedValue(ok(makeHostStatus())),
    });
    const user = userEvent.setup();
    renderHostPanel(api);

    await screen.findByTestId('host-panel');
    await user.click(screen.getByTestId('host-stop-button'));

    await waitFor(() => expect(api.host.stop).toHaveBeenCalledWith(CHANNEL_ID));
    await waitFor(() => expect(screen.getByTestId('host-status')).toHaveTextContent('已停止'));
    expect(screen.getByTestId('host-start-button')).toBeInTheDocument();
    expect(screen.getByTestId('host-edit-config')).toBeInTheDocument();
    expect(await screen.findByText('本机 Host 已停止')).toBeInTheDocument();
  });

  it('复制首选/本机/局域网地址写入剪贴板', async () => {
    const api = statusApi(makeRunningHostStatus());
    const user = userEvent.setup();
    // userEvent.setup() 会替换 navigator.clipboard 存根，spy 必须在其之后创建。
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    renderHostPanel(api);

    await screen.findByTestId('host-panel');

    await user.click(screen.getByRole('button', { name: '复制首选地址' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(HOST_LAN_URL));

    await user.click(screen.getByRole('button', { name: '复制本机地址' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(HOST_LOCAL_URL));

    await user.click(screen.getByRole('button', { name: '复制局域网地址 1' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(HOST_LAN_URL));

    expect(await screen.findByText(/首选订阅地址已复制/)).toBeInTheDocument();
  });

  it('停止时编辑配置：提交正确的 updateConfig（端口/监听范围/对外主机/公开地址）', async () => {
    const updated = makeHostStatus({ configuredPort: 9000, bindHost: '127.0.0.1' });
    const api = statusApi(makeHostStatus(), {
      updateConfig: vi.fn().mockResolvedValue(ok(updated)),
    });
    const { onChanged } = renderHostPanel(api);
    const user = userEvent.setup();

    await screen.findByTestId('host-panel');
    await user.click(screen.getByTestId('host-edit-config'));

    const dialog = await screen.findByTestId('host-config-dialog');
    expect(dialog).toBeInTheDocument();

    const portInput = screen.getByTestId('host-config-port');
    await user.clear(portInput);
    await user.type(portInput, '9000');
    await user.selectOptions(screen.getByTestId('host-config-bind-host'), '127.0.0.1');
    await user.clear(screen.getByTestId('host-config-advertise-host'));
    await user.type(screen.getByTestId('host-config-advertise-host'), 'my-pc.local');
    await user.type(screen.getByTestId('host-config-public-base-url'), 'http://my-pc.local:9000/');
    await user.click(screen.getByTestId('host-config-submit'));

    await waitFor(() =>
      expect(api.host.updateConfig).toHaveBeenCalledWith({
        channelId: CHANNEL_ID,
        patch: {
          port: 9000,
          bindHost: '127.0.0.1',
          advertiseHost: 'my-pc.local',
          publicBaseUrl: 'http://my-pc.local:9000/',
        },
      }),
    );
    await waitFor(() => expect(screen.queryByTestId('host-config-dialog')).not.toBeInTheDocument());
    expect(await screen.findByText(/Host 配置已更新/)).toBeInTheDocument();
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(screen.getByTestId('host-panel')).toHaveTextContent('仅本机（127.0.0.1）');
  });

  it('编辑配置端口非法时给出校验错误且不调用 IPC', async () => {
    const api = statusApi(makeHostStatus());
    const user = userEvent.setup();
    renderHostPanel(api);

    await screen.findByTestId('host-panel');
    await user.click(screen.getByTestId('host-edit-config'));
    await screen.findByTestId('host-config-dialog');

    const portInput = screen.getByTestId('host-config-port');
    await user.clear(portInput);
    await user.type(portInput, '70000');
    await user.click(screen.getByTestId('host-config-submit'));

    expect(await screen.findByText('端口必须是 1-65535 的整数')).toBeInTheDocument();
    expect(api.host.updateConfig).not.toHaveBeenCalled();
  });

  it('清空已配置的 advertiseHost 时提交空字符串（清除配置），未修改字段不传', async () => {
    const configuredHost = makeHostStatus({
      urls: {
        channelUrl: 'http://my-pc.local:8787/channel.json',
        localChannelUrl: HOST_LOCAL_URL,
        lanChannelUrls: [HOST_LAN_URL],
      },
    });
    const api = statusApi(configuredHost, {
      updateConfig: vi.fn().mockResolvedValue(ok(makeHostStatus())),
    });
    const user = userEvent.setup();
    renderHostPanel(api);

    await screen.findByTestId('host-panel');
    await user.click(screen.getByTestId('host-edit-config'));
    await screen.findByTestId('host-config-dialog');

    const advertiseInput = screen.getByTestId('host-config-advertise-host') as HTMLInputElement;
    // 当前对外主机名从首选订阅地址回显
    expect(advertiseInput.value).toBe('my-pc.local');
    expect(screen.getByText(/留空 = 清除可选配置/)).toBeInTheDocument();

    await user.clear(advertiseInput);
    await user.click(screen.getByTestId('host-config-submit'));

    await waitFor(() =>
      expect(api.host.updateConfig).toHaveBeenCalledWith({
        channelId: CHANNEL_ID,
        // advertiseHost 清空 => ''（清除）；未修改的 publicBaseUrl 不出现在 patch 中。
        patch: { port: 8787, bindHost: '0.0.0.0', advertiseHost: '' },
      }),
    );
  });

  it('启动失败时展示错误 toast，并展示上次启动失败的 lastError', async () => {
    const lastError = { code: 'STORAGE' as const, message: '端口 8787 已被占用' };
    const api = statusApi(makeHostStatus({ lastError }), {
      start: vi.fn().mockResolvedValue(fail('STORAGE', '端口 8787 已被占用')),
    });
    const user = userEvent.setup();
    renderHostPanel(api);

    await screen.findByTestId('host-panel');
    expect(screen.getByText('上次启动失败')).toBeInTheDocument();
    expect(screen.getAllByText(/端口 8787 已被占用/).length).toBeGreaterThan(0);

    await user.click(screen.getByTestId('host-start-button'));

    await waitFor(() => expect(api.host.start).toHaveBeenCalled());
    await waitFor(() => expect(screen.getAllByText(/端口 8787 已被占用/).length).toBeGreaterThan(1));
    expect(screen.getByTestId('host-status')).toHaveTextContent('已停止');
  });

  it('Host 状态读取出现非 UNSUPPORTED 错误时展示可重试的错误提示', async () => {
    const api = createMockApi({
      host: { status: vi.fn().mockResolvedValue(fail('INTERNAL', 'Host 服务初始化失败')) },
    });
    renderHostPanel(api);

    expect(await screen.findByTestId('host-panel')).toBeInTheDocument();
    expect(screen.getByText('本机 Host 状态读取失败')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /重试/ })).toBeInTheDocument();
  });
});
