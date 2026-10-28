import { createFakeLogger } from '@apphub/testkit';
import { describe, expect, it, vi } from 'vitest';
import type { UpdateStateDTO } from '../../shared/ipc';
import { UpdateManager } from './updater';
import type {
  UpdaterAdapter,
  UpdaterProgress,
  UpdaterTimers,
  UpdaterUpdateInfo,
} from './updater';

/** 可控的更新器适配器替身（手动触发 electron-updater 风格事件）。 */
class FakeAdapter implements UpdaterAdapter {
  currentVersion = '0.1.1';
  checkForUpdates = vi.fn(async (): Promise<unknown> => undefined);
  downloadUpdate = vi.fn(async (): Promise<unknown> => undefined);
  quitAndInstall = vi.fn();
  dispose = vi.fn();

  private availableHandler?: (info: UpdaterUpdateInfo) => void;
  private notAvailableHandler?: (info?: UpdaterUpdateInfo) => void;
  private progressHandler?: (progress: UpdaterProgress) => void;
  private downloadedHandler?: (info: UpdaterUpdateInfo) => void;
  private errorHandler?: (error: unknown) => void;

  onUpdateAvailable(handler: (info: UpdaterUpdateInfo) => void): void {
    this.availableHandler = handler;
  }
  onUpdateNotAvailable(handler: (info?: UpdaterUpdateInfo) => void): void {
    this.notAvailableHandler = handler;
  }
  onDownloadProgress(handler: (progress: UpdaterProgress) => void): void {
    this.progressHandler = handler;
  }
  onUpdateDownloaded(handler: (info: UpdaterUpdateInfo) => void): void {
    this.downloadedHandler = handler;
  }
  onError(handler: (error: unknown) => void): void {
    this.errorHandler = handler;
  }

  emitAvailable(info: UpdaterUpdateInfo): void {
    this.availableHandler?.(info);
  }
  emitNotAvailable(): void {
    this.notAvailableHandler?.();
  }
  emitProgress(progress: UpdaterProgress): void {
    this.progressHandler?.(progress);
  }
  emitDownloaded(info: UpdaterUpdateInfo): void {
    this.downloadedHandler?.(info);
  }
  emitError(error: unknown): void {
    this.errorHandler?.(error);
  }
}

class FakeTimers implements UpdaterTimers {
  private seq = 0;
  private readonly tasks = new Map<number, { fn: () => void; ms: number; cleared: boolean }>();

  setTimeout(handler: () => void, timeoutMs: number): unknown {
    const id = ++this.seq;
    this.tasks.set(id, { fn: handler, ms: timeoutMs, cleared: false });
    return id;
  }

  clearTimeout(handle: unknown): void {
    const task = this.tasks.get(handle as number);
    if (task) task.cleared = true;
  }

  pendingDelays(): number[] {
    return [...this.tasks.values()].filter((task) => !task.cleared).map((task) => task.ms);
  }

  runNext(): boolean {
    const entry = [...this.tasks.entries()].find(([, task]) => !task.cleared);
    if (!entry) return false;
    const [id, task] = entry;
    this.tasks.delete(id);
    task.fn();
    return true;
  }
}

const FIXED_NOW = '2026-01-01T00:00:00.000Z';

async function flush(times = 8): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await Promise.resolve();
  }
}

interface Harness {
  manager: UpdateManager;
  adapter: FakeAdapter;
  timers: FakeTimers;
  states: UpdateStateDTO[];
  logger: ReturnType<typeof createFakeLogger>;
}

function makeHarness(overrides: {
  adapter?: FakeAdapter | null;
  supported?: boolean;
  unsupportedReason?: 'dev' | 'platform' | 'e2e' | 'env';
  onBeforeInstall?: () => void;
} = {}): Harness {
  const adapter = overrides.adapter === undefined ? new FakeAdapter() : overrides.adapter;
  const timers = new FakeTimers();
  const logger = createFakeLogger();
  const states: UpdateStateDTO[] = [];
  const manager = new UpdateManager({
    adapter,
    logger,
    currentVersion: '0.1.1',
    supported: overrides.supported,
    unsupportedReason: overrides.unsupportedReason,
    checkDelayMs: 10_000,
    checkIntervalMs: 6 * 60 * 60 * 1000,
    now: () => new Date(FIXED_NOW),
    timers,
    onStateChange: (state) => states.push(state),
    onBeforeInstall: overrides.onBeforeInstall,
  });
  return { manager, adapter: adapter as FakeAdapter, timers, states, logger };
}

