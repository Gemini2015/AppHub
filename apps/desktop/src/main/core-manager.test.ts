import type { AppHubCore, CoreContext, SecretBox } from '@apphub/core';
import { AppError } from '@apphub/protocol';
import { createFakeLogger, createFakeSecretBox } from '@apphub/testkit';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createAppHubCore: vi.fn(),
  create: vi.fn(),
}));

vi.mock('@apphub/core', () => ({ createAppHubCore: mocks.createAppHubCore }));
vi.mock('@apphub/storage', () => ({ createStorageFactory: () => ({ create: mocks.create }) }));

import { CoreManager, DATA_SUBDIRS, resolveUserDataDir } from './core-manager';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'apphub-core-manager-'));
  vi.clearAllMocks();
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function fakeSecretBox(): SecretBox {
  return createFakeSecretBox();
}

function makeManager(overrides: Partial<ConstructorParameters<typeof CoreManager>[0]> = {}): CoreManager {
  return new CoreManager({
    dataDir: tempDir,
    logger: createFakeLogger(),
    secretBox: fakeSecretBox(),
    ...overrides,
  });
}

describe('core-manager：userData 解析', () => {
  it('APPHUB_USER_DATA_DIR 优先于 Electron 默认 userData', () => {
    expect(
      resolveUserDataDir({
        defaultUserData: path.join('C:', 'default', 'AppHub'),
        env: { APPHUB_USER_DATA_DIR: path.join(tempDir, 'override') },
      }),
    ).toBe(path.resolve(tempDir, 'override'));
  });

  it('环境变量为空/空白时回退默认 userData', () => {
    expect(resolveUserDataDir({ defaultUserData: path.join(tempDir, 'default'), env: {} })).toBe(
      path.resolve(tempDir, 'default'),
    );
    expect(
      resolveUserDataDir({ defaultUserData: path.join(tempDir, 'default'), env: { APPHUB_USER_DATA_DIR: '   ' } }),
    ).toBe(path.resolve(tempDir, 'default'));
  });

  it('相对路径的覆盖值会被解析为绝对路径', () => {
    const resolved = resolveUserDataDir({ defaultUserData: tempDir, env: { APPHUB_USER_DATA_DIR: 'relative-data' } });
    expect(path.isAbsolute(resolved)).toBe(true);
  });
});

describe('core-manager：prepare', () => {
  it('创建 docs/ARCHITECTURE.md §4.2 约定的本地目录并清理 tmp/', async () => {
    const tmpSub = path.join(tempDir, 'tmp', 'leftover-op');
    await mkdir(tmpSub, { recursive: true });
    await writeFile(path.join(tmpSub, 'partial-download.bin'), 'stale');

    const manager = makeManager();
    await manager.prepare();

    for (const sub of DATA_SUBDIRS) {
      const entries = await readdir(path.join(tempDir, sub), { withFileTypes: true });
      if (sub === 'tmp') expect(entries).toHaveLength(0);
    }
    const secrets = await readdir(path.join(tempDir, 'secrets', 'channel_pri'));
    expect(secrets).toHaveLength(0);
  });
});

