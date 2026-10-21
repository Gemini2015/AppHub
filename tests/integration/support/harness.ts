import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createAppHubCore } from '@apphub/core';
import type { AppHubCore, CoreContext, FetchLike, PublishFileInput } from '@apphub/core';
import { isAppError, type LocalStorageConfig } from '@apphub/protocol';
import { appendUrl } from '@apphub/protocol';
import {
  createMemoryStorageBacking,
  type MemoryStorageAdapter,
  type MemoryStorageBacking,
  type StorageAdapter,
  type StorageFactory,
} from '@apphub/storage';
import {
  createFakeClock,
  createFakeLogger,
  createFakeSecretBox,
  createTempDir,
  safeRemove,
  writeFileTree,
} from '@apphub/testkit';

/**
 * tests/integration 的公共测试装置。
 *
 * 设计目标（见 docs/TESTING.md §集成测试）：
 *  - **完全离线**：发布端用内存存储适配器（@apphub/storage 的 memory backing），
 *    订阅端用注入的 fetchImpl 把 `http://memory.local/*` 映射到同一份内存对象，
 *    从而在不启动 FTP/nginx/S3 的情况下走通"真实 HTTP 语义"的元信息解析/下载链路；
 *  - **双 core 实例**：owner（发布者）与 subscriber（订阅者）各自独立的 dataDir，
 *    模拟两台机器的本地状态；
 *  - **可注入**：对象可被直接篡改（损坏文件/坏 JSON/越权路径），用于错误与安全用例；
 *  - **写入顺序可观测**：storageFactory 被包装后记录每次 write，用于断言
 *    `payload → files.json → app.meta.json → channel.json` 的上传顺序。
 */

/** core 仍是 stub 时动态跳过用例的原因（出现在 vitest 报告里，不允许静默跳过）。 */
export const CORE_PENDING_REASON =
  '等待 @apphub/core 实现：createAppHubCore 当前仍是 stub（抛 UNSUPPORTED）。' +
  '用例已写好，core 实现完成后会自动执行；状态见 docs/TESTING.md「当前执行状态」。';

export const MEMORY_PUBLIC_BASE_URL = 'http://memory.local/';

export interface CorePeer {
  label: string;
  core: AppHubCore;
  dataDir: string;
}

export interface Harness {
  /** 本次用例的临时根目录（结束后删除）。 */
  rootDir: string;
  /** 内存存储后端（对象 Map + 工厂 + 直接操作的 adapter）。 */
  backing: MemoryStorageBacking;
  /** 注入 core 的 fetchImpl：把 memory.local 上的请求映射到内存对象。 */
  fetchImpl: FetchLike;
  /** 注入 core 的存储工厂（内部已包一层写入记录）。 */
  storageFactory: StorageFactory;
  /** 用于 channels.create 的合法 StorageConfig（local provider；实际落在内存适配器上）。 */
  storageConfig: LocalStorageConfig;
  clock: ReturnType<typeof createFakeClock>;
  secretBox: ReturnType<typeof createFakeSecretBox>;
  logger: ReturnType<typeof createFakeLogger>;
  /** 通过 storageFactory 发生的写操作 key（按时间顺序）。 */
  storageWrites: string[];
  /** 创建一个新的 core 实例（独立 dataDir，等价于另一台机器/另一个用户）。 */
  newCore(label: string): Promise<CorePeer>;
  /** 直接读内存存储中的文本对象。 */
  readText(key: string): Promise<string | null>;
  /** 直接读内存存储中的 JSON 对象。 */
  readJson<T = unknown>(key: string): Promise<T | undefined>;
  /** 列出内存存储中的全部 key。 */
  keys(): string[];
  /** 清空的写入记录（在需要断言某次操作顺序前调用）。 */
  clearWrites(): void;
  /** 把 key 映射为公开 HTTP URL（memory.local），用于手工构造订阅地址。 */
  httpUrl(key: string): string;
  /** 错误注入：直接覆盖对象内容。 */
  injectText(key: string, content: string): void;
  injectBinary(key: string, data: Buffer): void;
  deleteObject(key: string): void;
  /** 在临时目录中写一棵源文件树，返回目录路径（发布用例的输入）。 */
  writeSourceFiles(name: string, files: Record<string, string | Buffer>): Promise<string>;
  dispose(): Promise<void>;
}

