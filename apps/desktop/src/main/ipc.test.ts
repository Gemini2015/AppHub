import type { AppHubCore } from '@apphub/core';
import { AppError } from '@apphub/protocol';
import { createFakeLogger } from '@apphub/testkit';
import type { FakeLogger } from '@apphub/testkit';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  openDialog: vi.fn(),
  saveDialog: vi.fn(),
  showItemInFolder: vi.fn(),
  openPath: vi.fn(),
  ipcHandlers: new Map<string, (...args: any[]) => any>(),
}));

vi.mock('electron', () => ({
  app: { getName: () => 'AppHub', getVersion: () => '0.1.0' },
  dialog: {
    showOpenDialog: (...args: any[]) => h.openDialog(...args),
    showSaveDialog: (...args: any[]) => h.saveDialog(...args),
  },
  ipcMain: {
    handle: (channel: string, listener: (...args: any[]) => any) => h.ipcHandlers.set(channel, listener),
    removeHandler: (channel: string) => h.ipcHandlers.delete(channel),
  },
  shell: {
    showItemInFolder: (...args: any[]) => h.showItemInFolder(...args),
    openPath: (...args: any[]) => h.openPath(...args),
  },
}));

import { IPC_CHANNELS, IPC_EVENTS } from '../../shared/ipc';
import { buildPublishInput, createIpcRouter, registerIpcHandlers, toChannelSummary, toHostStatus } from './ipc';
import type { IpcEventLike, IpcRouterContext } from './ipc';
import { SelectionRegistry } from './selection-registry';
import { createSenderPolicy } from './sender';

const APP_INDEX = path.resolve('out', 'renderer', 'index.html');
const TRUSTED_URL = pathToFileURL(APP_INDEX).href;
const ISO = '2026-01-01T00:00:00.000Z';
const CHANNEL_ID = 'ch_0123456789abcdef';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function channelInfo(overrides: Record<string, unknown> = {}): any {
  return {
    id: CHANNEL_ID,
    name: '测试频道',
    description: '频道描述',
    visibility: 'public',
    role: 'owner',
    createdAt: ISO,
    updatedAt: ISO,
    appCount: 1,
    subscribeUrl: 'https://example.com/channel.json',
    canPublish: true,
    source: 'owned',
    ...overrides,
  };
}

function appInfo(overrides: Record<string, unknown> = {}): any {
  return {
    appId: 'demo-app',
    name: 'demo-app',
    displayName: '示例 App',
    description: '',
    author: 'tester',
    entry: 'app.exe',
    platforms: ['windows'],
    publishMode: 'files',
    latest: { windows: '1.0.0' },
    metaUrl: 'https://example.com/demo-app/app.meta.json',
    updatedAt: ISO,
    ...overrides,
  };
}

function versionEntry(): any {
  return {
    version: '1.0.0',
    platform: 'windows',
    publishMode: 'files',
    entry: 'app.exe',
    publishedAt: ISO,
    changelog: '',
    totalSize: 4,
    fileCount: 1,
    filesUrl: '1.0.0/files.json',
    downloadBaseUrl: '1.0.0/',
    files: [{ path: 'app.exe', size: 4, md5: '0'.repeat(32) }],
    archive: null,
  };
}

function channelDetail(): any {
  const summary = channelInfo();
  return {
    ...summary,
    channel: {
      schemaVersion: 1,
      kind: 'apphub-channel',
      id: CHANNEL_ID,
      name: summary.name,
      description: summary.description,
      visibility: 'public',
      owner: { name: '' },
      apps: [],
      createdAt: ISO,
      updatedAt: ISO,
    },
    apps: [appInfo()],
  };
}

function appDetail(): any {
  return {
    channelId: CHANNEL_ID,
    app: appInfo(),
    meta: {
      schemaVersion: 1,
      kind: 'apphub-app-meta',
      appId: 'demo-app',
      channelId: CHANNEL_ID,
      name: 'demo-app',
      displayName: '示例 App',
      description: '',
      author: 'tester',
      publishMode: 'files',
      entry: 'app.exe',
      platforms: ['windows'],
      latest: { windows: '1.0.0' },
      versions: [versionEntry()],
      updatedAt: ISO,
    },
    versions: [versionEntry()],
  };
}

function installedApp(overrides: Record<string, unknown> = {}): any {
  return {
    channelId: CHANNEL_ID,
    channelName: '测试频道',
    appId: 'demo-app',
    displayName: '示例 App',
    version: '1.0.0',
    platform: 'windows',
    publishMode: 'files',
    entry: 'app.exe',
    appRoot: path.resolve('.tmp-test-data', 'library', CHANNEL_ID, 'demo-app'),
    installPath: path.resolve('.tmp-test-data', 'library', CHANNEL_ID, 'demo-app', 'versions', '1.0.0'),
    installedAt: ISO,
    updatedAt: ISO,
    fileCount: 1,
    totalSize: 4,
    status: 'installed',
    ...overrides,
  };
}

function publishResult(): any {
  return {
    appId: 'demo-app',
    version: '1.0.0',
    platform: 'windows',
    publishMode: 'files',
    metaUrl: 'https://example.com/demo-app/app.meta.json',
    totalSize: 4,
    fileCount: 1,
    files: [{ path: 'app.exe', size: 4, md5: '0'.repeat(32) }],
    archive: null,
    channelUpdatedAt: ISO,
  };
}

function installResult(): any {
  return { app: installedApp(), downloadedBytes: 4, reusedBytes: 0 };
}

function hostUrls(overrides: Record<string, unknown> = {}): any {
  return {
    channelUrl: 'https://example.com/channel.json',
    localChannelUrl: 'http://127.0.0.1:8787/channel.json',
    lanChannelUrls: ['http://192.168.1.5:8787/channel.json'],
    ...overrides,
  };
}

function hostStatus(overrides: Record<string, unknown> = {}): any {
  return {
    channelId: CHANNEL_ID,
    channelName: '测试频道',
    visibility: 'public',
    running: true,
    configuredPort: 8787,
    port: 8787,
    bindHost: '0.0.0.0',
    urls: hostUrls(),
    startedAt: ISO,
    ...overrides,
  };
}

