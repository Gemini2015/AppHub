import { describe, expect, it, vi } from 'vitest';
import { LibraryView } from './LibraryView';
import {
  APP_ID,
  CHANNEL_ID,
  createMockApi,
  makeInstalledApp,
  makeUpdateCheck,
  makeVerifyResult,
  ok,
} from '../../test/mock-api';
import { renderWithApi, screen, userEvent, waitFor, within } from '../../test/render';

function renderLibrary(
  api: ReturnType<typeof createMockApi>,
  callbacks: { onLibraryChanged?: ReturnType<typeof vi.fn>; onGoChannels?: ReturnType<typeof vi.fn> } = {},
) {
  const onLibraryChanged = callbacks.onLibraryChanged ?? vi.fn();
  const onGoChannels = callbacks.onGoChannels ?? vi.fn();
  renderWithApi(
    <LibraryView
      dataVersion={0}
      onLibraryChanged={onLibraryChanged}
      onGoChannels={onGoChannels}
    />,
    api,
  );
  return { onLibraryChanged, onGoChannels };
}

describe('本地库', () => {
  it('没有已安装 App 时显示空态并可跳转频道页', async () => {
    const api = createMockApi({ library: { list: vi.fn().mockResolvedValue(ok([])) } });
    const { onGoChannels } = renderLibrary(api);
    const user = userEvent.setup();

    expect(await screen.findByTestId('library-empty')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /去频道看看/ }));
    expect(onGoChannels).toHaveBeenCalled();
  });

  it('渲染已安装 App 卡片与版本/状态信息', async () => {
    const api = createMockApi({
      library: { list: vi.fn().mockResolvedValue(ok([makeInstalledApp()])) },
    });
    renderLibrary(api);

    const card = await screen.findByTestId('installed-app-card');
    expect(card).toHaveAttribute('data-app-id', APP_ID);
    expect(within(card).getByText('FooBar')).toBeInTheDocument();
    expect(within(card).getByText('已安装')).toBeInTheDocument();
    expect(within(card).getByText(/v1\.0\.0/)).toBeInTheDocument();
    expect(within(card).getByText('示例频道')).toBeInTheDocument();
  });

  it('检查更新调用 library.checkUpdates 并展示可更新数量', async () => {
    const api = createMockApi({
      library: {
        list: vi.fn().mockResolvedValue(ok([makeInstalledApp({ status: 'outdated', availableVersion: '1.0.1' })])),
        checkUpdates: vi.fn().mockResolvedValue(ok([makeUpdateCheck()])),
      },
    });
    const user = userEvent.setup();
    renderLibrary(api);

    await screen.findByTestId('installed-app-card');
    await user.click(screen.getByTestId('library-check-updates'));

    await waitFor(() => expect(api.library.checkUpdates).toHaveBeenCalled());
    expect(await screen.findByText(/发现 1 个可更新的 App/)).toBeInTheDocument();
    await waitFor(() =>
      expect(vi.mocked(api.library.list).mock.calls.length).toBeGreaterThanOrEqual(2),
    );
  });

  it('点击更新调用 library.update 并刷新本地库', async () => {
    const api = createMockApi({
      library: {
        list: vi.fn().mockResolvedValue(ok([makeInstalledApp({ status: 'outdated', availableVersion: '1.0.1' })])),
      },
    });
    const onLibraryChanged = vi.fn();
    const user = userEvent.setup();
    renderLibrary(api, { onLibraryChanged });

    await screen.findByTestId('installed-app-card');
    await user.click(screen.getByRole('button', { name: /更新到/ }));

    await waitFor(() =>
      expect(api.library.update).toHaveBeenCalledWith({ channelId: CHANNEL_ID, appId: APP_ID }),
    );
    await waitFor(() => expect(onLibraryChanged).toHaveBeenCalled());
    expect(await screen.findByText(/已更新 FooBar 到 v1\.0\.1/)).toBeInTheDocument();
  });

  it('校验失败时展示 mismatch 明细', async () => {
    const api = createMockApi({
      library: {
        list: vi.fn().mockResolvedValue(ok([makeInstalledApp()])),
        verify: vi.fn().mockResolvedValue(
          ok(
            makeVerifyResult({
              ok: false,
              checkedFiles: 2,
              mismatches: [{ path: 'foobar.exe', reason: 'md5' }],
            }),
          ),
        ),
      },
    });
    const user = userEvent.setup();
    renderLibrary(api);

    await screen.findByTestId('installed-app-card');
    await user.click(screen.getByRole('button', { name: /^校验$/ }));

    const result = await screen.findByTestId('verify-result');
    expect(result).toHaveTextContent('发现文件差异');
    expect(within(result).getByText('MD5 不一致')).toBeInTheDocument();
  });

  it('卸载需要二次确认并调用 library.uninstall', async () => {
    const api = createMockApi({
      library: { list: vi.fn().mockResolvedValue(ok([makeInstalledApp()])) },
    });
    const user = userEvent.setup();
    renderLibrary(api);

    await screen.findByTestId('installed-app-card');
    await user.click(screen.getByRole('button', { name: /^卸载$/ }));

    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByTestId('uninstall-confirm-ok'));

    await waitFor(() =>
      expect(api.library.uninstall).toHaveBeenCalledWith({ channelId: CHANNEL_ID, appId: APP_ID }),
    );
    expect(await screen.findByText(/已卸载 FooBar/)).toBeInTheDocument();
  });
});
