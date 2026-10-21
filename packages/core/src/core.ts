import path from 'node:path';
import { AppError, DEFAULTS } from '@apphub/protocol';
import { wrapService } from './errors';
import { HttpClient, systemClock } from './http';
import { KeyedMutex } from './mutex';
import { StateStore } from './state';
import { ChannelServiceImpl } from './channels';
import { PublishServiceImpl } from './publish';
import { LibraryServiceImpl } from './library';
import type { AppHubCore, Clock, CoreContext, FetchLike, Logger } from './types';

/**
 * AppHub 核心服务工厂。
 *
 * 纯 Node 实现：所有环境能力（dataDir / secretBox / fetch / clock / storageFactory）
 * 均由调用方注入，因此可以在 Electron 主进程与纯 Node 测试中复用同一份逻辑。
 */

const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function resolveKeepVersions(value: number | undefined): number {
  if (value === undefined) return DEFAULTS.keepVersions;
  if (!Number.isInteger(value) || value < 1) {
    throw new AppError('VALIDATION', `keepVersions 必须是 >=1 的整数：${String(value)}`);
  }
  return value;
}

function assertContext(context: CoreContext): void {
  if (typeof context !== 'object' || context === null) {
    throw new AppError('VALIDATION', 'createAppHubCore 需要 CoreContext');
  }
  if (typeof context.dataDir !== 'string' || context.dataDir.trim().length === 0) {
    throw new AppError('VALIDATION', 'CoreContext.dataDir 必须是非空字符串');
  }
  if (!context.storageFactory || typeof context.storageFactory.create !== 'function') {
    throw new AppError('VALIDATION', 'CoreContext.storageFactory 必须提供 create(config) 方法');
  }
  if (
    !context.secretBox ||
    typeof context.secretBox.encrypt !== 'function' ||
    typeof context.secretBox.decrypt !== 'function'
  ) {
    throw new AppError('VALIDATION', 'CoreContext.secretBox 必须提供 encrypt/decrypt 方法');
  }
  if (context.clock !== undefined && typeof context.clock.now !== 'function') {
    throw new AppError('VALIDATION', 'CoreContext.clock 必须提供 now() 方法');
  }
  if (context.logger !== undefined) {
    for (const level of ['debug', 'info', 'warn', 'error'] as const) {
      if (typeof context.logger[level] !== 'function') {
        throw new AppError('VALIDATION', `CoreContext.logger.${level} 必须是函数`);
      }
    }
  }
}

class AppHubCoreImpl implements AppHubCore {
  readonly dataDir: string;
  readonly channels: AppHubCore['channels'];
  readonly publishing: AppHubCore['publishing'];
  readonly library: AppHubCore['library'];
  private readonly ready: Promise<void>;
  private readonly logger: Logger;

  constructor(options: {
    dataDir: string;
    channels: ChannelServiceImpl;
    publishing: PublishServiceImpl;
    library: LibraryServiceImpl;
    ready: Promise<void>;
    logger: Logger;
  }) {
    this.dataDir = options.dataDir;
    this.channels = wrapService(options.channels);
    this.publishing = wrapService(options.publishing);
    this.library = wrapService(options.library);
    this.ready = options.ready;
    this.logger = options.logger;
  }

  async close(): Promise<void> {
    try {
      await this.ready;
    } catch (error) {
      this.logger.warn('核心服务初始化未成功完成', { reason: AppError.from(error).message });
    }
  }
}

export function createAppHubCore(context: CoreContext): AppHubCore {
  assertContext(context);
  const dataDir = path.resolve(context.dataDir);
  const clock: Clock = context.clock ?? systemClock;
  const logger: Logger = context.logger ?? silentLogger;
  const keepVersions = resolveKeepVersions(context.keepVersions);
  const fetchImpl: FetchLike | undefined =
    context.fetchImpl ?? (globalThis.fetch as FetchLike | undefined);
  if (typeof fetchImpl !== 'function') {
    throw new AppError(
      'UNSUPPORTED',
      '当前运行环境没有可用的 fetch 实现，请通过 CoreContext.fetchImpl 注入',
    );
  }
  const mutex = new KeyedMutex();
  const state = new StateStore({
    dataDir,
    secretBox: context.secretBox,
    mutex,
    logger,
  });
  const http = new HttpClient({
    fetchImpl,
    defaultHeaders: context.defaultHeaders,
  });
  const ready = state.init();
  const channels = new ChannelServiceImpl({
    state,
    http,
    storageFactory: context.storageFactory,
    secretBox: context.secretBox,
    clock,
    logger,
    mutex,
    ready,
  });
  const publishing = new PublishServiceImpl(
    {
      state,
      storageFactory: context.storageFactory,
      secretBox: context.secretBox,
      clock,
      logger,
      mutex,
      ready,
    },
    channels,
  );
  const library = new LibraryServiceImpl({
    state,
    channels,
    http,
    clock,
    logger,
    mutex,
    keepVersions,
    ready,
  });
  return new AppHubCoreImpl({
    dataDir,
    channels,
    publishing,
    library,
    ready,
    logger,
  });
}
