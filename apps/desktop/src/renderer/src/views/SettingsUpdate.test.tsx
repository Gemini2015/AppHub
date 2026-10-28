import { describe, expect, it, vi } from 'vitest';
import { SettingsView } from './SettingsView';
import {
  createMockApi,
  fail,
  makeAvailableUpdate,
  makeDownloadedUpdate,
  makeDownloadingUpdate,
  makeUpdateState,
  ok,
} from '../../test/mock-api';
import { renderWithApi, screen, userEvent, waitFor } from '../../test/render';

function renderSettings(api: ReturnType<typeof createMockApi>) {
  renderWithApi(<SettingsView dataVersion={0} />, api);
}

function updateApi(initial: ReturnType<typeof makeUpdateState>, extra: Partial<ReturnType<typeof createMockApi>['updates']> = {}) {
  return createMockApi({
    updates: {
      state: vi.fn().mockResolvedValue(ok(initial)),
      ...extra,
    },
  });
}

describe('设置页 - 软件更新', () => {
  it('默认 dev 环境不支持自动更新：显示原因、禁用检查且不发起网络请求', async () => {
    const api = createMockApi();
    renderSettings(api);

    expect(await screen.findByTestId('update-status')).toHaveTextContent(
      '当前环境不支持自动更新',
    );
    expect(screen.getByText(/开发模式（未打包）不支持自动更新/)).toBeInTheDocument();
    expect(screen.getByTestId('update-check-button')).toBeDisabled();
    expect(api.updates.check).not.toHaveBeenCalled();
    expect(screen.queryByTestId('settings-update-download-button')).not.toBeInTheDocument();
  });

  it('支持环境：检查更新后展示可用版本与说明，可下载并显示进度', async () => {
    const api = updateApi(makeUpdateState({ supported: true, status: 'up-to-date' }), {
      check: vi.fn().mockResolvedValue(ok(makeAvailableUpdate())),
      download: vi.fn().mockResolvedValue(ok(makeDownloadingUpdate())),
    });
    const user = userEvent.setup();
    renderSettings(api);

    await screen.findByTestId('update-status');
    expect(screen.getByTestId('update-check-button')).toBeEnabled();
    await user.click(screen.getByTestId('update-check-button'));

    await waitFor(() => expect(api.updates.check).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId('update-status')).toHaveTextContent('发现新版本'));
    expect(screen.getByText(/v0\.2\.0/)).toBeInTheDocument();
    expect(screen.getByText(/添加自动更新/)).toBeInTheDocument();

    await user.click(screen.getByTestId('settings-update-download-button'));
    await waitFor(() => expect(api.updates.download).toHaveBeenCalled());
    expect(await screen.findByTestId('settings-update-progress')).toHaveTextContent('42%');
  });

  it('已下载时设置页可直接重启并安装', async () => {
    const api = updateApi(makeDownloadedUpdate());
    const user = userEvent.setup();
    renderSettings(api);

    await screen.findByTestId('update-status');
    await waitFor(() => expect(screen.getByTestId('update-status')).toHaveTextContent('更新已下载'));
    await user.click(screen.getByTestId('settings-update-install-button'));

    await waitFor(() => expect(api.updates.install).toHaveBeenCalled());
    expect(await screen.findByText(/正在重启并安装更新/)).toBeInTheDocument();
  });

  it('检查更新失败时展示 update 错误与错误码（内联 + toast）', async () => {
    const api = updateApi(makeUpdateState({ supported: true, status: 'idle' }), {
      check: vi.fn().mockResolvedValue(fail('NETWORK', '检查更新失败：无法连接 GitHub')),
    });
    const user = userEvent.setup();
    renderSettings(api);

    await screen.findByTestId('update-status');
    await user.click(screen.getByTestId('update-check-button'));

    const errorBox = await screen.findByTestId('settings-update-error');
    expect(errorBox).toHaveTextContent('无法连接 GitHub');
    expect(errorBox).toHaveTextContent('NETWORK');
    expect(screen.getAllByText('NETWORK').length).toBeGreaterThan(0);
  });

  it('环境变量禁用更新时显示对应原因', async () => {
    const api = updateApi(makeUpdateState({ supported: false, status: 'unsupported', unsupportedReason: 'env' }));
    renderSettings(api);

    expect(await screen.findByTestId('update-status')).toHaveTextContent(
      '当前环境不支持自动更新',
    );
    expect(screen.getByText(/环境变量禁用了自动更新/)).toBeInTheDocument();
    expect(screen.getByTestId('update-check-button')).toBeDisabled();
  });
});
