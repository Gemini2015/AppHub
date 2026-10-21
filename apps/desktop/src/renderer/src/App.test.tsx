import { describe, expect, it } from 'vitest';
import { App } from './App';
import { act, render, screen, userEvent, waitFor } from '../test/render';
import { createMockApi, makeProgressEvent } from '../test/mock-api';

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
});
