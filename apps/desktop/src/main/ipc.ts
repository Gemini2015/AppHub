import { AppError, normalizeRelativePath } from '@apphub/protocol';
import type {
  AppDetail,
  AppHubCore,
  AppInfo,
  ChannelDetail,
  ChannelInfo,
  HostConfigPatch,
  HostStatus,
  InstallResult,
  InstalledAppInfo,
  PublishAppInput,
  PublishResult,
  UpdateCheckItem,
  VerifyResult,
} from '@apphub/core';
import type { ProgressEvent } from '@apphub/core';
import { app, dialog, ipcMain, shell } from 'electron';
import { randomUUID } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  IPC_CHANNELS,
  IPC_EVENTS,
  type AppDetailDTO,
  type AppSummaryDTO,
  type ChannelDetailDTO,
  type ChannelSummaryDTO,
  type ChangeDataDirResultDTO,
  type DataChangedEventDTO,
  type ExportPrivateConfigResultDTO,
  type HostStatusDTO,
  type InspectSelectionResultDTO,
  type InstallRequestDTO,
  type InstallResultDTO,
  type InstalledAppDTO,
  type IpcChannel,
  type LaunchResultDTO,
  type ProgressEventDTO,
  type ProgressOperation,
  type PublishRequestDTO,
  type PublishResultDTO,
  type PublishSelectionDTO,
  type SubscribeUrlDTO,
  type SystemInfoDTO,
  type UpdateAppMetaRequestDTO,
  type UpdateCheckDTO,
  type VerifyResultDTO,
} from '../../shared/ipc';
import {
  AppRefRequestSchema,
  ChangeDataDirRequestSchema,
  ChannelIdRequestSchema,
  CreateChannelRequestSchema,
  EmptySchema,
  ExportPrivateConfigRequestSchema,
  HostUpdateConfigRequestSchema,
  InspectSelectionRequestSchema,
  InstallRequestSchema,
  PickRequestSchema,
  PublishRequestSchema,
  SubscribeRequestSchema,
  UpdateAppMetaRequestSchema,
  UpdateChannelRequestSchema,
  UpdateCheckRequestSchema,
  VerifyRequestSchema,
} from '../../shared/ipc-schemas';
import { runApi } from './api-result';
import { launchInstalledApp, resolveInstalledAppRoot } from './app-launcher';
import type { CoreManager } from './core-manager';
import type { Logger } from './logger';
import type { SelectionRecord, SelectionRegistry } from './selection-registry';
import { assertTrustedSender } from './sender';
import type { SenderPolicy } from './sender';

/**
 * IPC 层：把 shared/ipc.ts 的 AppHubApi 全部落到 core/storage 上。
 *
 * 每个 handler 都执行同样的流水线：
 *   1) 校验 sender frame（只接受自家窗口 / 开发模式 dev server）；
 *   2) 用 shared/ipc-schemas.ts 的 zod schema 重新校验入参（strict，拒绝多余字段）；
 *   3) 调用 core / 文件对话框 / 启动器；
 *   4) 统一 ApiResult 包装（AppError -> {ok:false,error}，未知异常 -> INTERNAL 并记录日志）；
 *   5) 变更类操作广播 data-changed，长任务推送 progress 事件。
 */

export interface AppVersions {
  appName: string;
  appVersion: string;
  electronVersion: string;
  chromeVersion: string;
  nodeVersion: string;
}

/** 渲染进程 webContents 的最小结构（便于测试替身）。 */
export interface IpcSenderLike {
  id: number;
  isDestroyed(): boolean;
  send(channel: string, data: unknown): void;
}

export interface IpcEventLike {
  sender: IpcSenderLike;
  senderFrame?: { url: string } | null;
}

export type IpcHandler = (event: IpcEventLike, payload: unknown) => Promise<{ ok: true; value: unknown } | { ok: false; error: unknown }>;

export type IpcRouter = Record<string, IpcHandler>;