function makeCore(overrides: Record<string, any> = {}): any {
  const core = {
    dataDir: path.resolve('.tmp-test-data'),
    channels: {
      list: vi.fn(async () => [channelInfo()]),
      get: vi.fn(async () => channelDetail()),
      create: vi.fn(async () => channelDetail()),
      update: vi.fn(async () => channelDetail()),
      subscribe: vi.fn(async () => channelDetail()),
      unsubscribe: vi.fn(async () => undefined),
      refresh: vi.fn(async () => channelDetail()),
      refreshAll: vi.fn(async () => [channelInfo()]),
      importPrivateConfig: vi.fn(async () => channelDetail()),
      exportPrivateConfig: vi.fn(async () => '{"schemaVersion":1}'),
      getSubscribeUrl: vi.fn(async () => 'https://example.com/channel.json'),
    },
    host: {
      start: vi.fn(async () => hostStatus()),
      stop: vi.fn(async () => hostStatus({ running: false, port: null, startedAt: undefined })),
      status: vi.fn(async () => hostStatus()),
      list: vi.fn(async () => [hostStatus()]),
      updateConfig: vi.fn(async () => hostStatus({ configuredPort: 9000 })),
      stopAll: vi.fn(async () => undefined),
    },
    publishing: {
      getApp: vi.fn(async () => appDetail()),
      publish: vi.fn(async () => publishResult()),
      updateMeta: vi.fn(async () => appDetail()),
    },
    library: {
      list: vi.fn(async () => [installedApp()]),
      checkUpdates: vi.fn(async () => []),
      install: vi.fn(async () => installResult()),
      update: vi.fn(async () => installResult()),
      verify: vi.fn(async () => ({ ok: true, checkedFiles: 1, mismatches: [] })),
      uninstall: vi.fn(async () => undefined),
      getLaunchDescriptor: vi.fn(async () => {
        throw new AppError('NOT_FOUND', '未安装');
      }),
    },
    close: vi.fn(async () => undefined),
  };
  return { ...core, ...overrides };
}

interface Harness {
  router: Record<string, (event: IpcEventLike, payload: unknown) => Promise<any>>;
  ctx: IpcRouterContext;
  core: any;
  logger: FakeLogger;
  registry: SelectionRegistry;
  sent: { channel: string; data: any }[];
  targets: { sent: { channel: string; data: any }[]; send: (channel: string, data: any) => void; isDestroyed: () => boolean; id: number }[];
  event: IpcEventLike;
  dialog: { showOpenDialog: ReturnType<typeof vi.fn> };
}

function makeHarness(options: {
  core?: any;
  frameUrl?: string;
  isTrustedSender?: (sender: { id: number }) => boolean;
  getWebContents?: () => any[];
  registryDialog?: any;
  launch?: any;
  reveal?: any;
  dataDirInfo?: IpcRouterContext['dataDirInfo'];
  changeDataDir?: (newPath: string) => Promise<{ previousDataDir: string; newDataDir: string; restarting: boolean }>;
  updater?: IpcRouterContext['updater'];
} = {}): Harness {
  const logger = createFakeLogger();
  const core = options.core ?? makeCore();
  const sent: { channel: string; data: any }[] = [];
  const sender = {
    id: 1,
    isDestroyed: () => false,
    send: (channel: string, data: any) => {
      sent.push({ channel, data });
    },
  };
  const dialog = { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) };
  const registry = new SelectionRegistry({
    logger,
    dialog: options.registryDialog ?? (dialog as any),
  });
  const targets: Harness['targets'] = [];
  if (options.getWebContents) {
    targets.push(...options.getWebContents());
  } else {
    targets.push({
      id: 2,
      isDestroyed: () => false,
      send: (channel: string, data: any) => {
        targets[0]?.sent.push({ channel, data });
      },
      sent: [],
    } as any);
  }
  const ctx: IpcRouterContext = {
    logger,
    coreManager: { dataDir: path.resolve('.tmp-test-data'), getCore: async () => core as AppHubCore },
    selectionRegistry: registry,
    senderPolicy: createSenderPolicy({ appIndexFile: APP_INDEX }),
    isTrustedSender: options.isTrustedSender ?? (() => true),
    getWebContents: () => targets,
    appVersions: () => ({
      appName: 'AppHub',
      appVersion: '0.1.0',
      electronVersion: '38.0.0',
      chromeVersion: '128.0.0',
      nodeVersion: '22.0.0',
    }),
    platform: 'win32',
    randomId: () => 'op-test-1',
    launch: options.launch,
    reveal: options.reveal,
    dataDirInfo: options.dataDirInfo,
    changeDataDir: options.changeDataDir,
    updater: options.updater,
  };
  const router = createIpcRouter(ctx) as Harness['router'];
  const event: IpcEventLike = { sender, senderFrame: { url: options.frameUrl ?? TRUSTED_URL } };
  return { router, ctx, core, logger, registry, sent, targets, event, dialog };
}

async function call(harness: Harness, channel: string, payload?: unknown): Promise<any> {
  const handler = harness.router[channel];
  if (!handler) throw new Error(`handler 缺失：${channel}`);
  return handler(harness.event, payload);
}

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'apphub-ipc-'));
  vi.clearAllMocks();
  h.ipcHandlers.clear();
  h.openPath.mockResolvedValue('');
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// sender 校验
// ---------------------------------------------------------------------------

describe('ipc：sender frame 校验', () => {
  it('不受信任的 frame URL 返回 SECURITY 且不调用 core', async () => {
    const harness = makeHarness({ frameUrl: 'https://evil.example/' });
    const result = await call(harness, IPC_CHANNELS.channelsList);
    expect(result).toMatchObject({ ok: false, error: { code: 'SECURITY' } });
    expect(harness.core.channels.list).not.toHaveBeenCalled();
  });

  it('frame URL 合法但不是主窗口 webContents 时返回 SECURITY', async () => {
    const harness = makeHarness({ isTrustedSender: () => false });
    const result = await call(harness, IPC_CHANNELS.channelsList);
    expect(result).toMatchObject({ ok: false, error: { code: 'SECURITY' } });
  });

  it('空 senderFrame 视为不受信任', async () => {
    const harness = makeHarness();
    const result = await harness.router[IPC_CHANNELS.channelsList](
      { sender: harness.event.sender, senderFrame: null },
      undefined,
    );
    expect(result).toMatchObject({ ok: false, error: { code: 'SECURITY' } });
  });
});

// ---------------------------------------------------------------------------
// zod 入参校验
// ---------------------------------------------------------------------------

describe('ipc：zod 入参校验', () => {
  it('拒绝多余字段', async () => {
    const harness = makeHarness();
    const result = await call(harness, IPC_CHANNELS.channelsGet, { channelId: CHANNEL_ID, extra: true });
    expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
    expect(harness.core.channels.get).not.toHaveBeenCalled();
  });

  it('拒绝非法 channelId / appId', async () => {
    const harness = makeHarness();
    expect(await call(harness, IPC_CHANNELS.channelsGet, { channelId: 'bad' })).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION' },
    });
    expect(await call(harness, IPC_CHANNELS.appsGet, { channelId: CHANNEL_ID, appId: 'UPPER' })).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION' },
    });
  });

  it('拒绝缺少必填字段 / 类型错误', async () => {
    const harness = makeHarness();
    expect(await call(harness, IPC_CHANNELS.channelsGet, {})).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
    expect(await call(harness, IPC_CHANNELS.libraryInstall, { channelId: CHANNEL_ID })).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION' },
    });
  });

  it('publishStart 拒绝未知字段与非法版本号', async () => {
    const harness = makeHarness();
    const base = {
      channelId: CHANNEL_ID,
      displayName: '示例',
      version: '1.0.0',
      platform: 'windows',
      publishMode: 'files',
      entry: 'app.exe',
      selectionId: 'sel-x',
    };
    expect(await call(harness, IPC_CHANNELS.publishStart, { ...base, extra: 1 })).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION' },
    });
    expect(await call(harness, IPC_CHANNELS.publishStart, { ...base, version: 'v1' })).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION' },
    });
  });
});