async function reachAvailable(harness: Harness, version = '0.2.0'): Promise<void> {
  harness.adapter.checkForUpdates.mockImplementation(async () => {
    harness.adapter.emitAvailable({ version, releaseName: `v${version}`, releaseNotes: '修复若干问题' });
  });
  const result = await harness.manager.check();
  expect(result.status).toBe('available');
}

async function reachDownloaded(harness: Harness, version = '0.2.0'): Promise<void> {
  await reachAvailable(harness, version);
  harness.adapter.downloadUpdate.mockImplementation(async () => {
    harness.adapter.emitProgress({ percent: 42, transferred: 42, total: 100, bytesPerSecond: 10 });
    harness.adapter.emitDownloaded({ version });
  });
  await harness.manager.download();
}

describe('updater：unsupported 状态', () => {
  it('不支持时初始状态为 unsupported，所有操作抛 UNSUPPORTED，start 不安排定时器', async () => {
    const harness = makeHarness({ adapter: null, supported: false, unsupportedReason: 'dev' });
    expect(harness.manager.getState()).toMatchObject({
      supported: false,
      unsupportedReason: 'dev',
      status: 'unsupported',
      currentVersion: '0.1.1',
    });

    await expect(harness.manager.check()).rejects.toMatchObject({ code: 'UNSUPPORTED', message: expect.stringContaining('开发模式') });
    await expect(harness.manager.download()).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    await expect(harness.manager.install()).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    expect(() => harness.manager.dismiss()).toThrowError(/不支持应用内更新/);

    harness.manager.start();
    expect(harness.timers.pendingDelays()).toEqual([]);
    expect(harness.states).toHaveLength(0);
  });
});

describe('updater：自动检查调度', () => {
  it('start 延迟 10s 首检，完成后安排 6h 周期检查', async () => {
    const harness = makeHarness();
    harness.manager.start();
    expect(harness.timers.pendingDelays()).toEqual([10_000]);

    harness.adapter.checkForUpdates.mockImplementation(async () => {
      harness.adapter.emitNotAvailable();
    });
    harness.timers.runNext();
    await flush();

    expect(harness.adapter.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(harness.manager.getState()).toMatchObject({ status: 'up-to-date', lastCheckedAt: FIXED_NOW });
    expect(harness.timers.pendingDelays()).toContain(6 * 60 * 60 * 1000);
    harness.manager.dispose();
  });

  it('dispose 清理定时器与适配器监听', async () => {
    const harness = makeHarness();
    harness.manager.start();
    harness.manager.dispose();
    expect(harness.timers.pendingDelays()).toEqual([]);
    expect(harness.adapter.dispose).toHaveBeenCalledTimes(1);
    await expect(harness.manager.check()).rejects.toMatchObject({ code: 'STATE' });
  });
});

describe('updater：检查更新', () => {
  it('check available：状态/版本/releaseNotes/lastCheckedAt 正确，状态回调包含 checking→available', async () => {
    const harness = makeHarness();
    harness.adapter.checkForUpdates.mockImplementation(async () => {
      harness.adapter.emitAvailable({
        version: '0.3.0',
        releaseName: 'AppHub 0.3.0',
        releaseNotes: '- 新功能',
        releaseDate: '2026-02-01T00:00:00.000Z',
      });
    });

    const result = await harness.manager.check();
    expect(result).toMatchObject({
      supported: true,
      status: 'available',
      currentVersion: '0.1.1',
      availableVersion: '0.3.0',
      releaseName: 'AppHub 0.3.0',
      releaseNotes: '- 新功能',
      releaseDate: '2026-02-01T00:00:00.000Z',
      lastCheckedAt: FIXED_NOW,
    });
    expect(harness.states.map((state) => state.status)).toEqual(['checking', 'available']);
  });

  it('check up-to-date：写入 lastCheckedAt 并清空可用版本信息', async () => {
    const harness = makeHarness();
    await reachAvailable(harness, '0.2.0');
    harness.adapter.checkForUpdates.mockImplementation(async () => {
      harness.adapter.emitNotAvailable();
    });
    const result = await harness.manager.check();
    expect(result).toMatchObject({ status: 'up-to-date', lastCheckedAt: FIXED_NOW });
    expect(result.availableVersion).toBeUndefined();
    expect(result.releaseNotes).toBeUndefined();
  });

  it('手动检查失败写入 error 状态（可展示）；自动检查失败仅记录日志', async () => {
    const manual = makeHarness();
    manual.adapter.checkForUpdates.mockRejectedValueOnce(new Error('network down'));
    const manualResult = await manual.manager.check();
    expect(manualResult.status).toBe('error');
    expect(manualResult.error).toMatchObject({ code: 'NETWORK', message: 'network down' });

    const auto = makeHarness();
    auto.adapter.checkForUpdates.mockImplementation(async () => {
      auto.adapter.emitError(new Error('temporary offline'));
    });
    auto.manager.start();
    auto.timers.runNext();
    await flush();
    expect(auto.manager.getState().status).not.toBe('error');
    expect(auto.manager.getState().error).toBeUndefined();
    expect(auto.logger.entries.some((entry) => entry.level === 'warn')).toBe(true);
    auto.manager.dispose();
  });

  it('并发 check 只触发一次适配器调用', async () => {
    const harness = makeHarness();
    let resolveCheck: (value?: unknown) => void = () => undefined;
    harness.adapter.checkForUpdates.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCheck = resolve;
        }),
    );

    const first = harness.manager.check();
    const second = await harness.manager.check();
    expect(second.status).toBe('checking');
    expect(harness.adapter.checkForUpdates).toHaveBeenCalledTimes(1);

    harness.adapter.emitAvailable({ version: '0.2.0' });
    resolveCheck();
    const firstResult = await first;
    expect(firstResult.status).toBe('available');
  });
});

