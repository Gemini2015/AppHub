import { useCallback, useState } from 'react';
import { useApi } from '../api';
import { copyText } from '../clipboard';
import { PlatformBadges, PublishModeBadge, RoleBadge, VisibilityBadge } from '../components/Badges';
import { ApiErrorBanner, InfoBanner } from '../components/Form';
import { HostPanel } from '../components/HostPanel';
import { Icon } from '../components/Icon';
import { ConfirmDialog } from '../components/Modal';
import { EmptyState, ErrorState, LoadingState, PageHeader, Section } from '../components/StateViews';
import { useToast } from '../components/Toast';
import { useAsyncData } from '../hooks/useAsyncData';
import { formatDateTime, platformLabel } from '../format';
import type { AppSummaryDTO, ChannelDetailDTO } from '../types';
import { PublishWizard } from './PublishWizard';

export interface ChannelDetailViewProps {
  channelId: string;
  /** App 全局数据版本：data-changed / 发布等操作后自增，驱动刷新。 */
  dataVersion: number;
  onBack: () => void;
  onOpenApp: (appId: string) => void;
  onChannelsChanged: () => void | Promise<void>;
  onNavigateChannel: (channelId: string) => void;
}

function AppCard({ app, onOpen }: { app: AppSummaryDTO; onOpen: (appId: string) => void }) {
  return (
    <button
      type="button"
      className="card app-card"
      data-testid="app-card"
      data-app-id={app.appId}
      onClick={() => onOpen(app.appId)}
    >
      <span className="app-card-head">
        <span className="app-icon">
          <Icon name="box" size={20} />
        </span>
        <span className="app-card-title">
          <span className="card-title">{app.displayName}</span>
          <span className="app-id mono">{app.appId}</span>
        </span>
        <PublishModeBadge mode={app.publishMode} />
      </span>
      <span className="card-desc">{app.description || '暂无简介'}</span>
      <span className="version-chips">
        {app.platforms.map((platform) => (
          <span className="version-chip" key={platform}>
            <span>{platformLabel(platform)}</span>
            <strong>{app.latest[platform] ?? '—'}</strong>
          </span>
        ))}
      </span>
      <span className="card-meta">
        <span className="meta-item">
          <Icon name="tag" size={14} />
          {app.author || '未知作者'}
        </span>
        <span className="meta-item">
          <Icon name="clock" size={14} />
          {formatDateTime(app.updatedAt)}
        </span>
      </span>
    </button>
  );
}

