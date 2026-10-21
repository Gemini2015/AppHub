import type { Readable } from 'node:stream';
import { Client as MinioClient } from 'minio';
import { AppError, appendUrl } from '@apphub/protocol';
import type { S3StorageConfig } from '@apphub/protocol';
import { assertStorageKey } from '../memory';
import type {
  StorageAdapter,
  StorageAdapterProvider,
  StorageEntry,
  StorageStat,
  StorageWriteOptions,
} from '../types';
import { isS3NotFound, mapS3Error, normalizeDirPrefix, normalizeListPrefix } from './common';

/** 预签名 URL 有效期：7 天（S3 允许的最大值）。 */
const PRESIGNED_EXPIRY_SECONDS = 7 * 24 * 60 * 60;

const DEFAULT_ENDPOINT = 's3.amazonaws.com';

/** 把 MinIO SDK 返回的对象流收集为 Buffer。 */
function collectStream(stream: Readable): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer | string) => {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk));
    });
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', (error) => reject(error));
  });
}

/**
 * S3 / MinIO 存储适配器（minio SDK，S3 兼容协议）。
 *
 * - `endpoint` 为空表示 AWS S3；存在时按 URL 的 http/https 决定是否 TLS；
 * - `prefix` 为频道根目录的对象前缀（空串 = 桶根目录）；
 * - `publicBaseUrl` 存在时下载地址直接拼接公开桶地址；否则生成 7 天有效的预签名 URL。
 */
export class S3StorageAdapter implements StorageAdapter {
  readonly provider: StorageAdapterProvider = 's3';
  readonly config: S3StorageConfig;

  /** 归一化后的对象前缀，始终以 `/` 结尾（空串表示桶根目录）。 */
  private readonly objectPrefix: string;
  private client: MinioClient | null = null;

  constructor(config: S3StorageConfig) {
    this.config = config;
    if (!config.bucket || config.bucket.trim().length === 0) {
      throw new AppError('VALIDATION', 'S3 存储配置缺少 bucket');
    }
    const prefix = normalizeDirPrefix(config.prefix ?? '', 'S3 对象前缀');
    this.objectPrefix = prefix === '' ? '' : `${prefix}/`;
  }

  // ------------------------------------------------------------------ 客户端

  private getClient(): MinioClient {
    if (this.client) return this.client;
    const { config } = this;
    let endPoint: string;
    let port: number;
    let useSSL: boolean;

    if (config.endpoint) {
      let url: URL;
      try {
        url = new URL(config.endpoint);
      } catch {
        throw new AppError('VALIDATION', `S3 endpoint 不是合法 URL：${config.endpoint}`);
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new AppError('VALIDATION', `S3 endpoint 仅支持 http/https：${config.endpoint}`);
      }
      if (url.pathname !== '/' && url.pathname !== '') {
        // minio SDK 不支持 path 形式的 endpoint（反向代理子路径），提前给出可读错误
        throw new AppError(
          'UNSUPPORTED',
          `S3 endpoint 不能包含子路径（${url.pathname}）：请使用 http(s)://host:port 形式，前缀请配置在 prefix 中`,
        );
      }
      endPoint = url.hostname;
      useSSL = url.protocol === 'https:';
      port = url.port ? Number(url.port) : useSSL ? 443 : 80;
    } else {
      endPoint = DEFAULT_ENDPOINT;
      useSSL = config.secure;
      port = config.secure ? 443 : 80;
    }

    try {
      this.client = new MinioClient({
        endPoint,
        port,
        useSSL,
        accessKey: config.accessKey,
        secretKey: config.secretKey,
        region: config.region,
        pathStyle: config.pathStyle,
      });
    } catch (error) {
      throw mapS3Error(error, `初始化 S3 客户端失败（endpoint=${endPoint}:${port}）`);
    }
    return this.client;
  }

  /** 频道内 key → 桶内对象名（加 prefix）。 */
  private objectNameOf(key: string): string {
    return `${this.objectPrefix}${assertStorageKey(key)}`;
  }

  /** 桶内对象名 → 频道内 key。 */
  private keyOf(objectName: string): string {
    return this.objectPrefix && objectName.startsWith(this.objectPrefix)
      ? objectName.slice(this.objectPrefix.length)
      : objectName;
  }

  // ------------------------------------------------------------------ 探测