describe('core-manager：core 惰性初始化', () => {
  it('注入 createCore 并以完整 CoreContext 创建一次（缓存结果）', async () => {
    const fakeCore = { dataDir: tempDir, close: vi.fn(async () => undefined) } as unknown as AppHubCore;
    const createCore = vi.fn((_context: CoreContext) => fakeCore);
    const storageFactory = { create: vi.fn() };
    const secretBox = fakeSecretBox();
    const fetchImpl = vi.fn(async () => new Response('ok'));
    const logger = createFakeLogger();
    const manager = new CoreManager({
      dataDir: tempDir,
      logger,
      secretBox,
      storageFactory,
      fetchImpl,
      keepVersions: 5,
      createCore,
    });

    await expect(manager.getCore()).resolves.toBe(fakeCore);
    await expect(manager.getCore()).resolves.toBe(fakeCore);
    expect(createCore).toHaveBeenCalledTimes(1);

    const context = createCore.mock.calls[0]?.[0];
    expect(context?.dataDir).toBe(path.resolve(tempDir));
    expect(context?.secretBox).toBe(secretBox);
    expect(context?.storageFactory).toBe(storageFactory);
    expect(context?.fetchImpl).toBe(fetchImpl);
    expect(context?.keepVersions).toBe(5);
    expect(context?.logger).toBe(logger);
    expect(manager.isInitialized).toBe(true);
  });

  it('core 初始化失败（stub 场景）返回可读错误，且不重复重试', async () => {
    const logger = createFakeLogger();
    const createCore = vi.fn(() => {
      throw new AppError('UNSUPPORTED', 'AppHub core 服务尚未实现');
    });
    const manager = new CoreManager({ dataDir: tempDir, logger, secretBox: fakeSecretBox(), createCore });

    await expect(manager.getCore()).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    await expect(manager.getCore()).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    expect(createCore).toHaveBeenCalledTimes(1);
    expect(manager.isInitialized).toBe(false);
    expect(logger.entries.filter((entry) => entry.level === 'error')).toHaveLength(1);
    expect(manager.getInitError()).toBeInstanceOf(AppError);
  });

  it('默认使用 @apphub/core 的 createAppHubCore 工厂', async () => {
    const fakeCore = { dataDir: tempDir, close: vi.fn() } as unknown as AppHubCore;
    mocks.createAppHubCore.mockReturnValue(fakeCore);
    const manager = makeManager();
    await expect(manager.getCore()).resolves.toBe(fakeCore);
    expect(mocks.createAppHubCore).toHaveBeenCalledTimes(1);
  });

  it('close 调用 core.close()，之后拒绝再创建', async () => {
    const close = vi.fn(async () => undefined);
    const fakeCore = { dataDir: tempDir, close } as unknown as AppHubCore;
    const createCore = vi.fn(() => fakeCore);
    const manager = new CoreManager({ dataDir: tempDir, logger: createFakeLogger(), secretBox: fakeSecretBox(), createCore });

    await manager.getCore();
    await manager.close();
    expect(close).toHaveBeenCalledTimes(1);
    await expect(manager.getCore()).rejects.toMatchObject({ code: 'STATE' });
    await manager.close(); // 幂等
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('close 时 core.close 抛错不会让主进程退出流程失败', async () => {
    const fakeCore = {
      dataDir: tempDir,
      close: vi.fn(async () => {
        throw new Error('already closed');
      }),
    } as unknown as AppHubCore;
    const manager = new CoreManager({
      dataDir: tempDir,
      logger: createFakeLogger(),
      secretBox: fakeSecretBox(),
      createCore: () => fakeCore,
    });
    await manager.getCore();
    await expect(manager.close()).resolves.toBeUndefined();
  });

  it('close 时先停止本机 Host（stopAll）再关闭 core', async () => {
    const stopAll = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    const fakeCore = {
      dataDir: tempDir,
      host: { stopAll },
      close,
    } as unknown as AppHubCore;
    const manager = new CoreManager({
      dataDir: tempDir,
      logger: createFakeLogger(),
      secretBox: fakeSecretBox(),
      createCore: () => fakeCore,
    });
    await manager.getCore();
    await manager.close();
    expect(stopAll).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(stopAll.mock.invocationCallOrder[0]).toBeLessThan(close.mock.invocationCallOrder[0]);
  });

  it('stopAll 抛错时仍继续关闭 core（退出流程不阻塞）', async () => {
    const close = vi.fn(async () => undefined);
    const fakeCore = {
      dataDir: tempDir,
      host: {
        stopAll: vi.fn(async () => {
          throw new Error('端口已释放');
        }),
      },
      close,
    } as unknown as AppHubCore;
    const logger = createFakeLogger();
    const manager = new CoreManager({
      dataDir: tempDir,
      logger,
      secretBox: fakeSecretBox(),
      createCore: () => fakeCore,
    });
    await manager.getCore();
    await expect(manager.close()).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledTimes(1);
    expect(logger.entries.some((entry) => entry.level === 'warn')).toBe(true);
  });
});
