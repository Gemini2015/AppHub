import type {
  AppMetaFile,
  AppVersionEntry,
  ChannelFile,
  ErrorCode,
  FileEntry,
  Platform,
  PublishMode,
  StorageConfig,
  Visibility,
} from '@apphub/protocol';

/**
 * 主进程 <-> 渲染进程 IPC 契约。
 *
 * 该文件同时被：
 *  - preload（暴露 window.apphub）
 *  - renderer（类型安全的调用）
 *  - main（实现 handlers）
 * 使用，改这里需要同步三处。
 *
 * 约定：
 *  - 所有 IPC 方法都返回 ApiResult<T>，绝不把异常直接抛给渲染进程；
 *  - 输入在主进程使用 zod（shared/ipc-schemas.ts）重新校验，不信任渲染进程；
 *  - DTO 必须是 JSON 可序列化的，服务端错误统一为 { code, message, details }。
 */

export const IPC_CHANNELS = {
  systemInfo: 'apphub:system:info',
  systemOpenDataDir: 'apphub:system:open-data-dir',
  systemPickDirectory: 'apphub:system:pick-directory',
  systemChangeDataDir: 'apphub:system:change-data-dir',

  updatesState: 'apphub:updates:state',
  updatesCheck: 'apphub:updates:check',
  updatesDownload: 'apphub:updates:download',
  updatesInstall: 'apphub:updates:install',
  updatesDismiss: 'apphub:updates:dismiss',

  channelsList: 'apphub:channels:list',
  channelsGet: 'apphub:channels:get',
  channelsCreate: 'apphub:channels:create',
  channelsUpdate: 'apphub:channels:update',
  channelsSubscribe: 'apphub:channels:subscribe',
  channelsUnsubscribe: 'apphub:channels:unsubscribe',
  channelsRefresh: 'apphub:channels:refresh',
  channelsRefreshAll: 'apphub:channels:refresh-all',
  channelsImportPrivateConfig: 'apphub:channels:import-private-config',
  channelsExportPrivateConfig: 'apphub:channels:export-private-config',
  channelsSubscribeUrl: 'apphub:channels:subscribe-url',

  hostStart: 'apphub:host:start',
  hostStop: 'apphub:host:stop',
  hostStatus: 'apphub:host:status',
  hostList: 'apphub:host:list',
  hostUpdateConfig: 'apphub:host:update-config',

  publishPick: 'apphub:publish:pick',
  publishInspectSelection: 'apphub:publish:inspect-selection',
  publishStart: 'apphub:publish:start',
  publishUpdateAppMeta: 'apphub:publish:update-app-meta',

  appsGet: 'apphub:apps:get',

  libraryList: 'apphub:library:list',
  libraryCheckUpdates: 'apphub:library:check-updates',
  libraryInstall: 'apphub:library:install',
  libraryUpdate: 'apphub:library:update',
  libraryVerify: 'apphub:library:verify',
  libraryUninstall: 'apphub:library:uninstall',
  libraryLaunch: 'apphub:library:launch',
  libraryReveal: 'apphub:library:reveal',
} as const;

export const IPC_EVENTS = {
  progress: 'apphub:event:progress',
  dataChanged: 'apphub:event:data-changed',
  updatesChanged: 'apphub:event:updates-changed',
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];
export type IpcEventChannel = (typeof IPC_EVENTS)[keyof typeof IPC_EVENTS];

// ---------------------------------------------------------------------------
// 通用结果
// ---------------------------------------------------------------------------

export type ApiErrorCode = ErrorCode;

export interface ApiError {
  code: ApiErrorCode;
  message: string;
  details?: unknown;
}

export type ApiResult<T> = { ok: true; value: T } | { ok: false; error: ApiError };

// ---------------------------------------------------------------------------
// 频道 DTO
// ---------------------------------------------------------------------------

export type ChannelRoleDTO = 'owner' | 'admin' | 'subscriber';

export interface ChannelSummaryDTO {
  id: string;
  name: string;
  description: string;
  visibility: Visibility;
  role: ChannelRoleDTO;
  source: 'owned' | 'subscribed';
  appCount: number;
  subscribeUrl: string;
  canPublish: boolean;
  createdAt: string;
  updatedAt: string;
  lastFetchedAt?: string;
}