// ---------------------------------------------------------------------------
// 通用结果包装 / 系统信息
// ---------------------------------------------------------------------------

describe('ipc：ApiResult 与 system.info', () => {
  it('system.info 返回版本/平台/数据目录/计数（缺省 dataDir 视为不可编辑默认目录）', async () => {
    const harness = makeHarness();
    const result = await call(harness, IPC_CHANNELS.systemInfo);
    expect(result.ok).toBe(true);
    expect(result.value).toMatchObject({
      appName: 'AppHub',
      appVersion: '0.1.0',
      electronVersion: '38.0.0',
      platform: 'win32',
      arch: process.arch,
      channelCount: 1,
      installedCount: 1,
      dataDirSource: 'default',
      dataDirEditable: false,
      defaultDataDir: path.resolve('.tmp-test-data'),
    });
    expect(path.isAbsolute(result.value.dataDir)).toBe(true);
  });

  it('system.info 反映注入的数据目录信息（default/custom/env 三态）', async () => {
    const defaultDataDir = path.resolve(tempDir, 'electron-user-data');
    const customDir = path.resolve(tempDir, 'custom-data');

    const defaultInfo = await call(
      makeHarness({
        dataDirInfo: { dataDir: defaultDataDir, defaultDataDir, source: 'default', editable: true },
      }),
      IPC_CHANNELS.systemInfo,
    );
    expect(defaultInfo.value).toMatchObject({
      dataDir: defaultDataDir,
      defaultDataDir,
      dataDirSource: 'default',
      dataDirEditable: true,
    });

    const customInfo = await call(
      makeHarness({
        dataDirInfo: { dataDir: customDir, defaultDataDir, source: 'custom', editable: true },
      }),
      IPC_CHANNELS.systemInfo,
    );
    expect(customInfo.value).toMatchObject({
      dataDir: customDir,
      defaultDataDir,
      dataDirSource: 'custom',
      dataDirEditable: true,
    });

    const envDir = path.resolve(tempDir, 'env-data');
    const envInfo = await call(
      makeHarness({
        dataDirInfo: { dataDir: envDir, defaultDataDir: envDir, source: 'env', editable: false },
      }),
      IPC_CHANNELS.systemInfo,
    );
    expect(envInfo.value).toMatchObject({
      dataDir: envDir,
      defaultDataDir: envDir,
      dataDirSource: 'env',
      dataDirEditable: false,
    });
  });

  it('core 初始化失败时 system.info 仍可用（计数降级为 0）', async () => {
    const harness = makeHarness({ core: makeCore() });
    // 模拟 core 初始化失败（stub 场景）
    harness.ctx.coreManager.getCore = async () => {
      throw new AppError('UNSUPPORTED', 'core not implemented');
    };
    const result = await call(harness, IPC_CHANNELS.systemInfo);
    expect(result).toMatchObject({ ok: true, value: { channelCount: 0, installedCount: 0 } });
  });

  it('AppError 保持 code；普通异常折叠为 INTERNAL 并记录日志', async () => {
    const harness = makeHarness();
    harness.core.channels.list.mockRejectedValueOnce(new AppError('AUTH', '无权限'));
    expect(await call(harness, IPC_CHANNELS.channelsList)).toMatchObject({
      ok: false,
      error: { code: 'AUTH', message: '无权限' },
    });

    harness.core.channels.list.mockRejectedValueOnce(new Error('boom'));
    const internal = await call(harness, IPC_CHANNELS.channelsList);
    expect(internal).toMatchObject({ ok: false, error: { code: 'INTERNAL' } });
    expect(JSON.stringify(internal)).not.toContain('at ');
    expect(harness.logger.entries.some((entry) => entry.level === 'error')).toBe(true);
  });

  it('channels.list 映射为 ChannelSummaryDTO', () => {
    const dto = toChannelSummary(channelInfo());
    expect(dto).toMatchObject({ id: CHANNEL_ID, role: 'owner', source: 'owned', canPublish: true });
    expect(dto).not.toHaveProperty('unknown');
  });
});

// ---------------------------------------------------------------------------
// channels / apps
// ---------------------------------------------------------------------------

describe('ipc：channels 与 apps', () => {
  it('channels.list / get / create 返回 DTO 并广播 data-changed', async () => {
    const harness = makeHarness();
    expect((await call(harness, IPC_CHANNELS.channelsList)).value).toHaveLength(1);

    const detail = await call(harness, IPC_CHANNELS.channelsGet, { channelId: CHANNEL_ID });
    expect(detail.value.summary.id).toBe(CHANNEL_ID);
    expect(detail.value.apps[0].appId).toBe('demo-app');

    const created = await call(harness, IPC_CHANNELS.channelsCreate, {
      name: '新频道',
      visibility: 'public',
      storage: { provider: 'local', rootDir: tempDir, publicBaseUrl: 'http://127.0.0.1:8080/' },
    });
    expect(created.ok).toBe(true);
    expect(harness.targets[0]?.sent.some((event) => event.channel === IPC_EVENTS.dataChanged)).toBe(true);
  });

  it('channels.subscribe / refreshAll / unsubscribe 正常返回', async () => {
    const harness = makeHarness();
    expect(
      await call(harness, IPC_CHANNELS.channelsSubscribe, { url: 'https://example.com/channel.json' }),
    ).toMatchObject({ ok: true });
    expect(harness.core.channels.subscribe).toHaveBeenCalledWith({
      url: 'https://example.com/channel.json',
      headers: undefined,
    });
    expect(await call(harness, IPC_CHANNELS.channelsRefreshAll)).toMatchObject({ ok: true });
    expect(await call(harness, IPC_CHANNELS.channelsUnsubscribe, { channelId: CHANNEL_ID })).toMatchObject({
      ok: true,
    });
    expect(harness.core.channels.unsubscribe).toHaveBeenCalledWith(CHANNEL_ID);
  });

  it('apps.get 映射 AppDetailDTO', async () => {
    const harness = makeHarness();
    const result = await call(harness, IPC_CHANNELS.appsGet, { channelId: CHANNEL_ID, appId: 'demo-app' });
    expect(result).toMatchObject({ ok: true, value: { channelId: CHANNEL_ID } });
    expect(result.value.app.appId).toBe('demo-app');
    expect(result.value.versions[0].version).toBe('1.0.0');
    expect(harness.core.publishing.getApp).toHaveBeenCalledWith(CHANNEL_ID, 'demo-app');
  });
});

