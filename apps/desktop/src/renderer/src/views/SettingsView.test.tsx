import { describe, expect, it, vi } from 'vitest';
import { SettingsView } from './SettingsView';
import { createMockApi } from '../../test/mock-api';
import { renderWithApi, screen, userEvent, waitFor } from '../../test/render';

describe('设置 / 关于', () => {
  it('展示版本信息、数据目录与去中心化说明', async () => {
    const api = createMockApi();
    renderWithApi(<SettingsView dataVersion={0} />, api);

    expect(await screen.findByText('关于 AppHub')).toBeInTheDocument();
    expect(await screen.findByText('0.1.0')).toBeInTheDocument();
    expect(screen.getByText('38.8.6')).toBeInTheDocument();
    expect(screen.getByText('22.20.0')).toBeInTheDocument();
    expect(screen.getByText('C:/Users/test/AppData/Roaming/AppHub')).toBeInTheDocument();
    expect(screen.getByText('去中心化说明')).toBeInTheDocument();
    expect(screen.getByText(/没有中心服务器/)).toBeInTheDocument();
    expect(screen.getByText(/发布权限 = 持有/)).toBeInTheDocument();
  });

  it('点击打开数据目录调用 system.openDataDir', async () => {
    const api = createMockApi();
    const user = userEvent.setup();
    renderWithApi(<SettingsView dataVersion={0} />, api);

    await screen.findByText('关于 AppHub');
    await user.click(screen.getByRole('button', { name: /打开数据目录/ }));

    await waitFor(() => expect(api.system.openDataDir).toHaveBeenCalled());
    expect(await screen.findByText(/已在文件管理器中打开数据目录/)).toBeInTheDocument();
  });
});
