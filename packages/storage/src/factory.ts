import { AppError } from '@apphub/protocol';
import type { StorageConfig } from '@apphub/protocol';
import { FtpHttpStorageAdapter } from './adapters/ftp-http';
import { LocalHostStorageAdapter } from './adapters/local-host';
import { LocalStorageAdapter } from './adapters/local';
import { S3StorageAdapter } from './adapters/s3';
import type { StorageAdapter, StorageFactory } from './types';

/**
 * 存储适配器工厂。
 *
 * 契约：create() 同步返回适配器；网络连接在首次操作时惰性建立；
 * 调用方负责在 finally 中 close()。
 *
 * 扩展新 provider：实现 StorageAdapter + 在下面 switch 注册 + 在 docs/STORAGE.md 补充配置说明。
 */
export function createStorageAdapter(config: StorageConfig): StorageAdapter {
  if (config === null || typeof config !== 'object') {
    throw new AppError('UNSUPPORTED', `暂不支持的存储类型：${String(config)}`);
  }
  switch (config.provider) {
    case 'local':
      return new LocalStorageAdapter(config);
    case 'local-host':
      // 本机 Host：本地目录读写 + 由本机网卡/端口推导公开下载地址（不绑定端口）
      return new LocalHostStorageAdapter(config);
    case 'ftp-http':
      return new FtpHttpStorageAdapter(config);
    case 's3':
      return new S3StorageAdapter(config);
    default: {
      // 正常流程下 zod 已经限制了 provider，这里的防御性分支只用于：
      //  - 旧数据/手工构造的配置对象
      //  - 未来协议先行、实现未跟上的版本
      const provider = (config as { provider?: unknown } | null)?.provider;
      throw new AppError('UNSUPPORTED', `暂不支持的存储类型：${String(provider)}`);
    }
  }
}

export function createStorageFactory(): StorageFactory {
  return {
    create: (config) => createStorageAdapter(config),
  };
}