// ---------------------------------------------------------------------------
// publish
// ---------------------------------------------------------------------------

describe('ipc：publish', () => {
  it('pick 取消时返回 ok:true + null', async () => {
    const harness = makeHarness();
    const result = await call(harness, IPC_CHANNELS.publishPick, { kind: 'files' });
    expect(result).toEqual({ ok: true, value: null });
  });

  it('publish.start（files 模式）转换 selection、推送 progress 并广播 data-changed', async () => {
    const exe = path.join(tempDir, 'app.exe');
    const readme = path.join(tempDir, 'readme.txt');
    await writeFile(exe, 'MZ');
    await writeFile(readme, 'hi');
    const harness = makeHarness({
      registryDialog: { showOpenDialog: vi.fn(async () => ({ canceled: false, filePaths: [exe, readme] })) },
    });
    harness.core.publishing.publish.mockImplementation(async (input: any) => {
      input.onProgress?.({ phase: 'transfer', message: '上传中', percent: 50, transferredBytes: 1, totalBytes: 2 });
      return publishResult();
    });
    const selection = await call(harness, IPC_CHANNELS.publishPick, { kind: 'files' });
    expect(selection.ok).toBe(true);

    const request = {
      channelId: CHANNEL_ID,
      displayName: '示例 App',
      version: '1.0.0',
      platform: 'windows',
      publishMode: 'files',
      entry: 'app.exe',
      selectionId: selection.value.selectionId,
    };
    const result = await call(harness, IPC_CHANNELS.publishStart, request);
    expect(result).toMatchObject({ ok: true, value: { appId: 'demo-app', version: '1.0.0' } });

    const input = harness.core.publishing.publish.mock.calls[0]?.[0];
    expect(input.publishMode).toBe('files');
    expect(input.entry).toBe('app.exe');
    expect(input.files).toEqual([
      { sourcePath: exe, targetPath: 'app.exe', executable: true },
      { sourcePath: readme, targetPath: 'readme.txt', executable: undefined },
    ]);

    const progress = harness.sent.filter((event) => event.channel === IPC_EVENTS.progress);
    expect(progress).toHaveLength(1);
    expect(progress[0]?.data).toMatchObject({
      operationId: 'op-test-1',
      operation: 'publish',
      phase: 'transfer',
      channelId: CHANNEL_ID,
      percent: 50,
    });
    const dataChanged = harness.targets[0]?.sent.filter((event) => event.channel === IPC_EVENTS.dataChanged) ?? [];
    expect(dataChanged.map((event) => event.data.domain)).toEqual(expect.arrayContaining(['channels', 'apps']));
  });

  it('publish.start：selection 不存在 -> NOT_FOUND；模式不匹配 -> VALIDATION', async () => {
    const zip = path.join(tempDir, 'bundle.zip');
    await writeFile(zip, 'PK');
    const harness = makeHarness({
      registryDialog: { showOpenDialog: vi.fn(async () => ({ canceled: false, filePaths: [zip] })) },
    });
    const base = {
      channelId: CHANNEL_ID,
      displayName: '示例 App',
      version: '1.0.0',
      platform: 'windows',
      entry: 'run.exe',
    };
    expect(
      await call(harness, IPC_CHANNELS.publishStart, { ...base, publishMode: 'files', selectionId: 'missing' }),
    ).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });

    const zipSelection = await call(harness, IPC_CHANNELS.publishPick, { kind: 'zip' });
    expect(zipSelection.ok).toBe(true);
    expect(
      await call(harness, IPC_CHANNELS.publishStart, {
        ...base,
        publishMode: 'files',
        selectionId: zipSelection.value.selectionId,
      }),
    ).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
    expect(harness.core.publishing.publish).not.toHaveBeenCalled();
  });

  it('publish.start：files 模式入口必须在文件列表中', async () => {
    const file = path.join(tempDir, 'app.exe');
    await writeFile(file, 'MZ');
    const harness = makeHarness({
      registryDialog: { showOpenDialog: vi.fn(async () => ({ canceled: false, filePaths: [file] })) },
    });
    const selection = await call(harness, IPC_CHANNELS.publishPick, { kind: 'files' });
    const result = await call(harness, IPC_CHANNELS.publishStart, {
      channelId: CHANNEL_ID,
      displayName: '示例',
      version: '1.0.0',
      platform: 'windows',
      publishMode: 'files',
      entry: 'other.exe',
      selectionId: selection.value.selectionId,
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
  });

  it('buildPublishInput：zip 选择生成 zipPath，folder 选择生成 zipFromDir', () => {
    const zipSelection = {
      id: 's1',
      kind: 'zip' as const,
      createdAt: 0,
      expiresAt: Date.now() + 1000,
      files: [],
      zipPath: path.join(tempDir, 'bundle.zip'),
    };
    const zipInput = buildPublishInput(
      {
        channelId: CHANNEL_ID,
        displayName: '示例',
        version: '1.0.0',
        platform: 'windows',
        publishMode: 'zip',
        entry: 'run.exe',
        selectionId: 's1',
      },
      zipSelection,
    );
    expect(zipInput.zipPath).toBe(zipSelection.zipPath);
    expect(zipInput.publishMode).toBe('zip');
    expect(zipInput.entry).toBe('run.exe');

    const folderSelection = {
      ...zipSelection,
      kind: 'folder' as const,
      zipPath: undefined,
      rootDir: tempDir,
    };
    const folderInput = buildPublishInput(
      {
        channelId: CHANNEL_ID,
        displayName: '示例',
        version: '1.0.0',
        platform: 'windows',
        publishMode: 'zip',
        entry: 'run.exe',
        selectionId: 's2',
      },
      folderSelection,
    );
    expect(folderInput.zipFromDir).toBe(tempDir);
    expect(folderInput.zipPath).toBeUndefined();
  });

  it('publish.updateAppMeta 调用 core 并返回 AppDetailDTO', async () => {
    const harness = makeHarness();
    const result = await call(harness, IPC_CHANNELS.publishUpdateAppMeta, {
      channelId: CHANNEL_ID,
      appId: 'demo-app',
      patch: { displayName: '新名字' },
    });
    expect(result).toMatchObject({ ok: true, value: { app: { displayName: '示例 App' } } });
    expect(harness.core.publishing.updateMeta).toHaveBeenCalledWith(CHANNEL_ID, 'demo-app', {
      displayName: '新名字',
    });
  });
});

// ---------------------------------------------------------------------------
// 私有配置导入/导出
// ---------------------------------------------------------------------------

