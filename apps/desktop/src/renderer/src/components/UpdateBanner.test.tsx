import { describe, expect, it, vi } from 'vitest';
import { UpdateBanner } from './UpdateBanner';
import {
  createMockApi,
  makeAvailableUpdate,
  makeDownloadedUpdate,
  makeDownloadingUpdate,
  makeUpdateState,
  ok,
} from '../../test/mock-api';
import { renderWithApi, screen, userEvent, waitFor } from '../../test/render';

function renderBanner(api: ReturnType<typeof createMockApi>) {
  renderWithApi(<UpdateBanner />, api);
}

function updateApi(initial: ReturnType<typeof makeUpdateState>, extra: Partial<ReturnType<typeof createMockApi>['updates']> = {}) {
  return createMockApi({
    updates: {
      state: vi.fn().mockResolvedValue(ok(initial)),
      ...extra,
    },
  });
}

describe('更新提示 Banner', () => {
  it('有可用更新时显示 Banner，「稍后」调用 dismiss 后隐藏', async () => {
    const api = updateApi(makeAvailableUpdate(), {
      dismiss: vi.fn().mockResolvedValue(ok(makeAvailableUpdate({ dismissed: true }))),
    });
    renderBanner(api);
    const user = userEvent.setup();

    const banner = await screen.findByTestId('update-banner');
    expect(banner).toHaveTextContent('发现新版本 v0.2.0');
    expect(screen.getByTestId('update-open-button')).toBeInTheDocument();

    await user.click(screen.getByTestId('update-dismiss-button'));

    await waitFor(() => expect(api.updates.dismiss).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByTestId('update-banner')).not.toBeInTheDocument());
  });

  it('下载中显示进度百分比，已下载显示安装引导', async () => {
    const downloadingApi = updateApi(makeDownloadingUpdate());
    const { unmount } = renderWithApi(<UpdateBanner />, downloadingApi);
    const downloadingBanner = await screen.findByTestId('update-banner');
    expect(downloadingBanner).toHaveTextContent('正在下载更新 v0.2.0');
    expect(downloadingBanner).toHaveTextContent('已下载 42%');
    unmount();

    const downloadedApi = updateApi(makeDownloadedUpdate());
    renderBanner(downloadedApi);
    const downloadedBanner = await screen.findByTestId('update-banner');
    expect(downloadedBanner).toHaveTextContent('已下载，重启 App 即可安装');
    expect(screen.getByTestId('update-open-button')).toHaveTextContent('查看并安装');
  });

  it('不支持自动更新或被用户稍后时完全不渲染', async () => {
    const unsupportedApi = updateApi(
      makeUpdateState({ supported: false, status: 'unsupported', unsupportedReason: 'dev' }),
    );
    const { unmount } = renderWithApi(<UpdateBanner />, unsupportedApi);
    await waitFor(() => expect(unsupportedApi.updates.state).toHaveBeenCalled());
    expect(screen.queryByTestId('update-banner')).not.toBeInTheDocument();
    unmount();

    const dismissedApi = updateApi(makeAvailableUpdate({ dismissed: true }));
    renderWithApi(<UpdateBanner />, dismissedApi);
    await waitFor(() => expect(dismissedApi.updates.state).toHaveBeenCalled());
    expect(screen.queryByTestId('update-banner')).not.toBeInTheDocument();
  });

  it('Banner 只展示提示，不发起检查/下载（点击查看由父层打开弹窗）', async () => {
    const api = updateApi(makeAvailableUpdate());
    renderBanner(api);

    await screen.findByTestId('update-banner');
    expect(api.updates.check).not.toHaveBeenCalled();
    expect(api.updates.download).not.toHaveBeenCalled();
  });
});