describe('updater：下载与安装', () => {
  it('download 仅 available 可用；进度事件更新 progress；downloaded 后状态为 downloaded', async () => {
    const idle = makeHarness();
    await expect(idle.manager.download()).rejects.toMatchObject({ code: 'STATE' });

    const harness = makeHarness();
    await reachAvailable(harness);
    harness.adapter.downloadUpdate.mockImplementation(async () => {
      harness.adapter.emitProgress({ percent: 42, transferred: 42, total: 100, bytesPerSecond: 5 });
      harness.adapter.emitDownloaded({ version: '0.2.0' });
    });
    const result = await harness.manager.download();
    expect(result.status).toBe('downloaded');
    expect(result.progress?.percent).toBe(100);
    const downloadingState = harness.states.find((state) => state.status === 'downloading');
    expect(downloadingState?.progress?.percent).toBe(0);
    expect(harness.adapter.downloadUpdate).toHaveBeenCalledTimes(1);
  });

  it('下载进度只在 downloading 状态生效（其它状态忽略）', async () => {
    const harness = makeHarness();
    harness.adapter.emitProgress({ percent: 10, transferred: 1, total: 10, bytesPerSecond: 1 });
    expect(harness.manager.getState().progress).toBeUndefined();
  });

  it('install 仅 downloaded 可用；先 onBeforeInstall 再 quitAndInstall(false,true)', async () => {
    const order: string[] = [];
    const harness = makeHarness({
      onBeforeInstall: () => {
        order.push('before-install');
      },
    });
    harness.adapter.quitAndInstall.mockImplementation(() => {
      order.push('quit-and-install');
    });

    await expect(harness.manager.install()).rejects.toMatchObject({ code: 'STATE' });

    await reachDownloaded(harness);
    await harness.manager.install();
    expect(order).toEqual(['before-install', 'quit-and-install']);
    expect(harness.adapter.quitAndInstall).toHaveBeenCalledWith(false, true);
    expect(harness.adapter.dispose).toHaveBeenCalledTimes(1);
  });

  it('安装前回调抛错不阻止 quitAndInstall', async () => {
    const harness = makeHarness({
      onBeforeInstall: () => {
        throw new Error('callback failed');
      },
    });
    await reachDownloaded(harness);
    await harness.manager.install();
    expect(harness.adapter.quitAndInstall).toHaveBeenCalledTimes(1);
  });
});

describe('updater：dismiss 会话忽略', () => {
  it('dismiss 当前可用版本；同版本再次检查保持 dismissed；新版本恢复展示', async () => {
    const harness = makeHarness();
    await reachAvailable(harness, '0.2.0');

    const dismissed = harness.manager.dismiss();
    expect(dismissed.dismissed).toBe(true);

    // 同版本再次出现（例如自动检查）：仍然 dismissed
    harness.adapter.checkForUpdates.mockImplementation(async () => {
      harness.adapter.emitAvailable({ version: '0.2.0' });
    });
    const sameVersion = await harness.manager.check();
    expect(sameVersion.status).toBe('available');
    expect(sameVersion.dismissed).toBe(true);

    // 新版本：清除 dismissed
    harness.adapter.checkForUpdates.mockImplementation(async () => {
      harness.adapter.emitAvailable({ version: '0.3.0' });
    });
    const newVersion = await harness.manager.check();
    expect(newVersion.availableVersion).toBe('0.3.0');
    expect(newVersion.dismissed).not.toBe(true);
  });
});
