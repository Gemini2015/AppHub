import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createMemoryStorageBacking } from '@apphub/storage';
import type {
  StorageAdapter,
  StorageAdapterProvider,
  StorageFactory,
  StorageWriteOptions,
} from '@apphub/storage';
import {
  createFakeClock,
  createFakeLogger,
  createFakeSecretBox,
  createTempDir,
  safeRemove,
} from '@apphub/testkit';
import type { FakeLogger, FakeSecretBox } from '@apphub/testkit';
import type {
  ChannelCreateInput,
  ChannelDetail,
  CoreContext,
  FetchLike,
  ProgressEvent,
  ProgressListener,
} from './types';
import type { LocalStorageConfig, StorageConfig } from '@apphub/protocol';
import { createAppHubCore } from './index';
import type { AppHubCore } from './types';

/**
 * @apphub/core 测试基础设施。
 *
 * 每个测试环境包含：
 *  - 独立临时 dataDir（真实文件 IO，验证原子写/缓存/安装目录）；
 *  - 共享的 MemoryStorageBacking（模拟远端存储，可被多个 env 共享以模拟"发布者+订阅者"）；
 *  - 记录写入顺序的 StorageAdapter 包装（断言 payload → files.json → app.meta.json → channel.json）；
 *  - 内存 fetchImpl（把 http://memory.local/<key> 映射到内存对象，走真实 HTTP 解析路径）；
 *  - fake SecretBox / Clock / Logger。
 */

export interface StoredObjectLike {
  data: Buffer;
  modifiedAt: string;
  contentType?: string;
}

export interface WriteRecord {
  op: 'writeText' | 'writeBinary' | 'delete';
  key: string;
}

export interface StorageFaults {
  probe?: (config: StorageConfig) => void;
  writeText?: (key: string, content: string) => void;
  writeBinary?: (key: string, data: Buffer) => void;
  readText?: (key: string) => void;
}

export interface FetchHookContext {
  key: string;
  url: string;
  init?: RequestInit;
}

export type MemoryFetchHook = (
  context: FetchHookContext,
) => Response | undefined | Promise<Response | undefined>;

export interface TestEnvOptions {
  /** 复用既有内存对象（模拟另一个 AppHub 实例/订阅者）。 */
  objects?: Map<string, StoredObjectLike>;
  keepVersions?: number;
  faults?: StorageFaults;
  fetchHook?: MemoryFetchHook;
  publicBaseUrl?: string;
  secretBox?: FakeSecretBox;
  /** 注入 CoreContext.defaultHeaders（测试 HTTP 默认请求头）。 */
  defaultHeaders?: Record<string, string>;
  /**
   * 覆盖适配器 getDownloadUrl 的行为（模拟真实 provider 的 baseUrl/prefix 语义，
   * 例如 S3：publicBaseUrl + prefix + key）。
   */
  getDownloadUrlOverride?: (key: string, inner: () => Promise<string>) => Promise<string>;
}

export interface TestEnv {
  dataDir: string;
  storageRoot: string;
  backing: ReturnType<typeof createMemoryStorageBacking>;
  objects: Map<string, StoredObjectLike>;
  secretBox: FakeSecretBox;
  clock: ReturnType<typeof createFakeClock>;
  logger: FakeLogger;
  writes: WriteRecord[];
  fetchRequests: string[];
  probes: { count: number };
  faults: StorageFaults;
  factory: StorageFactory;
  fetch: FetchLike;
  core: AppHubCore;
  setFetchHook(hook: MemoryFetchHook | undefined): void;
  storageConfig(overrides?: Partial<LocalStorageConfig>): StorageConfig;
  ftpHttpConfig(): StorageConfig;
  createChannel(overrides?: Partial<ChannelCreateInput>): Promise<ChannelDetail>;
  readObject(key: string): Buffer | null;
  readObjectText(key: string): string | null;
  readJsonObject<T = unknown>(key: string): T;
  setObject(key: string, data: string | Buffer): void;
  deleteObject(key: string): void;
  dispose(): Promise<void>;
}

