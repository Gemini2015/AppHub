import { AppError } from '@apphub/protocol';
import type { AppHubCore, CoreContext } from './types';

export * from './types';

/**
 * 创建 AppHub 核心服务。
 *
 * 注意：此文件最初由 Lead 放置占位实现，core-dev 负责实现真正的服务并保留该工厂签名。
 */
export function createAppHubCore(_context: CoreContext): AppHubCore {
  throw new AppError('UNSUPPORTED', 'AppHub core 服务尚未实现');
}