export interface AppSummaryDTO {
  appId: string;
  name: string;
  displayName: string;
  description: string;
  author: string;
  entry: string;
  platforms: Platform[];
  publishMode: PublishMode;
  latest: Record<string, string>;
  metaUrl: string;
  updatedAt: string;
  iconUrl?: string;
}

export interface ChannelDetailDTO {
  summary: ChannelSummaryDTO;
  /** 远端 channel.json 原始内容。 */
  channel: ChannelFile;
  apps: AppSummaryDTO[];
}

export interface AppDetailDTO {
  channelId: string;
  app: AppSummaryDTO;
  meta: AppMetaFile;
  /** 按 semver 降序。 */
  versions: AppVersionEntry[];
}

export interface CreateChannelRequestDTO {
  name: string;
  description?: string;
  visibility: Visibility;
  owner?: { name?: string; contact?: string };
  storage: StorageConfig;
}

export interface UpdateChannelRequestDTO {
  channelId: string;
  patch: {
    name?: string;
    description?: string;
    owner?: { name?: string; contact?: string };
  };
}

export interface SubscribeRequestDTO {
  url: string;
  headers?: Record<string, string>;
}

export interface ChannelIdRequestDTO {
  channelId: string;
}

export interface ExportPrivateConfigResultDTO {
  canceled: boolean;
  savedPath?: string;
}

export interface SubscribeUrlDTO {
  url: string;
}

// ---------------------------------------------------------------------------
// 发布 DTO
// ---------------------------------------------------------------------------

export type PickKind = 'files' | 'folder' | 'zip';

export interface PickedFileDTO {
  /** 主进程文件选择注册表中的 token（渲染进程拿不到真实路径）。 */
  id: string;
  name: string;
  /** 相对路径（files 选择为文件名；folder 选择为相对目录结构）。 */
  relativePath: string;
  size: number;
}

export interface PublishSelectionDTO {
  selectionId: string;
  kind: PickKind;
  /** files/folder 选择时的文件列表；zip 选择时为空，需调用 inspectSelection。 */
  files: PickedFileDTO[];
}

export interface PickedZipInfoDTO {
  name: string;
  size: number;
}

export interface InspectSelectionResultDTO {
  kind: PickKind;
  /** zip 内容或 folder 文件列表（相对路径 + size）。 */
  files: { path: string; size: number }[];
  /** 推荐的启动入口（常见为 .exe；找不到时为第一个文件）。 */
  suggestedEntry: string | null;
  /** 仅 zip 选择时有值。 */
  zip?: PickedZipInfoDTO;
}

export interface PublishRequestDTO {
  channelId: string;
  /** 已存在 App 时无需填；新 App 可指定 appId（缺省由 displayName 生成）。 */
  appId?: string;
  displayName: string;
  description?: string;
  author?: string;
  homepage?: string;
  version: string;
  platform: Platform;
  publishMode: PublishMode;
  /** files 模式：选择文件中的相对路径；zip 模式：压缩包内路径。 */
  entry: string;
  changelog?: string;
  overwrite?: boolean;
  selectionId: string;
}

export interface PublishResultDTO {
  appId: string;
  version: string;
  platform: Platform;
  publishMode: PublishMode;
  metaUrl: string;
  totalSize: number;
  fileCount: number;
  files: FileEntry[];
  archive: { url: string; size: number; md5: string; format: 'zip' } | null;
  channelUpdatedAt: string;
}

export interface UpdateAppMetaRequestDTO {
  channelId: string;
  appId: string;
  patch: {
    displayName?: string;
    description?: string;
    author?: string;
    homepage?: string;
    entry?: string;
  };
}

// ---------------------------------------------------------------------------
// 本地库 DTO
// ---------------------------------------------------------------------------

export interface InstalledAppDTO {
  channelId: string;
  channelName: string;
  appId: string;
  displayName: string;
  version: string;
  platform: Platform;
  publishMode: PublishMode;
  entry: string;
  appRoot: string;
  installPath: string;
  installedAt: string;
  updatedAt: string;
  fileCount: number;
  totalSize: number;
  status: 'installed' | 'outdated' | 'broken';
  availableVersion?: string;
}

export interface InstallRequestDTO {
  channelId: string;
  appId: string;
  version?: string;
  platform?: Platform;
  force?: boolean;
}

export interface InstallResultDTO {
  app: InstalledAppDTO;
  downloadedBytes: number;
  reusedBytes: number;
  updatedFrom?: string;
}

