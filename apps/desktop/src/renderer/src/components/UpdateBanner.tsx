import { Icon } from './Icon';
import { useUpdate } from './UpdateProvider';
import type { UpdateStateDTO } from '../types';

function bannerTitle(state: UpdateStateDTO): string {
  if (state.status === 'downloaded') {
    return `更新 v${state.availableVersion ?? ''} 已下载，重启 App 即可安装`;
  }
  if (state.status === 'downloading') {
    return `正在下载更新 v${state.availableVersion ?? ''}`;
  }
  return `发现新版本 v${state.availableVersion ?? ''}`;
}

function progressPercent(state: UpdateStateDTO): number | undefined {
  const percent = state.progress?.percent;
  if (typeof percent !== 'number' || !Number.isFinite(percent)) return undefined;
  return Math.max(0, Math.min(100, Math.round(percent)));
}

/**
 * 非阻塞更新提示条：
 * 仅在 available / downloading / downloaded 且用户未选择「稍后」时显示。
 * 「稍后」只是隐藏本次会话的 Banner，不改变更新状态、不影响 App 使用。
 */
export function UpdateBanner() {
  const { state, busy, openDialog, dismiss } = useUpdate();

  if (!state || !state.supported) return null;
  if (state.dismissed) return null;
  if (state.status !== 'available' && state.status !== 'downloading' && state.status !== 'downloaded') {
    return null;
  }

  const percent = progressPercent(state);
  const downloading = state.status === 'downloading';

  return (
    <div className="update-banner" data-testid="update-banner" role="status">
      <span className="update-banner-icon">
        <Icon name={state.status === 'downloaded' ? 'check-circle' : 'download'} size={18} />
      </span>
      <div className="update-banner-text">
        <strong>{bannerTitle(state)}</strong>
        <span>
          {state.releaseName ? state.releaseName : `当前版本 v${state.currentVersion}`}
          {downloading && percent !== undefined ? ` · 已下载 ${percent}%` : ''}
        </span>
        {downloading ? (
          <span className="update-banner-progress" aria-hidden="true">
            <span className="update-banner-progress-fill" style={{ width: `${percent ?? 8}%` }} />
          </span>
        ) : null}
      </div>
      <div className="update-banner-actions">
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          data-testid="update-open-button"
          onClick={openDialog}
        >
          {state.status === 'downloaded' ? '查看并安装' : '查看更新'}
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          data-testid="update-dismiss-button"
          onClick={() => void dismiss()}
          disabled={busy === 'dismiss'}
        >
          稍后
        </button>
      </div>
    </div>
  );
}
