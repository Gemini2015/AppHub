import { useState } from 'react';
import { useApi } from '../api';
import { InstallStatusBadge } from '../components/Badges';
import { ApiErrorBanner, InfoBanner } from '../components/Form';
import { Icon } from '../components/Icon';
import { ConfirmDialog } from '../components/Modal';
import { EmptyState, ErrorState, LoadingState, PageHeader } from '../components/StateViews';
import { useToast } from '../components/Toast';
import { useAsyncData } from '../hooks/useAsyncData';
import { formatBytes, formatDateTime, platformLabel, publishModeLabel } from '../format';
import type { InstalledAppDTO, UpdateCheckDTO, VerifyResultDTO } from '../types';

export interface LibraryViewProps {
  dataVersion: number;
  onLibraryChanged: () => void | Promise<void>;
  onGoChannels: () => void;
}

type CardAction = 'launch' | 'update' | 'verify' | 'reveal' | 'uninstall';

const MISMATCH_REASON_LABEL: Record<VerifyResultDTO['mismatches'][number]['reason'], string> = {
  md5: 'MD5 不一致',
  size: '大小不一致',
  missing: '文件缺失',
  extra: '多余文件',
};

function appKey(app: { channelId: string; appId: string }): string {
  return `${app.channelId}:${app.appId}`;
}

