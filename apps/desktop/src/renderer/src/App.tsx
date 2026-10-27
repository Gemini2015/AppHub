import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { getRuntimeApi, useApi } from './api';
import { ApiProvider } from './components/ApiProvider';
import { Icon } from './components/Icon';
import { ProgressProvider } from './components/Progress';
import { Sidebar } from './components/Sidebar';
import { ToastProvider, useToast } from './components/Toast';
import type { Route } from './routes';
import type {
  ApiError,
  AppHubApi,
  ChannelDetailDTO,
  ChannelSummaryDTO,
  HostStatusDTO,
  SystemInfoDTO,
} from './types';
import { AppDetailView } from './views/AppDetailView';
import { ChannelDetailView } from './views/ChannelDetailView';
import { ChannelsView } from './views/ChannelsView';
import { CreateChannelWizard } from './views/CreateChannelWizard';
import { LibraryView } from './views/LibraryView';
import { SettingsView } from './views/SettingsView';
import { SubscribeDialog } from './views/SubscribeDialog';

export interface AppProps {
  /** 注入 API（测试用）；不传则使用 window.apphub。传 null 用于验证「缺少运行时」的降级界面。 */
  api?: AppHubApi | null;
}

function MissingApiNotice() {
  return (
    <div className="app-shell app-shell-missing" data-testid="app-root">
      <div className="card missing-api">
        <span className="missing-api-icon">
          <Icon name="alert" size={32} />
        </span>
        <h1>未检测到 AppHub 运行环境</h1>
        <p>
          渲染进程没有找到 <code>window.apphub</code>。请通过 <code>pnpm dev</code> 或{' '}
          <code>pnpm start</code> 启动 Electron 桌面应用，而不是直接在浏览器中打开此页面。
        </p>
        <p className="muted">
          如果问题仍然存在，请检查 preload 脚本是否加载失败（主进程日志中会有对应错误）。
        </p>
      </div>
    </div>
  );
}

