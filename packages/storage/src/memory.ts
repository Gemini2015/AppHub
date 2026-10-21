import { AppError, appendUrl, isSafeRelativePath } from '@apphub/protocol';
import type {
  MemoryStorageConfig,
  StorageAdapter,
  StorageAdapterProvider,
  StorageEntry,
  StorageFactory,
  StorageStat,
  StorageWriteOptions,
} from './types';

interface StoredObject {
  data: Buffer;
  modifiedAt: string;
  contentType?: string;
}

/** 校验并归一化存储对象 key。 */
export function assertStorageKey(key: string): string {
  if (typeof key !== 'string' || key.length === 0) {
    throw new AppError('VALIDATION', '存储对象 key 不能为空');
  }
  const normalized = key.replace(/^\/+/, '');
  if (!isSafeRelativePath(normalized)) {
    throw new AppError('SECURITY', `非法的存储对象 key：${key}`);
  }
  return normalized;
}

function normalizePrefix(prefix: string): string {
  if (!prefix) return '';
  const trimmed = prefix.replace(/^\/+/, '').replace(/\/+$/, '');
  if (trimmed === '') return '';
  return `${assertStorageKey(trimmed)}/`;
}

/**
 * 内存存储适配器：用于单元测试、演示与"无外部依赖"的集成测试。
 * 实例之间共享同一个 Map，便于测试中观察/注入对象。
 */
export class MemoryStorageAdapter implements StorageAdapter {
  readonly provider: StorageAdapterProvider = 'memory';
  readonly config: MemoryStorageConfig;

  constructor(
    private readonly objects: Map<string, StoredObject>,
    options: MemoryStorageConfig = { provider: 'memory' },
  ) {
    this.config = options;
  }

  private get baseUrl(): string {
    return this.config.publicBaseUrl ?? 'http://memory.local/';
  }

  async probe(): Promise<void> {
    // 内存实现永远可用
  }

  async readText(key: string): Promise<string | null> {
    const object = this.objects.get(assertStorageKey(key));
    return object ? object.data.toString('utf8') : null;
  }

  async readBinary(key: string): Promise<Buffer | null> {
    const object = this.objects.get(assertStorageKey(key));
    return object ? Buffer.from(object.data) : null;
  }

  async exists(key: string): Promise<boolean> {
    return this.objects.has(assertStorageKey(key));
  }

  async stat(key: string): Promise<StorageStat | null> {
    const object = this.objects.get(assertStorageKey(key));
    return object ? { size: object.data.length, modifiedAt: object.modifiedAt } : null;
  }

  async list(prefix: string): Promise<StorageEntry[]> {
    const normalized = normalizePrefix(prefix);
    return [...this.objects.entries()]
      .filter(([key]) => key.startsWith(normalized))
      .map(([key, object]) => ({ key, size: object.data.length, modifiedAt: object.modifiedAt }))
      .sort((a, b) => a.key.localeCompare(b.key));
  }

  async writeText(key: string, content: string): Promise<void> {
    await this.writeBinary(key, Buffer.from(content, 'utf8'), { contentType: 'application/json' });
  }

  async writeBinary(key: string, data: Buffer, options?: StorageWriteOptions): Promise<void> {
    const normalized = assertStorageKey(key);
    this.objects.set(normalized, {
      data: Buffer.from(data),
      modifiedAt: new Date().toISOString(),
      contentType: options?.contentType,
    });
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(assertStorageKey(key));
  }

  async getDownloadUrl(key: string): Promise<string> {
    return appendUrl(this.baseUrl, assertStorageKey(key));
  }

  async close(): Promise<void> {
    // 无连接需要释放
  }

  /** 测试辅助：直接写入对象（绕过 key 校验，用于构造异常数据）。 */
  unsafeSet(key: string, data: Buffer | string): void {
    this.objects.set(key, {
      data: typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data),
      modifiedAt: new Date().toISOString(),
    });
  }

  /** 测试辅助：列出全部对象 key。 */
  keys(): string[] {
    return [...this.objects.keys()].sort();
  }

  /** 测试辅助：读取原始对象。 */
  snapshot(): Record<string, Buffer> {
    const out: Record<string, Buffer> = {};
    for (const [key, object] of this.objects) out[key] = Buffer.from(object.data);
    return out;
  }
}

export interface MemoryStorageBacking {
  adapter: MemoryStorageAdapter;
  factory: StorageFactory;
  objects: Map<string, StoredObject>;
}

/**
 * 创建共享同一个对象 Map 的内存存储工厂。
 * 每次 factory.create() 返回新的适配器实例，但数据共享（模拟持久化存储）。
 */
export function createMemoryStorageBacking(
  options: { objects?: Map<string, StoredObject>; publicBaseUrl?: string } = {},
): MemoryStorageBacking {
  const objects = options.objects ?? new Map<string, StoredObject>();
  const config: MemoryStorageConfig = {
    provider: 'memory',
    publicBaseUrl: options.publicBaseUrl ?? 'http://memory.local/',
  };
  const adapter = new MemoryStorageAdapter(objects, config);
  const factory: StorageFactory = {
    create: () => new MemoryStorageAdapter(objects, config),
  };
  return { adapter, factory, objects };
}
