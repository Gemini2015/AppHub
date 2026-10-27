import { Badge, RoleBadge, VisibilityBadge } from '../components/Badges';
import { Icon } from '../components/Icon';
import { EmptyState, ErrorState, LoadingState, PageHeader, Section } from '../components/StateViews';
import { formatDateTime, hostStatusLabel } from '../format';
import type { ApiError, ChannelSummaryDTO, HostStatusDTO } from '../types';

export interface ChannelsViewProps {
  channels: ChannelSummaryDTO[];
  loading: boolean;
  error: ApiError | null;
  refreshing?: boolean;
  /** channelId -> 本机 Host 状态（来自 api.host.list()）。 */
  hostStatuses?: Record<string, HostStatusDTO>;
  onRetry: () => void;
  onRefresh: () => void;
  onCreate: () => void;
  onSubscribe: () => void;
  onOpenChannel: (channelId: string) => void;
}

function ChannelCard({
  channel,
  host,
  onOpen,
}: {
  channel: ChannelSummaryDTO;
  host?: HostStatusDTO;
  onOpen: (channelId: string) => void;
}) {
  return (
    <button
      type="button"
      className="card channel-card"
      data-testid="channel-card"
      data-channel-id={channel.id}
      onClick={() => onOpen(channel.id)}
    >
      <span className="card-head">
        <span className="card-title">{channel.name}</span>
        <span className="badge-row">
          <VisibilityBadge visibility={channel.visibility} />
          <RoleBadge role={channel.role} />
          {host ? (
            <Badge
              tone={host.running ? 'success' : 'muted'}
              icon={host.running ? 'server' : 'x-circle'}
              testId="channel-host-badge"
            >
              {hostStatusLabel(host.running)}
            </Badge>
          ) : null}
        </span>
      </span>
      <span className="card-desc">{channel.description || '暂无频道描述'}</span>
      <span className="card-meta">
        <span className="meta-item">
          <Icon name="box" size={14} />
          {channel.appCount} 个 App
        </span>
        <span className="meta-item">
          <Icon name="clock" size={14} />
          更新于 {formatDateTime(channel.updatedAt)}
        </span>
      </span>
      <span className="card-foot">
        <span className="card-url" title={channel.subscribeUrl}>
          {channel.subscribeUrl}
        </span>
        <span className="card-arrow">
          <Icon name="arrow-right" size={16} />
        </span>
      </span>
    </button>
  );
}

/** 频道页：我拥有的 / 我订阅的 分组 + 空态引导 + 创建/订阅入口。 */
export function ChannelsView({
  channels,
  loading,
  error,
  refreshing = false,
  hostStatuses = {},
  onRetry,
  onRefresh,
  onCreate,
  onSubscribe,
  onOpenChannel,
}: ChannelsViewProps) {
  const owned = channels.filter((channel) => channel.source === 'owned');
  const subscribed = channels.filter((channel) => channel.source !== 'owned');

  return (
    <div className="page">
      <PageHeader
        eyebrow="AppHub"
        title="频道"
        description="频道是 App 的分享单元：所有者用自己的存储承载文件，订阅者通过 channel.json 链接发现并安装 App。"
        actions={
          <>
            <button
              type="button"
              className="btn btn-secondary"
              data-testid="subscribe-channel-button"
              onClick={onSubscribe}
            >
              <Icon name="link" size={16} />
              订阅频道
            </button>
            <button
              type="button"
              className="btn btn-primary"
              data-testid="create-channel-button"
              onClick={onCreate}
            >
              <Icon name="plus" size={16} />
              创建频道
            </button>
          </>
        }
      />

      {loading && channels.length === 0 ? <LoadingState label="正在加载频道…" /> : null}

      {!loading && error && channels.length === 0 ? (
        <ErrorState error={error} title="频道列表加载失败" onRetry={onRetry} />
      ) : null}

      {!loading && !error && channels.length === 0 ? (
        <EmptyState
          icon="channels"
          title="还没有任何频道"
          description="创建一个自己的频道，把存储作为 App 仓库；或者通过别人的 channel.json 链接订阅公开/私密频道。"
        >
          <button type="button" className="btn btn-primary" onClick={onCreate}>
            <Icon name="plus" size={16} />
            创建我的第一个频道
          </button>
          <button type="button" className="btn btn-secondary" onClick={onSubscribe}>
            <Icon name="link" size={16} />
            通过链接订阅
          </button>
        </EmptyState>
      ) : null}

      {channels.length > 0 ? (
        <>
          {error ? (
            <div className="inline-error-row">
              <span>
                <Icon name="alert" size={16} />
                刷新失败：{error.message}（{error.code}）
              </span>
              <button type="button" className="btn btn-ghost btn-sm" onClick={onRefresh} disabled={refreshing}>
                {refreshing ? '刷新中…' : '重试'}
              </button>
            </div>
          ) : null}

          {owned.length > 0 ? (
            <Section
              title="我拥有的"
              count={owned.length}
              className="section-channels"
              actions={
                <button type="button" className="btn btn-ghost btn-sm" onClick={onRefresh} disabled={refreshing}>
                  <Icon name="refresh" size={14} />
                  {refreshing ? '刷新中…' : '刷新'}
                </button>
              }
            >
              <div className="grid channel-grid">
                {owned.map((channel) => (
                  <ChannelCard
                    key={channel.id}
                    channel={channel}
                    host={hostStatuses[channel.id]}
                    onOpen={onOpenChannel}
                  />
                ))}
              </div>
            </Section>
          ) : null}

          {subscribed.length > 0 ? (
            <Section title="我订阅的" count={subscribed.length} className="section-channels">
              <div className="grid channel-grid">
                {subscribed.map((channel) => (
                  <ChannelCard
                    key={channel.id}
                    channel={channel}
                    host={hostStatuses[channel.id]}
                    onOpen={onOpenChannel}
                  />
                ))}
              </div>
            </Section>
          ) : null}

          {owned.length === 0 && subscribed.length > 0 ? (
            <p className="page-footnote">
              <Badge tone="info" icon="info">
                提示
              </Badge>
              你也可以创建自己的频道，把自己的存储变成 App 仓库。
            </p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