function AppShell() {
  const api = useApi();
  const toast = useToast();

  const [route, setRoute] = useState<Route>({ name: 'channels' });
  const [channels, setChannels] = useState<ChannelSummaryDTO[] | null>(null);
  const [channelsLoading, setChannelsLoading] = useState(true);
  const [channelsRefreshing, setChannelsRefreshing] = useState(false);
  const [channelsError, setChannelsError] = useState<ApiError | null>(null);
  const [hostStatuses, setHostStatuses] = useState<HostStatusDTO[]>([]);
  const [systemInfo, setSystemInfo] = useState<SystemInfoDTO | null>(null);
  const [dataVersion, setDataVersion] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);
  const [subscribeOpen, setSubscribeOpen] = useState(false);

  const loadChannels = useCallback(
    async (mode: 'initial' | 'refresh' = 'initial') => {
      if (mode === 'initial') setChannelsLoading(true);
      else setChannelsRefreshing(true);
      try {
        const result = await api.channels.list();
        if (result.ok) {
          setChannels(result.value);
          setChannelsError(null);
        } else {
          setChannelsError(result.error);
          if (mode === 'initial') toast.error(result.error, '频道列表加载失败');
        }
      } finally {
        setChannelsLoading(false);
        setChannelsRefreshing(false);
      }
    },
    [api, toast],
  );

  const loadSystemInfo = useCallback(async () => {
    const result = await api.system.info();
    if (result.ok) setSystemInfo(result.value);
  }, [api]);

  /** 加载本机 Host 列表（用于频道卡片徽标；非 local-host 频道不会出现在这里）。 */
  const loadHostStatuses = useCallback(async () => {
    const result = await api.host.list();
    if (result.ok) setHostStatuses(result.value);
  }, [api]);

  useEffect(() => {
    void loadChannels();
    void loadSystemInfo();
    void loadHostStatuses();
  }, [loadChannels, loadSystemInfo, loadHostStatuses]);

  // 订阅主进程数据变更事件：刷新相关视图（列表/计数/详情通过 dataVersion 重新拉取）。
  useEffect(() => {
    const unsubscribe = api.events.onDataChanged((event) => {
      setDataVersion((current) => current + 1);
      if (event.domain === 'channels' || event.domain === 'apps') void loadChannels('refresh');
      if (event.domain === 'library') void loadSystemInfo();
      if (event.domain === 'host') void loadHostStatuses();
    });
    return unsubscribe;
  }, [api, loadChannels, loadSystemInfo, loadHostStatuses]);

  const refreshAllData = useCallback(async () => {
    await Promise.all([loadChannels('refresh'), loadSystemInfo(), loadHostStatuses()]);
  }, [loadChannels, loadSystemInfo, loadHostStatuses]);

  const hostStatusMap = useMemo(() => {
    const map: Record<string, HostStatusDTO> = {};
    for (const host of hostStatuses) map[host.channelId] = host;
    return map;
  }, [hostStatuses]);

  const navigate = (next: Route) => {
    setRoute(next);
    setCreateOpen(false);
    setSubscribeOpen(false);
  };

  let content: ReactNode;
  if (route.name === 'channels') {
    content = (
      <ChannelsView
        channels={channels ?? []}
        loading={channelsLoading && channels === null}
        error={channelsError}
        refreshing={channelsRefreshing}
        hostStatuses={hostStatusMap}
        onRetry={() => void loadChannels('initial')}
        onRefresh={() => void loadChannels('refresh')}
        onCreate={() => setCreateOpen(true)}
        onSubscribe={() => setSubscribeOpen(true)}
        onOpenChannel={(channelId) => navigate({ name: 'channel', channelId })}
      />
    );
  } else if (route.name === 'channel') {
    content = (
      <ChannelDetailView
        key={route.channelId}
        channelId={route.channelId}
        dataVersion={dataVersion}
        onBack={() => navigate({ name: 'channels' })}
        onOpenApp={(appId) => navigate({ name: 'app', channelId: route.channelId, appId })}
        onChannelsChanged={refreshAllData}
        onNavigateChannel={(channelId) => navigate({ name: 'channel', channelId })}
      />
    );
  } else if (route.name === 'app') {
    content = (
      <AppDetailView
        key={`${route.channelId}:${route.appId}`}
        channelId={route.channelId}
        appId={route.appId}
        dataVersion={dataVersion}
        onBack={() => navigate({ name: 'channel', channelId: route.channelId })}
        onLibraryChanged={loadSystemInfo}
      />
    );
  } else if (route.name === 'library') {
    content = (
      <LibraryView
        dataVersion={dataVersion}
        onLibraryChanged={loadSystemInfo}
        onGoChannels={() => navigate({ name: 'channels' })}
      />
    );
  } else {
    content = <SettingsView dataVersion={dataVersion} />;
  }

  return (
    <div className="app-shell" data-testid="app-root">
      <Sidebar
        route={route}
        channelCount={channels?.length ?? 0}
        installedCount={systemInfo?.installedCount ?? 0}
        appVersion={systemInfo?.appVersion}
        onNavigate={navigate}
      />
      <main className="app-main">
        <div className="page-wrap">{content}</div>
      </main>

      {createOpen ? (
        <CreateChannelWizard
          onClose={() => setCreateOpen(false)}
          onCreated={(detail: ChannelDetailDTO) => {
            setCreateOpen(false);
            void refreshAllData();
            navigate({ name: 'channel', channelId: detail.summary.id });
          }}
        />
      ) : null}

      {subscribeOpen ? (
        <SubscribeDialog
          onClose={() => setSubscribeOpen(false)}
          onSubscribed={(detail: ChannelDetailDTO) => {
            setSubscribeOpen(false);
            void refreshAllData();
            navigate({ name: 'channel', channelId: detail.summary.id });
          }}
        />
      ) : null}
    </div>
  );
}

/** 应用根组件：解析运行时 API → 注入上下文 → 渲染外壳。 */
export function App({ api }: AppProps = {}) {
  const resolved = api === null ? undefined : (api ?? getRuntimeApi());
  if (!resolved) return <MissingApiNotice />;

  return (
    <ApiProvider api={resolved}>
      <ToastProvider>
        <ProgressProvider>
          <AppShell />
        </ProgressProvider>
      </ToastProvider>
    </ApiProvider>
  );
}
