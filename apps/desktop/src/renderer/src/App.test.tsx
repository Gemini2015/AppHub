import { describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { act, render, screen, userEvent, waitFor } from '../test/render';
import { createMockApi, makeAvailableUpdate, makeHostStatus, makeProgressEvent, makeRunningHostStatus, ok } from '../test/mock-api';

describe('App 外壳', () => {
  it('window.apphub 缺失时显示可读错误而不是白屏', () => {
    const { unmount } = render(<App />);
    expect(screen.getByText('未检测到 AppHub 运行环境')).toBeInTheDocument();
    expect(screen.getByTestId('app-root')).toBeInTheDocument();
    unmount();

    render(<App api={null} />);
    expect(screen.getByText('未检测到 AppHub 运行环境')).toBeInTheDocument();
  });

  it('渲染侧边栏导航，data-changed 事件触发频道列表刷新', async () => {
    const api = createMockApi();
    render(<App api={api} />);

    expect(await screen.findByText('示例频道')).toBeInTheDocument();
    expect(api.channels.list).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('nav-channels')).toBeInTheDocument();
    expect(screen.getByTestId('nav-library')).toBeInTheDocument();
    expect(screen.getByTestId('nav-settings')).toBeInTheDocument();

    act(() => {
      api.emitDataChanged({ domain: 'channels', channelId: 'ch_1' });
    });
    await waitFor(() => expect(api.channels.list).toHaveBeenCalledTimes(2));
  });

  it('侧边栏可切换到本地库与设置页', async () => {
    const api = createMockApi();
    const user = userEvent.setup();
    render(<App api={api} />);
    await screen.findByText('示例频道');

    await user.click(screen.getByTestId('nav-library'));
    expect(await screen.findByRole('heading', { name: '本地库' })).toBeInTheDocument();
    expect(screen.getByTestId('library-empty')).toBeInTheDocument();

    await user.click(screen.getByTestId('nav-settings'));
    expect(await screen.findByRole('heading', { name: '设置 / 关于' })).toBeInTheDocument();
    expect(await screen.findByText('去中心化说明')).toBeInTheDocument();
    await waitFor(() => expect(api.system.info).toHaveBeenCalled());
  });

  it('订阅 onProgress 事件后显示全局进度浮层', async () => {
    const api = createMockApi();
    render(<App api={api} />);
    await screen.findByText('示例频道');

    act(() => {
      api.emitProgress(makeProgressEvent({ percent: 37, operation: 'publish' }));
    });

    expect(await screen.findByText('37%')).toBeInTheDocument();
    expect(screen.getByText(/发布/)).toBeInTheDocument();
  });

  it('加载 host.list 并在频道卡片显示 Host 运行徽标', async () => {
    const api = createMockApi({
      host: { list: vi.fn().mockResolvedValue(ok([makeRunningHostStatus()])) },
    });
    render(<App api={api} />);

    expect(await screen.findByText('示例频道')).toBeInTheDocument();
    await waitFor(() => expect(api.host.list).toHaveBeenCalled());
    const badge = await screen.findByTestId('channel-host-badge');
    expect(badge).toHaveTextContent('Host 运行中');
  });

  it('data-changed domain=host 时刷新 Host 状态列表与徽标', async () => {
    const api = createMockApi({
      host: { list: vi.fn().mockResolvedValue(ok([makeHostStatus()])) },
    });
    render(<App api={api} />);
    await screen.findByText('示例频道');
    await waitFor(() => expect(api.host.list).toHaveBeenCalledTimes(1));
    expect(await screen.findByTestId('channel-host-badge')).toHaveTextContent('Host 已停止');

    act(() => {
      api.emitDataChanged({ domain: 'host', channelId: 'ch_1' });
    });

    await waitFor(() => expect(api.host.list).toHaveBeenCalledTimes(2));
  });

  it('有可用更新时显示 Banner，点击查看打开更新弹窗', async () => {
    const api = createMockApi({
      updates: { state: vi.fn().mockResolvedValue(ok(makeAvailableUpdate())) },
    });
    const user = userEvent.setup();
    render(<App api={api} />);

    const banner = await screen.findByTestId('update-banner');
    expect(banner).toHaveTextContent('发现新版本 v0.2.0');

    await user.click(screen.getByTestId('update-open-button'));
    const dialog = await screen.findByTestId('update-dialog');
    expect(dialog).toHaveTextContent('AppHub v0.2.0');
    expect(dialog).toHaveTextContent(/添加自动更新/);
    expect(screen.getByTestId('update-download-button')).toBeInTheDocument();
  });
});
