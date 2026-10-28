import { describe, expect, it, vi } from 'vitest';
import { PublishWizard } from './PublishWizard';
import {
  CHANNEL_ID,
  META_URL,
  createMockApi,
  fail,
  makeAppDetail,
  makeAppMeta,
  makePublishResult,
  ok,
} from '../../test/mock-api';
import { renderWithApi, screen, userEvent, waitFor, within } from '../../test/render';

function renderWizard(
  api: ReturnType<typeof createMockApi>,
  options: { app?: ReturnType<typeof makeAppDetail> | null; onPublished?: ReturnType<typeof vi.fn> } = {},
) {
  const onPublished = options.onPublished ?? vi.fn();
  const onClose = vi.fn();
  renderWithApi(
    <PublishWizard
      channelId={CHANNEL_ID}
      channelName="示例频道"
      app={options.app ?? null}
      onClose={onClose}
      onPublished={onPublished}
    />,
    api,
  );
  return { onPublished, onClose };
}

async function fillStep1(
  user: ReturnType<typeof userEvent.setup>,
  fields: { displayName?: string; version: string },
) {
  if (fields.displayName !== undefined) {
    await user.type(screen.getByTestId('publish-display-name'), fields.displayName);
  }
  await user.clear(screen.getByTestId('publish-version'));
  await user.type(screen.getByTestId('publish-version'), fields.version);
  await user.click(screen.getByTestId('publish-next'));
}

async function pickFiles(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /^选择文件$/ }));
  await waitFor(() =>
    expect(screen.getByLabelText(/启动入口（从已选文件中选择）/)).toBeInTheDocument(),
  );
}