export interface UpdateCheckDTO {
  channelId: string;
  channelName: string;
  appId: string;
  displayName: string;
  currentVersion: string;
  latestVersion: string;
  platform: Platform;
  updateAvailable: boolean;
}

export interface VerifyRequestDTO {
  channelId: string;
  appId: string;
}

export interface VerifyResultDTO {
  ok: boolean;
  checkedFiles: number;
  mismatches: { path: string; reason: 'md5' | 'size' | 'missing' | 'extra'; expectedMd5?: string; actualMd5?: string }[];
}

export interface LaunchResultDTO {
  pid: number | null;
}

// ---------------------------------------------------------------------------
// 系统 / 事件 DTO
// ---------------------------------------------------------------------------

export interface SystemInfoDTO {
  appName: string;
  appVersion: string;
  electronVersion: string;
  chromeVersion: string;
  nodeVersion: string;
  platform: string;
  arch: string;
  dataDir: string;
  /** 数据目录来源：Electron 默认 / 用户在设置中自定义 / 环境变量固定。 */
  dataDirSource: 'default' | 'custom' | 'env';
  /** 是否允许在设置中修改数据目录（环境变量固定时为 false）。 */
  dataDirEditable: boolean;
  /** Electron 默认 userData 目录（用于展示与"恢复默认"说明）。 */
  defaultDataDir: string;
  channelCount: number;
  installedCount: number;
}

export interface ChangeDataDirRequestDTO {
  /** 新的 AppHub 数据目录（绝对路径）。 */
  path: string;
}

export interface ChangeDataDirResultDTO {
  previousDataDir: string;
  newDataDir: string;
  /** 变更将在 App 重启后生效。 */
  restarting: boolean;
}

// ---------------------------------------------------------------------------
// 本机 Host DTO
// ---------------------------------------------------------------------------

export interface HostUrlsDTO {
  channelUrl: string;
  localChannelUrl: string;
  lanChannelUrls: string[];
}

export interface HostStatusDTO {
  channelId: string;
  channelName: string;
  visibility: Visibility;
  running: boolean;
  configuredPort: number;
  port: number | null;
  bindHost: string;
  urls: HostUrlsDTO;
  startedAt?: string;
  lastError?: ApiError;
}

export interface HostConfigPatchDTO {
  port?: number;
  bindHost?: '0.0.0.0' | '127.0.0.1';
  advertiseHost?: string;
  publicBaseUrl?: string;
}

export interface UpdateHostConfigRequestDTO {
  channelId: string;
  patch: HostConfigPatchDTO;
}

export type ProgressOperation = 'publish' | 'install' | 'update' | 'verify';

export interface ProgressEventDTO {
  operationId: string;
  operation: ProgressOperation;
  phase: 'prepare' | 'transfer' | 'verify' | 'extract' | 'commit' | 'cleanup' | 'fetch';
  message?: string;
  currentFile?: string;
  index?: number;
  count?: number;
  transferredBytes?: number;
  totalBytes?: number;
  percent?: number;
  channelId?: string;
  appId?: string;
}

export interface DataChangedEventDTO {
  domain: 'channels' | 'library' | 'apps' | 'host';
  channelId?: string;
  appId?: string;
}

// ---------------------------------------------------------------------------
// 应用自动更新 DTO
// ---------------------------------------------------------------------------

export type UpdateStatus =
  | 'unsupported'
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'installing'
  | 'up-to-date'
  | 'error';

export interface UpdateProgressDTO {
  percent: number;
  transferred: number;
  total: number;
  bytesPerSecond: number;
}

export interface UpdateStateDTO {
  /** 当前运行环境是否支持自动更新（打包的 Windows 安装版）。 */
  supported: boolean;
  /** 不支持时的稳定原因码：dev / platform / e2e / env。 */
  unsupportedReason?: 'dev' | 'platform' | 'e2e' | 'env';
  status: UpdateStatus;
  currentVersion: string;
  availableVersion?: string;
  releaseName?: string;
  /** GitHub Release notes 纯文本；渲染进程不得按 HTML 解析。 */
  releaseNotes?: string;
  releaseDate?: string;
  progress?: UpdateProgressDTO;
  error?: ApiError;
  lastCheckedAt?: string;
  /** 用户在本次会话选择了「稍后」，仅影响 Banner 展示。 */
  dismissed?: boolean;
}

export type Unsubscribe = () => void;

