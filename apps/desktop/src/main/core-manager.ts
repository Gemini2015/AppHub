import { AppError, DEFAULTS } from '@apphub/protocol';
import { createAppHubCore } from '@apphub/core';
import type { AppHubCore, CoreContext, FetchLike, SecretBox } from '@apphub/core';
import { createStorageFactory } from '@apphub/storage';
import type { StorageFactory } from '@apphub/storage';
import { mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from './logger';

/**
 * 主进程里 @apphub/core 的装配与生命周期。
 *
 * - dataDir 来自 Electron `app.getPath('userData')`（可用 APPHUB_USER_DATA_DIR 覆盖，见 index.ts）；
 * - 按 docs/ARCHITECTURE.md §4.2 预创建本地目录，并在启动时清理 tmp/；
 * - core 惰性创建：即使 core 初始化失败，窗口/系统信息等 IPC 仍然可用，
 *   业务 IPC 会得到可读的 UNSUPPORTED/INTERNAL 错误，而不是让主进程崩溃。
 */

export const DATA_SUBDIRS = [
  'channels',
  'secrets',
  'secrets/channel_pri',
  'library',
  'tmp',
  'logs',
] as const;

export interface CoreManagerOptions {
  dataDir: string;
  logger: Logger;
  secretBox: SecretBox;
  storageFactory?: StorageFactory;
  fetchImpl?: FetchLike;
  keepVersions?: number;
  /** 便于测试注入 createAppHubCore 替身。 */
  createCore?: (context: CoreContext) => AppHubCore;
}

/** 解析最终 userData 目录（APPHUB_USER_DATA_DIR 优先，用于测试/多实例隔离）。 */
export function resolveUserDataDir(options: {
  defaultUserData: string;
  env?: NodeJS.ProcessEnv;
}): string {
  const override = options.env?.APPHUB_USER_DATA_DIR?.trim();
  return path.resolve(override && override.length > 0 ? override : options.defaultUserData);
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

export class CoreManager {
  readonly dataDir: string;
  private readonly logger: Logger;
  private readonly secretBox: SecretBox;
  private readonly storageFactory: StorageFactory;
  private readonly fetchImpl: FetchLike;
  private readonly keepVersions: number;
  private readonly createCore: (context: CoreContext) => AppHubCore;

  private core: AppHubCore | null = null;
  private initError: unknown = null;
  private closed = false;

  constructor(options: CoreManagerOptions) {
    this.dataDir = path.resolve(options.dataDir);
    this.logger = options.logger;
    this.secretBox = options.secretBox;
    this.storageFactory = options.storageFactory ?? createStorageFactory();
    this.fetchImpl = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
    this.keepVersions = options.keepVersions ?? DEFAULTS.keepVersions;
    this.createCore = options.createCore ?? createAppHubCore;
  }

  /** 预创建目录 + 清理 tmp/（启动阶段调用，失败会抛 AppError）。 */
  async prepare(): Promise<void> {
    try {
      await mkdir(this.dataDir, { recursive: true });
      for (const sub of DATA_SUBDIRS) {
        const target = path.join(this.dataDir, sub);
        if (!isInside(this.dataDir, target)) {
          throw new AppError('SECURITY', `数据目录子路径越界：${sub}`);
        }
        await mkdir(target, { recursive: true });
      }
    } catch (err) {
      this.logger.error('准备数据目录失败', {
        dataDir: this.dataDir,
        message: err instanceof Error ? err.message : String(err),
      });
      throw AppError.from(err, 'IO');
    }
    await this.cleanTempDir();
    this.logger.info('数据目录已就绪', { dataDir: this.dataDir });
  }

  private async cleanTempDir(): Promise<void> {
    const tmpDir = path.join(this.dataDir, 'tmp');
    if (!isInside(this.dataDir, tmpDir)) return;
    try {
      const entries = await readdir(tmpDir, { withFileTypes: true });
      await Promise.all(
        entries.map((entry) =>
          rm(path.join(tmpDir, entry.name), { recursive: true, force: true }).catch(() => undefined),
        ),
      );
      if (entries.length > 0) this.logger.debug('已清理临时目录', { removed: entries.length });
    } catch (err) {
      this.logger.warn('清理临时目录失败（忽略）', {
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** 惰性创建 core；之前初始化失败过则直接复用错误（避免每次 IPC 都重试）。 */
  async getCore(): Promise<AppHubCore> {
    if (this.core) return this.core;
    if (this.closed) throw new AppError('STATE', 'AppHub 核心服务已关闭');
    if (this.initError) throw AppError.from(this.initError);

    try {
      const core = this.createCore({
        dataDir: this.dataDir,
        storageFactory: this.storageFactory,
        secretBox: this.secretBox,
        logger: this.logger,
        fetchImpl: this.fetchImpl,
        keepVersions: this.keepVersions,
      });
      this.core = core;
      this.logger.info('AppHub core 已初始化', { keepVersions: this.keepVersions });
      return core;
    } catch (err) {
      this.initError = err;
      this.logger.error('AppHub core 初始化失败', {
        code: err instanceof AppError ? err.code : 'INTERNAL',
        message: err instanceof Error ? err.message : String(err),
      });
      throw AppError.from(err, 'INTERNAL');
    }
  }

  /** 最近一次 core 初始化错误（供 system.info 等降级展示）。 */
  getInitError(): unknown {
    return this.initError;
  }

  get isInitialized(): boolean {
    return this.core !== null;
  }

  async close(): Promise<void> {
    this.closed = true;
    const core = this.core;
    this.core = null;
    if (!core) return;
    try {
      await core.close();
      this.logger.info('AppHub core 已关闭');
    } catch (err) {
      this.logger.warn('关闭 core 失败（忽略）', {
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
