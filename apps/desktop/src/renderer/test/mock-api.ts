/**
 * 渲染进程测试用的 mock AppHubApi。
 *
 * 测试不依赖 window.apphub / Electron：通过 <ApiProvider api={createMockApi()}> 注入。
 * 所有方法的默认实现返回成功 fixture，单个测试用 vi.mocked(...).mockResolvedValue(...) 覆盖。
 */
import { vi } from 'vitest';
import type {
  ApiError,
  ApiErrorCode,
  ApiResult,
  AppDetailDTO,
  AppHubApi,
  AppSummaryDTO,
  ChannelDetailDTO,
  ChannelSummaryDTO,
  DataChangedEventDTO,
  HostStatusDTO,
  InstallResultDTO,
  InstalledAppDTO,
  PublishResultDTO,
  ProgressEventDTO,
  SystemInfoDTO,
  UpdateCheckDTO,
  UpdateProgressDTO,
  UpdateStateDTO,
  VerifyResultDTO,
} from '../../../shared/ipc';

export const CHANNEL_ID = 'ch_0123456789abcdef0123';
export const APP_ID = 'foobar';
export const NOW = '2026-01-03T00:00:00.000Z';
export const EARLIER = '2026-01-01T00:00:00.000Z';
export const SUBSCRIBE_URL = 'http://127.0.0.1:8080/app_repo/channel.json';
export const META_URL = 'foobar/app.meta.json';
export const HOST_LAN_URL = 'http://192.168.1.10:8787/channel.json';
export const HOST_LOCAL_URL = 'http://127.0.0.1:8787/channel.json';
export const PICKED_DIR = 'D:/AppHub/channel-repo';
export const NEW_DATA_DIR = 'D:/AppHub-data';

type Platform = AppSummaryDTO['platforms'][number];

export function ok<T>(value: T): ApiResult<T> {
  return { ok: true, value };
}

