import { AppError } from '@apphub/protocol';
import type { StorageConfig } from '@apphub/protocol';
import type { StorageAdapter, StorageFactory } from './types';

/**
 * 存储适配器工厂（各 provider 的实现由 storage-dev 在 ./adapters 下完成）。
 *
 * 契约：create() 同步返回适配器；连接在首次操作时惰性建立；
 * 调用方负责在 finally 中 close()。
 */
export function createStorageAdapter(config: StorageConfig): StorageAdapter {
  throw new AppError(
    'UNSUPPORTED',
    `暂不支持的存储类型：${(config as { provider?: string }).provider}`,
  );
}

export function createStorageFactory(): StorageFactory {
  return {
    create: (config) => createStorageAdapter(config),
  };
}
