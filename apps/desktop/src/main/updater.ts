import { AppError } from '@apphub/protocol';
import type { ApiError, UpdateStateDTO, UpdateStatus } from '../../shared/ipc';
import type { Logger } from './logger';

/**
 * 应用内自动更新（主进程）——纯状态机，不直接依赖 electron-updater。
 *
 * 设计：
 *  - 通过注入的 `UpdaterAdapter` 与真实 electron-updater 解耦（便于单测）；
 *  - 状态：unsupported / idle / checking / available / downloading / downloaded / installing /
 *    up-to-date / error，字段对齐 shared/ipc.ts 的 UpdateStateDTO；
 *  - 绝不自动下载/安装：只有用户显式 download() / install() 才执行；
 *  - 启动延迟（默认 10s）首检 + 每 6h 自动检查；自动检查失败仅记录日志，手动失败展示 error 状态；
 *  - dismiss 只影响本次会话的 Banner（按版本忽略），不改变实际更新能力。
 */

export type UnsupportedUpdateReason = 'dev' | 'platform' | 'e2e' | 'env';

export interface UpdaterUpdateInfo {
  version: string;
  releaseName?: string;
  releaseNotes?: string;
  releaseDate?: string;
}

export interface UpdaterProgress {
  percent: number;
  transferred: number;
  total: number;
  bytesPerSecond: number;
}

/** 真实更新器的最小接口（index.ts 注入 electron-updater 实现；测试注入 fake）。 */
export interface UpdaterAdapter {
  readonly currentVersion: string;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
  onUpdateAvailable(handler: (info: UpdaterUpdateInfo) => void): void;
  onUpdateNotAvailable(handler: (info?: UpdaterUpdateInfo) => void): void;
  onDownloadProgress(handler: (progress: UpdaterProgress) => void): void;
  onUpdateDownloaded(handler: (info: UpdaterUpdateInfo) => void): void;
  onError(handler: (error: unknown) => void): void;
  /** 移除所有监听并释放内部资源。 */
  dispose(): void;
}

