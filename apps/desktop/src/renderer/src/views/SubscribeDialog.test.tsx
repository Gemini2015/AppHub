import { describe, expect, it, vi } from 'vitest';
import { SubscribeDialog } from './SubscribeDialog';
import { createMockApi, fail, makeChannelDetail, ok } from '../../test/mock-api';
import { renderWithApi, screen, userEvent, waitFor, within } from '../../test/render';

describe('订阅频道对话框', () => {
  it('非法 URL 给出校验错误且不调用 subscribe', async () => {
    const api = createMockApi();
    const onSubscribed = vi.fn();
    renderWithApi(<SubscribeDialog onClose={vi.fn()} onSubscribed={onSubscribed} />, api);
    const user = userEvent.setup();

    await user.type(screen.getByTestId('subscribe-url-input'), 'not-a-url');
    await user.click(screen.getByTestId('subscribe-submit'));

    expect(await screen.findByText(/请输入合法的 http\(s\) 地址/)).toBeInTheDocument();
    expect(api.channels.subscribe).not.toHaveBeenCalled();
    expect(onSubscribed).not.toHaveBeenCalled();
  });

  it('订阅成功时携带 URL 与可选 headers，并回调 onSubscribed', async () => {
    const detail = makeChannelDetail();
    const api = createMockApi({
      channels: { subscribe: vi.fn().mockResolvedValue(ok(detail)) },
    });
    const onSubscribed = vi.fn();
    renderWithApi(<SubscribeDialog onClose={vi.fn()} onSubscribed={onSubscribed} />, api);
    const user = userEvent.setup();

    await user.type(screen.getByTestId('subscribe-url-input'), 'http://example.com/app_repo/channel.json');
    await user.click(screen.getByRole('button', { name: /高级：HTTP 请求头/ }));
    await user.click(screen.getByRole('button', { name: /添加请求头/ }));
    await user.type(screen.getByLabelText('请求头名称 1'), 'Authorization');
    await user.type(screen.getByLabelText('请求头值 1'), 'Bearer token');
    await user.click(screen.getByTestId('subscribe-submit'));

    await waitFor(() =>
      expect(api.channels.subscribe).toHaveBeenCalledWith({
        url: 'http://example.com/app_repo/channel.json',
        headers: { Authorization: 'Bearer token' },
      }),
    );
    await waitFor(() => expect(onSubscribed).toHaveBeenCalledWith(detail));
  });

  it('订阅失败时在对话框内展示错误码与错误信息，并弹出错误 toast', async () => {
    const api = createMockApi({
      channels: { subscribe: vi.fn().mockResolvedValue(fail('AUTH', '频道不存在或无访问权限')) },
    });
    renderWithApi(<SubscribeDialog onClose={vi.fn()} onSubscribed={vi.fn()} />, api);
    const user = userEvent.setup();

    await user.type(screen.getByTestId('subscribe-url-input'), 'https://example.com/channel.json');
    await user.click(screen.getByTestId('subscribe-submit'));

    const dialog = screen.getByTestId('subscribe-dialog');
    expect(await within(dialog).findByText(/频道不存在或无访问权限/)).toBeInTheDocument();
    expect(within(dialog).getByText('AUTH')).toBeInTheDocument();
    // toast 也会展示错误（另外一处 AUTH）
    await waitFor(() => expect(screen.getAllByText('AUTH').length).toBeGreaterThan(1));
  });
});
