import { describe, expect, it, vi } from 'vitest';
import { UpdateDialog } from './UpdateDialog';
import { useUpdate } from './UpdateProvider';
import {
  RELEASE_NOTES,
  createMockApi,
  fail,
  makeAvailableUpdate,
  makeDownloadedUpdate,
  makeDownloadingUpdate,
  makeUpdateState,
  ok,
} from '../../test/mock-api';
import { renderWithApi, screen, userEvent, waitFor } from '../../test/render';

function OpenUpdateButton() {
  const { openDialog } = useUpdate();
  return (
    <button type="button" data-testid="open-update" onClick={openDialog}>
      open
    </button>
  );
}

function renderDialog(api: ReturnType<typeof createMockApi>) {
  renderWithApi(
    <>
      <OpenUpdateButton />
      <UpdateDialog />
    </>,
    api,
  );
}

async function openDialog(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByTestId('open-update'));
  return screen.findByTestId('update-dialog');
}

function updateApi(initial: ReturnType<typeof makeUpdateState>, extra: Partial<ReturnType<typeof createMockApi>['updates']> = {}) {
  return createMockApi({
    updates: {
      state: vi.fn().mockResolvedValue(ok(initial)),
      ...extra,
    },
  });
}

describe('更新详情弹窗', () => {
  it('展示版本、发布日期与纯文本 release notes；下载后显示进度', async () => {
    const api = updateApi(makeAvailableUpdate(), {
      download: vi.fn().mockResolvedValue(ok(makeDownloadingUpdate())),
    });
    renderDialog(api);
    const user = userEvent.setup();

    const dialog = await openDialog(user);
    expect(dialog).toHaveTextContent('当前版本 v0.1.0');
    expect(dialog).toHaveTextContent('可用版本 v0.2.0');
    expect(dialog).toHaveTextContent('AppHub v0.2.0');
    expect(dialog).toHaveTextContent(/添加自动更新/);
    expect(screen.queryByTestId('update-progress')).not.toBeInTheDocument();

    await user.click(screen.getByTestId('update-download-button'));

    await waitFor(() => expect(api.updates.download).toHaveBeenCalled());
    const progress = await screen.findByTestId('update-progress');
    expect(progress).toHaveTextContent('42%');
    expect(progress).toHaveTextContent('正在下载更新');
  });

  it('release notes 按纯文本渲染，不解析 HTML', async () => {
    const api = updateApi(
      makeAvailableUpdate({ releaseNotes: '<b>not-bold</b> <img src=x onerror="alert(1)">' }),
    );
    renderDialog(api);
    const user = userEvent.setup();

    const dialog = await openDialog(user);
    expect(dialog).toHaveTextContent('<b>not-bold</b> <img src=x onerror="alert(1)">');
    expect(dialog.querySelector('b')).toBeNull();
    expect(dialog.querySelector('img')).toBeNull();
  });

  it('已下载时可重启并安装', async () => {
    const api = updateApi(makeDownloadedUpdate());
    renderDialog(api);
    const user = userEvent.setup();

    await openDialog(user);
    expect(screen.queryByTestId('update-download-button')).not.toBeInTheDocument();
    await user.click(screen.getByTestId('update-install-button'));

    await waitFor(() => expect(api.updates.install).toHaveBeenCalled());
    expect(await screen.findByText(/正在重启并安装更新/)).toBeInTheDocument();
  });

  it('下载失败时展示 update-error 与错误码，重试再次调用 download', async () => {
    const api = updateApi(makeAvailableUpdate(), {
      download: vi.fn().mockResolvedValue(fail('NETWORK', '下载更新失败：连接超时')),
    });
    renderDialog(api);
    const user = userEvent.setup();

    await openDialog(user);
    await user.click(screen.getByTestId('update-download-button'));

    const errorBox = await screen.findByTestId('update-error');
    expect(errorBox).toHaveTextContent('下载更新失败：连接超时');
    expect(errorBox).toHaveTextContent('NETWORK');

    await user.click(screen.getByTestId('update-retry-button'));
    await waitFor(() => expect(api.updates.download).toHaveBeenCalledTimes(2));
  });

  it('已是最新版本或环境不支持时显示对应说明，且无下载/安装按钮', async () => {
    const upToDateApi = updateApi(makeAvailableUpdate({ status: 'up-to-date', availableVersion: undefined }));
    const { unmount } = renderWithApi(
      <>
        <OpenUpdateButton />
        <UpdateDialog />
      </>,
      upToDateApi,
    );
    const user = userEvent.setup();
    await openDialog(user);
    expect(screen.getByText('已是最新版本')).toBeInTheDocument();
    expect(screen.queryByTestId('update-download-button')).not.toBeInTheDocument();
    unmount();

    const unsupportedApi = updateApi(makeUpdateState({ supported: false, status: 'unsupported' }));
    renderDialog(unsupportedApi);
    await openDialog(user);
    await waitFor(() =>
      expect(screen.getAllByText(/当前环境不支持自动更新/).length).toBeGreaterThan(0),
    );
    expect(screen.queryByTestId('update-download-button')).not.toBeInTheDocument();
    expect(screen.queryByTestId('update-install-button')).not.toBeInTheDocument();
  });

  it('稍后按钮调用 dismiss 并关闭弹窗', async () => {
    const api = updateApi(makeAvailableUpdate(), {
      dismiss: vi.fn().mockResolvedValue(ok(makeAvailableUpdate({ dismissed: true }))),
    });
    renderDialog(api);
    const user = userEvent.setup();

    await openDialog(user);
    const buttons = screen.getAllByRole('button', { name: '稍后' });
    await user.click(buttons[0]);

    await waitFor(() => expect(api.updates.dismiss).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByTestId('update-dialog')).not.toBeInTheDocument());
    expect(RELEASE_NOTES).toContain('更新内容');
  });
});
