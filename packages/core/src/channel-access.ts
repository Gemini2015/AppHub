import path from 'node:path';
import {
  AppError,
  appMetaKey,
  assertFileName,
  parseAppMetaFile,
  parseChannelFile,
  privatePrefix,
  resolveAppMetaUrl,
  resolveDownloadBaseUrl,
  resolveFileDownloadUrl,
  resolveUrl,
  serializeChannelFile,
  serializeAppMetaFile,
  versionArchiveKey,
  versionFilePathKey,
} from '@apphub/protocol';
import type {
  AppMetaFile,
  AppVersionEntry,
  ChannelAppRef,
  ChannelFile,
  ChannelPrivateFile,
} from '@apphub/protocol';
import type { StorageAdapter } from '@apphub/storage';
import type { Clock, Logger } from './types';
import type { StateStore } from './state';
import type { HttpClient } from './http';
import {
  createStorageAdapter,
  privateChannelDescriptorKey,
  storageHeaders,
  storageCall,
  deriveSubscribeUrl,
} from './storage';

/**
 * 频道访问器：owner/admin 走存储适配器，subscriber 走 HTTP。
 *
 * 这一层把"角色差异"收敛掉，供 PublishService / LibraryService 复用：
 *  - readChannelRemote / writeChannelRemote
 *  - readAppMeta（含 URL 解析与合法性校验）
 *  - fileDownload / archiveDownload（返回已鉴权/已解析的下载目标）
 */

export interface ChannelAccessDeps {
  state: StateStore;
  http: HttpClient;
  storageFactory: import('@apphub/storage').StorageFactory;
  logger?: Logger;
  clock: Clock;
}

export interface AppMetaAccess {
  meta: AppMetaFile;
  /** subscriber 时来自渠道 channel.json 的 App 引用；owner 时为 null。 */
  appRef: ChannelAppRef | null;
  /** app.meta.json 的绝对 URL（subscriber 用于解析相对下载地址）。 */
  metaUrl: string;
}

export interface DownloadTarget {
  url: string;
  headers?: Record<string, string>;
}

export class ChannelAccess {
  private constructor(
    private readonly deps: ChannelAccessDeps,
    readonly record: import('./types').ChannelRecord,
    private readonly pri: ChannelPrivateFile | null,
    private readonly adapter: StorageAdapter | null,
    private readonly headers: Record<string, string> | undefined,
  ) {}

  static async open(
    deps: ChannelAccessDeps,
    record: import('./types').ChannelRecord,
  ): Promise<ChannelAccess> {
    let pri: ChannelPrivateFile | null = null;
    let adapter: StorageAdapter | null = null;
    if (record.role !== 'subscriber') {
      pri = await deps.state.readPrivateConfig(record.channelId);
      if (!pri) {
        throw new AppError(
          'STATE',
          '本地缺少该频道的发布配置（channel_pri.json），请导入私有配置或重新创建频道',
        );
      }
      if (pri.channelId !== record.channelId) {
        throw new AppError('STATE', '频道私有配置与本地记录不一致（channelId）');
      }
      adapter = createStorageAdapter(deps, pri.storage);
    }
    const headers = await deps.state.readChannelHeaders(record);
    return new ChannelAccess(deps, record, pri, adapter, headers);
  }

  get channelId(): string {
    return this.record.channelId;
  }

  get hasStorageAccess(): boolean {
    return this.adapter !== null && this.pri !== null;
  }

  /**
   * 私密频道的所有对象都位于 `_private/<channelId>/<accessKey>/` 前缀下
   * （见 docs/PROTOCOL.md §2）；发布端读写存储 key 时必须加该前缀，
   * 订阅端通过 channel.json 的 URL 相对解析天然带上前缀。
   */
  private storagePrefix(): string {
    if (!this.pri || this.pri.visibility !== 'private') return '';
    if (!this.pri.accessKey) {
      throw new AppError('STATE', '私密频道的私有配置缺少 accessKey');
    }
    return `${privatePrefix(this.pri.channelId, this.pri.accessKey)}/`;
  }