export interface SkipContext {
  skip(condition?: boolean, note?: string): void;
}

/** core 是否已实现（首次调用时探测并缓存）。 */
let availabilityPromise: Promise<boolean> | undefined;

export function isCoreImplemented(): Promise<boolean> {
  availabilityPromise ??= detectCoreAvailability();
  return availabilityPromise;
}

async function detectCoreAvailability(): Promise<boolean> {
  const probeDir = await createTempDir('apphub-core-probe-');
  try {
    const core = createAppHubCore({
      dataDir: probeDir,
      // 若 core 在构造期就访问存储，这里会抛 UNSUPPORTED；正常实现不会。
      storageFactory: {
        create: () => {
          throw new Error('probe storageFactory 不应被调用');
        },
      },
      secretBox: createFakeSecretBox(),
      logger: createFakeLogger(),
      clock: createFakeClock(),
    });
    try {
      await core.close();
    } catch {
      // 关闭失败不影响"是否实现"的判断
    }
    return true;
  } catch (error) {
    if (isAppError(error) && error.code === 'UNSUPPORTED') return false;
    // 非 stub 的异常意味着实现存在但构造失败 —— 必须让测试失败，不能误跳过
    throw error;
  } finally {
    await safeRemove(probeDir);
  }
}

/**
 * 标准用例包装：core 未实现时动态 skip（带可读原因），否则创建装置、执行、清理。
 *
 * 用法：
 * ```ts
 * it('...', async (t) => {
 *   await withHarness(t, async (h) => { ... });
 * });
 * ```
 */
export async function withHarness(
  t: SkipContext,
  fn: (h: Harness) => Promise<void>,
): Promise<void> {
  if (!(await isCoreImplemented())) {
    t.skip(true, CORE_PENDING_REASON);
    return;
  }
  const harness = await createHarness();
  try {
    await fn(harness);
  } finally {
    await harness.dispose();
  }
}

export async function createHarness(): Promise<Harness> {
  const rootDir = await createTempDir('apphub-int-');
  const backing = createMemoryStorageBacking({ publicBaseUrl: MEMORY_PUBLIC_BASE_URL });
  const clock = createFakeClock();
  const secretBox = createFakeSecretBox();
  const logger = createFakeLogger();
  const storageWrites: string[] = [];
  const storageFactory = createRecordingFactory(backing.factory, storageWrites);
  const fetchImpl = createMemoryFetchImpl(backing.adapter);
  const peers: AppHubCore[] = [];

  const storageConfig: LocalStorageConfig = {
    provider: 'local',
    rootDir: path.join(rootDir, 'remote-repo'),
    publicBaseUrl: MEMORY_PUBLIC_BASE_URL,
  };

  let peerCounter = 0;

  const harness: Harness = {
    rootDir,
    backing,
    fetchImpl,
    storageFactory,
    storageConfig,
    clock,
    secretBox,
    logger,
    storageWrites,
    async newCore(label: string): Promise<CorePeer> {
      peerCounter += 1;
      const dataDir = path.join(rootDir, 'peers', `${label}-${peerCounter}`);
      await fs.mkdir(dataDir, { recursive: true });
      const context: CoreContext = {
        dataDir,
        storageFactory,
        secretBox,
        logger,
        clock,
        fetchImpl,
        keepVersions: 2,
      };
      const core = createAppHubCore(context);
      peers.push(core);
      return { label, core, dataDir };
    },
    readText: (key) => backing.adapter.readText(key),
    async readJson<T = unknown>(key: string): Promise<T | undefined> {
      const text = await backing.adapter.readText(key);
      if (text === null) return undefined;
      try {
        return JSON.parse(text) as T;
      } catch {
        return undefined;
      }
    },
    keys: () => backing.adapter.keys(),
    clearWrites: () => {
      storageWrites.length = 0;
    },
    httpUrl: (key) => appendUrl(MEMORY_PUBLIC_BASE_URL, key),
    injectText: (key, content) => backing.adapter.unsafeSet(key, content),
    injectBinary: (key, data) => backing.adapter.unsafeSet(key, data),
    deleteObject: (key) => {
      void backing.adapter.delete(key);
    },
    writeSourceFiles: async (name, files) => {
      const dir = path.join(rootDir, 'sources', name);
      await writeFileTree(
        dir,
        Object.entries(files).map(([filePath, content]) => ({ path: filePath, content })),
      );
      return dir;
    },
    async dispose() {
      for (const core of peers) {
        try {
          await core.close();
        } catch {
          // 用例失败时优先保留原始错误
        }
      }
      await safeRemove(rootDir);
    },
  };

  return harness;
}

