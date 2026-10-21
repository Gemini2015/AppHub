import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  AppError,
  FILE_NAMES,
  isAppId,
  isChannelId,
  normalizeRelativePath,
  parseAppMetaFile,
  parseChannelFile,
  parseChannelPrivateFile,
} from '@apphub/protocol';
import type {
  AppMetaFile,
  ArchiveInfo,
  ChannelFile,
  ChannelPrivateFile,
  FileEntry,
  Platform,
  PublishMode,
} from '@apphub/protocol';
import {
  ensureDir,
  pathExists,
  readJsonFile,
  readTextFileOrNull,
  removePath,
  safeJoin,
  walkFiles,
  writeFileAtomic,
  writeJsonAtomic,
} from './fs';
import type { ChannelRecord, Logger, SecretBox } from './types';
import type { KeyedMutex } from './mutex';

/**
 * 本地状态存储（<dataDir> 下的 JSON / 密文）。
 *
 * 结构见 docs/ARCHITECTURE.md §4.2：
 *   channels.json
 *   channels/<channelId>/channel.json
 *   channels/<channelId>/apps/<appId>/app.meta.json   （读取失败时的回退缓存）
 *   secrets/channel_pri/<channelId>.enc
 *   library/index.json
 *   library/<channelId>/<appId>/install.json
 *   tmp/<opId>/
 *
 * 所有写操作都是"读-合并-写回"，并用 KeyedMutex 串行化，保证并发安全。
 */

export interface InstalledRecord {
  schemaVersion: 1;
  kind: 'apphub-install';
  channelId: string;
  channelName: string;
  appId: string;
  displayName: string;
  version: string;
  platform: Platform;
  publishMode: PublishMode;
  entry: string;
  installedAt: string;
  updatedAt: string;
  fileCount: number;
  totalSize: number;
  files: FileEntry[];
  archive?: ArchiveInfo | null;
}

export interface LibraryIndexEntry {
  channelId: string;
  channelName: string;
  appId: string;
  displayName: string;
  version: string;
  platform: Platform;
  publishMode: PublishMode;
  entry: string;
  installedAt: string;
  updatedAt: string;
  fileCount: number;
  totalSize: number;
}

interface ChannelsFile {
  schemaVersion: number;
  kind: 'apphub-channels';
  channels: ChannelRecord[];
}

interface LibraryIndexFile {
  schemaVersion: number;
  kind: 'apphub-library-index';
  apps: LibraryIndexEntry[];
}

const CHANNELS_FILE_NAME = 'channels.json';
const LIBRARY_INDEX_NAME = 'index.json';

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new AppError('STATE', `本地状态字段非法（${label}）`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function requireNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new AppError('STATE', `本地状态字段非法（${label}）`);
  }
  return value;
}

function parseChannelRecord(value: unknown): ChannelRecord {
  const raw = value as Record<string, unknown>;
  const visibility = raw.visibility;
  if (visibility !== 'public' && visibility !== 'private') {
    throw new AppError('STATE', '本地频道记录非法（visibility）');
  }
  const role = raw.role;
  if (role !== 'owner' && role !== 'admin' && role !== 'subscriber') {
    throw new AppError('STATE', '本地频道记录非法（role）');
  }
  const source = raw.source;
  if (source !== 'owned' && source !== 'subscribed') {
    throw new AppError('STATE', '本地频道记录非法（source）');
  }
  return {
    channelId: requireString(raw.channelId, 'channelId'),
    url: requireString(raw.url, 'url'),
    visibility,
    role,
    source,
    channelName: requireString(raw.channelName, 'channelName'),
    createdAt: requireString(raw.createdAt, 'createdAt'),
    updatedAt: requireString(raw.updatedAt, 'updatedAt'),
    ...(optionalString(raw.lastFetchedAt) ? { lastFetchedAt: raw.lastFetchedAt as string } : {}),
    ...(optionalString(raw.headersCipher) ? { headersCipher: raw.headersCipher as string } : {}),
  };
}