  /** 频道根相对 key → 实际存储对象 key（私密频道加 _private 前缀）。 */
  objectKey(key: string): string {
    return `${this.storagePrefix()}${key}`;
  }

  private requireAdapter(): StorageAdapter {
    if (!this.adapter) throw new AppError('AUTH', '当前频道为订阅者身份，没有发布端存储访问权限');
    return this.adapter;
  }

  private requirePri(): ChannelPrivateFile {
    if (!this.pri) throw new AppError('AUTH', '缺少频道发布配置');
    return this.pri;
  }

  async close(): Promise<void> {
    if (!this.adapter) return;
    try {
      await this.adapter.close();
    } catch (error) {
      this.deps.logger?.warn('关闭存储适配器失败', { reason: AppError.from(error).message });
    }
  }

  private ensureChannelMatches(channel: ChannelFile): ChannelFile {
    if (channel.id !== this.record.channelId) {
      throw new AppError(
        'VALIDATION',
        `channel.json 的 id（${channel.id}）与本地频道记录（${this.record.channelId}）不一致`,
      );
    }
    return channel;
  }

  /** 从远端（存储或 HTTP）读取 channel.json；失败直接抛错（不回落缓存）。 */
  async readChannelRemote(): Promise<ChannelFile> {
    if (this.adapter) {
      const key = privateChannelDescriptorKey(this.requirePri());
      const text = await storageCall('读取频道信息失败', () => this.adapter!.readText(key));
      if (text === null) {
        throw new AppError('NOT_FOUND', '远端存储中不存在 channel.json（频道可能已被删除）');
      }
      return this.ensureChannelMatches(parseChannelFile(text));
    }
    const text = await this.deps.http.fetchText(this.record.url, {
      headers: this.headers,
      label: 'channel.json',
    });
    return this.ensureChannelMatches(parseChannelFile(text));
  }

  /** 优先远端；失败时回退本地缓存（订阅场景的离线可用性）。 */
  async loadChannel(): Promise<ChannelFile> {
    try {
      return await this.readChannelRemote();
    } catch (error) {
      const cached = await this.deps.state.readChannelCache(this.record.channelId);
      if (cached) {
        this.deps.logger?.warn('读取远端 channel.json 失败，使用本地缓存', {
          channelId: this.record.channelId,
          reason: AppError.from(error).message,
        });
        return cached;
      }
      throw AppError.from(error);
    }
  }

  async writeChannelRemote(channel: ChannelFile): Promise<void> {
    const adapter = this.requireAdapter();
    const key = privateChannelDescriptorKey(this.requirePri());
    const text = serializeChannelFile(channel);
    await storageCall('写入频道信息失败', () => adapter.writeText(key, text));
  }

  async writeAppMetaRemote(meta: AppMetaFile): Promise<void> {
    const adapter = this.requireAdapter();
    const text = serializeAppMetaFile(meta);
    const key = this.objectKey(appMetaKey(meta.appId));
    await storageCall('写入 App 元信息失败', () => adapter.writeText(key, text));
  }

  /** 写入任意存储对象（发布 payload / files.json / 图标等）。 */
  async writeObject(
    key: string,
    data: string | Buffer,
    options?: import('@apphub/storage').StorageWriteOptions,
  ): Promise<void> {
    const adapter = this.requireAdapter();
    const objectKey = this.objectKey(key);
    await storageCall(`写入存储对象失败：${key}`, () =>
      typeof data === 'string'
        ? adapter.writeText(objectKey, data)
        : adapter.writeBinary(objectKey, data, options),
    );
  }

  /** 读取任意存储对象的文本内容（不存在返回 null）。 */
  async readObjectText(key: string): Promise<string | null> {
    const adapter = this.requireAdapter();
    const objectKey = this.objectKey(key);
    return storageCall(`读取存储对象失败：${key}`, () => adapter.readText(objectKey));
  }

