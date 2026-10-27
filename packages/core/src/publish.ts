import path from 'node:path';
import {
  AppError,
  LIMITS,
  PLATFORMS,
  PUBLISH_MODES,
  appMetaKey,
  assertAppId,
  assertFileName,
  assertValidVersion,
  compareVersionsLenient,
  isHttpUrl,
  normalizeRelativePath,
  serializeFilesFile,
  maxVersion,
  slugifyAppName,
  versionArchiveKey,
  versionArchiveUrl,
  versionDownloadBaseUrl,
  versionFilePathKey,
  versionFilesKey,
  versionFilesUrl,
} from '@apphub/protocol';
import type {
  AppMetaFile,
  AppVersionEntry,
  ArchiveInfo,
  ChannelAppRef,
  FileEntry,
  FilesFile,
  Platform,
  PublishMode,
} from '@apphub/protocol';
import type { ChannelAccess } from './channel-access';
import type { ChannelServiceImpl } from './channels';
import { createProgressEmitter } from './progress';
import { hashFile, lowerExtension, readFileBuffer, statOrNull } from './fs';
import { createZipFromDirectory, inspectZipArchiveWithHash } from './zip';
import type { CreatedZip } from './zip';
import type {
  AppDetail,
  AppInfo,
  AppMetaPatch,
  ChannelRecord,
  Clock,
  Logger,
  PublishAppInput,
  PublishResult,
  PublishService,
  SecretBox,
} from './types';
import { channelWriteLockKey } from './mutex';
import type { KeyedMutex } from './mutex';
import type { StateStore } from './state';

/**
 * 发布服务。
 *
 * 写入顺序（不可变，对应 docs/ARCHITECTURE.md §3.3）：
 *   payload（版本文件/压缩包） → files.json → app.meta.json → channel.json
 *
 * 语义：
 *  - files / zip 两种模式，App 级 publishMode 创建后不可切换；
 *  - 同版本再发布：文件清单完全一致 = 幂等成功（只补写 channel.json 登记）；
 *    内容不同 = CONFLICT（overwrite=true 才整版本替换）；
 *  - 发布旧版本号只登记历史，不降低 latest（latest 按平台取 semver 最大）。
 */

export interface PublishServiceDeps {
  state: StateStore;
  storageFactory: import('@apphub/storage').StorageFactory;
  secretBox: SecretBox;
  clock: Clock;
  logger?: Logger;
  mutex: KeyedMutex;
  ready: Promise<void>;
}

interface PublishPayload {
  mode: PublishMode;
  entry: string;
  files: FileEntry[];
  /** files 模式下与 files 对齐的本地源文件路径。 */
  sources: string[];
  totalSize: number;
  archive: ArchiveInfo | null;
  archiveName?: string;
  archiveLocalPath?: string;
  /** zipFromDir 打包产生的临时文件清理函数。 */
  cleanup?: () => Promise<void>;
}

const ICON_EXTENSIONS = ['.png', '.ico', '.jpg', '.jpeg', '.svg', '.webp'];
const MAX_ICON_BYTES = 2 * 1024 * 1024;

function validatePlatform(value: unknown): Platform {
  if (typeof value !== 'string' || !(PLATFORMS as readonly string[]).includes(value)) {
    throw new AppError('VALIDATION', `不支持的平台：${String(value)}`);
  }
  return value as Platform;
}

function validatePublishMode(value: unknown): PublishMode {
  if (typeof value !== 'string' || !(PUBLISH_MODES as readonly string[]).includes(value)) {
    throw new AppError('VALIDATION', `不支持的发布方式：${String(value)}`);
  }
  return value as PublishMode;
}

function validateHomepage(value: string | undefined): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (!isHttpUrl(value)) throw new AppError('VALIDATION', '主页地址必须是 http(s) 地址');
  return value;
}

function validateChangelog(value: string | undefined): string {
  const changelog = value ?? '';
  if (changelog.length > LIMITS.changelog) {
    throw new AppError('VALIDATION', `更新说明过长（上限 ${LIMITS.changelog} 字符）`);
  }
  return changelog;
}

function resolveAppId(input: PublishAppInput): string {
  const app = input.app;
  if (app?.appId) return assertAppId(app.appId);
  if (!app) {
    throw new AppError('VALIDATION', '发布新版本时必须提供 app.appId 以定位现有 App');
  }
  if (typeof app.displayName !== 'string' || app.displayName.trim().length === 0) {
    throw new AppError('VALIDATION', '创建 App 时必须提供 displayName');
  }
  return slugifyAppName(app.displayName);
}

