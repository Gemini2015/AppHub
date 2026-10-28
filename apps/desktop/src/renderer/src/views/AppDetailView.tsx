import { useState } from 'react';
import { useApi } from '../api';
import { InstallStatusBadge, PlatformBadges, PublishModeBadge, Badge } from '../components/Badges';
import { ApiErrorBanner, InfoBanner } from '../components/Form';
import { Icon } from '../components/Icon';
import { ConfirmDialog } from '../components/Modal';
import { ErrorState, LoadingState } from '../components/StateViews';
import { useToast } from '../components/Toast';
import { useAsyncData } from '../hooks/useAsyncData';
import {
  formatBytes,
  formatDateTime,
  installStatusLabel,
  isNewerVersion,
  platformLabel,
} from '../format';
import type {
  AppDetailDTO,
  ChannelDetailDTO,
  InstalledAppDTO,
  PublishResultDTO,
  VerifyResultDTO,
} from '../types';
import { PublishWizard } from './PublishWizard';

export interface AppDetailViewProps {
  channelId: string;
  appId: string;
  dataVersion: number;
  onBack: () => void;
  onLibraryChanged: () => void | Promise<void>;
}

type ActionKey = 'install' | 'update' | 'verify' | 'launch' | 'reveal' | 'uninstall';

const MISMATCH_REASON_LABEL: Record<VerifyResultDTO['mismatches'][number]['reason'], string> = {
  md5: 'MD5 不一致',
  size: '大小不一致',
  missing: '文件缺失',
  extra: '多余文件',
};