  /** 下载某个版本内文件所需的 URL 与 headers。 */
  async fileDownload(appId: string, version: AppVersionEntry, filePath: string, metaUrl?: string): Promise<DownloadTarget> {
    if (this.adapter) {
      const key = this.objectKey(versionFilePathKey(appId, version.version, filePath));
      const url = await storageCall('生成文件下载地址失败', () => this.adapter!.getDownloadUrl(key));
      return { url, headers: storageHeaders(this.requirePri().storage) };
    }
    if (!metaUrl) throw new AppError('INTERNAL', '订阅者下载文件时缺少 app.meta.json 地址');
    const base = resolveDownloadBaseUrl(metaUrl, version.downloadBaseUrl);
    return { url: resolveFileDownloadUrl(base, filePath), headers: this.headers };
  }

  /** 下载 zip 发布方式的压缩包。 */
  async archiveDownload(appId: string, version: AppVersionEntry, metaUrl?: string): Promise<DownloadTarget> {
    if (!version.archive) {
      throw new AppError('STATE', `版本 ${version.version} 缺少压缩包信息（archive）`);
    }
    const archiveName = assertFileName(path.posix.basename(version.archive.url), '压缩包文件名');
    if (this.adapter) {
      const key = this.objectKey(versionArchiveKey(appId, version.version, archiveName));
      const url = await storageCall('生成压缩包下载地址失败', () => this.adapter!.getDownloadUrl(key));
      return { url, headers: storageHeaders(this.requirePri().storage) };
    }
    if (!metaUrl) throw new AppError('INTERNAL', '订阅者下载压缩包时缺少 app.meta.json 地址');
    return { url: resolveUrl(metaUrl, version.archive.url), headers: this.headers };
  }

  /**
   * 读取 App 元信息并做一致性校验（appId/channelId）。
   * owner/admin 直接读存储；subscriber 先解析 channel.json 中的 metaUrl 再 HTTP 获取。
   */
  async readAppMeta(appId: string): Promise<AppMetaAccess> {
    let meta: AppMetaFile;
    let appRef: ChannelAppRef | null = null;
    let metaUrl: string;
    if (this.adapter) {
      const relativeKey = appMetaKey(appId);
      const text = await storageCall('读取 App 元信息失败', () =>
        this.adapter!.readText(this.objectKey(relativeKey)),
      );
      if (text === null) {
        throw new AppError('NOT_FOUND', `App 不存在：${appId}`);
      }
      meta = parseAppMetaFile(text);
      metaUrl = relativeKey;
    } else {
      const channel = await this.loadChannel();
      appRef = channel.apps.find((app) => app.appId === appId) ?? null;
      if (!appRef) {
        throw new AppError('NOT_FOUND', `频道中不存在 App：${appId}`);
      }
      metaUrl = resolveAppMetaUrl(this.record.url, appRef.metaUrl);
      const text = await this.deps.http.fetchText(metaUrl, {
        headers: this.headers,
        label: 'app.meta.json',
      });
      meta = parseAppMetaFile(text);
    }
    if (meta.appId !== appId) {
      throw new AppError('VALIDATION', `app.meta.json 的 appId（${meta.appId}）与请求（${appId}）不一致`);
    }
    if (meta.channelId !== this.record.channelId) {
      throw new AppError(
        'VALIDATION',
        `app.meta.json 的 channelId（${meta.channelId}）与本地频道（${this.record.channelId}）不一致`,
      );
    }
    await this.deps.state.writeAppMetaCache(meta);
    return { meta, appRef, metaUrl };
  }

  /** 频道订阅链接（私密频道为带 accessKey 的能力链接）。 */
  async subscribeUrl(): Promise<string> {
    if (this.pri && this.adapter) {
      return deriveSubscribeUrl(this.pri, this.adapter);
    }
    return this.record.url;
  }

  /** 供日志使用：安全的频道描述（无凭据）。 */
  describe(): { channelId: string; role: string; provider: string } {
    return {
      channelId: this.record.channelId,
      role: this.record.role,
      provider: this.pri?.storage.provider ?? 'http',
    };
  }
}