function isSameVersionContent(
  existing: AppVersionEntry,
  payload: PublishPayload,
  platform: Platform,
): boolean {
  if (existing.platform !== platform) return false;
  if (existing.publishMode !== payload.mode) return false;
  if (normalizeRelativePath(existing.entry, '已有版本入口') !== payload.entry) return false;
  if (existing.files.length !== payload.files.length) return false;
  const byPath = new Map(existing.files.map((file) => [file.path, file]));
  for (const file of payload.files) {
    const current = byPath.get(file.path);
    if (!current) return false;
    if (current.size !== file.size || current.md5.toLowerCase() !== file.md5.toLowerCase()) return false;
  }
  return true;
}

function toAppInfo(meta: AppMetaFile, metaUrl: string): AppInfo {
  return {
    appId: meta.appId,
    name: meta.name,
    displayName: meta.displayName,
    description: meta.description,
    author: meta.author,
    entry: meta.entry,
    platforms: meta.platforms,
    publishMode: meta.publishMode,
    latest: meta.latest,
    metaUrl,
    updatedAt: meta.updatedAt,
    ...(meta.iconUrl ? { iconUrl: meta.iconUrl } : {}),
  };
}

function appRefFromMeta(meta: AppMetaFile): ChannelAppRef {
  return {
    appId: meta.appId,
    name: meta.name,
    displayName: meta.displayName,
    description: meta.description,
    author: meta.author,
    entry: meta.entry,
    platforms: meta.platforms,
    publishMode: meta.publishMode,
    latest: meta.latest,
    metaUrl: appMetaKey(meta.appId),
    ...(meta.iconUrl ? { iconUrl: meta.iconUrl } : {}),
    updatedAt: meta.updatedAt,
  };
}

/** 合并 channel.json 中的 App 引用（保留其它 App 顺序）。 */
export function mergeAppRef(apps: ChannelAppRef[], ref: ChannelAppRef): ChannelAppRef[] {
  const index = apps.findIndex((app) => app.appId === ref.appId);
  if (index < 0) return [...apps, ref];
  const copy = [...apps];
  copy[index] = ref;
  return copy;
}

export class PublishServiceImpl implements PublishService {
  constructor(
    private readonly deps: PublishServiceDeps,
    private readonly channels: ChannelServiceImpl,
  ) {}

  async getApp(channelId: string, appId: string): Promise<AppDetail> {
    await this.deps.ready;
    const record = await this.channels.requireRecord(channelId);
    const access = await this.channels.openAccess(record);
    try {
      const { meta, appRef } = await access.readAppMeta(appId);
      return this.buildAppDetail(channelId, meta, appRef?.metaUrl ?? appMetaKey(appId));
    } catch (error) {
      const cached = await this.deps.state.readAppMetaCache(channelId, appId);
      if (cached) {
        this.deps.logger?.warn('读取远端 App 元信息失败，使用本地缓存', {
          channelId,
          appId,
          reason: AppError.from(error).message,
        });
        return this.buildAppDetail(channelId, cached, appMetaKey(cached.appId));
      }
      throw AppError.from(error);
    } finally {
      await access.close();
    }
  }

  async publish(input: PublishAppInput): Promise<PublishResult> {
    await this.deps.ready;
    const record = await this.channels.requireRecord(input.channelId);
    if (record.role === 'subscriber') {
      throw new AppError('AUTH', '当前频道为订阅者身份，没有发布权限');
    }
    const appId = resolveAppId(input);
    const version = assertValidVersion(input.version);
    const platform = validatePlatform(input.platform);
    const publishMode = validatePublishMode(input.publishMode);
    // 频道级互斥：同一频道的发布必须串行（channel.json 是唯一总索引，
    // 同频道不同 App 并发发布会丢 App / 并发写本地缓存触发 Windows EPERM）。
    return this.deps.mutex.runExclusive(channelWriteLockKey(record.channelId), () =>
      this.doPublish(record, appId, version, platform, publishMode, input),
    );
  }