/** App 详情：信息、各平台 latest、安装状态与操作、版本历史、发布新版本入口。 */
export function AppDetailView({ channelId, appId, dataVersion, onBack, onLibraryChanged }: AppDetailViewProps) {
  const api = useApi();
  const toast = useToast();

  const versionKey = `${channelId}:${appId}:${dataVersion}`;
  const detailState = useAsyncData<AppDetailDTO>(() => api.apps.get(channelId, appId), versionKey);
  const channelState = useAsyncData<ChannelDetailDTO>(() => api.channels.get(channelId), versionKey);
  const libraryState = useAsyncData<InstalledAppDTO[]>(() => api.library.list(), versionKey);

  const [action, setAction] = useState<ActionKey | null>(null);
  const [verifyResult, setVerifyResult] = useState<VerifyResultDTO | null>(null);
  const [confirmUninstall, setConfirmUninstall] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);

  const detail = detailState.data;
  const installed =
    libraryState.data?.find((item) => item.channelId === channelId && item.appId === appId) ?? null;
  const canPublish = channelState.data?.summary.canPublish ?? false;
  const latestForInstalled = installed
    ? detail?.meta.latest[installed.platform]
    : undefined;
  const updateAvailable =
    installed !== null &&
    (installed.status === 'outdated' ||
      isNewerVersion(latestForInstalled, installed.version) ||
      isNewerVersion(installed.availableVersion, installed.version));

  const refreshLibrary = async () => {
    await libraryState.reload();
  };

  const runInstall = async (kind: 'install' | 'update') => {
    setAction(kind);
    try {
      const result =
        kind === 'install'
          ? await api.library.install({ channelId, appId })
          : await api.library.update({ channelId, appId });
      if (!result.ok) {
        toast.error(result.error, kind === 'install' ? '安装失败' : '更新失败');
        return;
      }
      const { app } = result.value;
      toast.success(
        `${kind === 'install' ? '已安装' : '已更新'} ${app.displayName} v${app.version}` +
          (result.value.reusedBytes > 0
            ? `（复用 ${formatBytes(result.value.reusedBytes)}，下载 ${formatBytes(result.value.downloadedBytes)}）`
            : ''),
      );
      await refreshLibrary();
      await onLibraryChanged();
    } finally {
      setAction(null);
    }
  };

  const verify = async () => {
    setAction('verify');
    try {
      const result = await api.library.verify({ channelId, appId });
      if (!result.ok) {
        toast.error(result.error, '校验失败');
        return;
      }
      setVerifyResult(result.value);
      if (result.value.ok) toast.success(`校验通过（检查了 ${result.value.checkedFiles} 个文件）`);
      else toast.error({ code: 'STATE', message: `发现 ${result.value.mismatches.length} 处文件差异` }, '校验未通过');
      await refreshLibrary();
    } finally {
      setAction(null);
    }
  };

  const launch = async () => {
    setAction('launch');
    try {
      const result = await api.library.launch({ channelId, appId });
      if (!result.ok) {
        toast.error(result.error, '启动失败');
        return;
      }
      toast.success(result.value.pid ? `已启动（PID ${result.value.pid}）` : '已启动');
    } finally {
      setAction(null);
    }
  };

  const reveal = async () => {
    setAction('reveal');
    try {
      const result = await api.library.reveal({ channelId, appId });
      if (!result.ok) {
        toast.error(result.error, '打开目录失败');
        return;
      }
      toast.success('已在文件管理器中打开安装目录');
    } finally {
      setAction(null);
    }
  };

  const uninstall = async () => {
    setAction('uninstall');
    try {
      const result = await api.library.uninstall({ channelId, appId });
      if (!result.ok) {
        toast.error(result.error, '卸载失败');
        return;
      }
      setConfirmUninstall(false);
      setVerifyResult(null);
      toast.success('已卸载');
      await refreshLibrary();
      await onLibraryChanged();
    } finally {
      setAction(null);
    }
  };

  if (!detail && detailState.loading) return <LoadingState label="正在加载 App 详情…" />;
  if (!detail && detailState.error) {
    return <ErrorState error={detailState.error} title="App 详情加载失败" onRetry={() => void detailState.reload()} />;
  }
  if (!detail) {
    return <ErrorState error={{ code: 'NOT_FOUND', message: 'App 不存在或已被移除。' }} onRetry={onBack} />;
  }

  const { meta, app, versions } = detail;
  const busy = action !== null;

  return (
    <div className="page" data-testid="app-detail">
      <button type="button" className="back-link" onClick={onBack}>
        <Icon name="chevron-left" size={16} />
        返回频道详情
      </button>

      <div className="card detail-hero">
        <div className="detail-hero-head">
          <div className="detail-title app-detail-title">
            <span className="app-icon app-icon-lg">
              <Icon name="box" size={26} />
            </span>
            <div>
              <h1>{app.displayName}</h1>
              <span className="badge-row">
                <span className="mono muted">{app.appId}</span>
                <PublishModeBadge mode={meta.publishMode} />
                <PlatformBadges platforms={meta.platforms} />
                {installed ? <InstallStatusBadge status={installed.status} /> : null}
              </span>
            </div>
          </div>
          <div className="detail-hero-actions">
            <span className="install-status" data-testid="install-status">
              {installed ? `已安装 v${installed.version}` : '未安装'}
              {updateAvailable && latestForInstalled ? ` · 可更新 v${latestForInstalled}` : ''}
            </span>
            {!installed ? (
              <button
                type="button"
                className="btn btn-primary"
                data-testid="install-button"
                onClick={() => void runInstall('install')}
                disabled={busy}
              >
                <Icon name="download" size={16} />
                {action === 'install' ? '安装中…' : '安装'}
              </button>
            ) : (
              <>
                {updateAvailable ? (
                  <button
                    type="button"
                    className="btn btn-primary"
                    data-testid="update-button"
                    onClick={() => void runInstall('update')}
                    disabled={busy}
                  >
                    <Icon name="download" size={16} />
                    {action === 'update' ? '更新中…' : '更新'}
                  </button>
                ) : null}
                <button
                  type="button"
                  className="btn btn-secondary"
                  data-testid="verify-button"
                  onClick={() => void verify()}
                  disabled={busy}
                >
                  <Icon name="shield" size={16} />
                  {action === 'verify' ? '校验中…' : '校验'}
                </button>
                <button type="button" className="btn btn-secondary" onClick={() => void launch()} disabled={busy}>
                  <Icon name="play" size={16} />
                  {action === 'launch' ? '启动中…' : '启动'}
                </button>
                <button type="button" className="btn btn-secondary" onClick={() => void reveal()} disabled={busy}>
                  <Icon name="folder" size={16} />
                  打开目录
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-danger-text"
                  data-testid="uninstall-button"
                  onClick={() => setConfirmUninstall(true)}
                  disabled={busy}
                >
                  <Icon name="trash" size={16} />
                  卸载
                </button>
              </>
            )}
            {canPublish ? (
              <button
                type="button"
                className="btn btn-secondary"
                data-testid="publish-new-version-button"
                onClick={() => setPublishOpen(true)}
                disabled={busy}
              >
                <Icon name="publish" size={16} />
                发布新版本
              </button>
            ) : null}
          </div>
        </div>

        <p className="detail-desc">{meta.description || '这个 App 还没有填写简介。'}</p>

        <dl className="detail-meta">
          <div>
            <dt>作者</dt>
            <dd>{meta.author || '未填写'}</dd>
          </div>
          <div>
            <dt>主页</dt>
            <dd className="mono break-all">{meta.homepage || '—'}</dd>
          </div>
          <div>
            <dt>启动入口</dt>
            <dd className="mono">{meta.entry}</dd>
          </div>
          <div>
            <dt>最近更新</dt>
            <dd>{formatDateTime(meta.updatedAt)}</dd>
          </div>
        </dl>

        <div className="platform-latest">
          <h3>各平台最新版本</h3>
          <div className="platform-latest-grid">
            {meta.platforms.map((platform) => {
              const latest = meta.latest[platform];
              const entry =
                versions.find((item) => item.version === latest && item.platform === platform)?.entry ?? meta.entry;
              return (
                <div className="platform-card" key={platform}>
                  <span className="platform-name">{platformLabel(platform)}</span>
                  <span className="platform-version mono">{latest ?? '—'}</span>
                  <span className="muted mono platform-entry" title={entry}>
                    {entry}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {installed ? (
          <InfoBanner tone="info" title="本地安装信息">
            已安装 v{installed.version}（{platformLabel(installed.platform)}），状态：
            {installStatusLabel(installed.status)}；{installed.fileCount} 个文件 ·{' '}
            {formatBytes(installed.totalSize)}；安装于 {formatDateTime(installed.installedAt)}。
            {installed.availableVersion
              ? ` 远端最新版本 v${installed.availableVersion}。`
              : ''}
          </InfoBanner>
        ) : null}

        {detailState.error ? <ApiErrorBanner error={detailState.error} title="刷新 App 信息失败" /> : null}
        {libraryState.error ? <ApiErrorBanner error={libraryState.error} title="读取本地安装状态失败" /> : null}

        {verifyResult ? (
          <div
            className={verifyResult.ok ? 'banner banner-success' : 'banner banner-warn'}
            role="status"
            data-testid="verify-result"
          >
            <Icon name={verifyResult.ok ? 'check-circle' : 'alert'} size={18} />
            <div className="banner-body">
              <strong>{verifyResult.ok ? '校验通过' : '发现文件差异'}</strong>
              <div className="banner-text">检查了 {verifyResult.checkedFiles} 个文件。</div>
              {verifyResult.mismatches.length > 0 ? (
                <ul className="mismatch-list">
                  {verifyResult.mismatches.map((mismatch) => (
                    <li key={`${mismatch.path}-${mismatch.reason}`}>
                      <code>{mismatch.path}</code>
                      <span className="badge badge-warn">{MISMATCH_REASON_LABEL[mismatch.reason]}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>

      <section className="section">
        <div className="section-head">
          <h2 className="section-title">
            版本历史
            <span className="count">{versions.length}</span>
          </h2>
          <span className="muted">
            {meta.publishMode === 'zip' ? '压缩包发布' : '散文件发布'} · 版本目录全局唯一
          </span>
        </div>
        {versions.length === 0 ? (
          <p className="muted">暂无版本记录。</p>
        ) : (
          <ul className="version-list">
            {versions.map((item) => (
              <li className="version-item card" key={`${item.version}-${item.platform}`}>
                <div className="version-head">
                  <span className="version-tag mono">v{item.version}</span>
                  <Badge tone="muted">{platformLabel(item.platform)}</Badge>
                  <PublishModeBadge mode={item.publishMode} />
                  {meta.latest[item.platform] === item.version ? (
                    <Badge tone="success">latest</Badge>
                  ) : null}
                  <span className="muted version-date">{formatDateTime(item.publishedAt)}</span>
                </div>
                {item.changelog ? <p className="version-changelog">{item.changelog}</p> : null}
                <div className="version-meta">
                  <span>
                    <Icon name="file" size={13} /> {item.fileCount} 个文件
                  </span>
                  <span>
                    <Icon name="database" size={13} /> {formatBytes(item.totalSize)}
                  </span>
                  <span>
                    <Icon name="play" size={13} /> 入口 <code>{item.entry}</code>
                  </span>
                  {item.archive ? <span>zip {formatBytes(item.archive.size)}</span> : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {confirmUninstall ? (
        <ConfirmDialog
          title="卸载 App"
          message={
            <>
              确定要从本地库卸载「{app.displayName}」吗？本地文件会被删除（远端频道内容不受影响）。
            </>
          }
          confirmLabel="卸载"
          danger
          busy={action === 'uninstall'}
          confirmTestId="uninstall-confirm-ok"
          onCancel={() => setConfirmUninstall(false)}
          onConfirm={() => void uninstall()}
        />
      ) : null}

      {publishOpen ? (
        <PublishWizard
          channelId={channelId}
          channelName={channelState.data?.summary.name}
          app={detail}
          onClose={() => setPublishOpen(false)}
          onPublished={(_result: PublishResultDTO) => {
            void detailState.reload();
            void libraryState.reload();
          }}
        />
      ) : null}
    </div>
  );
}