  async probe(): Promise<void> {
    const client = this.getClient();
    try {
      const exists = await client.bucketExists(this.config.bucket);
      if (!exists) {
        throw new AppError(
          'NOT_FOUND',
          `S3 bucket 不存在（bucket=${this.config.bucket}）；请先在 MinIO/S3 中创建桶并确认账号有权限`,
        );
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw mapS3Error(error, `S3 存储探测失败（bucket=${this.config.bucket}）`);
    }
  }

  // ------------------------------------------------------------------ 读

  async readText(key: string): Promise<string | null> {
    const binary = await this.readBinary(key);
    return binary === null ? null : binary.toString('utf8');
  }

  async readBinary(key: string): Promise<Buffer | null> {
    const client = this.getClient();
    const objectName = this.objectNameOf(key);
    try {
      const stream = await client.getObject(this.config.bucket, objectName);
      return await collectStream(stream);
    } catch (error) {
      if (isS3NotFound(error)) return null;
      throw mapS3Error(error, `读取 S3 对象失败：${key}`);
    }
  }

  async exists(key: string): Promise<boolean> {
    return (await this.stat(key)) !== null;
  }

  async stat(key: string): Promise<StorageStat | null> {
    const client = this.getClient();
    const objectName = this.objectNameOf(key);
    try {
      const stat = await client.statObject(this.config.bucket, objectName);
      return {
        size: stat.size,
        modifiedAt: stat.lastModified instanceof Date ? stat.lastModified.toISOString() : undefined,
      };
    } catch (error) {
      if (isS3NotFound(error)) return null;
      throw mapS3Error(error, `读取 S3 对象元信息失败：${key}`);
    }
  }

  async list(prefix: string): Promise<StorageEntry[]> {
    const client = this.getClient();
    const normalizedPrefix = normalizeListPrefix(prefix);
    const objectPrefix = `${this.objectPrefix}${normalizedPrefix}`;
    const stream = client.listObjectsV2(this.config.bucket, objectPrefix, true);

    const entries = await new Promise<StorageEntry[]>((resolve, reject) => {
      const collected: StorageEntry[] = [];
      stream.on('data', (item: { name?: string; size?: number; lastModified?: Date }) => {
        if (!item.name) return; // 递归列举不会出现目录占位对象，这里只是类型兜底
        const key = this.keyOf(item.name);
        if (!key.startsWith(normalizedPrefix)) return;
        collected.push({
          key,
          size: item.size ?? 0,
          modifiedAt: item.lastModified instanceof Date ? item.lastModified.toISOString() : undefined,
        });
      });
      stream.on('end', () => resolve(collected));
      stream.on('error', (error) => reject(error));
    }).catch((error) => {
      throw mapS3Error(error, `列出 S3 对象失败：${prefix}`);
    });

    return entries.sort((a, b) => a.key.localeCompare(b.key));
  }

  // ------------------------------------------------------------------ 写

  async writeText(key: string, content: string): Promise<void> {
    if (typeof content !== 'string') {
      throw new AppError('VALIDATION', 'writeText 需要字符串内容');
    }
    await this.writeBinary(key, Buffer.from(content, 'utf8'), {
      contentType: 'application/json; charset=utf-8',
    });
  }

  async writeBinary(key: string, data: Buffer, options?: StorageWriteOptions): Promise<void> {
    if (!Buffer.isBuffer(data)) {
      throw new AppError('VALIDATION', 'writeBinary 需要 Buffer 数据');
    }
    const client = this.getClient();
    const objectName = this.objectNameOf(key);
    try {
      await client.putObject(this.config.bucket, objectName, data, data.length, {
        'Content-Type': options?.contentType ?? 'application/octet-stream',
      });
    } catch (error) {
      throw mapS3Error(error, `写入 S3 对象失败：${key}`);
    }
  }

  async delete(key: string): Promise<void> {
    const client = this.getClient();
    const objectName = this.objectNameOf(key);
    try {
      // S3 DeleteObject 对不存在的对象同样返回成功，天然幂等
      await client.removeObject(this.config.bucket, objectName);
    } catch (error) {
      throw mapS3Error(error, `删除 S3 对象失败：${key}`);
    }
  }

  async getDownloadUrl(key: string): Promise<string> {
    const objectName = this.objectNameOf(key);
    if (this.config.publicBaseUrl) {
      return appendUrl(this.config.publicBaseUrl, objectName);
    }
    const client = this.getClient();
    try {
      return await client.presignedGetObject(
        this.config.bucket,
        objectName,
        PRESIGNED_EXPIRY_SECONDS,
      );
    } catch (error) {
      throw mapS3Error(error, `生成 S3 预签名下载地址失败：${key}`);
    }
  }

  async close(): Promise<void> {
    // minio Client 没有公开的 close()：丢弃引用即可，底层 http agent 随实例被 GC 回收
    this.client = null;
  }
}
