import { describe, expect, it, vi } from 'vitest';
import { CreateChannelWizard } from './CreateChannelWizard';
import {
  CHANNEL_ID,
  PICKED_DIR,
  createMockApi,
  fail,
  makeChannelDetail,
  makeHostStatus,
  ok,
} from '../../test/mock-api';
import { renderWithApi, screen, userEvent, waitFor } from '../../test/render';

function renderWizard(api: ReturnType<typeof createMockApi>, onCreated = vi.fn()) {
  renderWithApi(<CreateChannelWizard onClose={vi.fn()} onCreated={onCreated} />, api);
  return { onCreated };
}

async function openLocalHostStep(user: ReturnType<typeof userEvent.setup>, name = '本机频道') {
  await user.type(screen.getByTestId('create-channel-name'), name);
  await user.click(screen.getByTestId('create-channel-next'));
  await user.selectOptions(screen.getByTestId('storage-provider-select'), 'local-host');
}

describe('创建频道向导 - 本机 Host（local-host）', () => {
  it('默认监听 0.0.0.0:8787，展示浏览按钮与局域网/防火墙说明', async () => {
    const api = createMockApi();
    renderWizard(api);
    const user = userEvent.setup();

    await openLocalHostStep(user);

    const portInput = screen.getByTestId('local-host-port') as HTMLInputElement;
    expect(portInput.value).toBe('8787');
    expect(screen.getByTestId('local-host-bind-host')).toHaveValue('0.0.0.0');
    expect(screen.getByTestId('local-host-root-dir')).toBeInTheDocument();
    expect(screen.getByTestId('local-host-browse-root')).toBeInTheDocument();
    expect(screen.getByText(/默认对局域网开放/)).toBeInTheDocument();
    expect(screen.getByText(/防火墙/)).toBeInTheDocument();
    expect(screen.getByText(/Host 只在 AppHub 运行期间有效/)).toBeInTheDocument();

    await user.selectOptions(screen.getByTestId('local-host-bind-host'), '127.0.0.1');
    expect(screen.getByTestId('local-host-bind-host')).toHaveValue('127.0.0.1');
  });

  it('「浏览…」调用 system.pickDirectory；取消选择不改变已填目录', async () => {
    const api = createMockApi();
    renderWizard(api);
    const user = userEvent.setup();

    await openLocalHostStep(user);
    await user.click(screen.getByTestId('local-host-browse-root'));

    const rootInput = screen.getByTestId('local-host-root-dir') as HTMLInputElement;
    await waitFor(() => expect(rootInput.value).toBe(PICKED_DIR));
    expect(api.system.pickDirectory).toHaveBeenCalled();

    await user.clear(rootInput);
    vi.mocked(api.system.pickDirectory).mockResolvedValueOnce(ok(null));
    await user.click(screen.getByTestId('local-host-browse-root'));
    await waitFor(() => expect(api.system.pickDirectory).toHaveBeenCalledTimes(2));
    expect(rootInput.value).toBe('');
  });

  it('local-host 字段校验：rootDir/端口/advertiseHost/publicBaseUrl', async () => {
    const api = createMockApi();
    renderWizard(api);
    const user = userEvent.setup();

    await openLocalHostStep(user);
    await user.click(screen.getByTestId('create-channel-next'));
    expect(await screen.findByText('请选择或输入 Host 仓库根目录')).toBeInTheDocument();

    await user.type(screen.getByTestId('local-host-root-dir'), 'D:/AppHub/repo');
    const portInput = screen.getByTestId('local-host-port');
    await user.clear(portInput);
    await user.type(portInput, '70000');
    await user.click(screen.getByTestId('create-channel-next'));
    expect(await screen.findByText('端口必须是 1-65535 的整数')).toBeInTheDocument();

    await user.clear(portInput);
    await user.type(portInput, '8787');
    await user.type(
      screen.getByLabelText(/对外主机名/),
      'http://bad-host/path',
    );
    await user.click(screen.getByTestId('create-channel-next'));
    expect(await screen.findByText(/只能是主机名或 IPv4/)).toBeInTheDocument();

    await user.clear(screen.getByLabelText(/对外主机名/));
    await user.type(screen.getByLabelText(/公开基地址/), 'ftp://not-http');
    await user.click(screen.getByTestId('create-channel-next'));
    expect(await screen.findByText(/必须是 http\(s\) 地址/)).toBeInTheDocument();

    await user.clear(screen.getByLabelText(/公开基地址/));
    await user.click(screen.getByTestId('create-channel-next'));
    expect(await screen.findByText('请确认频道配置')).toBeInTheDocument();
    expect(api.channels.create).not.toHaveBeenCalled();
  });

  it('创建 local-host 频道：提交正确 storage payload 并自动启动 Host', async () => {
    const created = makeChannelDetail();
    const api = createMockApi({
      channels: { create: vi.fn().mockResolvedValue(ok(created)) },
    });
    const { onCreated } = renderWizard(api);
    const user = userEvent.setup();

    await openLocalHostStep(user);
    await user.type(screen.getByTestId('local-host-root-dir'), 'D:/AppHub/repo');
    const portInput = screen.getByTestId('local-host-port');
    await user.clear(portInput);
    await user.type(portInput, '9000');
    await user.selectOptions(screen.getByTestId('local-host-bind-host'), '127.0.0.1');
    await user.type(screen.getByLabelText(/对外主机名/), 'my-pc.local');
    await user.type(screen.getByLabelText(/公开基地址/), 'http://my-pc.local:9000/');
    await user.click(screen.getByTestId('create-channel-next'));

    expect(await screen.findByText('请确认频道配置')).toBeInTheDocument();
    expect(screen.getByText('本机 Host（local-host）')).toBeInTheDocument();
    await user.click(screen.getByTestId('create-channel-submit'));

    await waitFor(() =>
      expect(api.channels.create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: '本机频道',
          storage: expect.objectContaining({
            provider: 'local-host',
            rootDir: 'D:/AppHub/repo',
            port: 9000,
            bindHost: '127.0.0.1',
            advertiseHost: 'my-pc.local',
            publicBaseUrl: 'http://my-pc.local:9000/',
          }),
        }),
      ),
    );
    await waitFor(() => expect(api.host.start).toHaveBeenCalledWith(CHANNEL_ID));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(created));
    expect(await screen.findByText(/本机 Host 已启动/)).toBeInTheDocument();
  });

  it('默认 bindHost 0.0.0.0 / 端口 8787 会进入创建 payload', async () => {
    const api = createMockApi({ channels: { create: vi.fn().mockResolvedValue(ok(makeChannelDetail())) } });
    renderWizard(api);
    const user = userEvent.setup();

    await openLocalHostStep(user);
    await user.type(screen.getByTestId('local-host-root-dir'), 'D:/AppHub/repo');
    await user.click(screen.getByTestId('create-channel-next'));
    await user.click(await screen.findByTestId('create-channel-submit'));

    await waitFor(() =>
      expect(api.channels.create).toHaveBeenCalledWith(
        expect.objectContaining({
          storage: expect.objectContaining({ provider: 'local-host', bindHost: '0.0.0.0', port: 8787 }),
        }),
      ),
    );
  });

  it('自动启动 Host 失败时给出警告 toast，但频道创建结果继续回调', async () => {
    const created = makeChannelDetail();
    const api = createMockApi({
      channels: { create: vi.fn().mockResolvedValue(ok(created)) },
      host: {
        start: vi.fn().mockResolvedValue(fail('STORAGE', '端口 8787 已被占用')),
      },
    });
    const { onCreated } = renderWizard(api);
    const user = userEvent.setup();

    await openLocalHostStep(user);
    await user.type(screen.getByTestId('local-host-root-dir'), 'D:/AppHub/repo');
    await user.click(screen.getByTestId('create-channel-next'));
    await user.click(await screen.findByTestId('create-channel-submit'));

    await waitFor(() => expect(api.host.start).toHaveBeenCalledWith(CHANNEL_ID));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(created));
    expect(await screen.findByText(/本机 Host 启动失败/)).toBeInTheDocument();
    expect(screen.getAllByText(/端口 8787 已被占用/).length).toBeGreaterThan(0);
  });

  it('端口自动建议：8787 已被现有 local-host 频道使用 → 推荐 8788', async () => {
    const api = createMockApi({
      host: { list: vi.fn().mockResolvedValue(ok([makeHostStatus({ configuredPort: 8787 })])) },
    });
    renderWizard(api);
    const user = userEvent.setup();

    await openLocalHostStep(user);
    const portInput = screen.getByTestId('local-host-port') as HTMLInputElement;

    await waitFor(() => expect(portInput.value).toBe('8788'));
    expect(api.host.list).toHaveBeenCalled();
    expect(screen.getByText(/已用端口：8787/)).toBeInTheDocument();
    expect(screen.getByText(/推荐 8788/)).toBeInTheDocument();
  });

  it('端口自动建议：8787/8788 都已占用 → 推荐 8789', async () => {
    const api = createMockApi({
      host: {
        list: vi.fn().mockResolvedValue(
          ok([
            makeHostStatus({ configuredPort: 8787 }),
            makeHostStatus({ channelId: 'ch_second', configuredPort: 8788 }),
          ]),
        ),
      },
    });
    renderWizard(api);
    const user = userEvent.setup();

    await openLocalHostStep(user);
    const portInput = screen.getByTestId('local-host-port') as HTMLInputElement;

    await waitFor(() => expect(portInput.value).toBe('8789'));
    expect(screen.getByText(/推荐 8789/)).toBeInTheDocument();
  });

  it('手动修改端口后切换 provider 不再自动覆盖', async () => {
    const api = createMockApi({
      host: { list: vi.fn().mockResolvedValue(ok([makeHostStatus({ configuredPort: 8787 })])) },
    });
    renderWizard(api);
    const user = userEvent.setup();

    await openLocalHostStep(user);
    const portInput = screen.getByTestId('local-host-port') as HTMLInputElement;
    await waitFor(() => expect(portInput.value).toBe('8788'));

    await user.clear(portInput);
    await user.type(portInput, '9000');

    const providerSelect = screen.getByTestId('storage-provider-select');
    await user.selectOptions(providerSelect, 'local');
    await user.selectOptions(providerSelect, 'local-host');

    expect((screen.getByTestId('local-host-port') as HTMLInputElement).value).toBe('9000');
  });

  it('端口与现有频道重复时提交前给出 inline 错误并推荐可用端口', async () => {
    const api = createMockApi({
      host: { list: vi.fn().mockResolvedValue(ok([makeHostStatus({ configuredPort: 8787 })])) },
    });
    renderWizard(api);
    const user = userEvent.setup();

    await openLocalHostStep(user);
    await user.type(screen.getByTestId('local-host-root-dir'), 'D:/AppHub/repo');
    const portInput = screen.getByTestId('local-host-port');
    await waitFor(() => expect((portInput as HTMLInputElement).value).toBe('8788'));
    await user.clear(portInput);
    await user.type(portInput, '8787');
    await user.click(screen.getByTestId('create-channel-next'));

    expect(
      await screen.findByText('端口 8787 已被现有 local-host 频道使用，推荐 8788'),
    ).toBeInTheDocument();
    expect(screen.queryByText('请确认频道配置')).not.toBeInTheDocument();
    expect(api.channels.create).not.toHaveBeenCalled();
  });

  it('host.list 失败时静默忽略，仍使用默认端口', async () => {
    const api = createMockApi({
      host: { list: vi.fn().mockResolvedValue(fail('INTERNAL', 'host 服务不可用')) },
    });
    renderWizard(api);
    const user = userEvent.setup();

    await openLocalHostStep(user);

    expect((screen.getByTestId('local-host-port') as HTMLInputElement).value).toBe('8787');
    expect(screen.getByTestId('local-host-root-dir')).toBeInTheDocument();
  });
});