  async updateMeta(channelId: string, appId: string, patch: AppMetaPatch): Promise<AppDetail> {
    await this.deps.ready;
    const record = await this.channels.requireRecord(channelId);
    if (record.role === 'subscriber') {
      throw new AppError('AUTH', '当前频道为订阅者身份，没有修改 App 元信息的权限');
    }
    // 与 publish 共用频道级锁：updateMeta 也会重写 channel.json，必须串行合并。
    return this.deps.mutex.runExclusive(channelWriteLockKey(channelId), () =>
      this.doUpdateMeta(record, appId, patch),
    );
  }

  // -------------------------------------------------------------------------
  // 内部实现
  // -------------------------------------------------------------------------

  private buildAppDetail(channelId: string, meta: AppMetaFile, metaUrl: string): AppDetail {
    const versions = [...meta.versions].sort((a, b) =>
      compareVersionsLenient(b.version, a.version),
    );
    return {
      channelId,
      app: toAppInfo(meta, metaUrl),
      meta,
      versions,
    };
  }

  private async buildFilesPayload(
    input: PublishAppInput,
    progress: ReturnType<typeof createProgressEmitter>,
  ): Promise<PublishPayload> {
    const inputs = input.files ?? [];
    if (inputs.length === 0) {
      throw new AppError('VALIDATION', 'files 发布方式必须至少提供一个文件');
    }
    if (inputs.length > LIMITS.fileCount) {
      throw new AppError('VALIDATION', `文件数量超过上限（${LIMITS.fileCount}）`);
    }
    const entry = normalizeRelativePath(input.entry, '启动入口');
    const files: FileEntry[] = [];
    const sources: string[] = [];
    const seen = new Set<string>();
    let totalSize = 0;
    for (let index = 0; index < inputs.length; index += 1) {
      const fileInput = inputs[index]!;
      if (typeof fileInput.sourcePath !== 'string' || fileInput.sourcePath.length === 0) {
        throw new AppError('VALIDATION', `第 ${index + 1} 个文件缺少源路径`);
      }
      const targetPath = normalizeRelativePath(fileInput.targetPath, '目标路径');
      if (seen.has(targetPath)) {
        throw new AppError('VALIDATION', `目标路径重复：${targetPath}`);
      }
      seen.add(targetPath);
      const sourcePath = path.resolve(fileInput.sourcePath);
      const stat = await statOrNull(sourcePath);
      if (!stat || !stat.isFile()) {
        throw new AppError('NOT_FOUND', `源文件不存在：${fileInput.sourcePath}`);
      }
      progress({
        phase: 'prepare',
        message: `正在校验文件：${targetPath}`,
        currentFile: targetPath,
        index: index + 1,
        count: inputs.length,
      });
      const hash = await hashFile(sourcePath);
      totalSize += hash.size;
      if (totalSize > LIMITS.totalSize) {
        throw new AppError('VALIDATION', `发布内容总大小超过上限（${LIMITS.totalSize} 字节）`);
      }
      files.push({
        path: targetPath,
        size: hash.size,
        md5: hash.md5,
        ...(fileInput.executable === true ? { executable: true } : {}),
      });
      sources.push(sourcePath);
    }
    files.sort((a, b) => a.path.localeCompare(b.path));
    const sourceByPath = new Map<string, string>();
    inputs.forEach((fileInput, index) => {
      sourceByPath.set(normalizeRelativePath(fileInput.targetPath, '目标路径'), sources[index]!);
    });
    const orderedSources = files.map((file) => sourceByPath.get(file.path)!);
    if (!seen.has(entry)) {
      throw new AppError('VALIDATION', `启动入口 ${entry} 不在待发布的文件列表中`);
    }
    return {
      mode: 'files',
      entry,
      files,
      sources: orderedSources,
      totalSize,
      archive: null,
    };
  }

