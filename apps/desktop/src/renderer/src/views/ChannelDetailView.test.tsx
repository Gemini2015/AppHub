import { describe, expect, it, vi } from 'vitest';
import { ChannelDetailView } from './ChannelDetailView';
import {
  CHANNEL_ID,
  HOST_LAN_URL,
  SUBSCRIBE_URL,
  createMockApi,
  makeChannelDetail,
  makeChannelSummary,
  makeRunningHostStatus,
  ok,
} from '../../test/mock-api';
import { renderWithApi, screen, userEvent, waitFor, within } from '../../test/render';

function renderChannelDetail(api: ReturnType<typeof createMockApi>, onBack = vi.fn()) {
  return {
    onBack,
    ...renderWithApi(
      <ChannelDetailView
        channelId={CHANNEL_ID}
        dataVersion={0}
        onBack={onBack}
        onOpenApp={vi.fn()}
        onChannelsChanged={vi.fn()}
        onNavigateChannel={vi.fn()}
      />,
      api,
    ),
  };
}

describe('频道详情', () => {
  it('渲染频道信息、App 卡片网格与发布入口（canPublish）', async () => {
    const api = createMockApi();
    renderChannelDetail(api);

    expect(await screen.findByTestId('channel-detail')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: '示例频道' })).toBeInTheDocument();
    const card = await screen.findByTestId('app-card');
    expect(card).toHaveAttribute('data-app-id', 'foobar');
    expect(within(card).getByText('FooBar')).toBeInTheDocument();
    expect(within(card).getByText('1.0.1')).toBeInTheDocument();
    expect(screen.getByTestId('publish-open-button')).toBeInTheDocument();
    expect(screen.getByText(SUBSCRIBE_URL)).toBeInTheDocument();
  });

  it('订阅者看不到发布按钮，但可以看到取消订阅', async () => {
    const detail = makeChannelDetail({
      summary: makeChannelSummary({
        role: 'subscriber',
        source: 'subscribed',
        canPublish: false,
      }),
    });
    const api = createMockApi({ channels: { get: vi.fn().mockResolvedValue(ok(detail)) } });
    renderChannelDetail(api);

    await screen.findByTestId('channel-detail');
    await waitFor(() => expect(screen.queryByTestId('publish-open-button')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: /取消订阅/ })).toBeInTheDocument();
    expect(screen.getByText('订阅者')).toBeInTheDocument();
  });

  it('点击复制订阅链接时调用 getSubscribeUrl 并写入剪贴板', async () => {
    const api = createMockApi();
    const user = userEvent.setup();
    // 注意：userEvent.setup() 会替换 navigator.clipboard 存根，spy 必须在其之后创建。
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    renderChannelDetail(api);

    await screen.findByTestId('channel-detail');
    await user.click(screen.getByRole('button', { name: /复制订阅链接/ }));

    await waitFor(() => expect(api.channels.getSubscribeUrl).toHaveBeenCalledWith(CHANNEL_ID));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(SUBSCRIBE_URL));
    expect(await screen.findByText(/订阅链接已复制/)).toBeInTheDocument();
  });

  it('刷新调用 channels.refresh 并更新视图', async () => {
    const api = createMockApi();
    const user = userEvent.setup();
    renderChannelDetail(api);

    await screen.findByTestId('channel-detail');
    await user.click(screen.getByTestId('channel-refresh-button'));

    await waitFor(() => expect(api.channels.refresh).toHaveBeenCalledWith(CHANNEL_ID));
    expect(await screen.findByText('频道已刷新')).toBeInTheDocument();
  });

  it('取消订阅需要二次确认，确认后调用 unsubscribe 并返回列表', async () => {
    const detail = makeChannelDetail({
      summary: makeChannelSummary({ role: 'subscriber', source: 'subscribed', canPublish: false }),
    });
    const api = createMockApi({
      channels: {
        get: vi.fn().mockResolvedValue(ok(detail)),
        unsubscribe: vi.fn().mockResolvedValue(ok(undefined)),
      },
    });
    const user = userEvent.setup();
    const { onBack } = renderChannelDetail(api);

    await screen.findByTestId('channel-detail');
    await user.click(screen.getByRole('button', { name: /取消订阅/ }));

    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByTestId('confirm-ok'));

    await waitFor(() => expect(api.channels.unsubscribe).toHaveBeenCalledWith(CHANNEL_ID));
    await waitFor(() => expect(onBack).toHaveBeenCalled());
  });

  it('owner 的 local-host 频道展示本机 Host 面板与运行状态', async () => {
    const api = createMockApi({
      host: { status: vi.fn().mockResolvedValue(ok(makeRunningHostStatus())) },
    });
    renderChannelDetail(api);

    await screen.findByTestId('channel-detail');
    const panel = await screen.findByTestId('host-panel');
    expect(panel).toBeInTheDocument();
    expect(api.host.status).toHaveBeenCalledWith(CHANNEL_ID);
    expect(screen.getByTestId('host-status')).toHaveTextContent('运行中');
    expect(screen.getByTestId('host-url')).toHaveTextContent(HOST_LAN_URL);
  });

  it('订阅者不查询也不展示 Host 面板', async () => {
    const detail = makeChannelDetail({
      summary: makeChannelSummary({ role: 'subscriber', source: 'subscribed', canPublish: false }),
    });
    const api = createMockApi({
      channels: { get: vi.fn().mockResolvedValue(ok(detail)) },
      host: { status: vi.fn().mockResolvedValue(ok(makeRunningHostStatus())) },
    });
    renderChannelDetail(api);

    await screen.findByTestId('channel-detail');
    expect(screen.queryByTestId('host-panel')).not.toBeInTheDocument();
    expect(api.host.status).not.toHaveBeenCalled();
  });
});