export interface UpdaterTimers {
  setTimeout(handler: () => void, timeoutMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

const defaultTimers: UpdaterTimers = {
  setTimeout(handler, timeoutMs) {
    const handle = setTimeout(handler, timeoutMs);
    (handle as { unref?: () => void }).unref?.();
    return handle;
  },
  clearTimeout(handle) {
    if (handle !== undefined && handle !== null) clearTimeout(handle as NodeJS.Timeout);
  },
};

export const DEFAULT_CHECK_DELAY_MS = 10_000;
export const DEFAULT_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface UpdateManagerOptions {
  adapter: UpdaterAdapter | null;
  logger: Logger;
  /** 当前 App 版本（展示用）。 */
  currentVersion: string;
  /** 缺省为 adapter !== null。 */
  supported?: boolean;
  /** supported=false 时的稳定原因码。 */
  unsupportedReason?: UnsupportedUpdateReason;
  onStateChange?: (state: UpdateStateDTO) => void;
  /** install() 前调用（index.ts 用于设置 quitting=true，让 quitAndInstall 接管退出）。 */
  onBeforeInstall?: () => void;
  checkDelayMs?: number;
  checkIntervalMs?: number;
  now?: () => Date;
  timers?: UpdaterTimers;
}

function unsupportedMessage(reason: UnsupportedUpdateReason | undefined): string {
  switch (reason) {
    case 'dev':
      return '开发模式不支持应用内更新（仅打包的 Windows 安装版可用）';
    case 'platform':
      return '当前平台不支持应用内自动更新（仅 Windows 安装版可用）';
    case 'e2e':
      return 'E2E 测试模式已禁用应用内更新';
    case 'env':
      return '已通过 APPHUB_UPDATE_DISABLED=1 禁用应用内更新';
    default:
      return '当前运行环境不支持应用内更新';
  }
}

function errorToApiError(error: unknown): ApiError {
  const appError = AppError.from(error, 'NETWORK');
  const apiError: ApiError = { code: appError.code, message: appError.message };
  if (appError.details !== undefined) {
    try {
      apiError.details = JSON.parse(JSON.stringify(appError.details)) as unknown;
    } catch {
      /* 丢弃不可序列化 details */
    }
  }
  return apiError;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

function cloneProgress(progress: UpdaterProgress | undefined): UpdaterProgress | undefined {
  return progress ? { ...progress } : undefined;
}

export class UpdateManager {
  private readonly adapter: UpdaterAdapter | null;
  private readonly logger: Logger;
  private readonly checkDelayMs: number;
  private readonly checkIntervalMs: number;
  private readonly now: () => Date;
  private readonly timers: UpdaterTimers;
  private readonly onStateChange: ((state: UpdateStateDTO) => void) | undefined;
  private readonly onBeforeInstall: (() => void) | undefined;

  private state: UpdateStateDTO;
  private startTimer: unknown = null;
  private autoCheckTimer: unknown = null;
  private started = false;
  private disposed = false;
  /** 当前进行中的检查是否由用户手动触发；undefined 表示没有进行中的检查。 */
  private pendingManualCheck: boolean | undefined;
  /** 本次会话被用户 dismiss 的版本（同版本不再弹 Banner）。 */
  private dismissedVersion: string | null = null;

  constructor(options: UpdateManagerOptions) {
    this.adapter = options.adapter;
    this.logger = options.logger;
    this.checkDelayMs = options.checkDelayMs ?? DEFAULT_CHECK_DELAY_MS;
    this.checkIntervalMs = options.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
    this.now = options.now ?? (() => new Date());
    this.timers = options.timers ?? defaultTimers;
    this.onStateChange = options.onStateChange;
    this.onBeforeInstall = options.onBeforeInstall;

    const supported = options.supported ?? options.adapter !== null;
    this.state = supported
      ? { supported: true, status: 'idle', currentVersion: options.currentVersion }
      : {
          supported: false,
          unsupportedReason: options.unsupportedReason,
          status: 'unsupported',
          currentVersion: options.currentVersion,
        };

    if (this.adapter) {
      this.adapter.onUpdateAvailable((info) => this.handleUpdateAvailable(info));
      this.adapter.onUpdateNotAvailable(() => this.handleUpdateNotAvailable());
      this.adapter.onDownloadProgress((progress) => this.handleDownloadProgress(progress));
      this.adapter.onUpdateDownloaded((info) => this.handleUpdateDownloaded(info));
      this.adapter.onError((error) => this.handleAdapterError(error));
    }
  }

  getState(): UpdateStateDTO {
    return {
      ...this.state,
      progress: cloneProgress(this.state.progress),
      error: this.state.error ? { ...this.state.error } : undefined,
    };
  }

  isSupported(): boolean {
    return this.state.supported;
  }

  /** 启动自动检查：延迟首检 + 周期性检查（不支持时什么都不做）。 */
  start(): void {
    if (this.started || this.disposed || !this.state.supported) return;
    this.started = true;
    this.startTimer = this.timers.setTimeout(() => {
      this.startTimer = null;
      void this.autoCheck();
    }, this.checkDelayMs);
    this.logger.debug('自动更新已启用', {
      checkDelayMs: this.checkDelayMs,
      checkIntervalMs: this.checkIntervalMs,
      currentVersion: this.state.currentVersion,
    });
  }

  /** 手动检查（渲染进程点击“检查更新”）：错误会写进 state.error。 */
  async check(manual = true): Promise<UpdateStateDTO> {
    this.ensureUsable();
    if (this.isBusy()) {
      // 防并发：检查/下载/安装进行中直接返回当前状态
      return this.getState();
    }
    this.pendingManualCheck = manual;
    this.patch(
      { status: 'checking', dismissed: undefined },
      { clear: ['error', 'progress', 'availableVersion', 'releaseName', 'releaseNotes', 'releaseDate'] },
    );
    try {
      await this.adapter!.checkForUpdates();
    } catch (error) {
      if (this.pendingManualCheck !== undefined) {
        // 适配器没有先通过 error 事件上报时，按当前流程处理
        this.handleAdapterError(error);
      } else {
        this.logger.debug('检查更新 Promise 拒绝（错误已通过事件处理）', {
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (this.state.status === 'checking') {
      // 适配器静默返回（未发事件）：视为已是最新，避免卡在 checking
      this.handleUpdateNotAvailable();
    }
    return this.getState();
  }

  /** 下载更新：仅 available 状态可用（绝不自动触发）。 */
  async download(): Promise<UpdateStateDTO> {
    this.ensureUsable();
    if (this.state.status !== 'available') {
      throw new AppError('STATE', '当前没有可下载的更新');
    }
    this.patch(
      {
        status: 'downloading',
        progress: { percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 },
      },
      { clear: ['error'] },
    );
    try {
      await this.adapter!.downloadUpdate();
    } catch (error) {
      // 用 getState() 读取，避免 TS 对 this.state 的窄化（patch 之后类型仍停在 available）
      if (this.getState().status === 'downloading') this.enterErrorState(error);
      else this.logger.debug('下载更新 Promise 拒绝（错误已通过事件处理）');
    }
    return this.getState();
  }

  /** 安装已下载更新：仅 downloaded 可用；先 onBeforeInstall，再交给 quitAndInstall。 */
  async install(): Promise<void> {
    this.ensureUsable();
    if (this.state.status !== 'downloaded') {
      throw new AppError('STATE', '更新尚未下载完成');
    }
    this.patch({ status: 'installing' });
    try {
      this.onBeforeInstall?.();
    } catch (error) {
      this.logger.warn('更新安装前回调失败（继续安装）', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
    this.adapter!.quitAndInstall(false, true);
    this.dispose();
  }

  /** 本次会话稍后提醒：隐藏 Banner，但不改变更新能力。 */
  dismiss(): UpdateStateDTO {
    this.ensureUsable();
    const version = this.state.availableVersion;
    if (version) {
      this.dismissedVersion = version;
      this.patch({ dismissed: true });
    }
    return this.getState();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.startTimer !== null) {
      this.timers.clearTimeout(this.startTimer);
      this.startTimer = null;
    }
    if (this.autoCheckTimer !== null) {
      this.timers.clearTimeout(this.autoCheckTimer);
      this.autoCheckTimer = null;
    }
    this.started = false;
    try {
      this.adapter?.dispose();
    } catch (error) {
      this.logger.warn('释放更新器失败（忽略）', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  private ensureUsable(): void {
    if (this.disposed) throw new AppError('STATE', '更新器已释放');
    if (!this.state.supported || !this.adapter) {
      throw new AppError('UNSUPPORTED', unsupportedMessage(this.state.unsupportedReason));
    }
  }

  private isBusy(): boolean {
    return (
      this.state.status === 'checking' ||
      this.state.status === 'downloading' ||
      this.state.status === 'installing'
    );
  }

  private autoCheck(): void {
    void (async () => {
      try {
        await this.check(false);
      } catch (error) {
        // check(false) 内部已处理错误；这里兜底记录
        this.logger.warn('自动检查更新失败（仅记录日志）', {
          message: error instanceof Error ? error.message : String(error),
        });
      } finally {
        this.scheduleNextAutoCheck();
      }
    })();
  }

  private scheduleNextAutoCheck(): void {
    if (this.disposed || !this.state.supported) return;
    if (this.autoCheckTimer !== null) this.timers.clearTimeout(this.autoCheckTimer);
    this.autoCheckTimer = this.timers.setTimeout(() => {
      this.autoCheckTimer = null;
      this.autoCheck();
    }, this.checkIntervalMs);
  }

  private handleUpdateAvailable(info: UpdaterUpdateInfo): void {
    const manual = this.pendingManualCheck;
    this.pendingManualCheck = undefined;
    if (!this.state.supported) return;
    if (!info || typeof info.version !== 'string' || info.version.length === 0) return;
    const dismissed = this.dismissedVersion !== null && this.dismissedVersion === info.version;
    this.patch(
      {
        status: 'available',
        availableVersion: info.version,
        releaseName: info.releaseName,
        releaseNotes: info.releaseNotes,
        releaseDate: info.releaseDate,
        lastCheckedAt: this.now().toISOString(),
        dismissed: dismissed ? true : undefined,
      },
      { clear: ['error', 'progress'] },
    );
    this.logger.info('发现可用更新', { version: info.version, manual: manual === true });
  }

  private handleUpdateNotAvailable(): void {
    this.pendingManualCheck = undefined;
    if (!this.state.supported) return;
    this.patch(
      {
        status: 'up-to-date',
        lastCheckedAt: this.now().toISOString(),
        dismissed: undefined,
      },
      { clear: ['error', 'progress', 'availableVersion', 'releaseName', 'releaseNotes', 'releaseDate'] },
    );
    this.logger.debug('当前已是最新版本');
  }

  private handleDownloadProgress(progress: UpdaterProgress): void {
    if (this.state.status !== 'downloading') return;
    this.patch({
      progress: {
        percent: clampPercent(progress.percent),
        transferred: Math.max(0, progress.transferred ?? 0),
        total: Math.max(0, progress.total ?? 0),
        bytesPerSecond: Math.max(0, progress.bytesPerSecond ?? 0),
      },
    });
  }

  private handleUpdateDownloaded(info: UpdaterUpdateInfo): void {
    this.pendingManualCheck = undefined;
    if (!this.state.supported) return;
    const version = info?.version ?? this.state.availableVersion;
    this.patch(
      {
        status: 'downloaded',
        availableVersion: version,
        lastCheckedAt: this.now().toISOString(),
        progress: { percent: 100, transferred: 0, total: 0, bytesPerSecond: 0 },
      },
      { clear: ['error'] },
    );
    this.logger.info('更新已下载，等待用户安装', { version });
  }

  private handleAdapterError(error: unknown): void {
    const manual = this.pendingManualCheck;
    const downloading = this.state.status === 'downloading';
    this.pendingManualCheck = undefined;

    if (manual !== true && !downloading) {
      // 自动检查失败：只记录日志，不打扰用户；检查态回退为 idle
      this.logger.warn('自动检查更新失败（仅记录日志）', {
        message: error instanceof Error ? error.message : String(error),
      });
      if (this.state.status === 'checking') {
        this.patch({ status: 'idle', lastCheckedAt: this.now().toISOString() }, { clear: ['error', 'progress'] });
      }
      return;
    }
    this.enterErrorState(error);
  }

  private enterErrorState(error: unknown): void {
    const apiError = errorToApiError(error);
    this.patch({ status: 'error', error: apiError }, { clear: ['progress'] });
    this.logger.error('更新失败', { code: apiError.code, message: apiError.message });
  }

  private patch(next: Partial<UpdateStateDTO>, options: { clear?: (keyof UpdateStateDTO)[] } = {}): void {
    const merged: UpdateStateDTO = { ...this.state, ...next };
    for (const key of options.clear ?? []) {
      delete (merged as unknown as Record<string, unknown>)[key as string];
    }
    this.state = merged;
    this.onStateChange?.(this.getState());
  }
}

export function isUpdateStatus(value: unknown): value is UpdateStatus {
  return (
    value === 'unsupported' ||
    value === 'idle' ||
    value === 'checking' ||
    value === 'available' ||
    value === 'downloading' ||
    value === 'downloaded' ||
    value === 'installing' ||
    value === 'up-to-date' ||
    value === 'error'
  );
}