  private async buildZipPayload(
    input: PublishAppInput,
    appId: string,
    version: string,
  ): Promise<PublishPayload> {
    if (input.files && input.files.length > 0) {
      throw new AppError('VALIDATION', 'zip 发布方式不能同时提供 files 列表');
    }
    if (input.zipPath && input.zipFromDir) {
      throw new AppError('VALIDATION', 'zipPath 与 zipFromDir 只能提供其中一个');
    }
    if (!input.zipPath && !input.zipFromDir) {
      throw new AppError('VALIDATION', 'zip 发布方式必须提供 zipPath 或 zipFromDir');
    }
    let localZipPath: string;
    let created: CreatedZip | undefined;
    if (input.zipFromDir) {
      created = await createZipFromDirectory(input.zipFromDir);
      localZipPath = created.zipPath;
    } else {
      localZipPath = path.resolve(input.zipPath!);
    }
    try {
      const stat = await statOrNull(localZipPath);
      if (!stat || !stat.isFile()) {
        throw new AppError('NOT_FOUND', `ZIP 文件不存在：${input.zipPath ?? input.zipFromDir}`);
      }
      const inspected = await inspectZipArchiveWithHash(localZipPath);
      const entry = normalizeRelativePath(input.entry, '启动入口');
      if (!inspected.files.some((file) => file.path === entry)) {
        throw new AppError(
          'VALIDATION',
          `启动入口 ${entry} 不在压缩包文件列表中（zip 模式 entry 必须是压缩包内路径）`,
        );
      }
      const archiveName = input.archiveName
        ? assertFileName(input.archiveName, '压缩包文件名')
        : `${appId}-${version}.zip`;
      const totalSize = inspected.files.reduce((sum, file) => sum + file.size, 0);
      if (totalSize > LIMITS.totalSize) {
        throw new AppError('VALIDATION', `压缩包解压后总大小超过上限（${LIMITS.totalSize} 字节）`);
      }
      const archive: ArchiveInfo = {
        url: versionArchiveUrl(version, archiveName),
        size: inspected.archiveSize,
        md5: inspected.archiveMd5,
        format: 'zip',
      };
      return {
        mode: 'zip',
        entry,
        files: inspected.files,
        sources: [],
        totalSize,
        archive,
        archiveName,
        archiveLocalPath: localZipPath,
        ...(created ? { cleanup: created.cleanup } : {}),
      };
    } catch (error) {
      if (created) await created.cleanup();
      throw AppError.from(error);
    }
  }

  private async doPublish(
    record: ChannelRecord,
    appId: string,
    version: string,
    platform: Platform,
    publishMode: PublishMode,
    input: PublishAppInput,
  ): Promise<PublishResult> {
    const progress = createProgressEmitter(input.onProgress);
    progress({ phase: 'prepare', message: '正在准备发布…' });
    const access = await this.channels.openAccess(record);
    let payload: PublishPayload | undefined;
    try {
      let currentMeta: AppMetaFile | null = null;
      try {
        currentMeta = (await access.readAppMeta(appId)).meta;
      } catch (error) {
        if (!(error instanceof AppError) || error.code !== 'NOT_FOUND') throw error;
      }
      if (currentMeta) {
        if (currentMeta.publishMode !== publishMode) {
          throw new AppError(
            'CONFLICT',
            `App 的发布方式为 ${currentMeta.publishMode}，创建后不可切换为 ${publishMode}`,
          );
        }
      } else if (!input.app) {
        throw new AppError('VALIDATION', `App ${appId} 不存在，创建新 App 需要提供 app 信息`);
      }

      payload =
        publishMode === 'files'
          ? await this.buildFilesPayload(input, progress)
          : await this.buildZipPayload(input, appId, version);

      const existingVersion = currentMeta?.versions.find((item) => item.version === version);
      const idempotent = existingVersion ? isSameVersionContent(existingVersion, payload, platform) : false;
      if (existingVersion && !idempotent && !input.overwrite) {
        throw new AppError(
          'CONFLICT',
          `版本 ${version} 已存在且内容不同；如需覆盖请设置 overwrite=true`,
          { version, platform },
        );
      }

      const nowIso = this.deps.clock.now().toISOString();
      const changelog = validateChangelog(input.changelog);
      const versionEntry: AppVersionEntry = {
        version,
        platform,
        publishMode,
        entry: payload.entry,
        publishedAt: nowIso,
        changelog,
        totalSize: payload.totalSize,
        fileCount: payload.files.length,
        filesUrl: versionFilesUrl(version),
        downloadBaseUrl: versionDownloadBaseUrl(version),
        files: payload.files,
        archive: payload.archive,
      };

      let nextMeta: AppMetaFile;
      if (idempotent && currentMeta && existingVersion) {
        nextMeta = currentMeta;
        progress({ phase: 'commit', message: '版本已存在且内容一致，补写频道索引' });
      } else {
        // 1) 上传 payload
        await this.uploadPayload(access, appId, version, payload, progress);
        const filesFile: FilesFile = {
          schemaVersion: 1,
          kind: 'apphub-files',
          appId,
          channelId: record.channelId,
          version,
          platform,
          publishMode,
          entry: payload.entry,
          totalSize: payload.totalSize,
          fileCount: payload.files.length,
          files: payload.files,
          archive: payload.archive,
          generatedAt: nowIso,
        };
        // 2) 上传 files.json
        await access.writeObject(versionFilesKey(appId, version), serializeFilesFile(filesFile));
        // 3) 合并历史并写 app.meta.json
        nextMeta = this.mergeMeta(currentMeta, {
          appId,
          channelId: record.channelId,
          versionEntry,
          input,
          platform,
          publishMode,
          nowIso,
        });
        progress({ phase: 'commit', message: '正在更新 App 元信息' });
        await access.writeAppMetaRemote(nextMeta);
      }

      // 4) 重新读取 channel.json，合并 App 引用后写回（最后一个写）
      progress({ phase: 'commit', message: '正在更新频道索引' });
      const remoteChannel = await access.readChannelRemote();
      const channel = {
        ...remoteChannel,
        apps: mergeAppRef(remoteChannel.apps, appRefFromMeta(nextMeta)),
        updatedAt: nowIso,
      };
      await access.writeChannelRemote(channel);
      await this.channels.storeChannelSnapshot(record, channel);
      progress({ phase: 'cleanup', message: '发布完成' });
      return {
        appId,
        version,
        platform,
        publishMode,
        metaUrl: appMetaKey(appId),
        totalSize: versionEntry.totalSize,
        fileCount: versionEntry.fileCount,
        files: versionEntry.files,
        archive: versionEntry.archive ?? null,
        channelUpdatedAt: channel.updatedAt,
      };
    } finally {
      if (payload?.cleanup) {
        try {
          await payload.cleanup();
        } catch (error) {
          this.deps.logger?.warn('清理临时压缩包失败', { reason: AppError.from(error).message });
        }
      }
      await access.close();
    }
  }

