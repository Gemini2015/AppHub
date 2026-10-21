import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createAppHubCore } from '@apphub/core';
import type { AppHubCore, CoreContext, FetchLike } from '@apphub/core';
import type { FtpHttpStorageConfig, LocalStorageConfig, S3StorageConfig } from '@apphub/protocol';
import { createStorageFactory, type StorageFactory } from '@apphub/storage';
import {
  createFakeClock,
  createFakeLogger,
  createFakeSecretBox,
  createTempDir,
  safeRemove,
  startFtpTestServer,
  startS3TestServer,
  startStaticServer,
} from '@apphub/testkit';
import type { FtpTestServer, S3TestServer, StaticServer } from '@apphub/testkit';

/**
 * 真实 provider 的集成测试装置（A/B/E/F 场景）。
 *
 * - owner 端：真实的 @apphub/storage 适配器（FTP / 本地目录 / S3），进程内服务器模拟
 *   vsftpd + nginx / 静态服务器 / MinIO；
 * - subscriber 端：真实 HTTP（global fetch，记录请求 URL 以断言"确实走了 HTTP 下载"）；
 * - 全部进程内、离线可跑，不依赖外网或本机已安装的 FTP/S3 服务。
 */

export interface RealPeer {
  label: string;
  core: AppHubCore;
  dataDir: string;
}

export interface RealHarness {
  rootDir: string;
  storageFactory: StorageFactory;
  /** subscriber/owner 的 HTTP 客户端（记录全部请求 URL）。 */
  fetchImpl: FetchLike;
  httpRequests: string[];
  clock: ReturnType<typeof createFakeClock>;
  logger: ReturnType<typeof createFakeLogger>;
  newCore(label: string): Promise<RealPeer>;
  dispose(): Promise<void>;
}

export async function createRealHarness(): Promise<RealHarness> {
  const rootDir = await createTempDir('apphub-real-');
  const storageFactory = createStorageFactory();
  const httpRequests: string[] = [];
  const clock = createFakeClock();
  const logger = createFakeLogger();
  const peers: AppHubCore[] = [];
  const realFetch = globalThis.fetch.bind(globalThis);

  const fetchImpl: FetchLike = async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString();
    httpRequests.push(url);
    return realFetch(input, init);
  };

  const harness: RealHarness = {
    rootDir,
    storageFactory,
    fetchImpl,
    httpRequests,
    clock,
    logger,
    async newCore(label: string): Promise<RealPeer> {
      const dataDir = path.join(rootDir, 'peers', label);
      await fs.mkdir(dataDir, { recursive: true });
      const context: CoreContext = {
        dataDir,
        storageFactory,
        secretBox: createFakeSecretBox(),
        logger,
        clock,
        fetchImpl,
        keepVersions: 2,
      };
      const core = createAppHubCore(context);
      peers.push(core);
      return { label, core, dataDir };
    },
    async dispose() {
      for (const core of peers) {
        await core.close().catch(() => undefined);
      }
      await safeRemove(rootDir);
    },
  };
  return harness;
}

/** 「FTP 写入 + nginx 静态读取」环境（模拟用户自建 ftp+nginx）。 */
export interface FtpHttpEnv {
  kind: 'ftp-http';
  repoDir: string;
  ftpServer: FtpTestServer;
  staticServer: StaticServer;
  storageConfig: FtpHttpStorageConfig;
  close(): Promise<void>;
}

export async function startFtpHttpEnv(rootDir: string, options: { password?: string } = {}): Promise<FtpHttpEnv> {
  const repoDir = path.join(rootDir, 'app_repo');
  await fs.mkdir(repoDir, { recursive: true });
  const staticServer = await startStaticServer(repoDir);
  const password = options.password ?? 'apphub-ftp-password';
  const ftpServer = await startFtpTestServer({
    rootDir: repoDir,
    user: 'apphub',
    password,
  });
  const storageConfig: FtpHttpStorageConfig = {
    provider: 'ftp-http',
    ftp: {
      host: '127.0.0.1',
      port: ftpServer.port,
      secure: false,
      user: 'apphub',
      password,
      rootDir: '',
      passive: true,
      timeoutMs: 20_000,
    },
    http: { baseUrl: staticServer.baseUrl },
  };
  return {
    kind: 'ftp-http',
    repoDir,
    ftpServer,
    staticServer,
    storageConfig,
    async close() {
      await ftpServer.close();
      await staticServer.close();
    },
  };
}

/** 「本地目录 writes + 静态服务器 reads」环境（模拟 local provider）。 */
export interface LocalEnv {
  kind: 'local';
  repoDir: string;
  staticServer: StaticServer;
  storageConfig: LocalStorageConfig;
  close(): Promise<void>;
}

export async function startLocalEnv(rootDir: string): Promise<LocalEnv> {
  const repoDir = path.join(rootDir, 'local_repo');
  await fs.mkdir(repoDir, { recursive: true });
  const staticServer = await startStaticServer(repoDir);
  const storageConfig: LocalStorageConfig = {
    provider: 'local',
    rootDir: repoDir,
    publicBaseUrl: staticServer.baseUrl,
  };
  return {
    kind: 'local',
    repoDir,
    staticServer,
    storageConfig,
    async close() {
      await staticServer.close();
    },
  };
}

/** S3（s3rver）环境；publicBaseUrl 使用匿名可读的 path-style 地址。 */
export interface S3Env {
  kind: 's3';
  s3Server: S3TestServer;
  publicBaseUrl: string;
  storageConfig: S3StorageConfig;
  close(): Promise<void>;
}

export async function startS3Env(rootDir: string): Promise<S3Env> {
  const s3Server = await startS3TestServer({ buckets: ['apphub-e2e'] });
  const publicBaseUrl = `${s3Server.endpoint}/${s3Server.bucket}/`;
  const storageConfig: S3StorageConfig = {
    provider: 's3',
    endpoint: s3Server.endpoint,
    region: 'us-east-1',
    bucket: s3Server.bucket,
    accessKey: s3Server.accessKey,
    secretKey: s3Server.secretKey,
    pathStyle: true,
    secure: false,
    prefix: '',
    publicBaseUrl,
  };
  return {
    kind: 's3',
    s3Server,
    publicBaseUrl,
    storageConfig,
    async close() {
      await s3Server.close();
    },
  };
}

/** 断言 HTTP 请求记录中包含某个 URL 片段（用于证明走的是真实 HTTP 下载）。 */
export function requestedIncludes(harness: RealHarness, fragment: string): boolean {
  return harness.httpRequests.some((url) => url.includes(fragment));
}

/** 直接读取仓储目录中的 JSON（owner 端写入结果断言）。 */
export async function readRepoJson<T = unknown>(repoDir: string, relativePath: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fs.readFile(path.join(repoDir, ...relativePath.split('/')), 'utf8')) as T;
  } catch {
    return undefined;
  }
}