function parseFileEntry(value: unknown): FileEntry {
  const raw = value as Record<string, unknown>;
  const filePath = requireString(raw.path, 'files[].path');
  const md5 = requireString(raw.md5, 'files[].md5');
  if (!/^[0-9a-f]{32}$/.test(md5.toLowerCase())) {
    throw new AppError('STATE', '本地状态字段非法（files[].md5）');
  }
  const implementation: FileEntry = {
    path: normalizeRelativePath(filePath, '本地文件路径'),
    size: requireNumber(raw.size, 'files[].size'),
    md5: md5.toLowerCase(),
  };
  if (typeof raw.executable === 'boolean') implementation.executable = raw.executable;
  return implementation;
}

function parseArchiveInfo(value: unknown): ArchiveInfo | null {
  if (value === null || value === undefined) return null;
  const raw = value as Record<string, unknown>;
  return {
    url: requireString(raw.url, 'archive.url'),
    size: requireNumber(raw.size, 'archive.size'),
    md5: requireString(raw.md5, 'archive.md5').toLowerCase(),
    format: 'zip',
  };
}

function parseInstalledRecord(value: unknown): InstalledRecord {
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.files)) {
    throw new AppError('STATE', 'install.json 已损坏（files 缺失）');
  }
  const platform = raw.platform;
  if (platform !== 'windows' && platform !== 'linux' && platform !== 'mac') {
    throw new AppError('STATE', 'install.json 已损坏（platform）');
  }
  const publishMode = raw.publishMode;
  if (publishMode !== 'files' && publishMode !== 'zip') {
    throw new AppError('STATE', 'install.json 已损坏（publishMode）');
  }
  return {
    schemaVersion: 1,
    kind: 'apphub-install',
    channelId: requireString(raw.channelId, 'channelId'),
    channelName: requireString(raw.channelName, 'channelName'),
    appId: requireString(raw.appId, 'appId'),
    displayName: requireString(raw.displayName, 'displayName'),
    version: requireString(raw.version, 'version'),
    platform,
    publishMode,
    entry: normalizeRelativePath(requireString(raw.entry, 'entry'), '启动入口'),
    installedAt: requireString(raw.installedAt, 'installedAt'),
    updatedAt: requireString(raw.updatedAt, 'updatedAt'),
    fileCount: requireNumber(raw.fileCount, 'fileCount'),
    totalSize: requireNumber(raw.totalSize, 'totalSize'),
    files: raw.files.map((file) => parseFileEntry(file)),
    archive: parseArchiveInfo(raw.archive),
  };
}

function parseLibraryIndexEntry(value: unknown): LibraryIndexEntry {
  const raw = value as Record<string, unknown>;
  const platform = raw.platform;
  if (platform !== 'windows' && platform !== 'linux' && platform !== 'mac') {
    throw new AppError('STATE', 'library/index.json 已损坏（platform）');
  }
  const publishMode = raw.publishMode;
  if (publishMode !== 'files' && publishMode !== 'zip') {
    throw new AppError('STATE', 'library/index.json 已损坏（publishMode）');
  }
  return {
    channelId: requireString(raw.channelId, 'channelId'),
    channelName: requireString(raw.channelName, 'channelName'),
    appId: requireString(raw.appId, 'appId'),
    displayName: requireString(raw.displayName, 'displayName'),
    version: requireString(raw.version, 'version'),
    platform,
    publishMode,
    entry: requireString(raw.entry, 'entry'),
    installedAt: requireString(raw.installedAt, 'installedAt'),
    updatedAt: requireString(raw.updatedAt, 'updatedAt'),
    fileCount: requireNumber(raw.fileCount, 'fileCount'),
    totalSize: requireNumber(raw.totalSize, 'totalSize'),
  };
}