/** 本地库：已安装 App 列表、检查更新、启动/更新/校验/打开目录/卸载。 */
export function LibraryView({ dataVersion, onLibraryChanged, onGoChannels }: LibraryViewProps) {
  const api = useApi();
  const toast = useToast();
  const state = useAsyncData<InstalledAppDTO[]>(() => api.library.list(), dataVersion);

  const [checking, setChecking] = useState(false);
  const [checks, setChecks] = useState<UpdateCheckDTO[] | null>(null);
  const [busy, setBusy] = useState<Record<string, CardAction | undefined>>({});
  const [verifyResults, setVerifyResults] = useState<Record<string, VerifyResultDTO>>({});
  const [confirmUninstall, setConfirmUninstall] = useState<InstalledAppDTO | null>(null);

  const apps = state.data ?? [];
  const updates = checks?.filter((item) => item.updateAvailable) ?? [];

  const checkUpdates = async () => {
    setChecking(true);
    try {
      const result = await api.library.checkUpdates();
      if (!result.ok) {
        toast.error(result.error, '检查更新失败');
        return;
      }
      setChecks(result.value);
      const available = result.value.filter((item) => item.updateAvailable);
      if (available.length > 0) toast.success(`发现 ${available.length} 个可更新的 App`);
      else toast.success('所有 App 都已是最新版本');
      await state.reload();
      await onLibraryChanged();
    } finally {
      setChecking(false);
    }
  };

  const runAction = async (action: CardAction, app: InstalledAppDTO) => {
    const key = appKey(app);
    const ref = { channelId: app.channelId, appId: app.appId };
    setBusy((current) => ({ ...current, [key]: action }));
    try {
      if (action === 'launch') {
        const result = await api.library.launch(ref);
        if (!result.ok) {
          toast.error(result.error, '启动失败');
          return;
        }
        toast.success(result.value.pid ? `已启动 ${app.displayName}（PID ${result.value.pid}）` : `已启动 ${app.displayName}`);
        return;
      }
      if (action === 'reveal') {
        const result = await api.library.reveal(ref);
        if (!result.ok) {
          toast.error(result.error, '打开目录失败');
          return;
        }
        toast.success('已在文件管理器中打开安装目录');
        return;
      }
      if (action === 'update') {
        const result = await api.library.update(ref);
        if (!result.ok) {
          toast.error(result.error, '更新失败');
          return;
        }
        toast.success(`已更新 ${result.value.app.displayName} 到 v${result.value.app.version}`);
        await state.reload();
        await onLibraryChanged();
        return;
      }
      const result = await api.library.verify(ref);
      if (!result.ok) {
        toast.error(result.error, '校验失败');
        return;
      }
      setVerifyResults((current) => ({ ...current, [key]: result.value }));
      if (result.value.ok) {
        toast.success(`校验通过（检查了 ${result.value.checkedFiles} 个文件）`);
      } else {
        toast.error({ code: 'STATE', message: `发现 ${result.value.mismatches.length} 处文件差异` }, '校验未通过');
      }
    } finally {
      setBusy((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
    }
  };

  const uninstall = async () => {
    if (!confirmUninstall) return;
    const app = confirmUninstall;
    const key = appKey(app);
    setBusy((current) => ({ ...current, [key]: 'uninstall' }));
    try {
      const result = await api.library.uninstall({ channelId: app.channelId, appId: app.appId });
      if (!result.ok) {
        toast.error(result.error, '卸载失败');
        return;
      }
      setConfirmUninstall(null);
      setVerifyResults((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
      toast.success(`已卸载 ${app.displayName}`);
      await state.reload();
      await onLibraryChanged();
    } finally {
      setBusy((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
    }
  };

  const headerActions = (
    <>
      <button
        type="button"
        className="btn btn-secondary"
        data-testid="library-check-updates"
        onClick={() => void checkUpdates()}
        disabled={checking}
      >
        <Icon name="refresh" size={16} />
        {checking ? '检查中…' : '检查更新'}
      </button>
      <button
        type="button"
        className="btn btn-ghost"
        onClick={() => void state.reload()}
        disabled={state.refreshing}
      >
        <Icon name="refresh" size={16} />
        {state.refreshing ? '刷新中…' : '刷新'}
      </button>
    </>
  );

  return (
    <div className="page" data-testid="library-page">
      <PageHeader
        eyebrow="本地"
        title="本地库"
        description="管理已安装到本机的 App：启动、校验完整性、更新到频道最新版本或卸载。"
        actions={headerActions}
      />

      {state.data === null && state.loading ? <LoadingState label="正在加载本地库…" /> : null}

      {state.data === null && state.error ? (
        <ErrorState error={state.error} title="本地库加载失败" onRetry={() => void state.reload()} />
      ) : null}

      {state.error && state.data !== null ? (
        <ApiErrorBanner error={state.error} title="刷新本地库失败" />
      ) : null}

      {checks !== null ? (
        <InfoBanner tone={updates.length > 0 ? 'info' : 'success'} title="更新检查结果">
          {updates.length > 0 ? (
            <>
              发现 {updates.length} 个可更新：
              {updates.map((item) => `${item.displayName} v${item.currentVersion} → v${item.latestVersion}`).join('、')}
            </>
          ) : (
            '所有 App 都已经是最新版本。'
          )}
        </InfoBanner>
      ) : null}

      {state.data !== null && apps.length === 0 ? (
        <EmptyState
          icon="library"
          title="本地库还是空的"
          description="去频道里挑选 App 并安装，安装完成后会出现在这里。"
          testId="library-empty"
        >
          <button type="button" className="btn btn-primary" onClick={onGoChannels}>
            <Icon name="channels" size={16} />
            去频道看看
          </button>
        </EmptyState>
      ) : null}

      {apps.length > 0 ? (
        <div className="grid library-grid">
          {apps.map((app) => {
            const key = appKey(app);
            const action = busy[key];
            const check = checks?.find(
              (item) => item.channelId === app.channelId && item.appId === app.appId,
            );
            const hasUpdate = app.status === 'outdated' || Boolean(check?.updateAvailable);
            const updateVersion = check?.updateAvailable ? check.latestVersion : app.availableVersion;
            const verifyResult = verifyResults[key];
            return (
              <article
                className="card installed-card"
                key={key}
                data-testid="installed-app-card"
                data-app-id={app.appId}
                data-channel-id={app.channelId}
              >
                <div className="installed-head">
                  <span className="app-icon">
                    <Icon name="box" size={20} />
                  </span>
                  <div className="installed-title">
                    <h3>{app.displayName}</h3>
                    <span className="mono muted">{app.appId}</span>
                  </div>
                  <InstallStatusBadge status={app.status} />
                </div>

                <div className="installed-meta">
                  <span>
                    <Icon name="channels" size={13} /> {app.channelName}
                  </span>
                  <span>
                    <Icon name="tag" size={13} /> v{app.version}
                    {hasUpdate && updateVersion ? ` → v${updateVersion}` : ''}
                  </span>
                  <span>
                    {platformLabel(app.platform)} · {publishModeLabel(app.publishMode)}
                  </span>
                  <span>
                    <Icon name="file" size={13} /> {app.fileCount} 个文件 · {formatBytes(app.totalSize)}
                  </span>
                  <span>
                    <Icon name="clock" size={13} /> 更新于 {formatDateTime(app.updatedAt)}
                  </span>
                </div>

                <div className="installed-actions">
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    onClick={() => void runAction('launch', app)}
                    disabled={Boolean(action)}
                  >
                    <Icon name="play" size={14} />
                    {action === 'launch' ? '启动中…' : '启动'}
                  </button>
                  {hasUpdate ? (
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() => void runAction('update', app)}
                      disabled={Boolean(action)}
                    >
                      <Icon name="download" size={14} />
                      {action === 'update' ? '更新中…' : `更新到 v${updateVersion ?? '最新'}`}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => void runAction('verify', app)}
                    disabled={Boolean(action)}
                  >
                    <Icon name="shield" size={14} />
                    {action === 'verify' ? '校验中…' : '校验'}
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => void runAction('reveal', app)}
                    disabled={Boolean(action)}
                  >
                    <Icon name="folder" size={14} />
                    打开目录
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm btn-danger-text"
                    onClick={() => setConfirmUninstall(app)}
                    disabled={Boolean(action)}
                  >
                    <Icon name="trash" size={14} />
                    卸载
                  </button>
                </div>

                {verifyResult ? (
                  <div
                    className={verifyResult.ok ? 'banner banner-success' : 'banner banner-warn'}
                    role="status"
                    data-testid="verify-result"
                  >
                    <Icon name={verifyResult.ok ? 'check-circle' : 'alert'} size={16} />
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
              </article>
            );
          })}
        </div>
      ) : null}

      {confirmUninstall ? (
        <ConfirmDialog
          title="卸载 App"
          message={
            <>
              确定要从本地库卸载「{confirmUninstall.displayName}」吗？本地文件会被删除（远端频道内容不受影响）。
            </>
          }
          confirmLabel="卸载"
          danger
          busy={busy[appKey(confirmUninstall)] === 'uninstall'}
          confirmTestId="uninstall-confirm-ok"
          onCancel={() => setConfirmUninstall(null)}
          onConfirm={() => void uninstall()}
        />
      ) : null}
    </div>
  );
}