/** 包装适配器以记录写入顺序，并支持故障注入。 */
class RecordingStorageAdapter implements StorageAdapter {
  readonly provider: StorageAdapterProvider;
  readonly config: StorageAdapter['config'];

  constructor(
    private readonly inner: StorageAdapter,
    private readonly writes: WriteRecord[],
    private readonly faults: StorageFaults,
    private readonly probes: { count: number },
    private readonly downloadUrlOverride?: (key: string, inner: () => Promise<string>) => Promise<string>,
  ) {
    this.provider = inner.provider;
    this.config = inner.config;
  }

  async probe(): Promise<void> {
    this.probes.count += 1;
    this.faults.probe?.(this.config as StorageConfig);
    return this.inner.probe();
  }

  async readText(key: string): Promise<string | null> {
    this.faults.readText?.(key);
    return this.inner.readText(key);
  }

  async readBinary(key: string): Promise<Buffer | null> {
    return this.inner.readBinary(key);
  }

  async exists(key: string): Promise<boolean> {
    return this.inner.exists(key);
  }

  async stat(key: string): Promise<{ size: number; modifiedAt?: string } | null> {
    return this.inner.stat(key);
  }

  async list(prefix: string): Promise<{ key: string; size: number; modifiedAt?: string }[]> {
    return this.inner.list(prefix);
  }

  async writeText(key: string, content: string): Promise<void> {
    this.faults.writeText?.(key, content);
    this.writes.push({ op: 'writeText', key });
    return this.inner.writeText(key, content);
  }

  async writeBinary(key: string, data: Buffer, options?: StorageWriteOptions): Promise<void> {
    this.faults.writeBinary?.(key, data);
    this.writes.push({ op: 'writeBinary', key });
    return this.inner.writeBinary(key, data, options);
  }

  async delete(key: string): Promise<void> {
    this.writes.push({ op: 'delete', key });
    return this.inner.delete(key);
  }

  async getDownloadUrl(key: string): Promise<string> {
    if (this.downloadUrlOverride) {
      return this.downloadUrlOverride(key, () => this.inner.getDownloadUrl(key));
    }
    return this.inner.getDownloadUrl(key);
  }

  async close(): Promise<void> {
    return this.inner.close();
  }
}

/** 创建映射到内存存储对象的 fetch 实现（模拟 nginx 静态下载）。 */
export function createMemoryFetch(
  objects: Map<string, { data: Buffer }>,
  options: {
    requests?: string[];
    hook?: () => MemoryFetchHook | undefined;
  } = {},
): FetchLike {
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString();
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return new Response('bad url', { status: 400 });
    }
    if (parsed.hostname !== 'memory.local') {
      return new Response('not found', { status: 404, statusText: 'Not Found' });
    }
    let key: string;
    try {
      key = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));
    } catch {
      return new Response('bad url', { status: 400 });
    }
    options.requests?.push(key);
    const override = await options.hook?.()?.({ key, url, init });
    if (override) return override;
    const object = objects.get(key);
    if (!object) return new Response('not found', { status: 404, statusText: 'Not Found' });
    return new Response(object.data, {
      status: 200,
      headers: { 'content-length': String(object.data.length) },
    });
  };
}