export function fail(code: ApiErrorCode, message: string, details?: unknown): ApiResult<never> {
  const error: ApiError = { code, message, ...(details === undefined ? {} : { details }) };
  return { ok: false, error };
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

export function makeChannelSummary(overrides: Partial<ChannelSummaryDTO> = {}): ChannelSummaryDTO {
  return {
    id: CHANNEL_ID,
    name: '示例频道',
    description: '用于测试的示例频道',
    visibility: 'public',
    role: 'owner',
    source: 'owned',
    appCount: 1,
    subscribeUrl: SUBSCRIBE_URL,
    canPublish: true,
    createdAt: NOW,
    updatedAt: NOW,
    lastFetchedAt: NOW,
    ...overrides,
  };
}

export function makeChannelFile(
  overrides: Partial<ChannelDetailDTO['channel']> = {},
): ChannelDetailDTO['channel'] {
  return {
    schemaVersion: 1,
    kind: 'apphub-channel',
    id: CHANNEL_ID,
    name: '示例频道',
    description: '用于测试的示例频道',
    visibility: 'public',
    owner: { name: 'Alice', contact: 'alice@example.com' },
    apps: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

export function makeAppSummary(overrides: Partial<AppSummaryDTO> = {}): AppSummaryDTO {
  return {
    appId: APP_ID,
    name: 'FooBar',
    displayName: 'FooBar',
    description: '示例 App',
    author: 'Alice',
    entry: 'foobar.exe',
    platforms: ['windows'],
    publishMode: 'files',
    latest: { windows: '1.0.1' },
    metaUrl: META_URL,
    updatedAt: NOW,
    ...overrides,
  };
}

export function makeVersionEntry(
  overrides: Partial<AppDetailDTO['versions'][number]> = {},
): AppDetailDTO['versions'][number] {
  return {
    version: '1.0.1',
    platform: 'windows',
    publishMode: 'files',
    entry: 'foobar.exe',
    publishedAt: NOW,
    changelog: '修复若干问题',
    totalSize: 1024,
    fileCount: 2,
    filesUrl: '1.0.1/files.json',
    downloadBaseUrl: '1.0.1/',
    files: [
      { path: 'foobar.exe', size: 1000, md5: 'd41d8cd98f00b204e9800998ecf8427e', executable: true },
      { path: 'resources/app.ini', size: 24, md5: '0cc175b9c0f1b6a831c399e269772661' },
    ],
    archive: null,
    ...overrides,
  };
}

export function makeAppMeta(overrides: Partial<AppDetailDTO['meta']> = {}): AppDetailDTO['meta'] {
  return {
    schemaVersion: 1,
    kind: 'apphub-app-meta',
    appId: APP_ID,
    channelId: CHANNEL_ID,
    name: 'FooBar',
    displayName: 'FooBar',
    description: '示例 App',
    author: 'Alice',
    homepage: 'https://example.com/foobar',
    publishMode: 'files',
    entry: 'foobar.exe',
    platforms: ['windows'],
    latest: { windows: '1.0.1' },
    versions: [
      makeVersionEntry(),
      makeVersionEntry({ version: '1.0.0', publishedAt: EARLIER, changelog: '首个版本' }),
    ],
    updatedAt: NOW,
    ...overrides,
  };
}

export function makeAppDetail(overrides: Partial<AppDetailDTO> = {}): AppDetailDTO {
  return {
    channelId: CHANNEL_ID,
    app: makeAppSummary(),
    meta: makeAppMeta(),
    versions: [
      makeVersionEntry(),
      makeVersionEntry({ version: '1.0.0', publishedAt: EARLIER, changelog: '首个版本' }),
    ],
    ...overrides,
  };
}

export function makeChannelDetail(overrides: Partial<ChannelDetailDTO> = {}): ChannelDetailDTO {
  return {
    summary: makeChannelSummary(),
    channel: makeChannelFile(),
    apps: [makeAppSummary()],
    ...overrides,
  };
}

export function makeInstalledApp(overrides: Partial<InstalledAppDTO> = {}): InstalledAppDTO {
  return {
    channelId: CHANNEL_ID,
    channelName: '示例频道',
    appId: APP_ID,
    displayName: 'FooBar',
    version: '1.0.0',
    platform: 'windows',
    publishMode: 'files',
    entry: 'foobar.exe',
    appRoot: 'C:/AppHub/library/ch/foobar',
    installPath: 'C:/AppHub/library/ch/foobar/versions/1.0.0',
    installedAt: NOW,
    updatedAt: NOW,
    fileCount: 2,
    totalSize: 1024,
    status: 'installed',
    ...overrides,
  };
}

export function makeSystemInfo(overrides: Partial<SystemInfoDTO> = {}): SystemInfoDTO {
  return {
    appName: 'AppHub',
    appVersion: '0.1.0',
    electronVersion: '38.8.6',
    chromeVersion: '128.0.0.0',
    nodeVersion: '22.20.0',
    platform: 'win32',
    arch: 'x64',
    dataDir: 'C:/Users/test/AppData/Roaming/AppHub/AppHubData',
    dataDirSource: 'default',
    dataDirEditable: true,
    defaultDataDir: 'C:/Users/test/AppData/Roaming/AppHub/AppHubData',
    channelCount: 1,
    installedCount: 1,
    ...overrides,
  };
}

export function makeUpdateCheck(overrides: Partial<UpdateCheckDTO> = {}): UpdateCheckDTO {
  return {
    channelId: CHANNEL_ID,
    channelName: '示例频道',
    appId: APP_ID,
    displayName: 'FooBar',
    currentVersion: '1.0.0',
    latestVersion: '1.0.1',
    platform: 'windows',
    updateAvailable: true,
    ...overrides,
  };
}

export function makeVerifyResult(overrides: Partial<VerifyResultDTO> = {}): VerifyResultDTO {
  return { ok: true, checkedFiles: 2, mismatches: [], ...overrides };
}

export function makeInstallResult(overrides: Partial<InstallResultDTO> = {}): InstallResultDTO {
  return {
    app: makeInstalledApp({ version: '1.0.1', status: 'installed' }),
    downloadedBytes: 1024,
    reusedBytes: 0,
    ...overrides,
  };
}

export function makePublishResult(overrides: Partial<PublishResultDTO> = {}): PublishResultDTO {
  return {
    appId: APP_ID,
    version: '1.0.2',
    platform: 'windows',
    publishMode: 'files',
    metaUrl: META_URL,
    totalSize: 1024,
    fileCount: 2,
    files: [
      { path: 'foobar.exe', size: 1000, md5: 'd41d8cd98f00b204e9800998ecf8427e', executable: true },
      { path: 'resources/app.ini', size: 24, md5: '0cc175b9c0f1b6a831c399e269772661' },
    ],
    archive: null,
    channelUpdatedAt: NOW,
    ...overrides,
  };
}

export function makeProgressEvent(overrides: Partial<ProgressEventDTO> = {}): ProgressEventDTO {
  return {
    operationId: 'op-1',
    operation: 'publish',
    phase: 'transfer',
    percent: 42,
    index: 1,
    count: 2,
    transferredBytes: 430,
    totalBytes: 1024,
    channelId: CHANNEL_ID,
    appId: APP_ID,
    ...overrides,
  };
}

/** 停止状态的本机 Host（默认 bindHost = 0.0.0.0，局域网可访问）。 */
export function makeHostStatus(overrides: Partial<HostStatusDTO> = {}): HostStatusDTO {
  return {
    channelId: CHANNEL_ID,
    channelName: '示例频道',
    visibility: 'public',
    running: false,
    configuredPort: 8787,
    port: null,
    bindHost: '0.0.0.0',
    urls: {
      channelUrl: HOST_LAN_URL,
      localChannelUrl: HOST_LOCAL_URL,
      lanChannelUrls: [HOST_LAN_URL],
    },
    ...overrides,
  };
}

/** 运行状态的本机 Host。 */
export function makeRunningHostStatus(overrides: Partial<HostStatusDTO> = {}): HostStatusDTO {
  return makeHostStatus({
    running: true,
    port: 8787,
    startedAt: NOW,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// 自动更新 fixtures
// ---------------------------------------------------------------------------

export const RELEASE_NOTES = '## 更新内容\n- 添加自动更新\n- 修复若干问题';

export function makeUpdateProgress(overrides: Partial<UpdateProgressDTO> = {}): UpdateProgressDTO {
  return {
    percent: 42,
    transferred: 4200,
    total: 10000,
    bytesPerSecond: 512 * 1024,
    ...overrides,
  };
}

/** 默认：非打包环境（dev），不支持自动更新。 */
export function makeUpdateState(overrides: Partial<UpdateStateDTO> = {}): UpdateStateDTO {
  return {
    supported: false,
    unsupportedReason: 'dev',
    status: 'unsupported',
    currentVersion: '0.1.0',
    ...overrides,
  };
}

/** 有可用更新（available）。 */
export function makeAvailableUpdate(overrides: Partial<UpdateStateDTO> = {}): UpdateStateDTO {
  return makeUpdateState({
    supported: true,
    unsupportedReason: undefined,
    status: 'available',
    currentVersion: '0.1.0',
    availableVersion: '0.2.0',
    releaseName: 'AppHub v0.2.0',
    releaseNotes: RELEASE_NOTES,
    releaseDate: NOW,
    lastCheckedAt: NOW,
    ...overrides,
  });
}

/** 正在下载（downloading），带进度。 */
export function makeDownloadingUpdate(overrides: Partial<UpdateStateDTO> = {}): UpdateStateDTO {
  return makeAvailableUpdate({
    status: 'downloading',
    progress: makeUpdateProgress(),
    ...overrides,
  });
}

/** 已下载（downloaded），可重启安装。 */
export function makeDownloadedUpdate(overrides: Partial<UpdateStateDTO> = {}): UpdateStateDTO {
  return makeAvailableUpdate({
    status: 'downloaded',
    progress: makeUpdateProgress({ percent: 100, transferred: 10000 }),
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// mock API
// ---------------------------------------------------------------------------

export interface MockApiOptions {
  system?: Partial<AppHubApi['system']>;
  channels?: Partial<AppHubApi['channels']>;
  apps?: Partial<AppHubApi['apps']>;
  host?: Partial<AppHubApi['host']>;
  publish?: Partial<AppHubApi['publish']>;
  library?: Partial<AppHubApi['library']>;
  updates?: Partial<AppHubApi['updates']>;
  events?: Partial<AppHubApi['events']>;
}

export interface MockAppHubApi extends AppHubApi {
  emitProgress(event: ProgressEventDTO): void;
  emitDataChanged(event: DataChangedEventDTO): void;
  emitUpdateState(state: UpdateStateDTO): void;
}

export function createMockApi(options: MockApiOptions = {}): MockAppHubApi {
  const progressHandlers = new Set<(event: ProgressEventDTO) => void>();
  const dataChangedHandlers = new Set<(event: DataChangedEventDTO) => void>();
  const updateStateHandlers = new Set<(state: UpdateStateDTO) => void>();

  const base: AppHubApi = {
    system: {
      info: vi.fn(async () => ok(makeSystemInfo())),
      openDataDir: vi.fn(async () => ok(undefined)),
      pickDirectory: vi.fn(async () => ok(PICKED_DIR)),
      changeDataDir: vi.fn(async (input: { path: string }) =>
        ok({
          previousDataDir: 'C:/Users/test/AppData/Roaming/AppHub/AppHubData',
          newDataDir: input.path,
          restarting: true,
        }),
      ),
    },
    channels: {
      list: vi.fn(async () => ok([makeChannelSummary()])),
      get: vi.fn(async () => ok(makeChannelDetail())),
      create: vi.fn(async () => ok(makeChannelDetail())),
      update: vi.fn(async () => ok(makeChannelDetail())),
      subscribe: vi.fn(async () => ok(makeChannelDetail())),
      unsubscribe: vi.fn(async () => ok(undefined)),
      refresh: vi.fn(async () => ok(makeChannelDetail())),
      refreshAll: vi.fn(async () => ok([makeChannelSummary()])),
      importPrivateConfig: vi.fn(async () => ok(null)),
      exportPrivateConfig: vi.fn(async () => ok({ canceled: false, savedPath: 'C:/tmp/channel_pri.json' })),
      getSubscribeUrl: vi.fn(async () => ok({ url: SUBSCRIBE_URL })),
    },
    apps: {
      get: vi.fn(async () => ok(makeAppDetail())),
    },
    // 默认假设频道不是 local-host（status 返回 UNSUPPORTED），HostPanel 会静默隐藏；
    // 需要 Host 面板的测试显式覆盖 status/start/stop/updateConfig。
    host: {
      start: vi.fn(async () => ok(makeRunningHostStatus())),
      stop: vi.fn(async () => ok(makeHostStatus())),
      status: vi.fn(async () => fail('UNSUPPORTED', '该频道不是本机 Host 频道')),
      list: vi.fn(async () => ok([])),
      updateConfig: vi.fn(async () => ok(makeHostStatus())),
    },
    publish: {
      pick: vi.fn(async () =>
        ok({
          selectionId: 'sel_1',
          kind: 'files' as const,
          files: [
            { id: 'f1', name: 'foobar.exe', relativePath: 'foobar.exe', size: 1000 },
            { id: 'f2', name: 'app.ini', relativePath: 'resources/app.ini', size: 24 },
          ],
        }),
      ),
      inspectSelection: vi.fn(async () => ({
        ok: true as const,
        value: {
          kind: 'files' as const,
          files: [
            { path: 'foobar.exe', size: 1000 },
            { path: 'resources/app.ini', size: 24 },
          ],
          suggestedEntry: 'foobar.exe',
        },
      })),
      start: vi.fn(async () => ok(makePublishResult())),
      updateAppMeta: vi.fn(async () => ok(makeAppDetail())),
    },
    library: {
      list: vi.fn(async () => ok([])),
      checkUpdates: vi.fn(async () => ok([makeUpdateCheck()])),
      install: vi.fn(async () => ok(makeInstallResult())),
      update: vi.fn(async () => ok(makeInstallResult({ updatedFrom: '1.0.0' }))),
      verify: vi.fn(async () => ok(makeVerifyResult())),
      uninstall: vi.fn(async () => ok(undefined)),
      launch: vi.fn(async () => ok({ pid: 4242 })),
      reveal: vi.fn(async () => ok(undefined)),
    },
    // 默认：开发环境不支持自动更新（无网络、无 Banner）；需要更新 UI 的测试显式覆盖。
    updates: {
      state: vi.fn(async () => ok(makeUpdateState())),
      check: vi.fn(async () => ok(makeUpdateState())),
      download: vi.fn(async () => ok(makeDownloadingUpdate())),
      install: vi.fn(async () => ok(undefined)),
      dismiss: vi.fn(async () => ok(makeAvailableUpdate({ dismissed: true }))),
    },
    events: {
      onProgress: vi.fn((handler: (event: ProgressEventDTO) => void) => {
        progressHandlers.add(handler);
        return () => {
          progressHandlers.delete(handler);
        };
      }),
      onDataChanged: vi.fn((handler: (event: DataChangedEventDTO) => void) => {
        dataChangedHandlers.add(handler);
        return () => {
          dataChangedHandlers.delete(handler);
        };
      }),
      onUpdateState: vi.fn((handler: (state: UpdateStateDTO) => void) => {
        updateStateHandlers.add(handler);
        return () => {
          updateStateHandlers.delete(handler);
        };
      }),
    },
  };

  const merged: AppHubApi = {
    system: { ...base.system, ...options.system },
    channels: { ...base.channels, ...options.channels },
    apps: { ...base.apps, ...options.apps },
    host: { ...base.host, ...options.host },
    publish: { ...base.publish, ...options.publish },
    library: { ...base.library, ...options.library },
    updates: { ...base.updates, ...options.updates },
    events: { ...base.events, ...options.events },
  };

  return {
    ...merged,
    emitProgress: (event: ProgressEventDTO) => progressHandlers.forEach((handler) => handler(event)),
    emitDataChanged: (event: DataChangedEventDTO) => dataChangedHandlers.forEach((handler) => handler(event)),
    emitUpdateState: (state: UpdateStateDTO) => updateStateHandlers.forEach((handler) => handler(state)),
  };
}

/** 供断言使用的导出，避免测试文件里散落 `as Platform`。 */
export type { Platform };