  private async uploadPayload(
    access: ChannelAccess,
    appId: string,
    version: string,
    payload: PublishPayload,
    progress: ReturnType<typeof createProgressEmitter>,
  ): Promise<void> {
    if (payload.mode === 'files') {
      let transferred = 0;
      const total = payload.totalSize;
      for (let index = 0; index < payload.files.length; index += 1) {
        const file = payload.files[index]!;
        const sourcePath = payload.sources[index]!;
        const buffer = await readFileBuffer(sourcePath, '源文件');
        await access.writeObject(versionFilePathKey(appId, version, file.path), buffer, {
          executable: file.executable === true,
        });
        transferred += file.size;
        progress({
          phase: 'transfer',
          message: `正在上传：${file.path}`,
          currentFile: file.path,
          index: index + 1,
          count: payload.files.length,
          transferredBytes: transferred,
          totalBytes: total,
          percent: total > 0 ? Math.round((transferred / total) * 100) : 100,
        });
      }
      return;
    }
    if (!payload.archiveLocalPath || !payload.archiveName) {
      throw new AppError('INTERNAL', 'zip 发布载荷缺少压缩包路径');
    }
    const buffer = await readFileBuffer(payload.archiveLocalPath, '压缩包');
    await access.writeObject(versionArchiveKey(appId, version, payload.archiveName), buffer, {
      contentType: 'application/zip',
    });
    progress({
      phase: 'transfer',
      message: `正在上传：${payload.archiveName}`,
      currentFile: payload.archiveName,
      index: 1,
      count: 1,
      transferredBytes: buffer.length,
      totalBytes: buffer.length,
      percent: 100,
    });
  }

