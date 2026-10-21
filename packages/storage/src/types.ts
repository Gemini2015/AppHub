import type { StorageConfig } from '@apphub/protocol';

/**
 * 存储适配器契约。
 *
 * 设计目标：
 *  - 发布端（owner/admin）通过 provider 原生协议写入：FTP / S3 / 本地目录；
 *  - 订阅端只依赖公开 HTTP 地址读取（由 core 的 HTTP 客户端完成，不需要适配器）；
 *  - 新增存储后端（MinIO、WebDAV、OSS...）时只需实现本接口并注册到工厂。
 *
 * key 规则：
 *  - 所有 key 都是相对于"频道存储根目录"的 POSIX 相对路径，例如
 *    `channel.json`、`foobar/app.meta.json`、`_private/<channelId>/<accessKey>/channel.json`；
 *  - 适配器内部负责 rootDir/prefix 拼接与目录创建；
 *  - 非法 key（绝对路径、`..`、Windows 保留名等）必须抛出 AppError('SECURITY'/'VALIDATION')。
 */

export interface StorageEntry {
  key: string;
  size: number;
  /** ISO 时间字符串（若后端支持）。 */
  modifiedAt?: string;
}

export interface StorageStat {
  size: number;
  modifiedAt?: string;
}

export interface StorageWriteOptions {
  contentType?: string;
  /** 可执行位（本地/S3 元数据可选；FTP 无法保证）。 */
  executable?: boolean;
}

/** 发布端使用的存储适配器。 */
export interface StorageAdapter {
  readonly provider: StorageAdapterProvider;
  /** 具体存储配置（含凭据，禁止直接写入日志或 UI）。 */
  readonly config: StorageConfig | MemoryStorageConfig;

  /** 连通性检查；失败抛出带可读诊断信息的 AppError。 */
  probe(): Promise<void>;

  /** 读取文本；不存在返回 null。 */
  readText(key: string): Promise<string | null>;
  /** 读取二进制；不存在返回 null。 */
  readBinary(key: string): Promise<Buffer | null>;
  /** 是否存在于存储中。 */
  exists(key: string): Promise<boolean>;
  /** 读取文件大小等元信息；不存在返回 null。 */
  stat(key: string): Promise<StorageStat | null>;
  /** 列出指定前缀下的对象（prefix 为空表示根目录）。 */
  list(prefix: string): Promise<StorageEntry[]>;

  writeText(key: string, content: string): Promise<void>;
  writeBinary(key: string, data: Buffer, options?: StorageWriteOptions): Promise<void>;
  delete(key: string): Promise<void>;

  /** 获取该对象的公开 HTTP 下载地址（供订阅者/测试/分享使用）。 */
  getDownloadUrl(key: string): Promise<string>;

  /** 释放底层连接（FTP 连接池、S3 agent 等）。 */
  close(): Promise<void>;
}

export type StorageAdapterProvider = StorageConfig['provider'] | 'memory';

/** 测试用内存存储配置（不属于线上协议）。 */
export interface MemoryStorageConfig {
  provider: 'memory';
  /** getDownloadUrl 使用的假地址前缀。 */
  publicBaseUrl?: string;
}

export interface StorageFactory {
  create(config: StorageConfig): StorageAdapter;
}

export interface ProbeCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface ProbeReport {
  ok: boolean;
  checks: ProbeCheck[];
}
