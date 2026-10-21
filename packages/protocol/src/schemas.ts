import { z } from 'zod';
import {
  APP_ID_PATTERN,
  ACCESS_KEY_PATTERN,
  CHANNEL_ID_PATTERN,
  LIMITS,
  PLATFORMS,
  PRIVATE_ROOT_DIR,
  PUBLISH_MODES,
  SCHEMA_VERSION,
  VISIBILITIES,
} from './constants';
import { AppError } from './errors';
import { isHttpUrl, isSafeRelativePath, normalizeRelativePath } from './paths';
import { isValidVersion } from './version';

// ---------------------------------------------------------------------------
// 基础字段
// ---------------------------------------------------------------------------

export const PlatformSchema = z.enum(PLATFORMS);
export const PublishModeSchema = z.enum(PUBLISH_MODES);
export const VisibilitySchema = z.enum(VISIBILITIES);

/** ISO 8601 UTC 时间戳。 */
export const TimestampSchema = z.string().datetime();

/** 32 位 MD5（大小写不敏感，统一转小写）。 */
export const Md5Schema = z
  .string()
  .regex(/^[0-9a-fA-F]{32}$/, 'MD5 必须是 32 位十六进制')
  .transform((value) => value.toLowerCase());

export const AppIdSchema = z
  .string()
  .regex(APP_ID_PATTERN, 'App 标识只能包含小写字母、数字、. _ -，首尾必须是字母或数字，长度 1-63');

export const ChannelIdSchema = z
  .string()
  .regex(CHANNEL_ID_PATTERN, '频道 ID 非法（形如 ch_ + 16-32 位小写十六进制）');

export const AccessKeySchema = z
  .string()
  .regex(ACCESS_KEY_PATTERN, '访问密钥只能是 16-64 位 URL 安全字符');

export const VersionSchema = z
  .string()
  .max(128)
  .refine(isValidVersion, '版本号必须符合 semver 规范，例如 1.0.0');

const RelativePathSchema = z
  .string()
  .min(1)
  .max(LIMITS.relativePath)
  .superRefine((value, ctx) => {
    if (!isSafeRelativePath(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `非法的相对路径：${value}`,
      });
    }
  })
  .transform((value) => normalizeRelativePath(value));

const HttpUrlSchema = z
  .string()
  .url()
  .refine((value) => isHttpUrl(value), '必须是 http(s) 地址');

// ---------------------------------------------------------------------------
// 文件条目
// ---------------------------------------------------------------------------

export const FileEntrySchema = z.object({
  path: RelativePathSchema,
  size: z.number().int().nonnegative(),
  md5: Md5Schema,
  executable: z.boolean().optional(),
});

export const ArchiveInfoSchema = z.object({
  url: z.string().min(1),
  size: z.number().int().nonnegative(),
  md5: Md5Schema,
  format: z.literal('zip'),
});

// ---------------------------------------------------------------------------
// app.meta.json
// ---------------------------------------------------------------------------

export const AppVersionEntrySchema = z.object({
  version: VersionSchema,
  platform: PlatformSchema,
  publishMode: PublishModeSchema,
  entry: RelativePathSchema,
  publishedAt: TimestampSchema,
  changelog: z.string().max(LIMITS.changelog).default(''),
  totalSize: z.number().int().nonnegative(),
  fileCount: z.number().int().nonnegative(),
  /** files.json 地址：相对于 app.meta.json 所在目录。 */
  filesUrl: z.string().min(1),
  /** 文件下载基准：相对于 app.meta.json 所在目录（通常为 `<version>/`）。 */
  downloadBaseUrl: z.string().min(1),
  /** 该版本的所有文件信息（与 files.json 内容一致，便于无额外请求展示）。 */
  files: z.array(FileEntrySchema),
  /** zip 发布方式下的压缩包信息。 */
  archive: ArchiveInfoSchema.nullable().optional(),
});

export const AppMetaFileSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  kind: z.literal('apphub-app-meta'),
  appId: AppIdSchema,
  channelId: ChannelIdSchema,
  name: z.string().min(1).max(LIMITS.appDisplayName),
  displayName: z.string().min(1).max(LIMITS.appDisplayName),
  description: z.string().max(LIMITS.appDescription).default(''),
  author: z.string().max(LIMITS.author).default(''),
  homepage: z.string().max(2048).optional(),
  iconUrl: z.string().max(2048).optional(),
  publishMode: PublishModeSchema,
  entry: RelativePathSchema,
  platforms: z.array(PlatformSchema).min(1),
  /** 各平台最新版本：platform -> version。 */
  latest: z.record(PlatformSchema, VersionSchema),
  versions: z.array(AppVersionEntrySchema).min(1),
  updatedAt: TimestampSchema,
});

// ---------------------------------------------------------------------------
// files.json
// ---------------------------------------------------------------------------

