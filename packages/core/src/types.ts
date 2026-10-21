import type {
  AppMetaFile,
  AppVersionEntry,
  ChannelFile,
  ChannelPrivateFile,
  FileEntry,
  Platform,
  PublishMode,
  StorageConfig,
  Visibility,
} from '@apphub/protocol';
import type { StorageFactory } from '@apphub/storage';

/**
 * @apphub/core 的公共 API 契约。
 *
 * 该文件由 Lead 维护，core-dev 实现具体服务，desktop main 进程按此契约集成。
 * 所有方法失败时抛出 AppError；所有返回对象必须是 JSON 可序列化的。
 */

// ---------------------------------------------------------------------------
// 基础设施
// ---------------------------------------------------------------------------

export interface Logger {
  debug(message: string, meta?: unknown): void;
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
}

/** 本地机密加密器（Electron 主进程用 safeStorage 实现；测试用 Fake 实现）。 */
export interface SecretBox {
  encrypt(plain: string): Promise<string>;
  decrypt(cipher: string): Promise<string>;
}

export interface Clock {
  now(): Date;
}

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface CoreContext {
  /** 应用数据目录（见 docs/ARCHITECTURE.md 的目录结构）。 */
  dataDir: string;
  storageFactory: StorageFactory;
  secretBox: SecretBox;
  logger?: Logger;
  clock?: Clock;
  /** 订阅/下载使用；默认 globalThis.fetch。 */
  fetchImpl?: FetchLike;
  /** 本地保留的历史版本数，默认 2。 */
  keepVersions?: number;
  /** 所有 HTTP 请求的默认附加头（例如企业代理），可选。 */
  defaultHeaders?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// 进度事件
// ---------------------------------------------------------------------------

export type ProgressPhase =
  | 'prepare'
  | 'transfer'
  | 'verify'
  | 'extract'
  | 'commit'
  | 'cleanup'
  | 'fetch';

export interface ProgressEvent {
  phase: ProgressPhase;
  /** 面向用户的中文描述。 */
  message?: string;
  currentFile?: string;
  index?: number;
  count?: number;
  transferredBytes?: number;
  totalBytes?: number;
  /** 0-100；无法估算时缺省。 */
  percent?: number;
}

export type ProgressListener = (event: ProgressEvent) => void;

// ---------------------------------------------------------------------------
// 频道
// ---------------------------------------------------------------------------

export interface ChannelCreateInput {
  name: string;
  description?: string;
  visibility: Visibility;
  owner?: { name?: string; contact?: string };
  /** 存储配置（含凭据）；私密频道会自动生成 accessKey。 */
  storage: StorageConfig;
  /** 跳过存储连通性探测（仅测试/离线演示使用）。 */
  skipProbe?: boolean;
}

export interface ChannelUpdateInput {
  name?: string;
  description?: string;
  owner?: { name?: string; contact?: string };
}

export type ChannelRole = 'owner' | 'admin' | 'subscriber';

export interface ChannelInfo {
  id: string;
  name: string;
  description: string;
  visibility: Visibility;
  /** 本机对该频道的权限：owner/admin 可发布；subscriber 只读。 */
  role: ChannelRole;
  createdAt: string;
  updatedAt: string;
  appCount: number;
  /** 分享给他人订阅的 channel.json 地址（私密频道为携带 accessKey 的能力链接）。 */
  subscribeUrl: string;
  /** 是否可发布。 */
  canPublish: boolean;
  /** 最近一次从远端拉取 channel.json 的时间。 */
  lastFetchedAt?: string;
  /** 本地记录来源：频道拥有者 or 订阅者。 */
  source: 'owned' | 'subscribed';
}

export interface AppInfo {
  appId: string;
  name: string;
  displayName: string;
  description: string;
  author: string;
  entry: string;
  platforms: Platform[];
  publishMode: PublishMode;
  /** platform -> version */
  latest: Record<string, string>;
  metaUrl: string;
  updatedAt: string;
  iconUrl?: string;
}

export interface ChannelDetail extends ChannelInfo {
  /** 远端 channel.json 原始内容（已校验）。 */
  channel: ChannelFile;
  apps: AppInfo[];
}

export interface SubscribeInput {
  /** channel.json 的 http(s) 地址；私密频道需包含 accessKey 路径。 */
  url: string;
  /** 读取该频道时附加的 HTTP 头（例如 Basic Auth），可选。 */
  headers?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// 发布
// ---------------------------------------------------------------------------

export interface PublishFileInput {
  /** 本地绝对路径（由 Electron 文件选择器产生）。 */
  sourcePath: string;
  /** 在版本目录中的目标相对路径。 */
  targetPath: string;
  /** 覆盖 files.json 中可执行标记（可选）。 */
  executable?: boolean;
}

export interface PublishAppInput {
  channelId: string;
  /** 创建新 App 时填写；已存在时忽略并使用 name。 */
  app?: {
    appId?: string;
    displayName: string;
    description?: string;
    author?: string;
    homepage?: string;
  };
  version: string;
  platform: Platform;
  publishMode: PublishMode;
  /** 启动入口：files 模式为目标相对路径；zip 模式为压缩包内路径。 */
  entry: string;
  /** files 模式：待发布的文件列表。 */
  files?: PublishFileInput[];
  /** zip 模式：本地 zip 文件路径（与 zipFromDir 二选一）。 */
  zipPath?: string;
  /** zip 模式：将本地目录打包为 zip（与 zipPath 二选一）。 */
  zipFromDir?: string;
  /** zip 文件名，默认 `<appId>-<version>.zip`。 */
  archiveName?: string;
  changelog?: string;
  /** 同版本再次发布时是否覆盖（默认 false，冲突报 CONFLICT）。 */
  overwrite?: boolean;
  onProgress?: ProgressListener;
}

export interface PublishResult {
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

export interface AppMetaPatch {
  displayName?: string;
  description?: string;
  author?: string;
  homepage?: string;
  entry?: string;
  iconSourcePath?: string;
}

export interface AppDetail {
  channelId: string;
  app: AppInfo;
  meta: AppMetaFile;
  /** 版本列表（按 semver 降序）。 */
  versions: AppVersionEntry[];
}

// ---------------------------------------------------------------------------
// 本地库 / 安装更新
// ---------------------------------------------------------------------------

export type InstalledStatus = 'installed' | 'outdated' | 'broken';

export interface InstalledAppInfo {
  channelId: string;
  channelName: string;
  appId: string;
  displayName: string;
  version: string;
  platform: Platform;
  publishMode: PublishMode;
  entry: string;
  /** App 根目录：<dataDir>/library/<channelId>/<appId> */
  appRoot: string;
  /** 当前版本文件目录。 */
  installPath: string;
  installedAt: string;
  updatedAt: string;
  fileCount: number;
  totalSize: number;
  status: InstalledStatus;
  /** 与远端对比后可用的新版本（未知时缺省）。 */
  availableVersion?: string;
}

export interface InstallTarget {
  channelId: string;
  appId: string;
  platform?: Platform;
  /** 指定版本；缺省安装最新版。 */
  version?: string;
  /** 已是最新时仍强制重新安装/校验。 */
  force?: boolean;
  onProgress?: ProgressListener;
}

export interface InstallResult {
  app: InstalledAppInfo;
  downloadedBytes: number;
  /** 从旧版本复用的字节数（散文件更新时按 MD5 复用）。 */
  reusedBytes: number;
  updatedFrom?: string;
}

export interface UpdateCheckItem {
  channelId: string;
  channelName: string;
  appId: string;
  displayName: string;
  currentVersion: string;
  latestVersion: string;
  platform: Platform;
  updateAvailable: boolean;
}

export interface FileMismatch {
  path: string;
  reason: 'md5' | 'size' | 'missing' | 'extra';
  expectedMd5?: string;
  actualMd5?: string;
}

export interface VerifyResult {
  ok: boolean;
  checkedFiles: number;
  mismatches: FileMismatch[];
}

export interface LaunchDescriptor {
  appRoot: string;
  versionDir: string;
  entryPath: string;
  cwd: string;
  args: string[];
}

export interface UpdateAllResult {
  checked: number;
  updated: InstallResult[];
  upToDateApps: string[];
}

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

export interface ChannelService {
  list(): Promise<ChannelInfo[]>;
  get(channelId: string): Promise<ChannelDetail>;
  create(input: ChannelCreateInput): Promise<ChannelDetail>;
  update(channelId: string, patch: ChannelUpdateInput): Promise<ChannelDetail>;
  subscribe(input: SubscribeInput): Promise<ChannelDetail>;
  unsubscribe(channelId: string): Promise<void>;
  /** 从远端重新拉取 channel.json（订阅者/管理员可用）。 */
  refresh(channelId: string): Promise<ChannelDetail>;
  refreshAll(): Promise<ChannelInfo[]>;
  /** 导入 channel_pri.json 内容（授予发布权限）。 */
  importPrivateConfig(rawJson: string): Promise<ChannelDetail>;
  /** 导出 channel_pri.json 明文（仅 owner/admin；由主进程弹窗写文件）。 */
  exportPrivateConfig(channelId: string): Promise<string>;
  /** 获取订阅链接（公开频道为 channel.json URL；私密频道为携带 accessKey 的能力链接）。 */
  getSubscribeUrl(channelId: string): Promise<string>;
}

export interface PublishService {
  /** 获取 App 详情；优先使用远端 app.meta.json（失败时回退本地缓存）。 */
  getApp(channelId: string, appId: string): Promise<AppDetail>;
  /** 创建 App 或发布新版本（原子地更新 files.json / app.meta.json / channel.json）。 */
  publish(input: PublishAppInput): Promise<PublishResult>;
  updateMeta(channelId: string, appId: string, patch: AppMetaPatch): Promise<AppDetail>;
}

export interface LibraryService {
  list(): Promise<InstalledAppInfo[]>;
  checkUpdates(options?: { channelId?: string }): Promise<UpdateCheckItem[]>;
  install(target: InstallTarget): Promise<InstallResult>;
  update(target: InstallTarget): Promise<InstallResult>;
  verify(channelId: string, appId: string): Promise<VerifyResult>;
  uninstall(channelId: string, appId: string): Promise<void>;
  getLaunchDescriptor(channelId: string, appId: string): Promise<LaunchDescriptor>;
}

export interface AppHubCore {
  readonly dataDir: string;
  readonly channels: ChannelService;
  readonly publishing: PublishService;
  readonly library: LibraryService;
  close(): Promise<void>;
}

/** 便于测试/工具使用的频道本地记录（core 内部使用，但导出类型方便断言）。 */
export interface ChannelRecord {
  channelId: string;
  url: string;
  visibility: Visibility;
  role: ChannelRole;
  source: 'owned' | 'subscribed';
  channelName: string;
  createdAt: string;
  updatedAt: string;
  lastFetchedAt?: string;
  headersCipher?: string;
}

export type { ChannelPrivateFile };