export class StateStore {
  readonly dataDir: string;
  private readonly secretBox: SecretBox;
  private readonly mutex: KeyedMutex;
  private readonly logger?: Logger;

  constructor(options: {
    dataDir: string;
    secretBox: SecretBox;
    mutex: KeyedMutex;
    logger?: Logger;
  }) {
    this.dataDir = options.dataDir;
    this.secretBox = options.secretBox;
    this.mutex = options.mutex;
    this.logger = options.logger;
  }

  // -------------------------------------------------------------------------
  // 路径
  // -------------------------------------------------------------------------

  get channelsFile(): string {
    return path.join(this.dataDir, CHANNELS_FILE_NAME);
  }

  get channelsDir(): string {
    return path.join(this.dataDir, 'channels');
  }

  channelCacheDir(channelId: string): string {
    return safeJoin(this.channelsDir, this.requireChannelId(channelId), '频道缓存目录');
  }

  channelCacheFile(channelId: string): string {
    return safeJoin(this.channelsDir, `${this.requireChannelId(channelId)}/${FILE_NAMES.channel}`, '频道缓存文件');
  }

  appMetaCacheFile(channelId: string, appId: string): string {
    return safeJoin(
      this.channelsDir,
      `${this.requireChannelId(channelId)}/apps/${this.requireAppId(appId)}/${FILE_NAMES.appMeta}`,
      'App 元信息缓存文件',
    );
  }

  get secretsDir(): string {
    return path.join(this.dataDir, 'secrets', 'channel_pri');
  }

  privateConfigFile(channelId: string): string {
    return safeJoin(this.secretsDir, `${this.requireChannelId(channelId)}.enc`, '频道私有配置');
  }

  get libraryDir(): string {
    return path.join(this.dataDir, 'library');
  }

  get libraryIndexFile(): string {
    return path.join(this.libraryDir, LIBRARY_INDEX_NAME);
  }

  appRoot(channelId: string, appId: string): string {
    return safeJoin(this.libraryDir, `${this.requireChannelId(channelId)}/${this.requireAppId(appId)}`, 'App 安装目录');
  }

  installFile(channelId: string, appId: string): string {
    return safeJoin(this.appRoot(channelId, appId), 'install.json', '安装状态文件');
  }

  versionsDir(channelId: string, appId: string): string {
    return safeJoin(this.appRoot(channelId, appId), 'versions', '版本目录');
  }

  versionDir(channelId: string, appId: string, version: string): string {
    const versionSegment = normalizeRelativePath(version, '版本号');
    return safeJoin(this.versionsDir(channelId, appId), versionSegment, '版本目录');
  }

  get tmpDir(): string {
    return path.join(this.dataDir, 'tmp');
  }

  tmpOperationDir(operationId: string): string {
    return safeJoin(this.tmpDir, this.requireOperationId(operationId), '临时目录');
  }

  private requireChannelId(channelId: string): string {
    if (!isChannelId(channelId)) {
      throw new AppError('VALIDATION', `频道 ID 非法：${String(channelId)}`);
    }
    return channelId;
  }

  private requireAppId(appId: string): string {
    if (!isAppId(appId)) {
      throw new AppError('VALIDATION', `App 标识非法：${String(appId)}`);
    }
    return appId;
  }