/** 频道详情：信息头 + 管理员操作 + App 卡片网格 + 发布入口（仅 canPublish）。 */
export function ChannelDetailView({
  channelId,
  dataVersion,
  onBack,
  onOpenApp,
  onChannelsChanged,
  onNavigateChannel,
}: ChannelDetailViewProps) {
  const api = useApi();
  const toast = useToast();
  const state = useAsyncData<ChannelDetailDTO>(
    () => api.channels.get(channelId),
    `${channelId}:${dataVersion}`,
  );
  const [publishOpen, setPublishOpen] = useState(false);
  const [confirmUnsubscribe, setConfirmUnsubscribe] = useState(false);
  const [action, setAction] = useState<'refresh' | 'export' | 'import' | 'unsubscribe' | null>(null);

  const detail = state.data;

  const copySubscribeUrl = useCallback(async () => {
    if (!detail) return;
    let url = detail.summary.subscribeUrl;
    const result = await api.channels.getSubscribeUrl(channelId);
    if (result.ok) url = result.value.url;
    const copied = await copyText(url);
    if (copied) toast.success('订阅链接已复制到剪贴板');
    else toast.error({ code: 'INTERNAL', message: '复制失败，请手动选中链接复制。' });
  }, [api, channelId, detail, toast]);

  const refreshChannel = async () => {
    setAction('refresh');
    try {
      const result = await api.channels.refresh(channelId);
      if (!result.ok) {
        toast.error(result.error, '刷新频道失败');
        return;
      }
      state.setData(result.value);
      toast.success('频道已刷新');
      await onChannelsChanged();
    } finally {
      setAction(null);
    }
  };

  const exportPrivateConfig = async () => {
    setAction('export');
    try {
      const result = await api.channels.exportPrivateConfig(channelId);
      if (!result.ok) {
        toast.error(result.error, '导出 channel_pri.json 失败');
        return;
      }
      if (result.value.canceled) {
        toast.info('已取消导出');
        return;
      }
      toast.success(
        result.value.savedPath
          ? `channel_pri.json 已导出：${result.value.savedPath}`
          : 'channel_pri.json 已导出',
      );
    } finally {
      setAction(null);
    }
  };

  const importPrivateConfig = async () => {
    setAction('import');
    try {
      const result = await api.channels.importPrivateConfig();
      if (!result.ok) {
        toast.error(result.error, '导入 channel_pri.json 失败');
        return;
      }
      if (!result.value) {
        toast.info('已取消导入');
        return;
      }
      const imported = result.value;
      toast.success(`已导入「${imported.summary.name}」的私密配置，现在可以发布 App`);
      await onChannelsChanged();
      if (imported.summary.id !== channelId) onNavigateChannel(imported.summary.id);
      else state.setData(imported);
    } finally {
      setAction(null);
    }
  };

  const unsubscribe = async () => {
    setAction('unsubscribe');
    try {
      const result = await api.channels.unsubscribe(channelId);
      if (!result.ok) {
        toast.error(result.error, '取消订阅失败');
        return;
      }
      toast.success('已取消订阅');
      setConfirmUnsubscribe(false);
      await onChannelsChanged();
      onBack();
    } finally {
      setAction(null);
    }
  };

  if (!detail && state.loading) {
    return <LoadingState label="正在加载频道详情…" />;
  }
  if (!detail && state.error) {
    return <ErrorState error={state.error} title="频道详情加载失败" onRetry={() => void state.reload()} />;
  }
  if (!detail) {
    return <ErrorState error={{ code: 'NOT_FOUND', message: '频道不存在或已被删除。' }} onRetry={onBack} />;
  }

  const summary = detail.summary;
  const canPublish = summary.canPublish;
  const canUnsubscribe = summary.role !== 'owner';
  const busy = action !== null;

  return (
    <div className="page" data-testid="channel-detail">
      <button type="button" className="back-link" onClick={onBack}>
        <Icon name="chevron-left" size={16} />
        返回频道列表
      </button>

      <div className="card detail-hero">
        <div className="detail-hero-head">
          <div className="detail-title">
            <h1>{summary.name}</h1>
            <span className="badge-row">
              <VisibilityBadge visibility={summary.visibility} />
              <RoleBadge role={summary.role} />
              <span className="badge badge-muted">{summary.appCount} 个 App</span>
            </span>
          </div>
          <div className="detail-hero-actions">
            <button type="button" className="btn btn-secondary" onClick={() => void copySubscribeUrl()}>
              <Icon name="copy" size={16} />
              复制订阅链接
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              data-testid="channel-refresh-button"
              onClick={() => void refreshChannel()}
              disabled={busy}
            >
              <Icon name="refresh" size={16} />
              {action === 'refresh' ? '刷新中…' : '刷新'}
            </button>
            {canPublish ? (
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => void exportPrivateConfig()}
                disabled={busy}
              >
                <Icon name="download" size={16} />
                {action === 'export' ? '导出中…' : '导出 channel_pri.json'}
              </button>
            ) : null}
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => void importPrivateConfig()}
              disabled={busy}
            >
              <Icon name="upload" size={16} />
              {action === 'import' ? '导入中…' : '导入 channel_pri.json'}
            </button>
            {canUnsubscribe ? (
              <button
                type="button"
                className="btn btn-ghost btn-danger-text"
                onClick={() => setConfirmUnsubscribe(true)}
                disabled={busy}
              >
                <Icon name="x-circle" size={16} />
                取消订阅
              </button>
            ) : null}
            {canPublish ? (
              <button
                type="button"
                className="btn btn-primary"
                data-testid="publish-open-button"
                onClick={() => setPublishOpen(true)}
                disabled={busy}
              >
                <Icon name="publish" size={16} />
                发布 App
              </button>
            ) : null}
          </div>
        </div>

        <p className="detail-desc">{summary.description || '这个频道还没有填写描述。'}</p>

        <dl className="detail-meta">
          <div>
            <dt>频道 ID</dt>
            <dd className="mono">{summary.id}</dd>
          </div>
          <div>
            <dt>所有者</dt>
            <dd>
              {detail.channel.owner.name || '未填写'}
              {detail.channel.owner.contact ? ` · ${detail.channel.owner.contact}` : ''}
            </dd>
          </div>
          <div>
            <dt>创建时间</dt>
            <dd>{formatDateTime(summary.createdAt)}</dd>
          </div>
          <div>
            <dt>最后同步</dt>
            <dd>{formatDateTime(summary.lastFetchedAt ?? summary.updatedAt)}</dd>
          </div>
        </dl>

        <div className="subscribe-link">
          <Icon name="link" size={15} />
          <code title={summary.subscribeUrl}>{summary.subscribeUrl}</code>
        </div>

        {!canPublish ? (
          <InfoBanner tone="info" title="你当前是订阅者">
            可以浏览、安装频道里的 App。如果需要发布 App，请向频道所有者索取{' '}
            <code>channel_pri.json</code> 并点击「导入 channel_pri.json」。
          </InfoBanner>
        ) : null}

        {state.error ? <ApiErrorBanner error={state.error} title="刷新频道信息失败" /> : null}
      </div>

      {/* 本机 Host 面板：订阅者看不到（local-host 频道的托管/管理只有 owner/admin 可用）。 */}
      {summary.role !== 'subscriber' ? (
        <HostPanel
          channelId={channelId}
          dataVersion={dataVersion}
          onChanged={onChannelsChanged}
        />
      ) : null}

      <Section
        title="App 列表"
        count={detail.apps.length}
        actions={
          canPublish ? (
            <button type="button" className="btn btn-primary btn-sm" onClick={() => setPublishOpen(true)}>
              <Icon name="publish" size={14} />
              发布 App
            </button>
          ) : undefined
        }
      >
        {detail.apps.length === 0 ? (
          <EmptyState
            icon="box"
            title="这个频道还没有 App"
            description={
              canPublish
                ? '点击「发布 App」，选择文件或 zip 压缩包，填写版本号后即可发布第一个 App。'
                : '频道所有者还没有发布 App，稍后刷新看看。'
            }
          >
            {canPublish ? (
              <button type="button" className="btn btn-primary" onClick={() => setPublishOpen(true)}>
                <Icon name="publish" size={16} />
                发布第一个 App
              </button>
            ) : null}
            <button type="button" className="btn btn-secondary" onClick={() => void refreshChannel()} disabled={busy}>
              <Icon name="refresh" size={16} />
              刷新
            </button>
          </EmptyState>
        ) : (
          <div className="grid app-grid">
            {detail.apps.map((app) => (
              <AppCard key={app.appId} app={app} onOpen={onOpenApp} />
            ))}
          </div>
        )}
      </Section>

      {confirmUnsubscribe ? (
        <ConfirmDialog
          title="取消订阅"
          message={
            <>
              确定要取消订阅「{summary.name}」吗？这只会删除本地订阅记录，<strong>不会影响远端频道内容</strong>
              ，已安装到本地库的 App 也会保留。
            </>
          }
          confirmLabel="取消订阅"
          danger
          busy={action === 'unsubscribe'}
          onCancel={() => setConfirmUnsubscribe(false)}
          onConfirm={() => void unsubscribe()}
        />
      ) : null}

      {publishOpen ? (
        <PublishWizard
          channelId={channelId}
          channelName={summary.name}
          app={null}
          onClose={() => setPublishOpen(false)}
          onPublished={() => {
            void state.reload();
            void onChannelsChanged();
          }}
        />
      ) : null}
    </div>
  );
}