export async function createTestEnv(options: TestEnvOptions = {}): Promise<TestEnv> {
  const dataDir = await createTempDir('apphub-core-data-');
  const storageRoot = await createTempDir('apphub-core-storage-');
  const publicBaseUrl = options.publicBaseUrl ?? 'http://memory.local/';
  const backing = createMemoryStorageBacking({
    ...(options.objects ? { objects: options.objects as never } : {}),
    publicBaseUrl,
  });
  const objects = backing.objects as unknown as Map<string, StoredObjectLike>;
  const secretBox = options.secretBox ?? createFakeSecretBox();
  const clock = createFakeClock('2026-01-01T00:00:00.000Z');
  const logger = createFakeLogger();
  const writes: WriteRecord[] = [];
  const fetchRequests: string[] = [];
  const probes = { count: 0 };
  const faults: StorageFaults = options.faults ?? {};
  let fetchHook: MemoryFetchHook | undefined = options.fetchHook;
  const fetch = createMemoryFetch(objects, {
    requests: fetchRequests,
    hook: () => fetchHook,
  });
  const factory: StorageFactory = {
    create: (config) =>
      new RecordingStorageAdapter(
        backing.factory.create(config),
        writes,
        faults,
        probes,
        options.getDownloadUrlOverride,
      ),
  };
  const context: CoreContext = {
    dataDir,
    storageFactory: factory,
    secretBox,
    clock,
    logger,
    fetchImpl: fetch,
    ...(options.keepVersions !== undefined ? { keepVersions: options.keepVersions } : {}),
    ...(options.defaultHeaders ? { defaultHeaders: options.defaultHeaders } : {}),
  };
  const core = createAppHubCore(context);

  const readObject = (key: string): Buffer | null => {
    const object = objects.get(key);
    return object ? Buffer.from(object.data) : null;
  };

  const env: TestEnv = {
    dataDir,
    storageRoot,
    backing,
    objects,
    secretBox,
    clock,
    logger,
    writes,
    fetchRequests,
    probes,
    faults,
    factory,
    fetch,
    core,
    setFetchHook: (hook) => {
      fetchHook = hook;
    },
    storageConfig: (overrides = {}) => ({
      provider: 'local',
      rootDir: storageRoot,
      publicBaseUrl,
      ...overrides,
    }),
    ftpHttpConfig: () => ({
      provider: 'ftp-http',
      ftp: {
        host: '127.0.0.1',
        port: 21,
        secure: false,
        user: 'apphub',
        password: 'secret-password',
        rootDir: 'app_repo/',
        passive: true,
        timeoutMs: 20000,
      },
      http: { baseUrl: publicBaseUrl },
    }),
    createChannel: async (overrides = {}) =>
      core.channels.create({
        name: '测试频道',
        visibility: 'public',
        storage: env.storageConfig(),
        skipProbe: false,
        ...overrides,
      }),
    readObject,
    readObjectText: (key) => readObject(key)?.toString('utf8') ?? null,
    readJsonObject: <T = unknown>(key: string): T => {
      const text = readObject(key)?.toString('utf8');
      if (text === undefined) throw new Error(`对象不存在：${key}`);
      return JSON.parse(text) as T;
    },
    setObject: (key, data) => {
      backing.adapter.unsafeSet(key, typeof data === 'string' ? data : Buffer.from(data));
    },
    deleteObject: (key) => {
      backing.objects.delete(key);
    },
    dispose: async () => {
      await core.close();
      await safeRemove(dataDir);
      await safeRemove(storageRoot);
    },
  };
  return env;
}

export interface ProgressRecorder {
  events: ProgressEvent[];
  listener: ProgressListener;
  phases(): string[];
}

/** 记录进度事件序列，供断言"真实进度"。 */
export function recordProgress(): ProgressRecorder {
  const events: ProgressEvent[] = [];
  return {
    events,
    listener: (event) => {
      events.push(event);
    },
    phases: () => events.map((event) => event.phase),
  };
}

/** 断言 Promise 失败且错误码匹配。 */
export async function expectAppError(
  promise: Promise<unknown>,
  code?: string,
): Promise<{ code: string; message: string }> {
  try {
    await promise;
  } catch (error) {
    const appError = error as { code?: string; message?: string; isAppHubError?: boolean };
    if (appError?.isAppHubError !== true) {
      throw new Error(`期望 AppError，实际抛出：${String(error)}`);
    }
    if (code && appError.code !== code) {
      throw new Error(`期望错误码 ${code}，实际 ${appError.code}：${appError.message}`);
    }
    return { code: appError.code ?? '', message: appError.message ?? '' };
  }
  throw new Error('期望抛出 AppError，但调用成功返回');
}

/** 在临时目录里写文件树（用于发布源文件）。 */
export async function writeFixtureFiles(
  rootDir: string,
  files: Record<string, string | Buffer>,
): Promise<string[]> {
  const paths: string[] = [];
  for (const [relativePath, content] of Object.entries(files)) {
    const target = path.join(rootDir, ...relativePath.split('/'));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
    paths.push(target);
  }
  return paths;
}
