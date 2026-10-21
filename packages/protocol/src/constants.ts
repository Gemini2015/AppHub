/**
 * AppHub 线上协议（wire protocol）中的常量。
 *
 * 该包必须保持"纯"：不依赖 node:fs / node:path 等 Node API，
 * 以便 Electron 渲染进程、CLI、测试代码共用同一份校验逻辑。
 */

/** 所有 JSON 协议文件的版本号，升级格式时递增。 */
export const SCHEMA_VERSION = 1 as const;

/** 协议中固定出现的文件名。 */
export const FILE_NAMES = {
  channel: 'channel.json',
  channelPrivate: 'channel_pri.json',
  appMeta: 'app.meta.json',
  files: 'files.json',
} as const;

/** 私密频道在存储根目录下使用的隔离前缀目录。 */
export const PRIVATE_ROOT_DIR = '_private';

/** App 标识：小写字母/数字开头结尾，中间可含 . _ -，长度 1..63。 */
export const APP_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,61}[a-z0-9])?$/;

/** 频道 ID：`ch_` + 16..32 位小写十六进制。 */
export const CHANNEL_ID_PATTERN = /^ch_[a-z0-9]{16,32}$/;

/** 私密频道访问密钥：16..64 位 URL 安全字符。 */
export const ACCESS_KEY_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

/** 平台标识。 */
export const PLATFORMS = ['windows', 'linux', 'mac'] as const;

/** App 发布方式。 */
export const PUBLISH_MODES = ['files', 'zip'] as const;

/** 频道可见性。 */
export const VISIBILITIES = ['public', 'private'] as const;

/** 字段长度上限，用于 zod 校验与 UI 提示。 */
export const LIMITS = {
  channelName: 64,
  channelDescription: 2048,
  appDisplayName: 128,
  appDescription: 4096,
  author: 256,
  changelog: 10000,
  relativePath: 1024,
  fileCount: 100_000,
  totalSize: 1024 * 1024 * 1024 * 1024, // 1 TiB
} as const;

/** 协议默认行为参数。 */
export const DEFAULTS = {
  /** 本地保留的历史版本数量（安装器清理时使用）。 */
  keepVersions: 2,
  /** 单次 HTTP 请求超时（毫秒）。 */
  httpTimeoutMs: 30_000,
  /** 下载/上传分片大小（字节）。 */
  chunkSize: 1024 * 1024,
} as const;

/** 协议中本地状态目录的版本，用于未来迁移。 */
export const LOCAL_STATE_VERSION = 1 as const;

/** 所有允许的 AppError code。 */
export const ERROR_CODES = [
  'VALIDATION',
  'NOT_FOUND',
  'STORAGE',
  'AUTH',
  'NETWORK',
  'CONFLICT',
  'UNSUPPORTED',
  'SECURITY',
  'IO',
  'STATE',
  'CANCELLED',
  'INTERNAL',
] as const;
