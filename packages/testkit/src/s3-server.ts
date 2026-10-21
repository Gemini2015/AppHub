/// <reference path="./s3rver.d.ts" />
import { promises as fs } from 'node:fs';
import path from 'node:path';
import S3rver from 's3rver';
import { createTempDir, safeRemove } from './temp';

/**
 * 进程内 S3 兼容服务器（基于 s3rver），用于模拟 MinIO / AWS S3。
 *
 * - 默认在系统临时目录创建数据目录并预创建桶，close 时清空并删除；
 * - 默认监听 127.0.0.1 的随机端口（0 = 系统分配）；
 * - 默认凭据为 s3rver 内置账号（S3RVER / S3RVER），S3 适配器测试需使用同样凭据；
 * - 支持匿名 GET（s3rver 对未签名请求不做鉴权），因此可用来验证 `publicBaseUrl` 公开读；
 * - 支持预签名 URL（s3rver 对 SigV4 签名不做严格校验，但会检查 accessKeyId 是否存在）。
 */
export interface S3TestServerOptions {
  /** 预创建的桶列表，默认 ['apphub-test']。 */
  buckets?: string[];
  /** 单桶简写；与 buckets 同时提供时以 buckets 为准。 */
  bucket?: string;
  /** 数据目录；默认创建临时目录并自动清理。 */
  directory?: string;
  /** 监听地址，默认 127.0.0.1。 */
  host?: string;
  /** HTTP 端口，默认 0（系统分配）。 */
  port?: number;
  /** 访问凭据；默认 s3rver 内置的 S3RVER/S3RVER。 */
  accessKey?: string;
  secretKey?: string;
}

export interface S3TestServer {
  host: string;
  port: number;
  /** `http://host:port`（S3 适配器的 endpoint）。 */
  endpoint: string;
  /** 已创建的桶列表。 */
  buckets: string[];
  /** 第一个桶（单桶场景便捷访问）。 */
  bucket: string;
  /** s3rver 的数据目录（绝对路径）。 */
  directory: string;
  accessKey: string;
  secretKey: string;
  close(): Promise<void>;
}

export async function startS3TestServer(options: S3TestServerOptions = {}): Promise<S3TestServer> {
  const host = options.host ?? '127.0.0.1';
  const autoDirectory = options.directory === undefined;
  const directory = path.resolve(options.directory ?? (await createTempDir('apphub-s3-')));
  await fs.mkdir(directory, { recursive: true });

  const buckets = options.buckets ?? (options.bucket ? [options.bucket] : ['apphub-test']);
  if (buckets.length === 0) throw new Error('S3 测试服务器至少需要一个桶');
  const accessKey = options.accessKey ?? 'S3RVER';
  const secretKey = options.secretKey ?? 'S3RVER';

  const server = new S3rver({
    address: host,
    port: options.port ?? 0,
    silent: true,
    directory,
    resetOnClose: true,
    configureBuckets: buckets.map((name) => ({ name })),
    vhostBuckets: true,
  });

  let address: { port: number };
  try {
    address = await server.run();
  } catch (error) {
    if (autoDirectory) await safeRemove(directory);
    throw error;
  }

  let closed = false;
  return {
    host,
    port: address.port,
    endpoint: `http://${host}:${address.port}`,
    buckets,
    bucket: buckets[0]!,
    directory,
    accessKey,
    secretKey,
    async close() {
      if (closed) return;
      closed = true;
      await Promise.resolve(server.close()).catch(() => undefined);
      if (autoDirectory) await safeRemove(directory);
    },
  };
}

/** `startS3Server` 是 `startS3TestServer` 的简写别名。 */
export const startS3Server = startS3TestServer;
