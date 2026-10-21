import {
  AppError,
  LIMITS,
  StorageConfigSchema,
  channelDescriptorKey,
  isAccessKey,
  isHttpUrl,
  newAccessKey,
  newChannelId,
  parseChannelFile,
  parseChannelPrivateFile,
  serializeChannelFile,
  serializeChannelPrivateFile,
  validationError,
} from '@apphub/protocol';
import type {
  ChannelAppRef,
  ChannelFile,
  ChannelPrivateFile,
  StorageConfig,
  Visibility,
} from '@apphub/protocol';
import type { ChannelAccess } from './channel-access';
import type { ChannelAccessDeps } from './channel-access';
import { ChannelAccess as ChannelAccessImpl } from './channel-access';
import type { HttpClient } from './http';
import type { KeyedMutex } from './mutex';
import type { StateStore } from './state';
import type {
  AppInfo,
  ChannelCreateInput,
  ChannelDetail,
  ChannelInfo,
  ChannelRecord,
  ChannelRole,
  ChannelService,
  ChannelUpdateInput,
  Clock,
  Logger,
  SecretBox,
  SubscribeInput,
} from './types';
import {
  createStorageAdapter,
  deriveSubscribeUrl,
  probeStorage,
  storageHeaders,
  storageCall,
  type StorageDeps,
} from './storage';

/**
 * 频道服务：创建 / 列表 / 详情 / 修改 / 订阅 / 刷新 / 私密配置导入导出。
 *
 * 关键不变量：
 *  - owner/admin 的频道记录依赖 secrets/channel_pri/<id>.enc（密文）才能发布；
 *  - 订阅记录优先使用本地缓存的 channel.json，刷新时重新拉取；
 *  - 私密频道的能力链接（含 accessKey）只在 owner/admin 本地推导，订阅者记录原始 URL；
 *  - 错误信息与日志中不出现凭据/accessKey（URL 一律脱敏）。
 */

export interface ChannelServiceDeps {
  state: StateStore;
  http: HttpClient;
  storageFactory: import('@apphub/storage').StorageFactory;
  secretBox: SecretBox;
  clock: Clock;
  logger?: Logger;
  mutex: KeyedMutex;
  ready: Promise<void>;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function validateName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : '';
  if (name.length === 0) throw new AppError('VALIDATION', '频道名称不能为空');
  if (name.length > LIMITS.channelName) {
    throw new AppError('VALIDATION', `频道名称过长（上限 ${LIMITS.channelName} 字符）`);
  }
  return name;
}

function validateDescription(value: unknown): string {
  const description = typeof value === 'string' ? value : '';
  if (description.length > LIMITS.channelDescription) {
    throw new AppError('VALIDATION', `频道描述过长（上限 ${LIMITS.channelDescription} 字符）`);
  }
  return description;
}

function validateOwner(owner: unknown): { name: string; contact?: string } {
  if (owner === undefined || owner === null) return { name: '' };
  if (typeof owner !== 'object') throw new AppError('VALIDATION', '频道所有者信息非法');
  const raw = owner as { name?: unknown; contact?: unknown };
  const name = asString(raw.name);
  const contact = asString(raw.contact);
  if (name.length > 128) throw new AppError('VALIDATION', '所有者名称过长（上限 128 字符）');
  if (contact.length > 256) throw new AppError('VALIDATION', '所有者联系方式过长（上限 256 字符）');
  return { name, ...(contact ? { contact } : {}) };
}

function validateVisibility(value: unknown): Visibility {
  if (value !== 'public' && value !== 'private') {
    throw new AppError('VALIDATION', '频道可见性必须是 public 或 private');
  }
  return value;
}

function validateStorageConfig(config: unknown): StorageConfig {
  const result = StorageConfigSchema.safeParse(config);
  if (!result.success) throw validationError('存储配置', result.error);
  return result.data as StorageConfig;
}