describe('ipc：channel_pri 导入/导出', () => {
  it('exportPrivateConfig 弹保存框并写盘（内容不进入日志）', async () => {
    const harness = makeHarness();
    const raw = '{"kind":"apphub-channel-private","accessKey":"abcdefghijklmnop"}';
    harness.core.channels.exportPrivateConfig.mockResolvedValue(raw);
    const target = path.join(tempDir, 'exported-channel-pri.json');
    h.saveDialog.mockResolvedValue({ canceled: false, filePath: target });

    const result = await call(harness, IPC_CHANNELS.channelsExportPrivateConfig, { channelId: CHANNEL_ID });
    expect(result).toMatchObject({ ok: true, value: { canceled: false, savedPath: target } });
    await expect(readFile(target, 'utf8')).resolves.toBe(raw);
    expect(JSON.stringify(harness.logger.entries)).not.toContain('abcdefghijklmnop');
  });

  it('exportPrivateConfig 取消保存返回 canceled:true', async () => {
    const harness = makeHarness();
    h.saveDialog.mockResolvedValue({ canceled: true });
    const result = await call(harness, IPC_CHANNELS.channelsExportPrivateConfig, { channelId: CHANNEL_ID });
    expect(result).toMatchObject({ ok: true, value: { canceled: true } });
  });

  it('importPrivateConfig 读取文件（去 BOM）并交给 core', async () => {
    const harness = makeHarness();
    const source = path.join(tempDir, 'channel_pri.json');
    await writeFile(source, `\uFEFF{"kind":"apphub-channel-private"}`, 'utf8');
    h.openDialog.mockResolvedValue({ canceled: false, filePaths: [source] });
    const result = await call(harness, IPC_CHANNELS.channelsImportPrivateConfig);
    expect(result).toMatchObject({ ok: true, value: { summary: { id: CHANNEL_ID } } });
    expect(harness.core.channels.importPrivateConfig).toHaveBeenCalledWith('{"kind":"apphub-channel-private"}');
  });

  it('importPrivateConfig 取消返回 null', async () => {
    const harness = makeHarness();
    h.openDialog.mockResolvedValue({ canceled: true, filePaths: [] });
    await expect(call(harness, IPC_CHANNELS.channelsImportPrivateConfig)).resolves.toEqual({
      ok: true,
      value: null,
    });
  });
});

// ---------------------------------------------------------------------------
// library
// ---------------------------------------------------------------------------

describe('ipc：library', () => {
  it('list / checkUpdates / verify 正常映射', async () => {
    const harness = makeHarness();
    const list = await call(harness, IPC_CHANNELS.libraryList);
    expect(list).toMatchObject({ ok: true, value: [{ appId: 'demo-app', status: 'installed' }] });
    expect(await call(harness, IPC_CHANNELS.libraryCheckUpdates)).toEqual({ ok: true, value: [] });

    harness.core.library.verify.mockResolvedValue({
      ok: false,
      checkedFiles: 2,
      mismatches: [{ path: 'app.exe', reason: 'md5', expectedMd5: 'a', actualMd5: 'b' }],
    });
    const verify = await call(harness, IPC_CHANNELS.libraryVerify, { channelId: CHANNEL_ID, appId: 'demo-app' });
    expect(verify.value).toMatchObject({ ok: false, checkedFiles: 2, mismatches: [{ path: 'app.exe', reason: 'md5' }] });
  });

  it('install 推送 progress 事件并返回 InstallResultDTO', async () => {
    const harness = makeHarness();
    harness.core.library.install.mockImplementation(async (input: any) => {
      input.onProgress?.({ phase: 'transfer', percent: 10 });
      return installResult();
    });
    const result = await call(harness, IPC_CHANNELS.libraryInstall, {
      channelId: CHANNEL_ID,
      appId: 'demo-app',
      force: true,
    });
    expect(result).toMatchObject({ ok: true, value: { downloadedBytes: 4 } });
    const progress = harness.sent.filter((event) => event.channel === IPC_EVENTS.progress);
    expect(progress[0]?.data).toMatchObject({ operation: 'install', operationId: 'op-test-1', percent: 10 });
  });

  it('update 使用 update 操作类型', async () => {
    const harness = makeHarness();
    harness.core.library.update.mockImplementation(async (input: any) => {
      input.onProgress?.({ phase: 'commit', percent: 100 });
      return { ...installResult(), updatedFrom: '0.9.0' };
    });
    const result = await call(harness, IPC_CHANNELS.libraryUpdate, { channelId: CHANNEL_ID, appId: 'demo-app' });
    expect(result.ok).toBe(true);
    expect(harness.sent.find((event) => event.channel === IPC_EVENTS.progress)?.data.operation).toBe('update');
  });

  it('launch：descriptor 逃逸时拒绝且不启动进程', async () => {
    const harness = makeHarness();
    const appRoot = path.join(tempDir, 'app-root');
    harness.core.library.getLaunchDescriptor.mockResolvedValue({
      appRoot,
      versionDir: path.join(appRoot, 'versions', '1.0.0'),
      entryPath: path.join(tempDir, 'evil.exe'),
      cwd: path.join(appRoot, 'versions', '1.0.0'),
      args: [],
    });
    const result = await call(harness, IPC_CHANNELS.libraryLaunch, { channelId: CHANNEL_ID, appId: 'demo-app' });
    expect(result).toMatchObject({ ok: false, error: { code: 'SECURITY' } });
  });

  it('launch：注入 launch 实现时正常返回 pid', async () => {
    const harness = makeHarness({ launch: async () => ({ pid: 777 }) });
    const result = await call(harness, IPC_CHANNELS.libraryLaunch, { channelId: CHANNEL_ID, appId: 'demo-app' });
    expect(result).toEqual({ ok: true, value: { pid: 777 } });
  });

  it('reveal：未安装 -> NOT_FOUND；已安装 -> shell.showItemInFolder', async () => {
    const harness = makeHarness();
    harness.core.library.list.mockResolvedValueOnce([]);
    expect(await call(harness, IPC_CHANNELS.libraryReveal, { channelId: CHANNEL_ID, appId: 'demo-app' })).toMatchObject({
      ok: false,
      error: { code: 'NOT_FOUND' },
    });
    expect(h.showItemInFolder).not.toHaveBeenCalled();

    const appRoot = path.join(tempDir, 'library', CHANNEL_ID, 'demo-app');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(appRoot, { recursive: true });
    harness.core.library.list.mockResolvedValue([installedApp({ appRoot })]);
    harness.core.dataDir = tempDir;
    expect(await call(harness, IPC_CHANNELS.libraryReveal, { channelId: CHANNEL_ID, appId: 'demo-app' })).toMatchObject({
      ok: true,
    });
    expect(h.showItemInFolder).toHaveBeenCalledWith(appRoot);
  });

  it('uninstall 调用 core 并广播 library 变更', async () => {
    const harness = makeHarness();
    const result = await call(harness, IPC_CHANNELS.libraryUninstall, { channelId: CHANNEL_ID, appId: 'demo-app' });
    expect(result).toMatchObject({ ok: true });
    expect(harness.core.library.uninstall).toHaveBeenCalledWith(CHANNEL_ID, 'demo-app');
    const domains = (harness.targets[0]?.sent ?? [])
      .filter((event) => event.channel === IPC_EVENTS.dataChanged)
      .map((event) => event.data.domain);
    expect(domains).toContain('library');
  });
});