/** 把 sourceDir 下的相对路径列表转换为 core 的 PublishFileInput[]。 */
export function toPublishFiles(sourceDir: string, relativePaths: readonly string[]): PublishFileInput[] {
  return relativePaths.map((relativePath) => ({
    sourcePath: path.join(sourceDir, ...relativePath.split('/')),
    targetPath: relativePath,
  }));
}

/** 创建频道的最常用入参（测试里用这个 + 覆盖需要变化的字段）。 */
export async function createChannel(
  peer: CorePeer,
  harness: Harness,
  options: { name?: string; visibility?: 'public' | 'private'; description?: string } = {},
) {
  return peer.core.channels.create({
    name: options.name ?? '集成测试频道',
    description: options.description ?? 'tests/integration 自动创建的测试频道',
    visibility: options.visibility ?? 'public',
    owner: { name: 'AppHub QA', contact: 'qa@example.com' },
    storage: harness.storageConfig,
  });
}

// ---------------------------------------------------------------------------
// 内部实现：写入记录工厂 + 内存 fetch
// ---------------------------------------------------------------------------

function createRecordingFactory(base: StorageFactory, writes: string[]): StorageFactory {
  return {
    create(config): StorageAdapter {
      const inner = base.create(config);
      return {
        provider: inner.provider,
        config: inner.config,
        probe: () => inner.probe(),
        readText: (key) => inner.readText(key),
        readBinary: (key) => inner.readBinary(key),
        exists: (key) => inner.exists(key),
        stat: (key) => inner.stat(key),
        list: (prefix) => inner.list(prefix),
        writeText: async (key, content) => {
          writes.push(key);
          return inner.writeText(key, content);
        },
        writeBinary: async (key, data, options) => {
          writes.push(key);
          return inner.writeBinary(key, data, options);
        },
        delete: (key) => inner.delete(key),
        getDownloadUrl: (key) => inner.getDownloadUrl(key),
        close: () => inner.close(),
      } satisfies StorageAdapter;
    },
  };
}

function createMemoryFetchImpl(adapter: MemoryStorageAdapter): FetchLike {
  return async (input) => {
    const url = new URL(input.toString());
    if (url.origin !== 'http://memory.local') {
      // 离线约束：任何指向外部网络的请求都直接失败，避免测试意外联网
      return new Response(`offline: ${url.origin}`, { status: 503, statusText: 'Offline' });
    }
    const key = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
    const data = await adapter.readBinary(key);
    if (!data) {
      return new Response('not found', { status: 404, statusText: 'Not Found' });
    }
    return new Response(new Uint8Array(data), {
      status: 200,
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': String(data.length),
      },
    });
  };
}