export const FilesFileSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  kind: z.literal('apphub-files'),
  appId: AppIdSchema,
  channelId: ChannelIdSchema,
  version: VersionSchema,
  platform: PlatformSchema,
  publishMode: PublishModeSchema,
  entry: RelativePathSchema,
  totalSize: z.number().int().nonnegative(),
  fileCount: z.number().int().nonnegative(),
  files: z.array(FileEntrySchema).min(1),
  archive: ArchiveInfoSchema.nullable().optional(),
  generatedAt: TimestampSchema,
});

// ---------------------------------------------------------------------------
// channel.json
// ---------------------------------------------------------------------------

export const ChannelAppRefSchema = z.object({
  appId: AppIdSchema,
  name: z.string().min(1).max(LIMITS.appDisplayName),
  displayName: z.string().min(1).max(LIMITS.appDisplayName),
  description: z.string().max(LIMITS.appDescription).default(''),
  author: z.string().max(LIMITS.author).default(''),
  entry: RelativePathSchema,
  platforms: z.array(PlatformSchema).min(1),
  publishMode: PublishModeSchema,
  /** 各平台最新版本。 */
  latest: z.record(PlatformSchema, VersionSchema).default({}),
  /** app.meta.json 地址：通常为相对 channel.json 所在目录的路径，也允许绝对 URL。 */
  metaUrl: z
    .string()
    .min(1)
    .max(2048)
    .refine((value) => isHttpUrl(value) || isSafeRelativePath(value), 'metaUrl 必须是相对路径或 http(s) 地址'),
  iconUrl: z.string().max(2048).optional(),
  updatedAt: TimestampSchema,
});

export const ChannelFileSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  kind: z.literal('apphub-channel'),
  id: ChannelIdSchema,
  name: z.string().min(1).max(LIMITS.channelName),
  description: z.string().max(LIMITS.channelDescription).default(''),
  visibility: VisibilitySchema,
  owner: z.object({
    name: z.string().max(128).default(''),
    contact: z.string().max(256).optional(),
  }),
  /** 私密频道时存在，仅表示"需要访问链接"这一事实，不包含密钥。 */
  access: z
    .object({
      type: z.literal('secret-url'),
    })
    .optional(),
  apps: z.array(ChannelAppRefSchema).default([]),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

// ---------------------------------------------------------------------------
// 存储配置（channel_pri.json 中保存，含私密凭据）
// ---------------------------------------------------------------------------

export const LocalStorageConfigSchema = z.object({
  provider: z.literal('local'),
  /** 发布目标的本地目录（例如 nginx 的 webroot）。 */
  rootDir: z.string().min(1),
  /** 该目录对外暴露的 HTTP 地址（nginx/静态服务器）。 */
  publicBaseUrl: HttpUrlSchema,
  /** 下载时附加的 HTTP 头（例如 Basic Auth），可选。 */
  headers: z.record(z.string()).optional(),
});

export const FtpSettingsSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(21),
  secure: z.boolean().default(false),
  user: z.string().default('anonymous'),
  password: z.string().default(''),
  /** FTP 根目录，例如 `app_repo/`。 */
  rootDir: z.string().default(''),
  passive: z.boolean().default(true),
  timeoutMs: z.number().int().positive().max(600_000).default(20_000),
});

export const HttpAccessConfigSchema = z.object({
  /** nginx 对外地址，例如 `http://domain/app_repo/`。 */
  baseUrl: HttpUrlSchema,
  /** 读取/下载时附加的 HTTP 头（可选，例如 Basic Auth）。 */
  headers: z.record(z.string()).optional(),
});

export const FtpHttpStorageConfigSchema = z.object({
  provider: z.literal('ftp-http'),
  ftp: FtpSettingsSchema,
  http: HttpAccessConfigSchema,
});

export const S3StorageConfigSchema = z.object({
  provider: z.literal('s3'),
  /** S3 兼容服务地址，例如 MinIO `http://127.0.0.1:9000`；为空表示 AWS S3。 */
  endpoint: HttpUrlSchema.optional(),
  region: z.string().min(1).default('us-east-1'),
  bucket: z.string().min(1),
  accessKey: z.string().min(1),
  secretKey: z.string().min(1),
  pathStyle: z.boolean().default(true),
  secure: z.boolean().default(true),
  /** 对象前缀，例如 `apphub/`。 */
  prefix: z.string().default(''),
  /** 公开访问基地址；为空时使用临时预签名 URL（私密频道/私有桶场景）。 */
  publicBaseUrl: HttpUrlSchema.optional(),
  headers: z.record(z.string()).optional(),
});

export const StorageConfigSchema = z.discriminatedUnion('provider', [
  LocalStorageConfigSchema,
  FtpHttpStorageConfigSchema,
  S3StorageConfigSchema,
]);

// ---------------------------------------------------------------------------
// channel_pri.json（私密频道文件，含存储凭据）
// ---------------------------------------------------------------------------

