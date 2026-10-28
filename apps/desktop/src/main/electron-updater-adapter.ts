import { autoUpdater } from 'electron-updater';
import type { ProgressInfo, UpdateInfo } from 'electron-updater';
import type { Logger } from './logger';
import type { UpdaterAdapter, UpdaterProgress, UpdaterUpdateInfo } from './updater';

/**
 * electron-updater 适配层：把 autoUpdater 的事件/配置封装成 updater.ts 需要的 UpdaterAdapter。
 *
 * 约束（见 task Phase10）：
 *  - 绝不自动下载/安装：autoDownload=false、autoInstallOnAppQuit=false；
 *  - allowPrerelease=false、allowDowngrade=false；
 *  - 只有用户显式调用 download()/install() 才会执行；
 *  - 不处理代码签名；发布/下载由 electron-updater 按 package.json build.publish 的 GitHub provider 执行。
 */

export interface ElectronUpdaterAdapterOptions {
  logger: Logger;
  /** App 版本（app.getVersion()）；适配器优先用它，autoUpdater 不可用时兜底。 */
  currentVersion?: string;
}

const MAX_RELEASE_NOTES_LENGTH = 20_000;

function formatValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function normalizeReleaseNotes(notes: UpdateInfo['releaseNotes']): string | undefined {
  let text: string | undefined;
  if (typeof notes === 'string') {
    text = notes;
  } else if (Array.isArray(notes)) {
    text = notes
      .map((entry) => {
        if (typeof entry === 'string') return entry;
        if (entry && typeof entry === 'object' && typeof entry.note === 'string') return entry.note;
        return '';
      })
      .filter((entry) => entry.trim().length > 0)
      .join('\n\n');
  }
  if (text === undefined) return undefined;
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length > MAX_RELEASE_NOTES_LENGTH
    ? `${trimmed.slice(0, MAX_RELEASE_NOTES_LENGTH)}…（截断）`
    : trimmed;
}

function normalizeInfo(info: UpdateInfo): UpdaterUpdateInfo {
  const normalized: UpdaterUpdateInfo = { version: typeof info.version === 'string' ? info.version : '' };
  if (typeof info.releaseName === 'string' && info.releaseName.length > 0) {
    normalized.releaseName = info.releaseName;
  }
  const notes = normalizeReleaseNotes(info.releaseNotes);
  if (notes !== undefined) normalized.releaseNotes = notes;
  if (typeof info.releaseDate === 'string' && info.releaseDate.length > 0) {
    normalized.releaseDate = info.releaseDate;
  }
  return normalized;
}

function normalizeProgress(progress: ProgressInfo): UpdaterProgress {
  return {
    percent: Number.isFinite(progress.percent) ? progress.percent : 0,
    transferred: Number.isFinite(progress.transferred) ? progress.transferred : 0,
    total: Number.isFinite(progress.total) ? progress.total : 0,
    bytesPerSecond: Number.isFinite(progress.bytesPerSecond) ? progress.bytesPerSecond : 0,
  };
}

export function createElectronUpdaterAdapter(options: ElectronUpdaterAdapterOptions): UpdaterAdapter {
  const logger = options.logger;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowPrerelease = false;
  autoUpdater.allowDowngrade = false;
  autoUpdater.logger = {
    info: (message?: unknown) => logger.info(`[electron-updater] ${formatValue(message)}`),
    warn: (message?: unknown) => logger.warn(`[electron-updater] ${formatValue(message)}`),
    error: (message?: unknown) => logger.error(`[electron-updater] ${formatValue(message)}`),
    debug: (message: string) => logger.debug(`[electron-updater] ${formatValue(message)}`),
  };

  const registered: { event: string; listener: (...args: never[]) => void }[] = [];
  const addListener = (event: string, listener: (...args: never[]) => void): void => {
    autoUpdater.on(event as Parameters<typeof autoUpdater.on>[0], listener as never);
    registered.push({ event, listener });
  };

  return {
    get currentVersion(): string {
      if (options.currentVersion !== undefined && options.currentVersion.length > 0) {
        return options.currentVersion;
      }
      try {
        return autoUpdater.currentVersion?.version ?? '';
      } catch {
        return '';
      }
    },
    checkForUpdates: () => autoUpdater.checkForUpdates(),
    downloadUpdate: () => autoUpdater.downloadUpdate(),
    quitAndInstall: (isSilent = false, isForceRunAfter = true) => {
      autoUpdater.quitAndInstall(isSilent, isForceRunAfter);
    },
    onUpdateAvailable: (handler) =>
      addListener('update-available', (info: UpdateInfo) => handler(normalizeInfo(info))),
    onUpdateNotAvailable: (handler) =>
      addListener('update-not-available', (info?: UpdateInfo) => handler(info ? normalizeInfo(info) : undefined)),
    onDownloadProgress: (handler) =>
      addListener('download-progress', (progress: ProgressInfo) => handler(normalizeProgress(progress))),
    onUpdateDownloaded: (handler) =>
      addListener('update-downloaded', (info: UpdateInfo) => handler(normalizeInfo(info))),
    onError: (handler) => addListener('error', (error: unknown) => handler(error)),
    dispose: () => {
      for (const { event, listener } of registered) {
        try {
          autoUpdater.removeListener(event as Parameters<typeof autoUpdater.removeListener>[0], listener as never);
        } catch {
          /* ignore */
        }
      }
      registered.length = 0;
    },
  };
}
