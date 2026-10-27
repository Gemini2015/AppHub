import { AppError, channelDescriptorKey } from '@apphub/protocol';
import type { ChannelPrivateFile, StorageConfig } from '@apphub/protocol';
import type { StorageAdapter, StorageFactory } from '@apphub/storage';
import { runWithErrorLabel } from './errors';
import type { Logger } from './types';

/**
 * 发布端存储适配器的创建与公共 URL 推导。
 *
 * 说明：凭据只在 channel_pri 密文中，本模块不会把配置写入日志/错误信息。
 */

export interface StorageDeps {
  storageFactory: StorageFactory;
  logger?: Logger;
}

/** 同步创建适配器（失败统一映射为 STORAGE）。 */
export function createStorageAdapter(deps: StorageDeps, config: StorageConfig): StorageAdapter {
  try {
    return deps.storageFactory.create(config);
  } catch (error) {
    throw new AppError('STORAGE', `无法创建存储适配器（provider=${config.provider}）：${AppError.from(error).message}`);
  }
}

/** 连接探测；失败给出可读错误（不包含凭据）。 */
export async function probeStorage(deps: StorageDeps, config: StorageConfig): Promise<void> {
  const adapter = createStorageAdapter(deps, config);
  try {
    await runWithErrorLabel(`存储连接检查失败（provider=${config.provider}）`, () => adapter.probe(), 'STORAGE');
  } finally {
    await adapter.close().catch((error: unknown) => {
      deps.logger?.warn('关闭存储适配器失败', { reason: AppError.from(error).message });
    });
  }
}

/** 存储配置中附带的 HTTP 头（用于 HTTP 下载，例如 Basic Auth）。 */
export function storageHeaders(config: StorageConfig): Record<string, string> | undefined {
  switch (config.provider) {
    case 'local':
      return config.headers;
    case 'ftp-http':
      return config.http.headers;
    case 'local-host':
      // 本机内置 Host 不附加额外鉴权头
      return undefined;
    case 's3':
      return config.headers;
  }
}

/** channel.json 的存储对象 key（私密频道带 _private/<id>/<accessKey> 前缀）。 */
export function privateChannelDescriptorKey(pri: ChannelPrivateFile): string {
  return channelDescriptorKey(pri.visibility, pri.channelId, pri.accessKey);
}

/**
 * 由存储配置推导 channel.json 的公开 HTTP 地址。
 *
 * 统一委托给适配器的 getDownloadUrl(key)：各 provider 的 baseUrl / prefix /
 * 预签名逻辑（例如 S3 的 publicBaseUrl + prefix、私有桶临时 URL）只在存储层实现一份，
 * core 不重复拼接，避免语义分叉。
 */
export async function deriveSubscribeUrl(
  pri: ChannelPrivateFile,
  adapter: StorageAdapter,
): Promise<string> {
  const key = privateChannelDescriptorKey(pri);
  return runWithErrorLabel('生成频道订阅地址失败', () => adapter.getDownloadUrl(key), 'STORAGE');
}

/** 包装一次存储适配器调用（错误统一 STORAGE，保留 AppError code）。 */
export async function storageCall<T>(label: string, fn: () => Promise<T>): Promise<T> {
  return runWithErrorLabel(label, fn, 'STORAGE');
}