// ---------------------------------------------------------------------------
// system
// ---------------------------------------------------------------------------

describe('ipc：system.openDataDir', () => {
  it('openPath 返回空串视为成功，返回非空给出 IO 错误', async () => {
    const harness = makeHarness();
    expect(await call(harness, IPC_CHANNELS.systemOpenDataDir)).toMatchObject({ ok: true });

    h.openPath.mockResolvedValue('无法打开目录');
    expect(await call(harness, IPC_CHANNELS.systemOpenDataDir)).toMatchObject({
      ok: false,
      error: { code: 'IO' },
    });
  });
});

// ---------------------------------------------------------------------------
// system.changeDataDir
// ---------------------------------------------------------------------------

describe('ipc：system.changeDataDir', () => {
  it('调用注入的 changeDataDir 回调并返回迁移结果（不广播 data-changed）', async () => {
    const changeDataDir = vi.fn(async (newPath: string) => ({
      previousDataDir: path.resolve(tempDir, 'old-data'),
      newDataDir: newPath,
      restarting: true,
    }));
    const harness = makeHarness({ changeDataDir });
    const newPath = path.resolve(tempDir, 'new-data');

    const result = await call(harness, IPC_CHANNELS.systemChangeDataDir, { path: newPath });
    expect(result).toEqual({
      ok: true,
      value: {
        previousDataDir: path.resolve(tempDir, 'old-data'),
        newDataDir: newPath,
        restarting: true,
      },
    });
    expect(changeDataDir).toHaveBeenCalledTimes(1);
    expect(changeDataDir).toHaveBeenCalledWith(newPath);
    // App 将重启，不需要广播 data-changed
    expect(harness.targets[0]?.sent.filter((event) => event.channel === IPC_EVENTS.dataChanged)).toHaveLength(0);
  });

  it('未注入回调（env 固定/测试未注入）→ UNSUPPORTED', async () => {
    const harness = makeHarness();
    const result = await call(harness, IPC_CHANNELS.systemChangeDataDir, { path: path.resolve(tempDir, 'x') });
    expect(result).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED' } });
    expect(result.error.message).toContain('不支持');
  });

  it('非法入参被 zod 拒绝且不调用回调（空/空白/非字符串/多余字段）', async () => {
    const changeDataDir = vi.fn(async (newPath: string) => ({
      previousDataDir: 'old',
      newDataDir: newPath,
      restarting: true,
    }));
    const harness = makeHarness({ changeDataDir });
    const invalid: unknown[] = [{}, { path: '' }, { path: '   ' }, { path: 123 }, { path: path.resolve(tempDir, 'x'), extra: 1 }];
    for (const payload of invalid) {
      const result = await call(harness, IPC_CHANNELS.systemChangeDataDir, payload);
      expect(result, `应拒绝 ${JSON.stringify(payload)}`).toMatchObject({
        ok: false,
        error: { code: 'VALIDATION' },
      });
    }
    expect(changeDataDir).not.toHaveBeenCalled();
  });

  it('回调抛 AppError 时透传 code/message；普通异常折叠为 INTERNAL', async () => {
    const conflictHarness = makeHarness({
      changeDataDir: async () => {
        throw new AppError('CONFLICT', '目标目录非空，请选择空目录');
      },
    });
    expect(await call(conflictHarness, IPC_CHANNELS.systemChangeDataDir, { path: path.resolve(tempDir, 'x') })).toMatchObject({
      ok: false,
      error: { code: 'CONFLICT', message: '目标目录非空，请选择空目录' },
    });

    const internalHarness = makeHarness({
      changeDataDir: async () => {
        throw new Error('boom');
      },
    });
    const internal = await call(internalHarness, IPC_CHANNELS.systemChangeDataDir, {
      path: path.resolve(tempDir, 'y'),
    });
    expect(internal).toMatchObject({ ok: false, error: { code: 'INTERNAL' } });
    expect(JSON.stringify(internal)).not.toContain('at ');
  });
});

// ---------------------------------------------------------------------------
// updates（应用内自动更新）
// ---------------------------------------------------------------------------

