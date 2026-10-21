import { describe, expect, it, vi } from 'vitest';
import { CreateChannelWizard } from './CreateChannelWizard';
import { createMockApi, makeChannelDetail, ok } from '../../test/mock-api';
import { renderWithApi, screen, userEvent, waitFor } from '../../test/render';

describe('创建频道向导', () => {
  it('名称为空时点击下一步被拦截，且不进入存储配置步骤', async () => {
    const api = createMockApi();
    const onCreated = vi.fn();
    renderWithApi(<CreateChannelWizard onClose={vi.fn()} onCreated={onCreated} />, api);
    const user = userEvent.setup();

    await user.click(screen.getByTestId('create-channel-next'));

    expect(await screen.findByText('请输入频道名称')).toBeInTheDocument();
    expect(screen.queryByTestId('storage-provider-select')).not.toBeInTheDocument();
    expect(api.channels.create).not.toHaveBeenCalled();

    await user.type(screen.getByTestId('create-channel-name'), '测试频道');
    await waitFor(() => expect(screen.queryByText('请输入频道名称')).not.toBeInTheDocument());
  });

  it('切换存储 provider 时渲染对应字段，并解释私密频道能力链接', async () => {
    const api = createMockApi();
    renderWithApi(<CreateChannelWizard onClose={vi.fn()} onCreated={vi.fn()} />, api);
    const user = userEvent.setup();

    await user.type(screen.getByTestId('create-channel-name'), '测试频道');
    await user.click(screen.getByTestId('create-channel-next'));

    // 默认 ftp-http
    expect(await screen.findByTestId('storage-provider-select')).toBeInTheDocument();
    expect(screen.getByLabelText(/FTP 主机/)).toBeInTheDocument();

    await user.selectOptions(screen.getByTestId('storage-provider-select'), 'local');
    expect(screen.getByLabelText(/本地根目录/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/FTP 主机/)).not.toBeInTheDocument();

    await user.selectOptions(screen.getByTestId('storage-provider-select'), 's3');
    expect(screen.getByLabelText(/Bucket/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Access Key/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/本地根目录/)).not.toBeInTheDocument();
  });

  it('选择私密可见性时展示能力链接说明', async () => {
    const api = createMockApi();
    renderWithApi(<CreateChannelWizard onClose={vi.fn()} onCreated={vi.fn()} />, api);
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: /私密/ }));

    expect(screen.getAllByText(/能力链接/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/channel_pri\.json/).length).toBeGreaterThan(0);
  });

  it('填写 local 存储配置后创建频道，提交正确入参并回调 onCreated', async () => {
    const created = makeChannelDetail();
    const api = createMockApi({
      channels: { create: vi.fn().mockResolvedValue(ok(created)) },
    });
    const onCreated = vi.fn();
    renderWithApi(<CreateChannelWizard onClose={vi.fn()} onCreated={onCreated} />, api);
    const user = userEvent.setup();

    await user.type(screen.getByTestId('create-channel-name'), '我的工具频道');
    await user.click(screen.getByTestId('create-channel-next'));
    await user.selectOptions(screen.getByTestId('storage-provider-select'), 'local');
    await user.type(screen.getByLabelText(/本地根目录/), 'D:/www/app_repo');
    await user.type(screen.getByLabelText(/公开 HTTP 地址/), 'http://127.0.0.1:8080/app_repo/');
    await user.click(screen.getByTestId('create-channel-next'));

    expect(await screen.findByText('请确认频道配置')).toBeInTheDocument();
    await user.click(screen.getByTestId('create-channel-submit'));

    await waitFor(() => expect(api.channels.create).toHaveBeenCalledTimes(1));
    expect(api.channels.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: '我的工具频道',
        visibility: 'public',
        storage: expect.objectContaining({
          provider: 'local',
          rootDir: 'D:/www/app_repo',
          publicBaseUrl: 'http://127.0.0.1:8080/app_repo/',
        }),
      }),
    );
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(created));
  });

  it('provider 字段缺失时给出校验错误且不调用 IPC', async () => {
    const api = createMockApi();
    renderWithApi(<CreateChannelWizard onClose={vi.fn()} onCreated={vi.fn()} />, api);
    const user = userEvent.setup();

    await user.type(screen.getByTestId('create-channel-name'), '频道');
    await user.click(screen.getByTestId('create-channel-next'));
    await user.selectOptions(screen.getByTestId('storage-provider-select'), 'local');
    await user.click(screen.getByTestId('create-channel-next'));

    expect(await screen.findByText('请输入本地存储根目录')).toBeInTheDocument();
    expect(screen.queryByText('请确认频道配置')).not.toBeInTheDocument();
    expect(api.channels.create).not.toHaveBeenCalled();
  });
});
