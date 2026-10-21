import { describe, expect, it, vi } from 'vitest';
import { AppDetailView } from './AppDetailView';
import {
  APP_ID,
  CHANNEL_ID,
  createMockApi,
  makeAppDetail,
  makeChannelDetail,
  makeChannelSummary,
  makeInstalledApp,
  makeVerifyResult,
  ok,
} from '../../test/mock-api';
import { renderWithApi, screen, userEvent, waitFor, within } from '../../test/render';

function renderAppDetail(api: ReturnType<typeof createMockApi>, onLibraryChanged = vi.fn()) {
  return renderWithApi(
    <AppDetailView
      channelId={CHANNEL_ID}
      appId={APP_ID}
      dataVersion={0}
      onBack={vi.fn()}
      onLibraryChanged={onLibraryChanged}
    />,
    api,
  );
}

describe('App 详情', () => {
  it('未安装时显示安装按钮，点击调用 library.install 并刷新本地状态', async () => {
    const api = createMockApi();
    const onLibraryChanged = vi.fn();
    const user = userEvent.setup();
    renderAppDetail(api, onLibraryChanged);

    expect(await screen.findByTestId('app-detail')).toBeInTheDocument();
    expect(await screen.findByTestId('install-status')).toHaveTextContent('未安装');
    expect(await screen.findByText('版本历史')).toBeInTheDocument();
    expect(screen.getByText('1.0.1')).toBeInTheDocument();
    expect(screen.getAllByText('foobar.exe').length).toBeGreaterThan(0);

    await user.click(screen.getByTestId('install-button'));

    await waitFor(() =>
      expect(api.library.install).toHaveBeenCalledWith({ channelId: CHANNEL_ID, appId: APP_ID }),
    );
    await waitFor(() => expect(vi.mocked(api.library.list).mock.calls.length).toBeGreaterThanOrEqual(2));
    await waitFor(() => expect(onLibraryChanged).toHaveBeenCalled());
    expect(await screen.findByText(/已安装 FooBar v1\.0\.1/)).toBeInTheDocument();
  });

  it('已安装且远端有新版本时显示更新/校验/卸载，并可触发校验', async () => {
    const api = createMockApi({
      library: {
        list: vi.fn().mockResolvedValue(ok([makeInstalledApp()])),
        verify: vi.fn().mockResolvedValue(ok(makeVerifyResult())),
      },
    });
    const user = userEvent.setup();
    renderAppDetail(api);

    await screen.findByTestId('app-detail');
    expect(await screen.findByTestId('install-status')).toHaveTextContent('已安装 v1.0.0');
    expect(screen.getByTestId('install-status')).toHaveTextContent('可更新 v1.0.1');
    expect(screen.getByTestId('update-button')).toBeInTheDocument();
    expect(screen.getByTestId('verify-button')).toBeInTheDocument();
    expect(screen.getByTestId('uninstall-button')).toBeInTheDocument();

    await user.click(screen.getByTestId('verify-button'));

    await waitFor(() =>
      expect(api.library.verify).toHaveBeenCalledWith({ channelId: CHANNEL_ID, appId: APP_ID }),
    );
    const result = await screen.findByTestId('verify-result');
    expect(result).toHaveTextContent('校验通过');
    expect(result).toHaveTextContent('检查了 2 个文件');
  });

  it('校验失败时展示 mismatch 明细', async () => {
    const api = createMockApi({
      library: {
        list: vi.fn().mockResolvedValue(ok([makeInstalledApp()])),
        verify: vi.fn().mockResolvedValue(
          ok(
            makeVerifyResult({
              ok: false,
              checkedFiles: 3,
              mismatches: [
                { path: 'foobar.exe', reason: 'md5', expectedMd5: 'a', actualMd5: 'b' },
                { path: 'lib/data.bin', reason: 'missing' },
              ],
            }),
          ),
        ),
      },
    });
    const user = userEvent.setup();
    renderAppDetail(api);

    await screen.findByTestId('app-detail');
    await user.click(await screen.findByTestId('verify-button'));

    const result = await screen.findByTestId('verify-result');
    expect(result).toHaveTextContent('发现文件差异');
    expect(within(result).getByText('MD5 不一致')).toBeInTheDocument();
    expect(within(result).getByText('文件缺失')).toBeInTheDocument();
  });

  it('卸载需要二次确认，确认后调用 library.uninstall', async () => {
    const api = createMockApi({
      library: { list: vi.fn().mockResolvedValue(ok([makeInstalledApp()])) },
    });
    const onLibraryChanged = vi.fn();
    const user = userEvent.setup();
    renderAppDetail(api, onLibraryChanged);

    await screen.findByTestId('app-detail');
    await user.click(await screen.findByTestId('uninstall-button'));

    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByTestId('uninstall-confirm-ok'));

    await waitFor(() =>
      expect(api.library.uninstall).toHaveBeenCalledWith({ channelId: CHANNEL_ID, appId: APP_ID }),
    );
    await waitFor(() => expect(onLibraryChanged).toHaveBeenCalled());
    expect(await screen.findByText(/已卸载/)).toBeInTheDocument();
  });

  it('有发布权限时可打开发布新版本向导，订阅者不可见', async () => {
    const api = createMockApi();
    const user = userEvent.setup();
    const { unmount } = renderAppDetail(api);
    await screen.findByTestId('app-detail');
    const publishButton = screen.getByRole('button', { name: /发布新版本/ });
    expect(publishButton).toBeInTheDocument();

    await user.click(publishButton);
    expect(await screen.findByTestId('publish-wizard')).toBeInTheDocument();
    expect(screen.getByText('发布方式')).toBeInTheDocument();
    unmount();

    const subscriberDetail = makeChannelDetail({
      summary: makeChannelSummary({ role: 'subscriber', source: 'subscribed', canPublish: false }),
    });
    const subscriberApi = createMockApi({
      channels: { get: vi.fn().mockResolvedValue(ok(subscriberDetail)) },
      apps: { get: vi.fn().mockResolvedValue(ok(makeAppDetail())) },
    });
    renderAppDetail(subscriberApi);
    await screen.findByTestId('app-detail');
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /发布新版本/ })).not.toBeInTheDocument(),
    );
  });
});