describe('ipc：updates', () => {
  function updateState(overrides: Record<string, unknown> = {}): any {
    return { supported: true, status: 'idle', currentVersion: '0.1.0', ...overrides };
  }

  function makeUpdater() {
    return {
      getState: vi.fn(() => updateState()),
      check: vi.fn(async () => updateState({ status: 'checking' })),
      download: vi.fn(async () => updateState({ status: 'downloaded', progress: { percent: 100 } })),
      install: vi.fn(async () => undefined),
      dismiss: vi.fn(() => updateState({ status: 'available', dismissed: true })),
    };
  }

  const UPDATE_CHANNELS = [
    IPC_CHANNELS.updatesState,
    IPC_CHANNELS.updatesCheck,
    IPC_CHANNELS.updatesDownload,
    IPC_CHANNELS.updatesInstall,
    IPC_CHANNELS.updatesDismiss,
  ];

  it('未注入 updater 时 5 个 updates API 均返回 UNSUPPORTED', async () => {
    const harness = makeHarness();
    for (const channel of UPDATE_CHANNELS) {
      expect(await call(harness, channel)).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED' } });
    }
  });

  it('5 个 handler 调用注入实现并返回 ApiResult', async () => {
    const updater = makeUpdater();
    const harness = makeHarness({ updater });

    expect(await call(harness, IPC_CHANNELS.updatesState)).toEqual({ ok: true, value: updateState() });
    expect(await call(harness, IPC_CHANNELS.updatesCheck)).toMatchObject({ ok: true, value: { status: 'checking' } });
    expect(await call(harness, IPC_CHANNELS.updatesDownload)).toMatchObject({
      ok: true,
      value: { status: 'downloaded' },
    });
    expect(await call(harness, IPC_CHANNELS.updatesInstall)).toEqual({ ok: true, value: undefined });
    expect(await call(harness, IPC_CHANNELS.updatesDismiss)).toMatchObject({ ok: true, value: { dismissed: true } });

    expect(updater.getState).toHaveBeenCalledTimes(1);
    expect(updater.check).toHaveBeenCalledTimes(1);
    expect(updater.download).toHaveBeenCalledTimes(1);
    expect(updater.install).toHaveBeenCalledTimes(1);
    expect(updater.dismiss).toHaveBeenCalledTimes(1);
  });

  it('更新器抛 AppError 时透传 code；普通异常折叠为 INTERNAL', async () => {
    const updater = makeUpdater();
    updater.check.mockRejectedValueOnce(new AppError('STATE', '更新器已释放'));
    const harness = makeHarness({ updater });
    expect(await call(harness, IPC_CHANNELS.updatesCheck)).toMatchObject({
      ok: false,
      error: { code: 'STATE', message: '更新器已释放' },
    });

    updater.download.mockRejectedValueOnce(new Error('boom'));
    const internal = await call(harness, IPC_CHANNELS.updatesDownload);
    expect(internal).toMatchObject({ ok: false, error: { code: 'INTERNAL' } });
    expect(JSON.stringify(internal)).not.toContain('at ');
  });

  it('拒绝多余字段入参（空入参契约）', async () => {
    const updater = makeUpdater();
    const harness = makeHarness({ updater });
    for (const channel of UPDATE_CHANNELS) {
      expect(await call(harness, channel, { extra: 1 })).toMatchObject({
        ok: false,
        error: { code: 'VALIDATION' },
      });
    }
    expect(updater.getState).not.toHaveBeenCalled();
    expect(updater.check).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// system.pickDirectory
// ---------------------------------------------------------------------------

describe('ipc：system.pickDirectory', () => {
  it('取消时返回 ok:true + null，并携带目录选择参数', async () => {
    const harness = makeHarness();
    h.openDialog.mockResolvedValue({ canceled: true, filePaths: [] });
    const result = await call(harness, IPC_CHANNELS.systemPickDirectory);
    expect(result).toEqual({ ok: true, value: null });
    expect(h.openDialog).toHaveBeenCalledTimes(1);
    expect(h.openDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        title: '选择频道本地存储目录',
        properties: expect.arrayContaining(['openDirectory', 'createDirectory']),
      }),
    );
  });

  it('用户选中目录时返回绝对路径', async () => {
    const harness = makeHarness();
    h.openDialog.mockResolvedValue({ canceled: false, filePaths: [tempDir] });
    await expect(call(harness, IPC_CHANNELS.systemPickDirectory)).resolves.toEqual({
      ok: true,
      value: tempDir,
    });
  });

  it('canceled=false 但 filePaths 为空时返回 null（不抛错）', async () => {
    const harness = makeHarness();
    h.openDialog.mockResolvedValue({ canceled: false, filePaths: [] });
    await expect(call(harness, IPC_CHANNELS.systemPickDirectory)).resolves.toEqual({
      ok: true,
      value: null,
    });
  });
});

// ---------------------------------------------------------------------------
// host（本机 Host）
// ---------------------------------------------------------------------------

describe('ipc：host', () => {
  it('toHostStatus 纯映射：urls 拷贝、lastError -> ApiError、undefined 字段省略', () => {
    const source = hostStatus({
      startedAt: undefined,
      lastError: { code: 'NETWORK', message: '端口被占用' },
    });
    const dto = toHostStatus(source);
    expect(dto).toMatchObject({
      channelId: CHANNEL_ID,
      channelName: '测试频道',
      visibility: 'public',
      running: true,
      configuredPort: 8787,
      port: 8787,
      bindHost: '0.0.0.0',
    });
    expect(dto.lastError).toEqual({ code: 'NETWORK', message: '端口被占用' });
    expect(dto).not.toHaveProperty('startedAt');
    // 数组/对象不能与 core 内部状态共享引用
    expect(dto.urls).not.toBe(source.urls);
    expect(dto.urls.lanChannelUrls).not.toBe(source.urls.lanChannelUrls);
    expect(dto.urls.lanChannelUrls).toEqual(source.urls.lanChannelUrls);
  });

  it('host.status 调用 core 并映射 DTO（查询不广播 data-changed）', async () => {
    const harness = makeHarness();
    const result = await call(harness, IPC_CHANNELS.hostStatus, { channelId: CHANNEL_ID });
    expect(result).toMatchObject({
      ok: true,
      value: {
        channelId: CHANNEL_ID,
        running: true,
        configuredPort: 8787,
        port: 8787,
        bindHost: '0.0.0.0',
      },
    });
    expect(result.value.urls.localChannelUrl).toBe('http://127.0.0.1:8787/channel.json');
    expect(harness.core.host.status).toHaveBeenCalledWith(CHANNEL_ID);
    expect(harness.targets[0]?.sent.filter((event) => event.channel === IPC_EVENTS.dataChanged)).toHaveLength(0);
  });

  it('host.start 成功后广播 data-changed（domain=host）', async () => {
    const harness = makeHarness();
    const result = await call(harness, IPC_CHANNELS.hostStart, { channelId: CHANNEL_ID });
    expect(result).toMatchObject({ ok: true, value: { running: true, port: 8787 } });
    expect(harness.core.host.start).toHaveBeenCalledWith(CHANNEL_ID);
    const changed = (harness.targets[0]?.sent ?? []).filter((event) => event.channel === IPC_EVENTS.dataChanged);
    expect(changed).toHaveLength(1);
    expect(changed[0]?.data).toEqual({ domain: 'host', channelId: CHANNEL_ID });
  });

  it('host.stop 返回停止态（port=null、无 startedAt）并广播', async () => {
    const harness = makeHarness();
    const result = await call(harness, IPC_CHANNELS.hostStop, { channelId: CHANNEL_ID });
    expect(result).toMatchObject({ ok: true, value: { running: false, port: null } });
    expect(result.value).not.toHaveProperty('startedAt');
    expect(harness.core.host.stop).toHaveBeenCalledWith(CHANNEL_ID);
    const changed = (harness.targets[0]?.sent ?? []).filter((event) => event.channel === IPC_EVENTS.dataChanged);
    expect(changed[0]?.data).toEqual({ domain: 'host', channelId: CHANNEL_ID });
  });

  it('host.list 映射全部状态（含已停止）', async () => {
    const harness = makeHarness();
    harness.core.host.list.mockResolvedValue([
      hostStatus(),
      hostStatus({
        channelId: 'ch_fedcba9876543210',
        channelName: '第二个频道',
        running: false,
        port: null,
        startedAt: undefined,
      }),
    ]);
    const result = await call(harness, IPC_CHANNELS.hostList);
    expect(result.ok).toBe(true);
    expect(result.value).toHaveLength(2);
    expect(result.value[1]).toMatchObject({
      channelId: 'ch_fedcba9876543210',
      channelName: '第二个频道',
      running: false,
      port: null,
    });
  });

  it('host.updateConfig 透传 patch 并广播', async () => {
    const harness = makeHarness();
    const patch = {
      port: 9000,
      bindHost: '127.0.0.1',
      advertiseHost: '192.168.1.10',
      publicBaseUrl: 'http://192.168.1.10:9000/',
    };
    const result = await call(harness, IPC_CHANNELS.hostUpdateConfig, { channelId: CHANNEL_ID, patch });
    expect(result).toMatchObject({ ok: true, value: { configuredPort: 9000 } });
    expect(harness.core.host.updateConfig).toHaveBeenCalledWith(CHANNEL_ID, patch);
    const changed = (harness.targets[0]?.sent ?? []).filter((event) => event.channel === IPC_EVENTS.dataChanged);
    expect(changed).toHaveLength(1);
    expect(changed[0]?.data).toEqual({ domain: 'host', channelId: CHANNEL_ID });
  });

  it('host.updateConfig 允许 advertiseHost: ""（清除对外主机名）并透传 core', async () => {
    const harness = makeHarness();
    const result = await call(harness, IPC_CHANNELS.hostUpdateConfig, {
      channelId: CHANNEL_ID,
      patch: { advertiseHost: '' },
    });
    expect(result).toMatchObject({ ok: true });
    expect(harness.core.host.updateConfig).toHaveBeenCalledWith(CHANNEL_ID, { advertiseHost: '' });
    const changed = (harness.targets[0]?.sent ?? []).filter((event) => event.channel === IPC_EVENTS.dataChanged);
    expect(changed).toHaveLength(1);
    expect(changed[0]?.data).toEqual({ domain: 'host', channelId: CHANNEL_ID });
  });

  it('host.updateConfig 允许 publicBaseUrl: ""（清除公开地址）并透传 core', async () => {
    const harness = makeHarness();
    const result = await call(harness, IPC_CHANNELS.hostUpdateConfig, {
      channelId: CHANNEL_ID,
      patch: { publicBaseUrl: '' },
    });
    expect(result).toMatchObject({ ok: true });
    expect(harness.core.host.updateConfig).toHaveBeenCalledWith(CHANNEL_ID, { publicBaseUrl: '' });
  });

  it('core 抛 AppError 时透传错误码且不广播 data-changed', async () => {
    const harness = makeHarness();
    harness.core.host.start.mockRejectedValue(new AppError('UNSUPPORTED', '仅支持 local-host 频道'));
    const result = await call(harness, IPC_CHANNELS.hostStart, { channelId: CHANNEL_ID });
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'UNSUPPORTED', message: '仅支持 local-host 频道' },
    });
    expect(harness.targets[0]?.sent.filter((event) => event.channel === IPC_EVENTS.dataChanged)).toHaveLength(0);
  });

  it('非法入参被 zod 拒绝且不调用 core（多余字段/port 越界/advertiseHost 带协议/bindHost 非法）', async () => {
    const harness = makeHarness();
    const invalid: { channel: string; payload: unknown }[] = [
      { channel: IPC_CHANNELS.hostStart, payload: { channelId: CHANNEL_ID, extra: true } },
      { channel: IPC_CHANNELS.hostStop, payload: { channelId: 'bad' } },
      { channel: IPC_CHANNELS.hostStatus, payload: { channelId: CHANNEL_ID, extra: 1 } },
      { channel: IPC_CHANNELS.hostList, payload: { sneaky: true } },
      { channel: IPC_CHANNELS.hostUpdateConfig, payload: { channelId: CHANNEL_ID, patch: { port: 0 } } },
      { channel: IPC_CHANNELS.hostUpdateConfig, payload: { channelId: CHANNEL_ID, patch: { port: 70000 } } },
      { channel: IPC_CHANNELS.hostUpdateConfig, payload: { channelId: CHANNEL_ID, patch: { port: 1.5 } } },
      {
        channel: IPC_CHANNELS.hostUpdateConfig,
        payload: { channelId: CHANNEL_ID, patch: { advertiseHost: 'http://evil.example' } },
      },
      {
        channel: IPC_CHANNELS.hostUpdateConfig,
        payload: { channelId: CHANNEL_ID, patch: { advertiseHost: 'host:8080' } },
      },
      {
        channel: IPC_CHANNELS.hostUpdateConfig,
        payload: { channelId: CHANNEL_ID, patch: { advertiseHost: '   ' } },
      },
      {
        channel: IPC_CHANNELS.hostUpdateConfig,
        payload: { channelId: CHANNEL_ID, patch: { publicBaseUrl: 123 } },
      },
      {
        channel: IPC_CHANNELS.hostUpdateConfig,
        payload: { channelId: CHANNEL_ID, patch: { bindHost: '192.168.1.2' } },
      },
      {
        channel: IPC_CHANNELS.hostUpdateConfig,
        payload: { channelId: CHANNEL_ID, patch: { publicBaseUrl: 'ftp://example.com/' } },
      },
      {
        channel: IPC_CHANNELS.hostUpdateConfig,
        payload: { channelId: CHANNEL_ID, patch: { rootDir: '/tmp/repo' } },
      },
      { channel: IPC_CHANNELS.hostUpdateConfig, payload: { channelId: CHANNEL_ID, patch: {}, extra: 1 } },
    ];
    for (const entry of invalid) {
      const result = await call(harness, entry.channel, entry.payload);
      expect(result, `${entry.channel} 应拒绝 ${JSON.stringify(entry.payload)}`).toMatchObject({
        ok: false,
        error: { code: 'VALIDATION' },
      });
    }
    expect(harness.core.host.start).not.toHaveBeenCalled();
    expect(harness.core.host.stop).not.toHaveBeenCalled();
    expect(harness.core.host.status).not.toHaveBeenCalled();
    expect(harness.core.host.list).not.toHaveBeenCalled();
    expect(harness.core.host.updateConfig).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 注册
// ---------------------------------------------------------------------------

describe('ipc：registerIpcHandlers', () => {
  it('注册 IPC_CHANNELS 的全部 channel，dispose 时全部移除', () => {
    const harness = makeHarness();
    const registered: string[] = [];
    const unregistered: string[] = [];
    const dispose = registerIpcHandlers({
      ctx: harness.ctx,
      register: (channel) => registered.push(channel),
      unregister: (channel) => unregistered.push(channel),
    });
    const expected = Object.values(IPC_CHANNELS);
    expect(registered.sort()).toEqual([...expected].sort());
    expect(registered).toHaveLength(expected.length);

    dispose();
    expect(unregistered.sort()).toEqual([...expected].sort());
  });

  it('通过 electron ipcMain 注册并返回 ApiResult（不会 reject）', async () => {
    const harness = makeHarness();
    const dispose = registerIpcHandlers({ ctx: harness.ctx });
    expect(h.ipcHandlers.size).toBe(Object.values(IPC_CHANNELS).length);
    const listener = h.ipcHandlers.get(IPC_CHANNELS.channelsList);
    expect(listener).toBeTypeOf('function');
    const result = await listener!(harness.event);
    expect(result).toMatchObject({ ok: true });
    dispose();
    expect(h.ipcHandlers.size).toBe(0);
  });
});
