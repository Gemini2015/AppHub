import { describe, expect, it, vi } from 'vitest';
import { SettingsView } from './SettingsView';
import { NEW_DATA_DIR, PICKED_DIR, createMockApi, fail, makeSystemInfo, ok } from '../../test/mock-api';
import { renderWithApi, screen, userEvent, waitFor } from '../../test/render';
import type { SystemInfoDTO } from '../types';

function renderSettings(api: ReturnType<typeof createMockApi>) {
  renderWithApi(<SettingsView dataVersion={0} />, api);
}

function infoApi(overrides: Partial<SystemInfoDTO>) {
  return createMockApi({
    system: { info: vi.fn().mockResolvedValue(ok(makeSystemInfo(overrides))) },
  });
}

describe('设置 / 关于', () => {
  it('展示版本信息、数据目录与去中心化说明', async () => {
    const api = createMockApi();
    renderSettings(api);

    expect(await screen.findByText('关于 AppHub')).toBeInTheDocument();
    expect(await screen.findByText('0.1.0')).toBeInTheDocument();
    expect(screen.getByText('38.8.6')).toBeInTheDocument();
    expect(screen.getByText('22.20.0')).toBeInTheDocument();
    expect(
      screen.getAllByText('C:/Users/test/AppData/Roaming/AppHub/AppHubData').length,
    ).toBeGreaterThan(0);
    expect(screen.getByTestId('data-dir-source')).toHaveTextContent('默认目录');
    expect(screen.getByTestId('data-dir-default-hint')).toHaveTextContent(
      'C:/Users/test/AppData/Roaming/AppHub/AppHubData',
    );
    expect(screen.getByText('去中心化说明')).toBeInTheDocument();
    expect(screen.getByText(/没有中心服务器/)).toBeInTheDocument();
    expect(screen.getByText(/发布权限 = 持有/)).toBeInTheDocument();
  });

  it('默认目录文案说明 AppHubData 独立子目录且与 Electron 缓存分离', async () => {
    const api = createMockApi();
    renderSettings(api);

    await screen.findByText('关于 AppHub');
    const hint = screen.getByTestId('data-dir-default-hint');
    expect(hint).toHaveTextContent('默认数据目录');
    expect(hint).toHaveTextContent('独立子目录');
    expect(hint).toHaveTextContent('AppHubData');
    expect(hint).toHaveTextContent('与 Electron/Chromium 的缓存与配置文件分离');
    expect(hint).toHaveTextContent('修改 AppHub 数据目录不会改变 Electron 自身的缓存/配置路径');
  });

  it('点击打开数据目录调用 system.openDataDir', async () => {
    const api = createMockApi();
    const user = userEvent.setup();
    renderSettings(api);

    await screen.findByText('关于 AppHub');
    await user.click(screen.getByRole('button', { name: /打开数据目录/ }));

    await waitFor(() => expect(api.system.openDataDir).toHaveBeenCalled());
    expect(await screen.findByText(/已在文件管理器中打开数据目录/)).toBeInTheDocument();
  });

  it('env 模式下禁用更改数据目录并说明两个环境变量语义', async () => {
    const api = infoApi({
      dataDirSource: 'env',
      dataDirEditable: false,
      dataDir: 'E:/fixed-apphub-data',
      defaultDataDir: 'C:/Users/test/AppData/Roaming/AppHub/AppHubData',
    });
    renderSettings(api);

    await screen.findByText('关于 AppHub');
    expect(screen.getByTestId('data-dir-source')).toHaveTextContent('环境变量固定');
    expect(screen.getByTestId('change-data-dir-button')).toBeDisabled();

    const envHint = screen.getByTestId('data-dir-env-hint');
    expect(envHint).toHaveTextContent(/APPHUB_DATA_DIR/);
    expect(envHint).toHaveTextContent(/只修改 AppHub 数据目录/);
    expect(envHint).toHaveTextContent(/不影响 Electron 自身的缓存\/配置路径/);
    expect(envHint).toHaveTextContent(/APPHUB_USER_DATA_DIR/);
    expect(envHint).toHaveTextContent(/整体覆盖 Electron 的 userData 目录/);
    expect(envHint).toHaveTextContent(/测试\/多实例/);
    expect(envHint).toHaveTextContent(/移除环境变量并重启 App/);
  });

  it('自定义目录来源展示当前目录与默认目录提示', async () => {
    const api = infoApi({
      dataDirSource: 'custom',
      dataDir: 'D:/custom/AppHubData',
      defaultDataDir: 'C:/Users/test/AppData/Roaming/AppHub/AppHubData',
    });
    renderSettings(api);

    await screen.findByText('关于 AppHub');
    expect(screen.getByTestId('data-dir-source')).toHaveTextContent('自定义目录');
    expect(screen.getByText('D:/custom/AppHubData')).toBeInTheDocument();
    expect(screen.getByTestId('data-dir-default-hint')).toHaveTextContent(
      'C:/Users/test/AppData/Roaming/AppHub/AppHubData',
    );
    expect(screen.getByTestId('change-data-dir-button')).toBeEnabled();
  });

  it('选择目录后取消确认：不调用 changeDataDir', async () => {
    const api = createMockApi({
      system: { pickDirectory: vi.fn().mockResolvedValue(ok(null)) },
    });
    const user = userEvent.setup();
    renderSettings(api);

    await screen.findByText('关于 AppHub');
    await user.click(screen.getByTestId('change-data-dir-button'));

    await waitFor(() => expect(api.system.pickDirectory).toHaveBeenCalled());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(api.system.changeDataDir).not.toHaveBeenCalled();
  });

  it('确认迁移后调用 changeDataDir({path}) 并提示即将重启', async () => {
    const api = createMockApi({
      system: { pickDirectory: vi.fn().mockResolvedValue(ok(NEW_DATA_DIR)) },
    });
    const user = userEvent.setup();
    renderSettings(api);

    await screen.findByText('关于 AppHub');
    await user.click(screen.getByTestId('change-data-dir-button'));

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent(NEW_DATA_DIR);
    expect(dialog).toHaveTextContent(/停止本机 Host|关闭本机 Host/);
    expect(dialog).toHaveTextContent(/旧目录不会自动删除/);
    expect(dialog).toHaveTextContent(/不会改变 Electron 自身的缓存\/配置路径/);

    await user.click(screen.getByTestId('change-data-dir-confirm-ok'));

    await waitFor(() =>
      expect(api.system.changeDataDir).toHaveBeenCalledWith({ path: NEW_DATA_DIR }),
    );
    expect(await screen.findByText(/数据目录已迁移，App 即将重启/)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('迁移失败时展示 CONFLICT 错误并保留确认框', async () => {
    const api = createMockApi({
      system: {
        pickDirectory: vi.fn().mockResolvedValue(ok(PICKED_DIR)),
        changeDataDir: vi.fn().mockResolvedValue(fail('CONFLICT', '目标目录非空，请选择空目录')),
      },
    });
    const user = userEvent.setup();
    renderSettings(api);

    await screen.findByText('关于 AppHub');
    await user.click(screen.getByTestId('change-data-dir-button'));
    await screen.findByRole('dialog');
    await user.click(screen.getByTestId('change-data-dir-confirm-ok'));

    await waitFor(() =>
      expect(api.system.changeDataDir).toHaveBeenCalledWith({ path: PICKED_DIR }),
    );
    expect(await screen.findByTestId('data-dir-change-error')).toHaveTextContent(
      '目标目录非空，请选择空目录',
    );
    expect(screen.getAllByText('CONFLICT').length).toBeGreaterThan(0);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.queryByText(/数据目录已迁移/)).not.toBeInTheDocument();
  });
});
