import { formatBytes, formatDateTime } from '../format';
import { ApiErrorBanner, InfoBanner } from './Form';
import { Icon } from './Icon';
import { Modal } from './Modal';
import { ProgressBar } from './Progress';
import { useUpdate } from './UpdateProvider';
import type { UpdateStateDTO } from '../types';

function dialogSubtitle(state: UpdateStateDTO): string {
  if (state.status === 'available') return '新版本已发布，可自行选择是否更新';
  if (state.status === 'downloading') return '正在后台下载更新，不影响继续使用 AppHub';
  if (state.status === 'downloaded') return '更新已下载完成，重启 App 即可安装';
  if (state.status === 'installing') return '正在重启并安装更新…';
  if (state.status === 'up-to-date') return '当前已是最新版本';
  return '自动更新';
}

function progressDetail(state: UpdateStateDTO): string | undefined {
  const progress = state.progress;
  if (!progress) return undefined;
  const parts = [`${formatBytes(progress.transferred)} / ${formatBytes(progress.total)}`];
  if (progress.bytesPerSecond > 0) parts.push(`${formatBytes(progress.bytesPerSecond)}/s`);
  return parts.join(' · ');
}

/** 自动更新详情弹窗：版本/日期/release notes（纯文本）/进度/错误与下载、安装、稍后、重试。 */
export function UpdateDialog() {
  const { state, dialogOpen, closeDialog, busy, error, download, install, dismiss, retry } = useUpdate();

  if (!dialogOpen) return null;

  if (!state) {
    return (
      <Modal title="软件更新" testId="update-dialog" size="md" onClose={closeDialog}>
        <p className="muted">正在读取更新状态…</p>
      </Modal>
    );
  }

  const installing = busy === 'install' || state.status === 'installing';
  const downloading = state.status === 'downloading' || busy === 'download';
  const showProgress = Boolean(state.progress) && (downloading || installing);
  const activeError = error ?? state.error;
  const percent = state.progress?.percent;

  const footer = (
    <>
      <button type="button" className="btn btn-ghost" onClick={closeDialog} disabled={installing}>
        关闭
      </button>
      <div className="footer-spacer" />
      <button
        type="button"
        className="btn btn-secondary"
        onClick={() => {
          void dismiss();
          closeDialog();
        }}
        disabled={busy === 'dismiss'}
      >
        稍后
      </button>
      {activeError ? (
        <button
          type="button"
          className="btn btn-secondary"
          data-testid="update-retry-button"
          onClick={() => void retry()}
          disabled={busy !== null}
        >
          <Icon name="refresh" size={16} />
          重试
        </button>
      ) : null}
      {state.status === 'available' ? (
        <button
          type="button"
          className="btn btn-primary"
          data-testid="update-download-button"
          onClick={() => void download()}
          disabled={busy !== null}
        >
          <Icon name="download" size={16} />
          {busy === 'download' ? '开始下载…' : '下载更新'}
        </button>
      ) : null}
      {state.status === 'downloaded' ? (
        <button
          type="button"
          className="btn btn-primary"
          data-testid="update-install-button"
          onClick={() => void install()}
          disabled={busy !== null}
        >
          <Icon name="refresh" size={16} />
          {installing ? '正在重启…' : '重启并安装'}
        </button>
      ) : null}
      {state.status === 'downloading' || state.status === 'installing' ? (
        <button type="button" className="btn btn-primary" disabled>
          <Icon name="download" size={16} />
          {state.status === 'downloading' ? '下载中…' : '安装中…'}
        </button>
      ) : null}
      {!activeError && state.status !== 'available' && state.status !== 'downloaded' && !downloading && !installing ? (
        <button
          type="button"
          className="btn btn-secondary"
          data-testid="update-dialog-check-button"
          onClick={() => void retry()}
          disabled={busy !== null || !state.supported}
        >
          <Icon name="refresh" size={16} />
          检查更新
        </button>
      ) : null}
    </>
  );

  return (
    <Modal
      title="软件更新"
      subtitle={dialogSubtitle(state)}
      testId="update-dialog"
      size="md"
      closable={!installing && busy !== 'download'}
      onClose={closeDialog}
      footer={footer}
    >
      <div className="update-dialog">
        <div className="update-version-row">
          <span className="update-version-current">当前版本 v{state.currentVersion}</span>
          {state.availableVersion ? (
            <span className="update-version-arrow">
              <Icon name="arrow-right" size={15} />
              <strong>可用版本 v{state.availableVersion}</strong>
            </span>
          ) : null}
        </div>

        {state.releaseName || state.releaseDate ? (
          <p className="update-release-meta">
            {state.releaseName ?? ''}
            {state.releaseDate ? ` · 发布于 ${formatDateTime(state.releaseDate)}` : ''}
          </p>
        ) : null}

        {state.releaseNotes ? (
          <div className="update-notes-wrap">
            <h3>更新说明</h3>
            {/* release notes 为纯文本：用 pre-wrap 原样展示，绝不按 HTML 渲染。 */}
            <pre className="update-notes">{state.releaseNotes}</pre>
          </div>
        ) : null}

        {showProgress ? (
          <div data-testid="update-progress">
            <ProgressBar
              percent={typeof percent === 'number' ? Math.max(0, Math.min(100, Math.round(percent))) : undefined}
              label={installing ? '正在重启并安装更新…' : '正在下载更新'}
              detail={progressDetail(state)}
            />
          </div>
        ) : null}

        {activeError ? (
          <div data-testid="update-error">
            <ApiErrorBanner error={activeError} title="更新失败" />
          </div>
        ) : null}

        {state.status === 'up-to-date' ? (
          <InfoBanner tone="success" title="已是最新版本">
            当前版本 v{state.currentVersion}
            {state.lastCheckedAt ? `，最近检查于 ${formatDateTime(state.lastCheckedAt)}` : ''}。
          </InfoBanner>
        ) : null}

        {!state.supported ? (
          <InfoBanner tone="info" title="当前环境不支持自动更新">
            开发模式、非 Windows 安装版或测试环境下不会检查/下载更新。
          </InfoBanner>
        ) : null}

        <p className="field-hint">
          更新为非强制：未下载/未安装不会影响 AppHub 使用；「稍后」只会隐藏提示，可在「设置 / 关于 → 软件更新」再次检查。
        </p>
      </div>
    </Modal>
  );
}