  private mergeMeta(
    current: AppMetaFile | null,
    options: {
      appId: string;
      channelId: string;
      versionEntry: AppVersionEntry;
      input: PublishAppInput;
      platform: Platform;
      publishMode: PublishMode;
      nowIso: string;
    },
  ): AppMetaFile {
    const { appId, channelId, versionEntry, input, publishMode, nowIso } = options;
    const otherVersions = (current?.versions ?? []).filter(
      (item) => item.version !== versionEntry.version,
    );
    const versions = [...otherVersions, versionEntry].sort((a, b) =>
      compareVersionsLenient(b.version, a.version),
    );
    const platforms = PLATFORMS.filter((platform) =>
      versions.some((item) => item.platform === platform),
    );
    const latest: Record<string, string> = {};
    for (const platform of platforms) {
      const candidates = versions
        .filter((item) => item.platform === platform)
        .map((item) => item.version);
      const best = maxVersion(candidates);
      if (best) latest[platform] = best;
    }
    const latestForPlatform = latest[options.platform];
    const displayName = current?.displayName ?? input.app?.displayName;
    if (!displayName) throw new AppError('VALIDATION', '创建 App 时必须提供 displayName');
    const homepage = current?.homepage ?? validateHomepage(input.app?.homepage);
    return {
      schemaVersion: 1,
      kind: 'apphub-app-meta',
      appId,
      channelId,
      name: current?.name ?? appId,
      displayName,
      description: current?.description ?? (input.app?.description ?? ''),
      author: current?.author ?? (input.app?.author ?? ''),
      ...(homepage !== undefined ? { homepage } : {}),
      ...(current?.iconUrl ? { iconUrl: current.iconUrl } : {}),
      publishMode,
      entry: latestForPlatform === versionEntry.version ? versionEntry.entry : (current?.entry ?? versionEntry.entry),
      platforms,
      latest,
      versions,
      updatedAt: nowIso,
    };
  }

  private async doUpdateMeta(
    record: ChannelRecord,
    appId: string,
    patch: AppMetaPatch,
  ): Promise<AppDetail> {
    const access = await this.channels.openAccess(record);
    try {
      const { meta } = await access.readAppMeta(appId);
      const next: AppMetaFile = { ...meta };
      if (patch.displayName !== undefined) {
        const displayName = patch.displayName.trim();
        if (displayName.length === 0 || displayName.length > LIMITS.appDisplayName) {
          throw new AppError('VALIDATION', `App 显示名称长度必须在 1-${LIMITS.appDisplayName} 之间`);
        }
        next.displayName = displayName;
      }
      if (patch.description !== undefined) {
        if (patch.description.length > LIMITS.appDescription) {
          throw new AppError('VALIDATION', `App 描述过长（上限 ${LIMITS.appDescription} 字符）`);
        }
        next.description = patch.description;
      }
      if (patch.author !== undefined) {
        if (patch.author.length > LIMITS.author) {
          throw new AppError('VALIDATION', `作者字段过长（上限 ${LIMITS.author} 字符）`);
        }
        next.author = patch.author;
      }
      if (patch.homepage !== undefined) {
        const homepage = validateHomepage(patch.homepage);
        if (homepage === undefined) delete next.homepage;
        else next.homepage = homepage;
      }
      if (patch.entry !== undefined) {
        const entry = normalizeRelativePath(patch.entry, '启动入口');
        const exists = meta.versions.some((version) => version.files.some((file) => file.path === entry));
        if (!exists) {
          throw new AppError('VALIDATION', `启动入口 ${entry} 不在任何版本的文件列表中`);
        }
        next.entry = entry;
      }
      if (patch.iconSourcePath !== undefined) {
        const iconBuffer = await readFileBuffer(patch.iconSourcePath, '图标文件');
        if (iconBuffer.length > MAX_ICON_BYTES) {
          throw new AppError('VALIDATION', `图标文件过大（上限 ${MAX_ICON_BYTES} 字节）`);
        }
        const extension = lowerExtension(patch.iconSourcePath);
        if (!ICON_EXTENSIONS.includes(extension)) {
          throw new AppError('VALIDATION', `不支持的图标格式：${extension || '（无扩展名）'}`);
        }
        const iconKey = `${appId}/icon${extension}`;
        await access.writeObject(iconKey, iconBuffer, { contentType: 'image/*' });
        next.iconUrl = `icon${extension}`;
      }
      next.updatedAt = this.deps.clock.now().toISOString();
      await access.writeAppMetaRemote(next);
      const remoteChannel = await access.readChannelRemote();
      const channel = {
        ...remoteChannel,
        apps: mergeAppRef(remoteChannel.apps, appRefFromMeta(next)),
        updatedAt: next.updatedAt,
      };
      await access.writeChannelRemote(channel);
      await this.channels.storeChannelSnapshot(record, channel);
      this.deps.logger?.info('已更新 App 元信息', { channelId: record.channelId, appId });
      return this.buildAppDetail(record.channelId, next, appMetaKey(appId));
    } finally {
      await access.close();
    }
  }

  /** 发布完成后的结果读取辅助（避免重复读取逻辑散落）。 */
}