describe('发布向导', () => {
  it('必填与 semver 校验拦截在第 1 步，修正后错误消失', async () => {
    const api = createMockApi();
    const { onPublished } = renderWizard(api);
    const user = userEvent.setup();

    await user.click(screen.getByTestId('publish-next'));
    expect(await screen.findByText('请输入 App 名称')).toBeInTheDocument();
    expect(screen.getByTestId('publish-version')).toBeInTheDocument();
    expect(screen.queryByTestId('publish-entry')).not.toBeInTheDocument();
    expect(api.publish.start).not.toHaveBeenCalled();

    await user.type(screen.getByTestId('publish-display-name'), 'TestApp');
    await user.type(screen.getByTestId('publish-version'), 'not-semver');
    await user.click(screen.getByTestId('publish-next'));

    expect(await screen.findByText(/版本号必须符合 semver/)).toBeInTheDocument();
    expect(screen.getByTestId('publish-version')).toBeInTheDocument();
    expect(screen.queryByTestId('publish-entry')).not.toBeInTheDocument();

    await user.clear(screen.getByTestId('publish-version'));
    await user.type(screen.getByTestId('publish-version'), '1.0.1');
    await waitFor(() => expect(screen.queryByText(/版本号必须符合 semver/)).not.toBeInTheDocument());
    expect(onPublished).not.toHaveBeenCalled();
  });

  it('选择散文件后 inspectSelection 提供 entry 选项，发布成功展示结果并回调', async () => {
    const api = createMockApi();
    const publishResult = makePublishResult();
    const { onPublished, onClose } = renderWizard(api);
    const user = userEvent.setup();

    await fillStep1(user, { displayName: 'TestApp', version: '1.0.1' });
    expect(await screen.findByText('选择要发布的内容')).toBeInTheDocument();

    await pickFiles(user);
    expect(api.publish.pick).toHaveBeenCalledWith('files');
    expect(api.publish.inspectSelection).toHaveBeenCalledWith('sel_1');
    expect(screen.getByRole('option', { name: 'foobar.exe' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'resources/app.ini' })).toBeInTheDocument();
    expect(screen.getByText('2 个文件')).toBeInTheDocument();

    await user.click(screen.getByTestId('publish-next'));
    expect(await screen.findByText('确认发布内容')).toBeInTheDocument();

    await user.click(screen.getByTestId('publish-submit'));

    await waitFor(() =>
      expect(api.publish.start).toHaveBeenCalledWith(
        expect.objectContaining({
          channelId: CHANNEL_ID,
          displayName: 'TestApp',
          version: '1.0.1',
          platform: 'windows',
          publishMode: 'files',
          entry: 'foobar.exe',
          selectionId: 'sel_1',
        }),
      ),
    );
    await waitFor(() => expect(onPublished).toHaveBeenCalledWith(publishResult));
    expect(await screen.findByText('发布成功')).toBeInTheDocument();
    expect(screen.getByText(META_URL)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '完成' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('zip 模式选择压缩包后展示内部文件与 entry', async () => {
    const api = createMockApi();
    vi.mocked(api.publish.pick).mockResolvedValue(
      ok({ selectionId: 'sel_zip', kind: 'zip', files: [] }),
    );
    vi.mocked(api.publish.inspectSelection).mockResolvedValue(
      ok({
        kind: 'zip',
        files: [{ path: 'foobar.exe', size: 10 }],
        suggestedEntry: 'foobar.exe',
        zip: { name: 'foobar.zip', size: 100 },
      }),
    );
    renderWizard(api);
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: /压缩包（zip）/ }));
    await fillStep1(user, { displayName: 'ZipApp', version: '2.0.0' });

    await user.click(screen.getByRole('button', { name: /选择压缩包/ }));
    await waitFor(() => expect(api.publish.pick).toHaveBeenCalledWith('zip'));
    expect(await screen.findByText(/foobar\.zip/)).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'foobar.exe' })).toBeInTheDocument();
  });

  it('版本已存在时必须勾选覆盖确认，发布请求携带 overwrite=true', async () => {
    const api = createMockApi();
    const existingApp = makeAppDetail();
    const { onPublished } = renderWizard(api, { app: existingApp });
    const user = userEvent.setup();

    // 已有 App：displayName 自动带出，只需要填版本号
    await fillStep1(user, { version: '1.0.1' });
    await pickFiles(user);
    await user.click(screen.getByTestId('publish-next'));

    expect(await screen.findByText('确认发布内容')).toBeInTheDocument();
    expect(screen.getByText('覆盖风险')).toBeInTheDocument();

    await user.click(screen.getByTestId('publish-submit'));
    expect(await screen.findByText('请勾选确认覆盖已存在的版本')).toBeInTheDocument();
    expect(api.publish.start).not.toHaveBeenCalled();

    await user.click(screen.getByLabelText(/我确认覆盖已存在的版本/));
    await user.click(screen.getByTestId('publish-submit'));

    await waitFor(() =>
      expect(api.publish.start).toHaveBeenCalledWith(
        expect.objectContaining({ version: '1.0.1', overwrite: true }),
      ),
    );
    await waitFor(() => expect(onPublished).toHaveBeenCalled());
  });

  it('发布已有 App 的新版本时携带原始 appId（displayName 与 appId 不一致时不会生成新 App）', async () => {
    const api = createMockApi();
    // 复现实际回归：首个版本显式 appId=cpu_z，displayName=CPU-Z；
    // 旧逻辑发布新版本时不传 appId，core 会按 displayName 重新 slugify 成 cpu-z，
    // 导致 channel.json 中出现两个 App。
    const existingApp = makeAppDetail({
      meta: makeAppMeta({ appId: 'cpu_z', name: 'cpu_z', displayName: 'CPU-Z' }),
    });
    renderWizard(api, { app: existingApp });
    const user = userEvent.setup();

    await fillStep1(user, { version: '1.0.2' });
    await pickFiles(user);
    await user.click(screen.getByTestId('publish-next'));

    expect(await screen.findByText('确认发布内容')).toBeInTheDocument();
    await user.click(screen.getByTestId('publish-submit'));

    await waitFor(() =>
      expect(api.publish.start).toHaveBeenCalledWith(
        expect.objectContaining({
          appId: 'cpu_z',
          displayName: 'CPU-Z',
          version: '1.0.2',
        }),
      ),
    );
  });

  it('发布失败时展示错误码与信息，且不回调 onPublished', async () => {
    const api = createMockApi({
      publish: { start: vi.fn().mockResolvedValue(fail('STORAGE', '上传频道文件失败')) },
    });
    const { onPublished } = renderWizard(api);
    const user = userEvent.setup();

    await fillStep1(user, { displayName: 'FailApp', version: '1.0.0' });
    await pickFiles(user);
    await user.click(screen.getByTestId('publish-next'));
    await user.click(await screen.findByTestId('publish-submit'));

    const dialog = screen.getByTestId('publish-wizard');
    expect(await within(dialog).findByTestId('dialog-error')).toBeInTheDocument();
    expect(within(dialog).getAllByText(/上传频道文件失败/).length).toBeGreaterThan(0);
    expect(within(dialog).getAllByText('STORAGE').length).toBeGreaterThan(0);
    expect(onPublished).not.toHaveBeenCalled();
  });
});