  private requireOperationId(operationId: string): string {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(operationId)) {
      throw new AppError('VALIDATION', `操作 ID 非法：${String(operationId)}`);
    }
    return operationId;
  }

  // -------------------------------------------------------------------------
  // 初始化
  // -------------------------------------------------------------------------

  async init(): Promise<void> {
    await Promise.all([
      ensureDir(this.dataDir),
      ensureDir(this.channelsDir),
      ensureDir(this.secretsDir),
      ensureDir(this.libraryDir),
      ensureDir(this.tmpDir),
    ]);
  }

  // -------------------------------------------------------------------------
  // channels.json
  // -------------------------------------------------------------------------

  async listChannelRecords(): Promise<ChannelRecord[]> {
    const data = await readJsonFile<ChannelsFile>(this.channelsFile, 'channels.json');
    if (!data) return [];
    if (!Array.isArray(data.channels)) {
      throw new AppError('STATE', 'channels.json 已损坏（channels 缺失）');
    }
    return data.channels.map((record) => parseChannelRecord(record));
  }

  async getChannelRecord(channelId: string): Promise<ChannelRecord | null> {
    const records = await this.listChannelRecords();
    return records.find((record) => record.channelId === channelId) ?? null;
  }

  async saveChannelRecords(records: ChannelRecord[]): Promise<void> {
    await this.mutex.runExclusive('channels', async () => {
      const data: ChannelsFile = { schemaVersion: 1, kind: 'apphub-channels', channels: records };
      await writeJsonAtomic(this.channelsFile, data);
    });
  }

  async upsertChannelRecord(record: ChannelRecord): Promise<void> {
    await this.mutex.runExclusive('channels', async () => {
      const records = await this.listChannelRecords();
      const index = records.findIndex((item) => item.channelId === record.channelId);
      if (index >= 0) records[index] = record;
      else records.push(record);
      const data: ChannelsFile = { schemaVersion: 1, kind: 'apphub-channels', channels: records };
      await writeJsonAtomic(this.channelsFile, data);
    });
  }

  async removeChannelRecord(channelId: string): Promise<void> {
    await this.mutex.runExclusive('channels', async () => {
      const records = await this.listChannelRecords();
      const filtered = records.filter((record) => record.channelId !== channelId);
      const data: ChannelsFile = { schemaVersion: 1, kind: 'apphub-channels', channels: filtered };
      await writeJsonAtomic(this.channelsFile, data);
    });
  }

  // -------------------------------------------------------------------------
  // channel.json 缓存
  // -------------------------------------------------------------------------

  async readChannelCache(channelId: string): Promise<ChannelFile | null> {
    const filePath = this.channelCacheFile(channelId);
    const text = await readTextFileOrNull(filePath);
    if (text === null) return null;
    try {
      return parseChannelFile(text);
    } catch (error) {
      this.logger?.warn('本地 channel.json 缓存已损坏，将忽略', {
        channelId,
        reason: AppError.from(error).message,
      });
      return null;
    }
  }

  async writeChannelCache(channel: ChannelFile): Promise<void> {
    const filePath = this.channelCacheFile(channel.id);
    await ensureDir(path.dirname(filePath));
    await writeJsonAtomic(filePath, channel);
  }

  async dropChannelCache(channelId: string): Promise<void> {
    await removePath(this.channelCacheDir(channelId));
  }

  async readAppMetaCache(channelId: string, appId: string): Promise<AppMetaFile | null> {
    const filePath = this.appMetaCacheFile(channelId, appId);
    const text = await readTextFileOrNull(filePath);
    if (text === null) return null;
    try {
      return parseAppMetaFile(text);
    } catch (error) {
      this.logger?.warn('本地 app.meta.json 缓存已损坏，将忽略', {
        channelId,
        appId,
        reason: AppError.from(error).message,
      });
      return null;
    }
  }

  async writeAppMetaCache(meta: AppMetaFile): Promise<void> {
    const filePath = this.appMetaCacheFile(meta.channelId, meta.appId);
    await ensureDir(path.dirname(filePath));
    await writeJsonAtomic(filePath, meta);
  }

  // -------------------------------------------------------------------------
  // channel_pri 密文
  // -------------------------------------------------------------------------

  async hasPrivateConfig(channelId: string): Promise<boolean> {
    return pathExists(this.privateConfigFile(channelId));
  }

  async readPrivateConfig(channelId: string): Promise<ChannelPrivateFile | null> {
    const filePath = this.privateConfigFile(channelId);
    const cipher = await readTextFileOrNull(filePath);
    if (cipher === null) return null;
    let plain: string;
    try {
      plain = await this.secretBox.decrypt(cipher);
    } catch (error) {
      throw new AppError('STATE', `频道私有配置解密失败：${AppError.from(error).message}`);
    }
    try {
      return parseChannelPrivateFile(plain);
    } catch (error) {
      throw new AppError('STATE', `频道私有配置内容非法：${AppError.from(error).message}`);
    }
  }

  async writePrivateConfig(config: ChannelPrivateFile): Promise<void> {
    const plain = JSON.stringify(config, null, 2);
    const cipher = await this.secretBox.encrypt(plain);
    const filePath = this.privateConfigFile(config.channelId);
    await ensureDir(path.dirname(filePath));
    await writeFileAtomic(filePath, cipher);
  }

  /** 读取订阅时持久化的 HTTP headers（解密后返回）。 */
  async readChannelHeaders(record: ChannelRecord): Promise<Record<string, string> | undefined> {
    if (!record.headersCipher) return undefined;
    let plain: string;
    try {
      plain = await this.secretBox.decrypt(record.headersCipher);
    } catch (error) {
      throw new AppError('STATE', `频道请求头解密失败：${AppError.from(error).message}`);
    }
    try {
      const parsed: unknown = JSON.parse(plain);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value === 'string') headers[key] = value;
      }
      return Object.keys(headers).length > 0 ? headers : undefined;
    } catch {
      throw new AppError('STATE', '频道请求头缓存已损坏');
    }
  }

  // -------------------------------------------------------------------------
  // library/index.json
  // -------------------------------------------------------------------------

  async readLibraryRecords(): Promise<LibraryIndexEntry[]> {
    const data = await readJsonFile<LibraryIndexFile>(this.libraryIndexFile, 'library/index.json');
    if (!data) {
      return this.rebuildLibraryRecords();
    }
    if (!Array.isArray(data.apps)) {
      throw new AppError('STATE', 'library/index.json 已损坏（apps 缺失）');
    }
    return data.apps.map((entry) => parseLibraryIndexEntry(entry));
  }

  /** 读取索引；损坏时从各 install.json 重建（并写回）。 */
  async listLibraryRecords(): Promise<LibraryIndexEntry[]> {
    try {
      return await this.readLibraryRecords();
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== 'STATE') throw error;
      this.logger?.warn('本地库索引已损坏，正在从 install.json 重建', { reason: error.message });
      const rebuilt = await this.rebuildLibraryRecords();
      await this.saveLibraryRecords(rebuilt);
      return rebuilt;
    }
  }

  /** 扫描 library/<channelId>/<appId>/install.json 重建索引。 */
  async rebuildLibraryRecords(): Promise<LibraryIndexEntry[]> {
    const entries: LibraryIndexEntry[] = [];
    let channelDirs: import('node:fs').Dirent[] = [];
    try {
      channelDirs = await fs.readdir(this.libraryDir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return entries;
      throw AppError.from(error, 'IO');
    }
    for (const channelDir of channelDirs) {
      if (!channelDir.isDirectory()) continue;
      const channelPath = path.join(this.libraryDir, channelDir.name);
      let appDirs: import('node:fs').Dirent[] = [];
      try {
        appDirs = await fs.readdir(channelPath, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const appDir of appDirs) {
        if (!appDir.isDirectory()) continue;
        const installPath = path.join(channelPath, appDir.name, 'install.json');
        try {
          const record = await this.readInstallFileAt(installPath);
          entries.push({
            channelId: record.channelId,
            channelName: record.channelName,
            appId: record.appId,
            displayName: record.displayName,
            version: record.version,
            platform: record.platform,
            publishMode: record.publishMode,
            entry: record.entry,
            installedAt: record.installedAt,
            updatedAt: record.updatedAt,
            fileCount: record.fileCount,
            totalSize: record.totalSize,
          });
        } catch (error) {
          this.logger?.warn('跳过损坏的安装记录', {
            path: installPath,
            reason: AppError.from(error).message,
          });
        }
      }
    }
    entries.sort(
      (a, b) =>
        a.channelId.localeCompare(b.channelId) || a.appId.localeCompare(b.appId),
    );
    return entries;
  }

  async saveLibraryRecords(records: LibraryIndexEntry[]): Promise<void> {
    await this.mutex.runExclusive('library', async () => {
      const data: LibraryIndexFile = { schemaVersion: 1, kind: 'apphub-library-index', apps: records };
      await writeJsonAtomic(this.libraryIndexFile, data);
    });
  }

  async upsertLibraryRecord(record: LibraryIndexEntry): Promise<void> {
    await this.mutex.runExclusive('library', async () => {
      let records: LibraryIndexEntry[];
      try {
        records = await this.readLibraryRecords();
      } catch {
        records = await this.rebuildLibraryRecords();
      }
      const index = records.findIndex(
        (item) => item.channelId === record.channelId && item.appId === record.appId,
      );
      if (index >= 0) records[index] = record;
      else records.push(record);
      records.sort(
        (a, b) => a.channelId.localeCompare(b.channelId) || a.appId.localeCompare(b.appId),
      );
      const data: LibraryIndexFile = { schemaVersion: 1, kind: 'apphub-library-index', apps: records };
      await writeJsonAtomic(this.libraryIndexFile, data);
    });
  }

  async removeLibraryRecord(channelId: string, appId: string): Promise<void> {
    await this.mutex.runExclusive('library', async () => {
      let records: LibraryIndexEntry[];
      try {
        records = await this.readLibraryRecords();
      } catch {
        records = [];
      }
      const filtered = records.filter(
        (record) => !(record.channelId === channelId && record.appId === appId),
      );
      const data: LibraryIndexFile = {
        schemaVersion: 1,
        kind: 'apphub-library-index',
        apps: filtered,
      };
      await writeJsonAtomic(this.libraryIndexFile, data);
    });
  }

  // -------------------------------------------------------------------------
  // install.json
  // -------------------------------------------------------------------------

  private async readInstallFileAt(filePath: string): Promise<InstalledRecord> {
    const data = await readJsonFile<Record<string, unknown>>(filePath, 'install.json');
    if (!data) throw new AppError('NOT_FOUND', `未安装：${filePath}`);
    return parseInstalledRecord(data);
  }

  async getInstallFile(channelId: string, appId: string): Promise<InstalledRecord | null> {
    const filePath = this.installFile(channelId, appId);
    const data = await readJsonFile<Record<string, unknown>>(filePath, 'install.json');
    if (!data) return null;
    return parseInstalledRecord(data);
  }

  async writeInstallFile(record: InstalledRecord): Promise<void> {
    const filePath = this.installFile(record.channelId, record.appId);
    await ensureDir(path.dirname(filePath));
    await writeJsonAtomic(filePath, record);
  }

  async removeAppDir(channelId: string, appId: string): Promise<void> {
    await removePath(this.appRoot(channelId, appId));
  }

  // -------------------------------------------------------------------------
  // 临时目录
  // -------------------------------------------------------------------------

  async ensureOperationDir(operationId: string): Promise<string> {
    const dir = this.tmpOperationDir(operationId);
    await ensureDir(dir);
    return dir;
  }

  async cleanupOperationDir(operationId: string): Promise<void> {
    await removePath(this.tmpOperationDir(operationId));
  }

  /** 清理 tmp 下所有残留（启动时调用，可选）。 */
  async cleanupAllTemp(): Promise<void> {
    await removePath(this.tmpDir);
    await ensureDir(this.tmpDir);
  }

  /** 测试/诊断用：列出 dataDir 下的相对文件路径。 */
  async listDataFiles(): Promise<string[]> {
    return walkFiles(this.dataDir);
  }
}
