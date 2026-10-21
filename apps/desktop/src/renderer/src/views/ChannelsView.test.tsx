import { describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { fail, createMockApi, makeChannelSummary, ok } from '../../test/mock-api';
import { render, screen, userEvent, waitFor } from '../../test/render';

describe('频道页', () => {
  it('没有频道时显示空态引导与创建/订阅入口', async () => {
    const api = createMockApi({ channels: { list: vi.fn().mockResolvedValue(ok([])) } });
    render(<App api={api} />);

    expect(await screen.findByText('还没有任何频道')).toBeInTheDocument();
    expect(screen.getByTestId('create-channel-button')).toBeInTheDocument();
    expect(screen.getByTestId('subscribe-channel-button')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /创建我的第一个频道/ })).toBeInTheDocument();
  });

  it('按「我拥有的 / 我订阅的」分组渲染频道卡片', async () => {
    const owned = makeChannelSummary({ id: 'ch_owned', name: 'Alice 的工具箱', appCount: 3 });
    const subscribed = makeChannelSummary({
      id: 'ch_sub',
      name: '社区频道',
      role: 'subscriber',
      source: 'subscribed',
      canPublish: false,
      appCount: 1,
      visibility: 'private',
    });
    const api = createMockApi({
      channels: { list: vi.fn().mockResolvedValue(ok([owned, subscribed])) },
    });
    render(<App api={api} />);

    expect(await screen.findByText('Alice 的工具箱')).toBeInTheDocument();
    expect(screen.getByText('社区频道')).toBeInTheDocument();
    expect(screen.getByText(/我拥有的/)).toBeInTheDocument();
    expect(screen.getByText(/我订阅的/)).toBeInTheDocument();
    const cards = screen.getAllByTestId('channel-card');
    expect(cards).toHaveLength(2);
    expect(cards[0]).toHaveAttribute('data-channel-id', 'ch_owned');
    expect(screen.getByText('私密')).toBeInTheDocument();
  });

  it('列表加载失败显示错误态，重试后恢复', async () => {
    const api = createMockApi({
      channels: { list: vi.fn().mockResolvedValue(fail('NETWORK', '无法连接频道仓库')) },
    });
    const user = userEvent.setup();
    render(<App api={api} />);

    expect(await screen.findByText('频道列表加载失败')).toBeInTheDocument();
    expect(screen.getAllByText('NETWORK').length).toBeGreaterThan(0);

    vi.mocked(api.channels.list).mockResolvedValue(ok([makeChannelSummary()]));
    await user.click(screen.getByRole('button', { name: /重试/ }));

    expect(await screen.findByText('示例频道')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByText('频道列表加载失败')).not.toBeInTheDocument(),
    );
  });
});