// ---------------------------------------------------------------------------
// 渲染进程可见的完整 API
// ---------------------------------------------------------------------------

export interface AppHubApi {
  system: {
    info(): Promise<ApiResult<SystemInfoDTO>>;
    openDataDir(): Promise<ApiResult<void>>;
    /** 选择本地目录（用于 local-host 的 rootDir / 数据目录等），取消返回 null。 */
    pickDirectory(): Promise<ApiResult<string | null>>;
    /** 迁移并修改 AppHub 数据目录（关闭 core → 复制数据 → 写引导配置 → 重启 App）。 */
    changeDataDir(input: ChangeDataDirRequestDTO): Promise<ApiResult<ChangeDataDirResultDTO>>;
  };
  channels: {
    list(): Promise<ApiResult<ChannelSummaryDTO[]>>;
    get(channelId: string): Promise<ApiResult<ChannelDetailDTO>>;
    create(input: CreateChannelRequestDTO): Promise<ApiResult<ChannelDetailDTO>>;
    update(input: UpdateChannelRequestDTO): Promise<ApiResult<ChannelDetailDTO>>;
    subscribe(input: SubscribeRequestDTO): Promise<ApiResult<ChannelDetailDTO>>;
    unsubscribe(channelId: string): Promise<ApiResult<void>>;
    refresh(channelId: string): Promise<ApiResult<ChannelDetailDTO>>;
    refreshAll(): Promise<ApiResult<ChannelSummaryDTO[]>>;
    importPrivateConfig(): Promise<ApiResult<ChannelDetailDTO | null>>;
    exportPrivateConfig(channelId: string): Promise<ApiResult<ExportPrivateConfigResultDTO>>;
    getSubscribeUrl(channelId: string): Promise<ApiResult<SubscribeUrlDTO>>;
  };
  apps: {
    get(channelId: string, appId: string): Promise<ApiResult<AppDetailDTO>>;
  };
  host: {
    start(channelId: string): Promise<ApiResult<HostStatusDTO>>;
    stop(channelId: string): Promise<ApiResult<HostStatusDTO>>;
    status(channelId: string): Promise<ApiResult<HostStatusDTO>>;
    list(): Promise<ApiResult<HostStatusDTO[]>>;
    updateConfig(input: UpdateHostConfigRequestDTO): Promise<ApiResult<HostStatusDTO>>;
  };
  publish: {
    pick(kind: PickKind): Promise<ApiResult<PublishSelectionDTO | null>>;
    inspectSelection(selectionId: string): Promise<ApiResult<InspectSelectionResultDTO>>;
    start(request: PublishRequestDTO): Promise<ApiResult<PublishResultDTO>>;
    updateAppMeta(input: UpdateAppMetaRequestDTO): Promise<ApiResult<AppDetailDTO>>;
  };
  library: {
    list(): Promise<ApiResult<InstalledAppDTO[]>>;
    checkUpdates(): Promise<ApiResult<UpdateCheckDTO[]>>;
    install(input: InstallRequestDTO): Promise<ApiResult<InstallResultDTO>>;
    update(input: InstallRequestDTO): Promise<ApiResult<InstallResultDTO>>;
    verify(input: VerifyRequestDTO): Promise<ApiResult<VerifyResultDTO>>;
    uninstall(input: VerifyRequestDTO): Promise<ApiResult<void>>;
    launch(input: VerifyRequestDTO): Promise<ApiResult<LaunchResultDTO>>;
    reveal(input: VerifyRequestDTO): Promise<ApiResult<void>>;
  };
  updates: {
    state(): Promise<ApiResult<UpdateStateDTO>>;
    check(): Promise<ApiResult<UpdateStateDTO>>;
    download(): Promise<ApiResult<UpdateStateDTO>>;
    /** 退出并安装已下载更新；成功时 App 会立即重启，调用通常不会返回。 */
    install(): Promise<ApiResult<void>>;
    /** 本次会话稍后提醒（隐藏 Banner，不改变更新状态）。 */
    dismiss(): Promise<ApiResult<UpdateStateDTO>>;
  };
  events: {
    onProgress(handler: (event: ProgressEventDTO) => void): Unsubscribe;
    onDataChanged(handler: (event: DataChangedEventDTO) => void): Unsubscribe;
    onUpdateState(handler: (event: UpdateStateDTO) => void): Unsubscribe;
  };
}