export const ChannelPrivateFileSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  kind: z.literal('apphub-channel-private'),
  channelId: ChannelIdSchema,
  channelName: z.string().min(1).max(LIMITS.channelName),
  visibility: VisibilitySchema,
  /** 私密频道必填：存储路径与订阅链接中的访问密钥。 */
  accessKey: AccessKeySchema.optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  /** App 存储配置（含 FTP/S3 私密凭据，仅本地保存或私下共享给管理员）。 */
  storage: StorageConfigSchema,
  owner: z.object({
    name: z.string().max(128).default(''),
    contact: z.string().max(256).optional(),
  }),
  /** 被授权发布的管理员列表（仅记录展示用，真正的授权凭证是本文件本身）。 */
  admins: z
    .array(
      z.object({
        name: z.string().min(1).max(128),
        contact: z.string().max(256).optional(),
      }),
    )
    .default([]),
  notes: z.string().max(LIMITS.channelDescription).optional(),
});

// ---------------------------------------------------------------------------
// 交叉字段校验（refine）
// ---------------------------------------------------------------------------

export const AppMetaFileSchemaStrict = AppMetaFileSchema.superRefine((meta, ctx) => {
  const seen = new Set<string>();
  for (const version of meta.versions) {
    if (seen.has(version.version)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['versions'],
        message: `版本重复：${version.version}（AppHub 要求同一 App 的版本号全局唯一）`,
      });
    }
    seen.add(version.version);
    if (!version.files.some((file) => file.path === version.entry)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['versions'],
        message: `版本 ${version.version} 的启动入口 ${version.entry} 不在文件列表中`,
      });
    }
    if (version.publishMode === 'zip' && !version.archive) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['versions'],
        message: `zip 发布方式缺少 archive 信息：${version.version}`,
      });
    }
    if (version.publishMode === 'files' && version.archive) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['versions'],
        message: `files 发布方式不应包含 archive 信息：${version.version}`,
      });
    }
  }
  for (const [platform, version] of Object.entries(meta.latest)) {
    if (version && !meta.versions.some((v) => v.version === version && v.platform === platform)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['latest'],
        message: `latest[${platform}] = ${version} 不存在于版本列表`,
      });
    }
  }
});

export const FilesFileSchemaStrict = FilesFileSchema.superRefine((files, ctx) => {
  if (files.fileCount !== files.files.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['fileCount'],
      message: `fileCount（${files.fileCount}）与文件数量（${files.files.length}）不一致`,
    });
  }
  const sum = files.files.reduce((acc, file) => acc + file.size, 0);
  if (sum !== files.totalSize) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['totalSize'],
      message: `totalSize（${files.totalSize}）与文件大小之和（${sum}）不一致`,
    });
  }
  if (!files.files.some((file) => file.path === files.entry)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['entry'],
      message: `启动入口 ${files.entry} 不在文件列表中`,
    });
  }
  if (files.publishMode === 'zip' && !files.archive) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['archive'], message: 'zip 发布方式缺少 archive 信息' });
  }
});

export const ChannelFileSchemaStrict = ChannelFileSchema.superRefine((channel, ctx) => {
  const seen = new Set<string>();
  for (const app of channel.apps) {
    if (seen.has(app.appId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['apps'],
        message: `App 重复登记：${app.appId}`,
      });
    }
    seen.add(app.appId);
  }
  if (channel.visibility === 'private' && channel.access?.type !== 'secret-url') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['access'],
      message: '私密频道必须声明 access.type = "secret-url"',
    });
  }
  if (channel.visibility === 'public' && channel.access) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['access'],
      message: '公开频道不应包含 access 字段',
    });
  }
});

export const ChannelPrivateFileSchemaStrict = ChannelPrivateFileSchema.superRefine((pri, ctx) => {
  if (pri.visibility === 'private' && !pri.accessKey) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['accessKey'],
      message: '私密频道的 channel_pri.json 必须包含 accessKey',
    });
  }
  if (pri.visibility === 'public' && pri.accessKey) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['accessKey'],
      message: '公开频道不应包含 accessKey',
    });
  }
});

// ---------------------------------------------------------------------------
// 解析助手（返回带默认值的规范化对象）
// ---------------------------------------------------------------------------

export const CHANNEL_SCHEMAS = {
  channel: ChannelFileSchemaStrict,
  channelPrivate: ChannelPrivateFileSchemaStrict,
  appMeta: AppMetaFileSchemaStrict,
  files: FilesFileSchemaStrict,
} as const;

/** 私密频道的存储前缀（用于展示/校验）。 */
export const PRIVATE_PREFIX_DIR = PRIVATE_ROOT_DIR;

/** 未知错误统一包装（供 zod 校验失败时使用）。 */
export function validationError(label: string, error: z.ZodError): AppError {
  const first = error.issues[0];
  const message = first ? `${label}：${first.message}${first.path.length ? `（${first.path.join('.')}）` : ''}` : `${label}校验失败`;
  return new AppError('VALIDATION', message, { issues: error.issues });
}