export interface IpcRouterContext {
  logger: Logger;
  coreManager: Pick<CoreManager, 'dataDir' | 'getCore'> & Partial<Pick<CoreManager, 'getInitError'>>;
  selectionRegistry: SelectionRegistry;
  senderPolicy: SenderPolicy;
  /** 进一步限制 sender 必须是主窗口的 webContents（生产环境由 index.ts 注入）。 */
  isTrustedSender?: (sender: IpcSenderLike) => boolean;
  /** 广播 data-changed 的目标（缺省只发给发起请求的 sender）。 */
  getWebContents?: () => IpcSenderLike[];
  appVersions?: () => AppVersions;
  platform?: NodeJS.Platform;
  randomId?: () => string;
  /** 测试注入：启动已安装 App。 */
  launch?: (core: AppHubCore, channelId: string, appId: string) => Promise<LaunchResultDTO>;
  /** 测试注入：在文件管理器中定位安装目录。 */
  reveal?: (core: AppHubCore, channelId: string, appId: string) => Promise<void>;
  /**
   * 当前数据目录信息（由 index.ts 按 bootstrap/env 注入）。
   * 缺省回退到 coreManager.dataDir，视为不可编辑的默认目录（便于测试与降级）。
   */
  dataDirInfo?: {
    dataDir: string;
    defaultDataDir: string;
    source: 'default' | 'custom' | 'env';
    editable: boolean;
  };
  /**
   * 修改数据目录：校验目标 → 关闭 core → 迁移 → 写引导配置 → 重启 App。
   * 缺省（如 env 固定或测试未注入）时 handler 返回 UNSUPPORTED。
   */
  changeDataDir?: (newPath: string) => Promise<ChangeDataDirResultDTO>;
}

const MAX_PRIVATE_CONFIG_BYTES = 2 * 1024 * 1024;

// ---------------------------------------------------------------------------
// 纯工具 / DTO 映射（便于单测）
// ---------------------------------------------------------------------------

export function defaultAppVersions(): AppVersions {
  return {
    appName: app.getName(),
    appVersion: app.getVersion(),
    electronVersion: process.versions['electron'] ?? '',
    chromeVersion: process.versions['chrome'] ?? '',
    nodeVersion: process.versions['node'] ?? '',
  };
}

export function toChannelSummary(info: ChannelInfo): ChannelSummaryDTO {
  return {
    id: info.id,
    name: info.name,
    description: info.description,
    visibility: info.visibility,
    role: info.role,
    source: info.source,
    appCount: info.appCount,
    subscribeUrl: info.subscribeUrl,
    canPublish: info.canPublish,
    createdAt: info.createdAt,
    updatedAt: info.updatedAt,
    lastFetchedAt: info.lastFetchedAt,
  };
}

export function toAppSummary(info: AppInfo): AppSummaryDTO {
  return {
    appId: info.appId,
    name: info.name,
    displayName: info.displayName,
    description: info.description,
    author: info.author,
    entry: info.entry,
    platforms: info.platforms,
    publishMode: info.publishMode,
    latest: info.latest,
    metaUrl: info.metaUrl,
    updatedAt: info.updatedAt,
    iconUrl: info.iconUrl,
  };
}

export function toChannelDetail(detail: ChannelDetail): ChannelDetailDTO {
  return {
    summary: toChannelSummary(detail),
    channel: detail.channel,
    apps: detail.apps.map(toAppSummary),
  };
}

export function toAppDetail(detail: AppDetail): AppDetailDTO {
  return {
    channelId: detail.channelId,
    app: toAppSummary(detail.app),
    meta: detail.meta,
    versions: detail.versions,
  };
}

export function toInstalledApp(info: InstalledAppInfo): InstalledAppDTO {
  return {
    channelId: info.channelId,
    channelName: info.channelName,
    appId: info.appId,
    displayName: info.displayName,
    version: info.version,
    platform: info.platform,
    publishMode: info.publishMode,
    entry: info.entry,
    appRoot: info.appRoot,
    installPath: info.installPath,
    installedAt: info.installedAt,
    updatedAt: info.updatedAt,
    fileCount: info.fileCount,
    totalSize: info.totalSize,
    status: info.status,
    availableVersion: info.availableVersion,
  };
}

export function toInstallResult(result: InstallResult): InstallResultDTO {
  return {
    app: toInstalledApp(result.app),
    downloadedBytes: result.downloadedBytes,
    reusedBytes: result.reusedBytes,
    updatedFrom: result.updatedFrom,
  };
}

export function toUpdateCheck(item: UpdateCheckItem): UpdateCheckDTO {
  return {
    channelId: item.channelId,
    channelName: item.channelName,
    appId: item.appId,
    displayName: item.displayName,
    currentVersion: item.currentVersion,
    latestVersion: item.latestVersion,
    platform: item.platform,
    updateAvailable: item.updateAvailable,
  };
}

export function toVerifyResult(result: VerifyResult): VerifyResultDTO {
  return {
    ok: result.ok,
    checkedFiles: result.checkedFiles,
    mismatches: result.mismatches.map((mismatch) => ({
      path: mismatch.path,
      reason: mismatch.reason,
      expectedMd5: mismatch.expectedMd5,
      actualMd5: mismatch.actualMd5,
    })),
  };
}