function validateHeaders(headers: unknown): Record<string, string> | undefined {
  if (headers === undefined || headers === null) return undefined;
  if (typeof headers !== 'object' || Array.isArray(headers)) {
    throw new AppError('VALIDATION', '订阅请求头必须是键值对对象');
  }
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (typeof value !== 'string') throw new AppError('VALIDATION', `请求头 ${key} 的值必须是字符串`);
    if (key.length === 0 || key.length > 256) throw new AppError('VALIDATION', `请求头名称非法：${key}`);
    if (value.length > 4096) throw new AppError('VALIDATION', `请求头 ${key} 过长`);
    output[key] = value;
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

function validateSubscribeUrl(rawUrl: unknown): string {
  if (typeof rawUrl !== 'string' || !isHttpUrl(rawUrl)) {
    throw new AppError('VALIDATION', '订阅地址必须是 http(s) 的 channel.json 地址');
  }
  const url = new URL(rawUrl);
  const segments = url.pathname.split('/').filter((segment) => segment.length > 0);
  const last = segments[segments.length - 1];
  if (!last || last.toLowerCase() !== 'channel.json') {
    throw new AppError('VALIDATION', '订阅地址必须指向 channel.json');
  }
  return url.toString();
}

/** 校验 channel.json 与订阅 URL 的可见性/私密标识一致性。 */
function validateDescriptorUrl(url: string, channel: ChannelFile): void {
  const segments = new URL(url).pathname.split('/').filter((segment) => segment.length > 0);
  if (channel.visibility === 'private') {
    const index = segments.indexOf('_private');
    if (index < 0) {
      throw new AppError('VALIDATION', '私密频道的订阅地址必须包含 _private/<channelId>/<accessKey> 前缀');
    }
    const idSegment = segments[index + 1];
    const keySegment = segments[index + 2];
    if (idSegment !== channel.id) {
      throw new AppError('VALIDATION', '订阅地址中的频道 ID 与 channel.json 不一致');
    }
    if (!keySegment || !isAccessKey(keySegment)) {
      throw new AppError('VALIDATION', '私密频道的订阅地址缺少合法的 accessKey');
    }
  } else if (segments.includes('_private')) {
    throw new AppError('VALIDATION', '公开频道的订阅地址不应包含 _private 前缀');
  }
}

function toAppInfo(ref: ChannelAppRef): AppInfo {
  return {
    appId: ref.appId,
    name: ref.name,
    displayName: ref.displayName,
    description: ref.description,
    author: ref.author,
    entry: ref.entry,
    platforms: ref.platforms,
    publishMode: ref.publishMode,
    latest: ref.latest,
    metaUrl: ref.metaUrl,
    updatedAt: ref.updatedAt,
    ...(ref.iconUrl ? { iconUrl: ref.iconUrl } : {}),
  };
}

export class ChannelServiceImpl implements ChannelService {
  private readonly deps: ChannelServiceDeps;
  private readonly storageDeps: StorageDeps;

  constructor(deps: ChannelServiceDeps) {
    this.deps = deps;
    this.storageDeps = { storageFactory: deps.storageFactory, logger: deps.logger };
  }

  // -------------------------------------------------------------------------
  // 公共 API
  // -------------------------------------------------------------------------

  async list(): Promise<ChannelInfo[]> {
    await this.deps.ready;
    const records = await this.deps.state.listChannelRecords();
    const infos: ChannelInfo[] = [];
    for (const record of records) {
      const channel = await this.deps.state.readChannelCache(record.channelId);
      infos.push(this.buildInfo(record, channel));
    }
    return infos.sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(channelId: string): Promise<ChannelDetail> {
    await this.deps.ready;
    const record = await this.requireRecord(channelId);
    const channel = await this.loadChannelForRecord(record);
    return this.buildDetail(record, channel);
  }

  async create(input: ChannelCreateInput): Promise<ChannelDetail> {
    await this.deps.ready;
    const name = validateName(input.name);
    const description = validateDescription(input.description);
    const visibility = validateVisibility(input.visibility);
    const storage = validateStorageConfig(input.storage);
    const owner = validateOwner(input.owner);
    const nowIso = this.deps.clock.now().toISOString();
    const channelId = newChannelId();
    const accessKey = visibility === 'private' ? newAccessKey() : undefined;
    const channel: ChannelFile = {
      schemaVersion: 1,
      kind: 'apphub-channel',
      id: channelId,
      name,
      description,
      visibility,
      owner,
      ...(accessKey ? { access: { type: 'secret-url' as const } } : {}),
      apps: [],
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    const pri: ChannelPrivateFile = {
      schemaVersion: 1,
      kind: 'apphub-channel-private',
      channelId,
      channelName: name,
      visibility,
      ...(accessKey ? { accessKey } : {}),
      createdAt: nowIso,
      updatedAt: nowIso,
      storage,
      owner,
      admins: [],
    };
    const descriptorKey = channelDescriptorKey(visibility, channelId, accessKey);
    const channelText = serializeChannelFile(channel);
    const adapter = createStorageAdapter(this.storageDeps, storage);
    let subscribeUrl: string;
    try {
      if (!input.skipProbe) {
        await storageCall(`存储连接检查失败（provider=${storage.provider}）`, () => adapter.probe());
      }
      const exists = await storageCall('检查频道存储失败', () => adapter.exists(descriptorKey));
      if (exists) {
        throw new AppError(
          'CONFLICT',
          '该存储位置已存在 channel.json，请更换目录/前缀，或通过"导入私有配置"接管现有频道',
        );
      }
      subscribeUrl = await deriveSubscribeUrl(pri, adapter);
      await storageCall('写入频道信息失败', () => adapter.writeText(descriptorKey, channelText));
    } finally {
      await adapter.close().catch((error: unknown) => {
        this.deps.logger?.warn('关闭存储适配器失败', { reason: AppError.from(error).message });
      });
    }
    await this.deps.state.writePrivateConfig(pri);
    const record: ChannelRecord = {
      channelId,
      url: subscribeUrl,
      visibility,
      role: 'owner',
      source: 'owned',
      channelName: name,
      createdAt: nowIso,
      updatedAt: nowIso,
      lastFetchedAt: nowIso,
    };
    await this.deps.state.upsertChannelRecord(record);
    await this.deps.state.writeChannelCache(channel);
    this.deps.logger?.info('已创建频道', { channelId, visibility, provider: storage.provider });
    return this.buildDetail(record, channel);
  }

  async update(channelId: string, patch: ChannelUpdateInput): Promise<ChannelDetail> {
    await this.deps.ready;
    const record = await this.requireRecord(channelId);
    if (record.role === 'subscriber') {
      throw new AppError('AUTH', '订阅者不能修改频道信息');
    }
    const access = await this.openAccess(record);
    try {
      const remote = await access.readChannelRemote();
      const nowIso = this.deps.clock.now().toISOString();
      const updated: ChannelFile = {
        ...remote,
        name: patch.name === undefined ? remote.name : validateName(patch.name),
        description:
          patch.description === undefined ? remote.description : validateDescription(patch.description),
        owner: patch.owner === undefined ? remote.owner : validateOwner(patch.owner),
        updatedAt: nowIso,
      };
      if (updated.visibility === 'private' && updated.access?.type !== 'secret-url') {
        updated.access = { type: 'secret-url' };
      }
      await access.writeChannelRemote(updated);
      const pri = await this.deps.state.readPrivateConfig(channelId);
      if (pri) {
        await this.deps.state.writePrivateConfig({
          ...pri,
          channelName: updated.name,
          owner: updated.owner,
          updatedAt: nowIso,
        });
      }
      const updatedRecord = await this.storeChannelSnapshot(record, updated);
      this.deps.logger?.info('已更新频道信息', { channelId });
      return this.buildDetail(updatedRecord, updated);
    } finally {
      await access.close();
    }
  }

  async subscribe(input: SubscribeInput): Promise<ChannelDetail> {
    await this.deps.ready;
    const url = validateSubscribeUrl(input.url);
    const headers = validateHeaders(input.headers);
    let text: string;
    try {
      text = await this.deps.http.fetchText(url, { headers, label: 'channel.json' });
    } catch (error) {
      throw new AppError(
        AppError.from(error).code,
        `无法读取频道信息：${AppError.from(error).message}`,
      );
    }
    let channel: ChannelFile;
    try {
      channel = parseChannelFile(text);
    } catch (error) {
      throw new AppError('VALIDATION', `channel.json 校验失败：${AppError.from(error).message}`);
    }
    validateDescriptorUrl(url, channel);
    const existing = await this.deps.state.getChannelRecord(channel.id);
    const hasPrivateConfig = await this.deps.state.hasPrivateConfig(channel.id);
    let role: ChannelRole;
    if (hasPrivateConfig) {
      role =
        existing && existing.role !== 'subscriber'
          ? existing.role
          : existing?.source === 'owned'
            ? 'owner'
            : 'admin';
    } else {
      role = 'subscriber';
    }
    const source: 'owned' | 'subscribed' = existing?.source ?? 'subscribed';
    let headersCipher = existing?.headersCipher;
    if (headers) {
      headersCipher = await this.deps.secretBox.encrypt(JSON.stringify(headers));
    }
    const nowIso = this.deps.clock.now().toISOString();
    const record: ChannelRecord = {
      channelId: channel.id,
      url,
      visibility: channel.visibility,
      role,
      source,
      channelName: channel.name,
      createdAt: channel.createdAt,
      updatedAt: channel.updatedAt,
      lastFetchedAt: nowIso,
      ...(headersCipher ? { headersCipher } : {}),
    };
    await this.deps.state.upsertChannelRecord(record);
    await this.deps.state.writeChannelCache(channel);
    this.deps.logger?.info('已订阅频道', { channelId: channel.id, role });
    return this.buildDetail(record, channel);
  }

  async unsubscribe(channelId: string): Promise<void> {
    await this.deps.ready;
    const record = await this.requireRecord(channelId);
    await this.deps.state.removeChannelRecord(record.channelId);
    await this.deps.state.dropChannelCache(record.channelId);
    this.deps.logger?.info('已取消订阅频道', { channelId });
  }

  async refresh(channelId: string): Promise<ChannelDetail> {
    await this.deps.ready;
    const record = await this.requireRecord(channelId);
    const channel = await this.refreshRecord(record);
    const latestRecord = (await this.deps.state.getChannelRecord(channelId)) ?? record;
    return this.buildDetail(latestRecord, channel);
  }

  async refreshAll(): Promise<ChannelInfo[]> {
    await this.deps.ready;
    const records = await this.deps.state.listChannelRecords();
    for (const record of records) {
      try {
        await this.refreshRecord(record);
      } catch (error) {
        this.deps.logger?.warn('刷新频道失败，保留本地缓存', {
          channelId: record.channelId,
          reason: AppError.from(error).message,
        });
      }
    }
    return this.list();
  }

  async importPrivateConfig(rawJson: string): Promise<ChannelDetail> {
    await this.deps.ready;
    let pri: ChannelPrivateFile;
    try {
      pri = parseChannelPrivateFile(rawJson);
    } catch (error) {
      throw new AppError('VALIDATION', `channel_pri.json 校验失败：${AppError.from(error).message}`);
    }
    await probeStorage(this.storageDeps, pri.storage);
    const adapter = createStorageAdapter(this.storageDeps, pri.storage);
    let channel: ChannelFile;
    let subscribeUrl: string;
    try {
      subscribeUrl = await deriveSubscribeUrl(pri, adapter);
      let text: string;
      try {
        text = await this.deps.http.fetchText(subscribeUrl, {
          headers: storageHeaders(pri.storage),
          label: 'channel.json',
        });
      } catch (error) {
        const appError = AppError.from(error);
        throw new AppError(appError.code, `无法访问频道描述文件：${appError.message}`, appError.details);
      }
      try {
        channel = parseChannelFile(text);
      } catch (error) {
        throw new AppError('VALIDATION', `远端 channel.json 校验失败：${AppError.from(error).message}`);
      }
    } finally {
      await adapter.close().catch((error: unknown) => {
        this.deps.logger?.warn('关闭存储适配器失败', { reason: AppError.from(error).message });
      });
    }
    if (channel.id !== pri.channelId) {
      throw new AppError('VALIDATION', 'channel_pri.json 与远端 channel.json 的频道 ID 不一致');
    }
    if (channel.visibility !== pri.visibility) {
      throw new AppError('VALIDATION', 'channel_pri.json 与远端 channel.json 的可见性不一致');
    }
    await this.deps.state.writePrivateConfig(pri);
    const existing = await this.deps.state.getChannelRecord(channel.id);
    const role: ChannelRole =
      existing && existing.role !== 'subscriber' ? existing.role : 'admin';
    const nowIso = this.deps.clock.now().toISOString();
    const record: ChannelRecord = {
      channelId: channel.id,
      url: subscribeUrl,
      visibility: channel.visibility,
      role,
      source: existing?.source ?? 'subscribed',
      channelName: channel.name,
      createdAt: channel.createdAt,
      updatedAt: channel.updatedAt,
      lastFetchedAt: nowIso,
      ...(existing?.headersCipher ? { headersCipher: existing.headersCipher } : {}),
    };
    await this.deps.state.upsertChannelRecord(record);
    await this.deps.state.writeChannelCache(channel);
    this.deps.logger?.info('已导入频道私有配置', { channelId: channel.id, role });
    return this.buildDetail(record, channel);
  }

  async exportPrivateConfig(channelId: string): Promise<string> {
    await this.deps.ready;
    const record = await this.requireRecord(channelId);
    if (record.role === 'subscriber') {
      throw new AppError('AUTH', '只有频道所有者/管理员才能导出私有配置');
    }
    const pri = await this.deps.state.readPrivateConfig(channelId);
    if (!pri) throw new AppError('NOT_FOUND', '本地不存在该频道的私有配置');
    return serializeChannelPrivateFile(pri);
  }

  async getSubscribeUrl(channelId: string): Promise<string> {
    await this.deps.ready;
    const record = await this.requireRecord(channelId);
    if (record.role === 'subscriber') return record.url;
    const pri = await this.deps.state.readPrivateConfig(channelId);
    if (!pri) return record.url;
    const adapter = createStorageAdapter(this.storageDeps, pri.storage);
    try {
      return await deriveSubscribeUrl(pri, adapter);
    } finally {
      await adapter.close().catch((error: unknown) => {
        this.deps.logger?.warn('关闭存储适配器失败', { reason: AppError.from(error).message });
      });
    }
  }

  // -------------------------------------------------------------------------
  // 内部辅助（PublishService / LibraryService 复用）
  // -------------------------------------------------------------------------

  async requireRecord(channelId: string): Promise<ChannelRecord> {
    const record = await this.deps.state.getChannelRecord(channelId);
    if (!record) throw new AppError('NOT_FOUND', `频道不存在：${channelId}`);
    return record;
  }

  async openAccess(record: ChannelRecord): Promise<ChannelAccess> {
    const deps: ChannelAccessDeps = {
      state: this.deps.state,
      http: this.deps.http,
      storageFactory: this.deps.storageFactory,
      logger: this.deps.logger,
      clock: this.deps.clock,
    };
    return ChannelAccessImpl.open(deps, record);
  }

  /** 从远端刷新 channel.json，并更新缓存 + 本地记录。 */
  async refreshRecord(record: ChannelRecord): Promise<ChannelFile> {
    const access = await this.openAccess(record);
    try {
      const channel = await access.readChannelRemote();
      await this.storeChannelSnapshot(record, channel);
      return channel;
    } finally {
      await access.close();
    }
  }

  /** 缓存 channel.json 并更新本地记录，返回最新记录。 */
  async storeChannelSnapshot(record: ChannelRecord, channel: ChannelFile): Promise<ChannelRecord> {
    const nowIso = this.deps.clock.now().toISOString();
    const updated: ChannelRecord = {
      ...record,
      channelName: channel.name,
      visibility: channel.visibility,
      createdAt: record.createdAt || channel.createdAt,
      updatedAt: channel.updatedAt,
      lastFetchedAt: nowIso,
    };
    await this.deps.state.writeChannelCache(channel);
    await this.deps.state.upsertChannelRecord(updated);
    return updated;
  }

  /** 获取频道详情所需的 channel.json：缓存优先，缺失时尝试刷新。 */
  async loadChannelForRecord(record: ChannelRecord): Promise<ChannelFile> {
    const cached = await this.deps.state.readChannelCache(record.channelId);
    if (cached) return cached;
    return this.refreshRecord(record);
  }

  buildInfo(record: ChannelRecord, channel: ChannelFile | null): ChannelInfo {
    return {
      id: record.channelId,
      name: channel?.name ?? record.channelName,
      description: channel?.description ?? '',
      visibility: channel?.visibility ?? record.visibility,
      role: record.role,
      createdAt: channel?.createdAt ?? record.createdAt,
      updatedAt: channel?.updatedAt ?? record.updatedAt,
      appCount: channel?.apps.length ?? 0,
      subscribeUrl: record.url,
      canPublish: record.role !== 'subscriber',
      ...(record.lastFetchedAt ? { lastFetchedAt: record.lastFetchedAt } : {}),
      source: record.source,
    };
  }

  buildDetail(record: ChannelRecord, channel: ChannelFile): ChannelDetail {
    return {
      ...this.buildInfo(record, channel),
      channel,
      apps: channel.apps.map(toAppInfo),
    };
  }
}
