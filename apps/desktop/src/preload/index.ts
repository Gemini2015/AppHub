import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';
import { IPC_CHANNELS, IPC_EVENTS } from '../../shared/ipc';
import type {
  ApiResult,
  AppDetailDTO,
  AppHubApi,
  ChannelDetailDTO,
  ChannelSummaryDTO,
  DataChangedEventDTO,
  ExportPrivateConfigResultDTO,
  HostStatusDTO,
  InspectSelectionResultDTO,
  InstallRequestDTO,
  InstallResultDTO,
  InstalledAppDTO,
  LaunchResultDTO,
  PickKind,
  ProgressEventDTO,
  PublishRequestDTO,
  PublishResultDTO,
  PublishSelectionDTO,
  SubscribeRequestDTO,
  SubscribeUrlDTO,
  SystemInfoDTO,
  Unsubscribe,
  UpdateAppMetaRequestDTO,
  UpdateChannelRequestDTO,
  UpdateCheckDTO,
  UpdateHostConfigRequestDTO,
  VerifyRequestDTO,
  VerifyResultDTO,
} from '../../shared/ipc';

/**
 * preload：通过 contextBridge 暴露 window.apphub。
 *
 * 安全约束：
 *  - 只暴露 shared/ipc.ts 定义的、返回 ApiResult 的方法；不暴露 ipcRenderer/require/process；
 *  - 事件订阅返回取消函数，避免渲染层反复注册造成泄漏；
 *  - 主进程对所有入参重新做 zod 校验，这里不做任何"信任渲染进程"的事。
 */

/** 统一 invoke 包装：channel 取 shared/ipc.ts 的常量，返回 ApiResult。 */
function invoke<T>(channel: string, ...args: unknown[]): Promise<ApiResult<T>> {
  return ipcRenderer.invoke(channel, ...args) as Promise<ApiResult<T>>;
}

function subscribe<T>(channel: string, handler: (payload: T) => void): Unsubscribe {
  const listener = (_event: IpcRendererEvent, payload: T): void => {
    handler(payload);
  };
  ipcRenderer.on(channel, listener);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    ipcRenderer.removeListener(channel, listener);
  };
}

const api: AppHubApi = {
  system: {
    info: () => invoke<SystemInfoDTO>(IPC_CHANNELS.systemInfo),
    openDataDir: () => invoke<void>(IPC_CHANNELS.systemOpenDataDir),
    pickDirectory: () => invoke<string | null>(IPC_CHANNELS.systemPickDirectory),
  },
  channels: {
    list: () => invoke<ChannelSummaryDTO[]>(IPC_CHANNELS.channelsList),
    get: (channelId: string) => invoke<ChannelDetailDTO>(IPC_CHANNELS.channelsGet, { channelId }),
    create: (input) => invoke<ChannelDetailDTO>(IPC_CHANNELS.channelsCreate, input),
    update: (input: UpdateChannelRequestDTO) =>
      invoke<ChannelDetailDTO>(IPC_CHANNELS.channelsUpdate, input),
    subscribe: (input: SubscribeRequestDTO) =>
      invoke<ChannelDetailDTO>(IPC_CHANNELS.channelsSubscribe, input),
    unsubscribe: (channelId: string) => invoke<void>(IPC_CHANNELS.channelsUnsubscribe, { channelId }),
    refresh: (channelId: string) => invoke<ChannelDetailDTO>(IPC_CHANNELS.channelsRefresh, { channelId }),
    refreshAll: () => invoke<ChannelSummaryDTO[]>(IPC_CHANNELS.channelsRefreshAll),
    importPrivateConfig: () =>
      invoke<ChannelDetailDTO | null>(IPC_CHANNELS.channelsImportPrivateConfig),
    exportPrivateConfig: (channelId: string) =>
      invoke<ExportPrivateConfigResultDTO>(IPC_CHANNELS.channelsExportPrivateConfig, { channelId }),
    getSubscribeUrl: (channelId: string) =>
      invoke<SubscribeUrlDTO>(IPC_CHANNELS.channelsSubscribeUrl, { channelId }),
  },
  apps: {
    // 渲染进程侧是 (channelId, appId) 两参，主进程用 AppRefRequestSchema 校验对象
    get: (channelId: string, appId: string) =>
      invoke<AppDetailDTO>(IPC_CHANNELS.appsGet, { channelId, appId }),
  },
  host: {
    start: (channelId: string) => invoke<HostStatusDTO>(IPC_CHANNELS.hostStart, { channelId }),
    stop: (channelId: string) => invoke<HostStatusDTO>(IPC_CHANNELS.hostStop, { channelId }),
    status: (channelId: string) => invoke<HostStatusDTO>(IPC_CHANNELS.hostStatus, { channelId }),
    list: () => invoke<HostStatusDTO[]>(IPC_CHANNELS.hostList),
    updateConfig: (input: UpdateHostConfigRequestDTO) =>
      invoke<HostStatusDTO>(IPC_CHANNELS.hostUpdateConfig, input),
  },
  publish: {
    pick: (kind: PickKind) => invoke<PublishSelectionDTO | null>(IPC_CHANNELS.publishPick, { kind }),
    inspectSelection: (selectionId: string) =>
      invoke<InspectSelectionResultDTO>(IPC_CHANNELS.publishInspectSelection, { selectionId }),
    start: (request: PublishRequestDTO) =>
      invoke<PublishResultDTO>(IPC_CHANNELS.publishStart, request),
    updateAppMeta: (input: UpdateAppMetaRequestDTO) =>
      invoke<AppDetailDTO>(IPC_CHANNELS.publishUpdateAppMeta, input),
  },
  library: {
    list: () => invoke<InstalledAppDTO[]>(IPC_CHANNELS.libraryList),
    checkUpdates: () => invoke<UpdateCheckDTO[]>(IPC_CHANNELS.libraryCheckUpdates),
    install: (input: InstallRequestDTO) => invoke<InstallResultDTO>(IPC_CHANNELS.libraryInstall, input),
    update: (input: InstallRequestDTO) => invoke<InstallResultDTO>(IPC_CHANNELS.libraryUpdate, input),
    verify: (input: VerifyRequestDTO) => invoke<VerifyResultDTO>(IPC_CHANNELS.libraryVerify, input),
    uninstall: (input: VerifyRequestDTO) => invoke<void>(IPC_CHANNELS.libraryUninstall, input),
    launch: (input: VerifyRequestDTO) => invoke<LaunchResultDTO>(IPC_CHANNELS.libraryLaunch, input),
    reveal: (input: VerifyRequestDTO) => invoke<void>(IPC_CHANNELS.libraryReveal, input),
  },
  events: {
    onProgress: (handler: (event: ProgressEventDTO) => void) =>
      subscribe<ProgressEventDTO>(IPC_EVENTS.progress, handler),
    onDataChanged: (handler: (event: DataChangedEventDTO) => void) =>
      subscribe<DataChangedEventDTO>(IPC_EVENTS.dataChanged, handler),
  },
};

contextBridge.exposeInMainWorld('apphub', api);