export function toPublishResult(result: PublishResult): PublishResultDTO {
  return {
    appId: result.appId,
    version: result.version,
    platform: result.platform,
    publishMode: result.publishMode,
    metaUrl: result.metaUrl,
    totalSize: result.totalSize,
    fileCount: result.fileCount,
    files: result.files,
    archive: result.archive,
    channelUpdatedAt: result.channelUpdatedAt,
  };
}

/** core.HostStatus -> HostStatusDTO（lastError 归一为可跨 IPC 的 ApiError 结构）。 */
export function toHostStatus(status: HostStatus): HostStatusDTO {
  const dto: HostStatusDTO = {
    channelId: status.channelId,
    channelName: status.channelName,
    visibility: status.visibility,
    running: status.running,
    configuredPort: status.configuredPort,
    port: status.port,
    bindHost: status.bindHost,
    urls: {
      channelUrl: status.urls.channelUrl,
      localChannelUrl: status.urls.localChannelUrl,
      lanChannelUrls: [...status.urls.lanChannelUrls],
    },
  };
  if (status.startedAt !== undefined) dto.startedAt = status.startedAt;
  if (status.lastError) {
    dto.lastError = { code: status.lastError.code, message: status.lastError.message };
  }
  return dto;
}

/**
 * 把 selection registry 的主进程记录转换为 core.PublishAppInput。
 * 这是安全边界上的关键转换：渲染进程只传 selectionId，绝对路径在此处才出现。
 */
export function buildPublishInput(request: PublishRequestDTO, selection: SelectionRecord): PublishAppInput {
  const entry = normalizeRelativePath(request.entry, '启动入口');
  const appBase: NonNullable<PublishAppInput['app']> = {
    displayName: request.displayName,
    description: request.description,
    author: request.author,
    homepage: request.homepage === '' ? undefined : request.homepage,
  };
  if (request.appId) appBase.appId = request.appId;

  const shared = {
    channelId: request.channelId,
    app: appBase,
    version: request.version,
    platform: request.platform,
    entry,
    changelog: request.changelog,
    overwrite: request.overwrite,
  };

  if (request.publishMode === 'files') {
    if (selection.kind === 'zip') {
      throw new AppError('VALIDATION', '散文件发布方式不能使用 zip 选择，请重新选择文件/文件夹');
    }
    if (selection.files.length === 0) {
      throw new AppError('VALIDATION', '选择中没有可发布的文件，请重新选择');
    }
    const files = selection.files.map((file) => ({
      sourcePath: file.absPath,
      targetPath: file.relativePath,
      executable: file.relativePath === entry ? true : undefined,
    }));
    if (!files.some((file) => file.targetPath === entry)) {
      throw new AppError('VALIDATION', '启动入口必须是所选文件之一（files 模式入口为相对路径）');
    }
    return { ...shared, publishMode: 'files', files };
  }

  if (selection.kind === 'zip') {
    if (!selection.zipPath) {
      throw new AppError('STATE', 'zip 选择记录损坏（缺少压缩包路径），请重新选择');
    }
    return { ...shared, publishMode: 'zip', zipPath: selection.zipPath };
  }
  if (selection.kind === 'folder') {
    if (!selection.rootDir) {
      throw new AppError('STATE', '文件夹选择记录损坏（缺少根目录），请重新选择');
    }
    return { ...shared, publishMode: 'zip', zipFromDir: selection.rootDir };
  }
  throw new AppError('VALIDATION', 'zip 发布方式需要选择 zip 文件或文件夹');
}

