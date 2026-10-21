/**
 * 渲染进程统一类型出口。
 *
 * 只从 `shared/ipc.ts`（相对路径、type-only）引入类型，
 * 并基于 DTO 派生出界面里常用的别名，避免在视图里散落相对路径。
 * 注意：renderer 不得 import core/storage/Node 模块，也不直接发网络请求。
 */
import type {
  AppDetailDTO,
  AppSummaryDTO,
  ChannelDetailDTO,
  ChannelSummaryDTO,
  CreateChannelRequestDTO,
} from '../../../shared/ipc';

export type {
  ApiError,
  ApiErrorCode,
  ApiResult,
  AppDetailDTO,
  AppHubApi,
  AppSummaryDTO,
  ChannelDetailDTO,
  ChannelIdRequestDTO,
  ChannelSummaryDTO,
  CreateChannelRequestDTO,
  DataChangedEventDTO,
  ExportPrivateConfigResultDTO,
  InstalledAppDTO,
  InstallRequestDTO,
  InstallResultDTO,
  InspectSelectionResultDTO,
  LaunchResultDTO,
  PickedFileDTO,
  PickKind,
  ProgressEventDTO,
  PublishRequestDTO,
  PublishResultDTO,
  PublishSelectionDTO,
  SubscribeRequestDTO,
  SystemInfoDTO,
  Unsubscribe,
  UpdateAppMetaRequestDTO,
  UpdateCheckDTO,
  UpdateChannelRequestDTO,
  VerifyRequestDTO,
  VerifyResultDTO,
} from '../../../shared/ipc';

/** 频道可见性：public / private。 */
export type Visibility = ChannelSummaryDTO['visibility'];
/** 当前用户在该频道中的角色。 */
export type ChannelRole = ChannelSummaryDTO['role'];
/** 频道来源：owned（我拥有）/ subscribed（我订阅）。 */
export type ChannelSource = ChannelSummaryDTO['source'];
/** 平台：windows / linux / mac。 */
export type Platform = AppSummaryDTO['platforms'][number];
/** 发布方式：files（散文件）/ zip（压缩包）。 */
export type PublishMode = AppSummaryDTO['publishMode'];
/** 存储 provider 配置联合类型。 */
export type StorageConfig = CreateChannelRequestDTO['storage'];
export type StorageProvider = StorageConfig['provider'];

/** 远端 channel.json 内容。 */
export type ChannelFile = ChannelDetailDTO['channel'];
/** app.meta.json 内容。 */
export type AppMetaFile = AppDetailDTO['meta'];
/** app.meta.json 中的单个历史版本。 */
export type AppVersionEntry = AppDetailDTO['versions'][number];
/** files 清单中的一条文件记录。 */
export type FileEntryDTO = AppVersionEntry['files'][number];
/** 发布/安装进度阶段。 */
export type ProgressPhase = import('../../../shared/ipc').ProgressEventDTO['phase'];