function parsePayloadWithSchema<S extends z.ZodTypeAny>(
  schema: S,
  rawPayload: unknown,
  defaultPayload: unknown,
): z.output<S> {
  const input = rawPayload === undefined && defaultPayload !== undefined ? defaultPayload : rawPayload;
  const result = schema.safeParse(input);
  if (!result.success) {
    const issues = result.error.issues.slice(0, 8).map((issue) => ({
      path: issue.path.join('.'),
      code: issue.code,
      message: issue.message,
    }));
    const first = issues[0];
    const suffix = first ? `${first.message}${first.path ? `（${first.path}）` : ''}` : '参数不合法';
    throw new AppError('VALIDATION', `参数校验失败：${suffix}`, { issues });
  }
  return result.data as z.output<S>;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Router 工厂
// ---------------------------------------------------------------------------

export function createIpcRouter(ctx: IpcRouterContext): Record<string, IpcHandler> {
  const randomId = ctx.randomId ?? (() => randomUUID());

  function assertTrusted(ctxLocal: IpcRouterContext, event: IpcEventLike, channel: string): void {
    const frameUrl = event.senderFrame?.url ?? '';
    try {
      assertTrustedSender(ctxLocal.senderPolicy, frameUrl);
      if (ctxLocal.isTrustedSender && !ctxLocal.isTrustedSender(event.sender)) {
        throw new AppError('SECURITY', 'IPC 调用来源不是主窗口，已拒绝');
      }
    } catch (err) {
      ctxLocal.logger.warn('拒绝不受信任的 IPC 调用', {
        channel,
        frame: typeof frameUrl === 'string' && frameUrl.length > 0 ? frameUrl.slice(0, 120) : '(empty)',
      });
      throw err;
    }
  }

  function sendToSender(event: IpcEventLike, channel: string, payload: unknown): void {
    try {
      if (!event.sender.isDestroyed()) event.sender.send(channel, payload);
    } catch (err) {
      ctx.logger.debug('推送 IPC 事件失败（窗口可能已关闭）', { channel, message: errorMessage(err) });
    }
  }

  function broadcastDataChanged(dto: DataChangedEventDTO): void {
    const targets = ctx.getWebContents ? ctx.getWebContents() : [];
    for (const webContents of targets) {
      try {
        if (!webContents.isDestroyed()) webContents.send(IPC_EVENTS.dataChanged, dto);
      } catch {
        /* 忽略：窗口关闭竞态 */
      }
    }
  }

  function emitProgress(
    event: IpcEventLike,
    base: { operationId: string; operation: ProgressOperation; channelId?: string; appId?: string },
    progress: ProgressEvent,
  ): void {
    const dto: ProgressEventDTO = {
      operationId: base.operationId,
      operation: base.operation,
      phase: progress.phase,
    };
    if (base.channelId !== undefined) dto.channelId = base.channelId;
    if (base.appId !== undefined) dto.appId = base.appId;
    if (progress.message !== undefined) dto.message = progress.message;
    if (progress.currentFile !== undefined) dto.currentFile = progress.currentFile;
    if (progress.index !== undefined) dto.index = progress.index;
    if (progress.count !== undefined) dto.count = progress.count;
    if (progress.transferredBytes !== undefined) dto.transferredBytes = progress.transferredBytes;
    if (progress.totalBytes !== undefined) dto.totalBytes = progress.totalBytes;
    if (progress.percent !== undefined) dto.percent = progress.percent;
    sendToSender(event, IPC_EVENTS.progress, dto);
  }

  function handle<S extends z.ZodTypeAny>(
    channel: string,
    schema: S,
    run: (payload: z.output<S>, event: IpcEventLike) => Promise<unknown>,
    defaultPayload?: unknown,
  ): IpcHandler {
    return async (event, rawPayload) =>
      runApi(ctx.logger, channel, async () => {
        assertTrusted(ctx, event, channel);
        const payload = parsePayloadWithSchema<S>(schema, rawPayload, defaultPayload);
        return run(payload, event);
      });
  }

  async function getCore(): Promise<AppHubCore> {
    return ctx.coreManager.getCore();
  }

  async function readSystemCounts(): Promise<{ channelCount: number; installedCount: number }> {
    try {
      const core = await getCore();
      const [channels, installed] = await Promise.all([core.channels.list(), core.library.list()]);
      return { channelCount: channels.length, installedCount: installed.length };
    } catch (err) {
      ctx.logger.warn('读取频道/已安装数量失败（降级为 0）', { message: errorMessage(err) });
      return { channelCount: 0, installedCount: 0 };
    }
  }

  async function runLaunch(core: AppHubCore, channelId: string, appId: string): Promise<LaunchResultDTO> {
    if (ctx.launch) return ctx.launch(core, channelId, appId);
    return launchInstalledApp(core, channelId, appId, { logger: ctx.logger });
  }

  async function runReveal(core: AppHubCore, channelId: string, appId: string): Promise<void> {
    if (ctx.reveal) {
      await ctx.reveal(core, channelId, appId);
      return;
    }
    const appRoot = await resolveInstalledAppRoot(core, channelId, appId);
    shell.showItemInFolder(appRoot);
  }

  async function openImportDialog(): Promise<string | null> {
    const result = await dialog.showOpenDialog({
      title: '导入频道管理员配置（channel_pri.json）',
      properties: ['openFile'],
      filters: [{ name: 'JSON 配置', extensions: ['json'] }],
    });
    if (result.canceled) return null;
    return result.filePaths?.[0] ?? null;
  }

  async function openExportDialog(defaultName: string): Promise<string | null> {
    const result = await dialog.showSaveDialog({
      title: '导出频道管理员配置（含敏凭据，请妥善保管）',
      defaultPath: defaultName,
      filters: [{ name: 'JSON 配置', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePath) return null;
    return result.filePath;
  }

  const StrictPickRequestSchema = PickRequestSchema.strict();
  const StrictInspectRequestSchema = InspectSelectionRequestSchema.strict();
  const StrictAppRefRequestSchema = AppRefRequestSchema.strict();
  const StrictVerifyRequestSchema = VerifyRequestSchema.strict();
  const StrictChannelIdRequestSchema = ChannelIdRequestSchema.strict();
  const StrictHostUpdateConfigRequestSchema = HostUpdateConfigRequestSchema.strict();

  const handlers: Record<IpcChannel, IpcHandler> = {
    // -----------------------------------------------------------------------
    // system
    // -----------------------------------------------------------------------
    [IPC_CHANNELS.systemInfo]: handle(IPC_CHANNELS.systemInfo, EmptySchema, async () => {
      const versions = (ctx.appVersions ?? defaultAppVersions)();
      const counts = await readSystemCounts();
      const dataDirInfo =
        ctx.dataDirInfo ?? {
          dataDir: ctx.coreManager.dataDir,
          defaultDataDir: ctx.coreManager.dataDir,
          source: 'default' as const,
          editable: false,
        };
      const info: SystemInfoDTO = {
        ...versions,
        platform: ctx.platform ?? process.platform,
        arch: process.arch,
        dataDir: path.resolve(dataDirInfo.dataDir),
        dataDirSource: dataDirInfo.source,
        dataDirEditable: dataDirInfo.editable,
        defaultDataDir: path.resolve(dataDirInfo.defaultDataDir),
        ...counts,
      };
      return info;
    }),

    [IPC_CHANNELS.systemOpenDataDir]: handle(IPC_CHANNELS.systemOpenDataDir, EmptySchema, async () => {
      const opened = await shell.openPath(path.resolve(ctx.coreManager.dataDir));
      if (typeof opened === 'string' && opened.length > 0) {
        throw new AppError('IO', `无法打开数据目录：${opened}`);
      }
    }),

    [IPC_CHANNELS.systemPickDirectory]: handle(IPC_CHANNELS.systemPickDirectory, EmptySchema, async () => {
      const result = await dialog.showOpenDialog({
        title: '选择频道本地存储目录',
        properties: ['openDirectory', 'createDirectory'],
      });
      if (result.canceled) return null;
      return result.filePaths?.[0] ?? null;
    }),

    [IPC_CHANNELS.systemChangeDataDir]: handle(
      IPC_CHANNELS.systemChangeDataDir,
      ChangeDataDirRequestSchema.strict(),
      async (payload) => {
        if (!ctx.changeDataDir) {
          throw new AppError('UNSUPPORTED', '当前启动方式不支持在设置中修改数据目录');
        }
        // 成功后 App 会重启，因此不广播 data-changed
        return ctx.changeDataDir(payload.path);
      },
    ),

    // -----------------------------------------------------------------------
    // channels
    // -----------------------------------------------------------------------
    [IPC_CHANNELS.channelsList]: handle(IPC_CHANNELS.channelsList, EmptySchema, async () => {
      const core = await getCore();
      const channels = await core.channels.list();
      return channels.map(toChannelSummary);
    }),

    [IPC_CHANNELS.channelsGet]: handle(IPC_CHANNELS.channelsGet, ChannelIdRequestSchema, async (payload) => {
      const core = await getCore();
      const detail = await core.channels.get(payload.channelId);
      return toChannelDetail(detail);
    }),

    [IPC_CHANNELS.channelsCreate]: handle(IPC_CHANNELS.channelsCreate, CreateChannelRequestSchema, async (payload) => {
      const core = await getCore();
      const detail = await core.channels.create({
        name: payload.name,
        description: payload.description,
        visibility: payload.visibility,
        owner: payload.owner,
        storage: payload.storage,
      });
      const dto = toChannelDetail(detail);
      broadcastDataChanged({ domain: 'channels', channelId: dto.summary.id });
      return dto;
    }),

    [IPC_CHANNELS.channelsUpdate]: handle(IPC_CHANNELS.channelsUpdate, UpdateChannelRequestSchema, async (payload) => {
      const core = await getCore();
      const detail = await core.channels.update(payload.channelId, payload.patch);
      const dto = toChannelDetail(detail);
      broadcastDataChanged({ domain: 'channels', channelId: dto.summary.id });
      return dto;
    }),

    [IPC_CHANNELS.channelsSubscribe]: handle(IPC_CHANNELS.channelsSubscribe, SubscribeRequestSchema, async (payload) => {
      const core = await getCore();
      const detail = await core.channels.subscribe({ url: payload.url, headers: payload.headers });
      const dto = toChannelDetail(detail);
      broadcastDataChanged({ domain: 'channels', channelId: dto.summary.id });
      return dto;
    }),

    [IPC_CHANNELS.channelsUnsubscribe]: handle(IPC_CHANNELS.channelsUnsubscribe, ChannelIdRequestSchema, async (payload) => {
      const core = await getCore();
      await core.channels.unsubscribe(payload.channelId);
      broadcastDataChanged({ domain: 'channels', channelId: payload.channelId });
    }),

    [IPC_CHANNELS.channelsRefresh]: handle(IPC_CHANNELS.channelsRefresh, ChannelIdRequestSchema, async (payload) => {
      const core = await getCore();
      const detail = await core.channels.refresh(payload.channelId);
      const dto = toChannelDetail(detail);
      broadcastDataChanged({ domain: 'channels', channelId: dto.summary.id });
      broadcastDataChanged({ domain: 'apps', channelId: dto.summary.id });
      return dto;
    }),

    [IPC_CHANNELS.channelsRefreshAll]: handle(IPC_CHANNELS.channelsRefreshAll, EmptySchema, async () => {
      const core = await getCore();
      const channels = await core.channels.refreshAll();
      broadcastDataChanged({ domain: 'channels' });
      broadcastDataChanged({ domain: 'library' });
      return channels.map(toChannelSummary);
    }),

    [IPC_CHANNELS.channelsImportPrivateConfig]: handle(
      IPC_CHANNELS.channelsImportPrivateConfig,
      EmptySchema,
      async () => {
        const filePath = await openImportDialog();
        if (!filePath) return null;
        const info = await stat(filePath).catch(() => null);
        if (!info || !info.isFile()) throw new AppError('NOT_FOUND', '配置文件不存在');
        if (info.size > MAX_PRIVATE_CONFIG_BYTES) {
          throw new AppError('VALIDATION', '配置文件过大，不是合法的 channel_pri.json');
        }
        const raw = (await readFile(filePath, 'utf8')).replace(/^\uFEFF/, '');
        const core = await getCore();
        const detail = await core.channels.importPrivateConfig(raw);
        const dto = toChannelDetail(detail);
        broadcastDataChanged({ domain: 'channels', channelId: dto.summary.id });
        return dto;
      },
    ),

    [IPC_CHANNELS.channelsExportPrivateConfig]: handle(
      IPC_CHANNELS.channelsExportPrivateConfig,
      ExportPrivateConfigRequestSchema,
      async (payload) => {
        const core = await getCore();
        // 注意：raw 含明文凭据，只能写盘，绝不进入日志/事件
        const raw = await core.channels.exportPrivateConfig(payload.channelId);
        if (typeof raw !== 'string' || raw.length === 0) {
          throw new AppError('STATE', 'core 未返回可导出的管理员配置');
        }
        const savedPath = await openExportDialog('channel_pri.json');
        if (!savedPath) return { canceled: true } satisfies ExportPrivateConfigResultDTO;
        await writeFile(savedPath, raw, { encoding: 'utf8', mode: 0o600 });
        ctx.logger.info('已导出频道管理员配置', { channelId: payload.channelId });
        return { canceled: false, savedPath } satisfies ExportPrivateConfigResultDTO;
      },
    ),

    [IPC_CHANNELS.channelsSubscribeUrl]: handle(
      IPC_CHANNELS.channelsSubscribeUrl,
      ChannelIdRequestSchema,
      async (payload) => {
        const core = await getCore();
        const url = await core.channels.getSubscribeUrl(payload.channelId);
        return { url } satisfies SubscribeUrlDTO;
      },
    ),

    // -----------------------------------------------------------------------
    // host（本机 Host：local-host 频道仓库的启停/状态/配置）
    // -----------------------------------------------------------------------
    [IPC_CHANNELS.hostStart]: handle(IPC_CHANNELS.hostStart, StrictChannelIdRequestSchema, async (payload) => {
      const core = await getCore();
      const status = await core.host.start(payload.channelId);
      const dto = toHostStatus(status);
      broadcastDataChanged({ domain: 'host', channelId: dto.channelId });
      return dto;
    }),

    [IPC_CHANNELS.hostStop]: handle(IPC_CHANNELS.hostStop, StrictChannelIdRequestSchema, async (payload) => {
      const core = await getCore();
      const status = await core.host.stop(payload.channelId);
      const dto = toHostStatus(status);
      broadcastDataChanged({ domain: 'host', channelId: dto.channelId });
      return dto;
    }),

    [IPC_CHANNELS.hostStatus]: handle(IPC_CHANNELS.hostStatus, StrictChannelIdRequestSchema, async (payload) => {
      const core = await getCore();
      const status = await core.host.status(payload.channelId);
      return toHostStatus(status);
    }),

    [IPC_CHANNELS.hostList]: handle(IPC_CHANNELS.hostList, EmptySchema, async () => {
      const core = await getCore();
      const statuses = await core.host.list();
      return statuses.map(toHostStatus);
    }),

    [IPC_CHANNELS.hostUpdateConfig]: handle(
      IPC_CHANNELS.hostUpdateConfig,
      StrictHostUpdateConfigRequestSchema,
      async (payload) => {
        const core = await getCore();
        const patch: HostConfigPatch = payload.patch;
        const status = await core.host.updateConfig(payload.channelId, patch);
        const dto = toHostStatus(status);
        broadcastDataChanged({ domain: 'host', channelId: dto.channelId });
        return dto;
      },
    ),

    // -----------------------------------------------------------------------
    // apps
    // -----------------------------------------------------------------------
    [IPC_CHANNELS.appsGet]: handle(IPC_CHANNELS.appsGet, StrictAppRefRequestSchema, async (payload) => {
      const core = await getCore();
      const detail = await core.publishing.getApp(payload.channelId, payload.appId);
      return toAppDetail(detail);
    }),

    // -----------------------------------------------------------------------
    // publish
    // -----------------------------------------------------------------------
    [IPC_CHANNELS.publishPick]: handle(
      IPC_CHANNELS.publishPick,
      StrictPickRequestSchema,
      async (payload) => ctx.selectionRegistry.pick(payload.kind) as Promise<PublishSelectionDTO | null>,
      { kind: 'files' },
    ),

    [IPC_CHANNELS.publishInspectSelection]: handle(
      IPC_CHANNELS.publishInspectSelection,
      StrictInspectRequestSchema,
      async (payload): Promise<InspectSelectionResultDTO> => ctx.selectionRegistry.inspect(payload.selectionId),
    ),

    [IPC_CHANNELS.publishStart]: handle(IPC_CHANNELS.publishStart, PublishRequestSchema, async (payload, event) => {
      const request = payload as PublishRequestDTO;
      const selection = ctx.selectionRegistry.get(request.selectionId);
      const input = buildPublishInput(request, selection);
      const core = await getCore();
      const operationId = randomId();
      const result = await core.publishing.publish({
        ...input,
        onProgress: (progress) =>
          emitProgress(
            event,
            { operationId, operation: 'publish', channelId: request.channelId, appId: request.appId },
            progress,
          ),
      });
      broadcastDataChanged({ domain: 'channels', channelId: request.channelId, appId: result.appId });
      broadcastDataChanged({ domain: 'apps', channelId: request.channelId, appId: result.appId });
      return toPublishResult(result);
    }),

    [IPC_CHANNELS.publishUpdateAppMeta]: handle(
      IPC_CHANNELS.publishUpdateAppMeta,
      UpdateAppMetaRequestSchema,
      async (payload) => {
        const request = payload as UpdateAppMetaRequestDTO;
        const core = await getCore();
        const detail = await core.publishing.updateMeta(request.channelId, request.appId, request.patch);
        const dto = toAppDetail(detail);
        broadcastDataChanged({ domain: 'apps', channelId: request.channelId, appId: request.appId });
        return dto;
      },
    ),

    // -----------------------------------------------------------------------
    // library
    // -----------------------------------------------------------------------
    [IPC_CHANNELS.libraryList]: handle(IPC_CHANNELS.libraryList, EmptySchema, async () => {
      const core = await getCore();
      const apps = await core.library.list();
      return apps.map(toInstalledApp);
    }),

    [IPC_CHANNELS.libraryCheckUpdates]: handle(
      IPC_CHANNELS.libraryCheckUpdates,
      UpdateCheckRequestSchema,
      async () => {
        const core = await getCore();
        const items = await core.library.checkUpdates();
        return items.map(toUpdateCheck);
      },
    ),

    [IPC_CHANNELS.libraryInstall]: handle(IPC_CHANNELS.libraryInstall, InstallRequestSchema, async (payload, event) => {
      const request = payload as InstallRequestDTO;
      const core = await getCore();
      const operationId = randomId();
      const result = await core.library.install({
        channelId: request.channelId,
        appId: request.appId,
        version: request.version,
        platform: request.platform,
        force: request.force,
        onProgress: (progress) =>
          emitProgress(
            event,
            { operationId, operation: 'install', channelId: request.channelId, appId: request.appId },
            progress,
          ),
      });
      broadcastDataChanged({ domain: 'library', channelId: request.channelId, appId: request.appId });
      broadcastDataChanged({ domain: 'apps', channelId: request.channelId, appId: request.appId });
      return toInstallResult(result);
    }),

    [IPC_CHANNELS.libraryUpdate]: handle(IPC_CHANNELS.libraryUpdate, InstallRequestSchema, async (payload, event) => {
      const request = payload as InstallRequestDTO;
      const core = await getCore();
      const operationId = randomId();
      const result = await core.library.update({
        channelId: request.channelId,
        appId: request.appId,
        version: request.version,
        platform: request.platform,
        force: request.force,
        onProgress: (progress) =>
          emitProgress(
            event,
            { operationId, operation: 'update', channelId: request.channelId, appId: request.appId },
            progress,
          ),
      });
      broadcastDataChanged({ domain: 'library', channelId: request.channelId, appId: request.appId });
      broadcastDataChanged({ domain: 'apps', channelId: request.channelId, appId: request.appId });
      return toInstallResult(result);
    }),

    [IPC_CHANNELS.libraryVerify]: handle(IPC_CHANNELS.libraryVerify, StrictVerifyRequestSchema, async (payload) => {
      const core = await getCore();
      const result = await core.library.verify(payload.channelId, payload.appId);
      broadcastDataChanged({ domain: 'library', channelId: payload.channelId, appId: payload.appId });
      return toVerifyResult(result);
    }),

    [IPC_CHANNELS.libraryUninstall]: handle(IPC_CHANNELS.libraryUninstall, StrictVerifyRequestSchema, async (payload) => {
      const core = await getCore();
      await core.library.uninstall(payload.channelId, payload.appId);
      broadcastDataChanged({ domain: 'library', channelId: payload.channelId, appId: payload.appId });
      broadcastDataChanged({ domain: 'apps', channelId: payload.channelId, appId: payload.appId });
    }),

    [IPC_CHANNELS.libraryLaunch]: handle(IPC_CHANNELS.libraryLaunch, StrictVerifyRequestSchema, async (payload) => {
      const core = await getCore();
      const result = await runLaunch(core, payload.channelId, payload.appId);
      broadcastDataChanged({ domain: 'library', channelId: payload.channelId, appId: payload.appId });
      return result;
    }),

    [IPC_CHANNELS.libraryReveal]: handle(IPC_CHANNELS.libraryReveal, StrictVerifyRequestSchema, async (payload) => {
      const core = await getCore();
      await runReveal(core, payload.channelId, payload.appId);
      broadcastDataChanged({ domain: 'library', channelId: payload.channelId, appId: payload.appId });
    }),
  };

  // 编译期由 Record<IpcChannel, IpcHandler> 保证 IPC_CHANNELS 全覆盖（缺一个直接 TS 报错），
  // 运行时再防御性检查一次，避免任何动态/降级路径漏注册。
  for (const channel of Object.values(IPC_CHANNELS)) {
    if (typeof handlers[channel] !== 'function') {
      throw new AppError('INTERNAL', `IPC channel 未实现：${channel}`);
    }
  }

  return handlers as Record<string, IpcHandler>;
}

// ---------------------------------------------------------------------------
// 注册到 ipcMain
// ---------------------------------------------------------------------------

export interface RegisterIpcOptions {
  ctx: IpcRouterContext;
  /** 缺省使用 electron ipcMain（测试可注入）。 */
  register?: (channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) => void;
  unregister?: (channel: string) => void;
}

/**
 * 把 router 注册到 ipcMain，返回清理函数。
 * 这里再包一层 try/catch：即使 handler 内部出现意外异常也返回 ApiResult，而不是让 invoke reject。
 */
export function registerIpcHandlers(options: RegisterIpcOptions): () => void {
  const { ctx } = options;
  const router = createIpcRouter(ctx);
  const register =
    options.register ??
    ((channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) => {
      ipcMain.handle(channel, listener);
    });
  const unregister =
    options.unregister ??
    ((channel: string) => {
      ipcMain.removeHandler(channel);
    });

  const channels = Object.values(IPC_CHANNELS);
  for (const channel of channels) {
    register(channel, async (event, ...args) => {
      const handler = router[channel];
      if (!handler) {
        return { ok: false, error: { code: 'INTERNAL', message: `IPC channel 未实现：${channel}` } };
      }
      const payload = args.length <= 1 ? args[0] : args;
      try {
        return await handler(event as IpcEventLike, payload);
      } catch (err) {
        ctx.logger.error(`IPC ${channel} 处理异常`, { message: errorMessage(err) });
        return {
          ok: false,
          error: { code: 'INTERNAL', message: '主进程处理请求时发生未知错误' },
        };
      }
    });
  }

  return () => {
    for (const channel of channels) unregister(channel);
  };
}
