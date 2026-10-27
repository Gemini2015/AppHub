import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  AppError,
  PLATFORMS,
  assertValidVersion,
  compareVersionsLenient,
  isValidVersion,
  sortVersionsDesc,
} from '@apphub/protocol';
import type { AppMetaFile, AppVersionEntry, ChannelFile, FileEntry, Platform } from '@apphub/protocol';
import type { ChannelServiceImpl } from './channels';
import { createProgressEmitter } from './progress';
import {
  copyFileEnsured,
  ensureDir,
  hashFile,
  pathExists,
  progressPercent,
  removePath,
  safeJoin,
  statOrNull,
  uniqueSuffix,
  walkFiles,
} from './fs';
import type { HttpClient } from './http';
import type { KeyedMutex } from './mutex';
import type { InstalledRecord, LibraryIndexEntry, StateStore } from './state';
import { extractZipArchive } from './zip';
import type {
  Clock,
  InstalledAppInfo,
  InstallResult,
  InstallTarget,
  LaunchDescriptor,
  LibraryService,
  Logger,
  UpdateCheckItem,
  VerifyResult,
} from './types';

/**
 * 本地库服务：安装 / 更新 / 校验 / 卸载 / 更新检测 / 启动描述符。
 *
 * 安装流程（对应 docs/ARCHITECTURE.md §3.4、PROTOCOL.md §8）：
 *   刷新频道 → 解析目标版本 → 下载到 tmp staging（files 模式按 MD5 复用旧文件；
 *   zip 模式先校验 archive 再安全解压）→ 逐文件校验 → rename 切换 versions/<version>
 *   → 原子写 install.json（current 指针）→ 清理旧版本（keepVersions）。
 *
 * 失败时 staging/临时目录清理，install.json 与旧版本目录保持可用。
 */

export interface LibraryServiceDeps {
  state: StateStore;
  channels: ChannelServiceImpl;
  http: HttpClient;
  clock: Clock;
  logger?: Logger;
  mutex: KeyedMutex;
  keepVersions: number;
  ready: Promise<void>;
}

interface VersionResolution {
  entry: AppVersionEntry;
  platform: Platform;
}

interface FilePlan {
  file: FileEntry;
  action: 'reuse' | 'download';
  oldPath?: string;
}

function isSameFileList(a: readonly FileEntry[], b: readonly FileEntry[]): boolean {
  if (a.length !== b.length) return false;
  const byPath = new Map(a.map((file) => [file.path, file]));
  for (const file of b) {
    const current = byPath.get(file.path);
    if (!current) return false;
    if (current.size !== file.size || current.md5.toLowerCase() !== file.md5.toLowerCase()) {
      return false;
    }
  }
  return true;
}

function pickDefaultPlatform(meta: AppMetaFile): Platform {
  for (const platform of PLATFORMS) {
    if (meta.latest[platform]) return platform;
  }
  return meta.platforms[0] ?? 'windows';
}

function resolveTargetVersion(
  meta: AppMetaFile,
  target: InstallTarget,
  installed: InstalledRecord | null,
): VersionResolution {
  if (target.version !== undefined) {
    assertValidVersion(target.version);
    const entry = meta.versions.find((item) => item.version === target.version);
    if (!entry) throw new AppError('NOT_FOUND', `版本 ${target.version} 不存在（App ${meta.appId}）`);
    if (target.platform && entry.platform !== target.platform) {
      throw new AppError(
        'VALIDATION',
        `版本 ${entry.version} 属于平台 ${entry.platform}，与请求的平台 ${target.platform} 不一致`,
      );
    }
    return { entry, platform: entry.platform };
  }
  const platform = target.platform ?? installed?.platform ?? pickDefaultPlatform(meta);
  const version = meta.latest[platform];
  if (!version) {
    throw new AppError('NOT_FOUND', `App ${meta.appId} 没有适用于平台 ${platform} 的版本`);
  }
  const entry =
    meta.versions.find((item) => item.version === version && item.platform === platform) ??
    meta.versions.find((item) => item.version === version);
  if (!entry) {
    throw new AppError('STATE', `app.meta.json 的 latest[${platform}] 指向不存在的版本：${version}`);
  }
  return { entry, platform: entry.platform };
}

export class LibraryServiceImpl implements LibraryService {
  constructor(private readonly deps: LibraryServiceDeps) {}

  // -------------------------------------------------------------------------
  // 列表
  // -------------------------------------------------------------------------

  async list(): Promise<InstalledAppInfo[]> {
    await this.deps.ready;
    const records = await this.deps.state.listLibraryRecords();
    const infos: InstalledAppInfo[] = [];
    for (const record of records) {
      infos.push(await this.buildInfoFromIndex(record));
    }
    return infos.sort(
      (a, b) => a.displayName.localeCompare(b.displayName) || a.appId.localeCompare(b.appId),
    );
  }

  // -------------------------------------------------------------------------
  // 更新检测
  // -------------------------------------------------------------------------

  async checkUpdates(options?: { channelId?: string }): Promise<UpdateCheckItem[]> {
    await this.deps.ready;
    const channelRecords = await this.deps.state.listChannelRecords();
    const installed = await this.deps.state.listLibraryRecords();
    const items: UpdateCheckItem[] = [];
    for (const record of channelRecords) {
      if (options?.channelId && record.channelId !== options.channelId) continue;
      let channel: ChannelFile | null = null;
      try {
        channel = await this.deps.channels.refreshRecord(record);
      } catch (error) {
        this.deps.logger?.warn('检查更新时刷新频道失败，使用本地缓存', {
          channelId: record.channelId,
          reason: AppError.from(error).message,
        });
        channel = await this.deps.state.readChannelCache(record.channelId);
      }
      if (!channel) continue;
      const channelInstalled = installed.filter((item) => item.channelId === record.channelId);
      for (const local of channelInstalled) {
        const appRef = channel.apps.find((app) => app.appId === local.appId);
        const latestVersion = appRef?.latest[local.platform] ?? local.version;
        const updateAvailable =
          latestVersion !== local.version && compareVersionsLenient(latestVersion, local.version) > 0;
        items.push({
          channelId: record.channelId,
          channelName: channel.name,
          appId: local.appId,
          displayName: local.displayName,
          currentVersion: local.version,
          latestVersion,
          platform: local.platform,
          updateAvailable,
        });
      }
    }
    return items;
  }

  // -------------------------------------------------------------------------
  // 安装 / 更新
  // -------------------------------------------------------------------------

  async install(target: InstallTarget): Promise<InstallResult> {
    await this.deps.ready;
    const record = await this.deps.channels.requireRecord(target.channelId);
    return this.deps.mutex.runExclusive(`install:${target.channelId}:${target.appId}`, () =>
      this.doInstall(record, target, false),
    );
  }

  async update(target: InstallTarget): Promise<InstallResult> {
    await this.deps.ready;
    const record = await this.deps.channels.requireRecord(target.channelId);
    return this.deps.mutex.runExclusive(`install:${target.channelId}:${target.appId}`, () =>
      this.doInstall(record, target, true),
    );
  }

  private async doInstall(
    initialRecord: import('./types').ChannelRecord,
    target: InstallTarget,
    requireInstalled: boolean,
  ): Promise<InstallResult> {
    const progress = createProgressEmitter(target.onProgress);
    progress({ phase: 'prepare', message: '正在准备安装…' });
    const access = await this.deps.channels.openAccess(initialRecord);
    const operationId = uniqueSuffix();
    let operationDir: string | undefined;
    try {
      // 1) 刷新频道元信息（失败容忍：使用缓存）
      progress({ phase: 'fetch', message: '正在获取频道信息…' });
      let record = initialRecord;
      try {
        const channel = await access.readChannelRemote();
        record = await this.deps.channels.storeChannelSnapshot(initialRecord, channel);
      } catch (error) {
        const cached = await this.deps.state.readChannelCache(initialRecord.channelId);
        if (!cached) throw AppError.from(error);
        this.deps.logger?.warn('安装时刷新频道失败，继续使用本地缓存', {
          channelId: initialRecord.channelId,
          reason: AppError.from(error).message,
        });
      }
      // 2) 获取 App 元信息并解析目标版本
      const { meta, metaUrl } = await access.readAppMeta(target.appId);
      let installed: InstalledRecord | null = null;
      try {
        installed = await this.deps.state.getInstallFile(target.channelId, target.appId);
      } catch (error) {
        if (error instanceof AppError && error.code === 'STATE') {
          this.deps.logger?.warn('本地安装状态损坏，按全新安装处理', {
            channelId: target.channelId,
            appId: target.appId,
            reason: error.message,
          });
          installed = null;
        } else {
          throw AppError.from(error);
        }
      }
      if (requireInstalled && !installed) {
        throw new AppError('NOT_FOUND', `App 尚未安装，无法更新：${target.appId}`);
      }
      const resolution = resolveTargetVersion(meta, target, installed);
      const versionEntry = resolution.entry;
      const platform = resolution.platform;
      const versionDir = this.deps.state.versionDir(target.channelId, target.appId, versionEntry.version);
      const existingDirAvailable = installed
        ? await pathExists(
            this.deps.state.versionDir(target.channelId, target.appId, installed.version),
          )
        : false;
      if (
        installed &&
        installed.version === versionEntry.version &&
        installed.platform === platform &&
        !target.force &&
        existingDirAvailable &&
        isSameFileList(installed.files, versionEntry.files)
      ) {
        progress({ phase: 'verify', message: `已是最新版本：${versionEntry.version}` });
        return {
          app: await this.buildInfoFromInstall(installed),
          downloadedBytes: 0,
          reusedBytes: 0,
        };
      }

      // 3) 准备 staging 目录
      operationDir = await this.deps.state.ensureOperationDir(operationId);
      const stagingDir = path.join(operationDir, 'staging');
      await ensureDir(stagingDir);
      const oldVersionDir = installed
        ? this.deps.state.versionDir(target.channelId, target.appId, installed.version)
        : undefined;
      let reusedBytes = 0;
      let downloadedBytes = 0;

      if (versionEntry.publishMode === 'files') {
        const plan = await this.planFiles(
          versionEntry.files,
          installed?.files ?? [],
          oldVersionDir,
        );
        reusedBytes = plan
          .filter((item) => item.action === 'reuse')
          .reduce((sum, item) => sum + item.file.size, 0);
        const totalBytes = versionEntry.totalSize;
        let transferred = reusedBytes;
        for (let index = 0; index < plan.length; index += 1) {
          const item = plan[index]!;
          const destination = safeJoin(stagingDir, item.file.path, '版本文件路径');
          await ensureDir(path.dirname(destination));
          if (item.action === 'reuse' && item.oldPath) {
            await copyFileEnsured(item.oldPath, destination);
            if (item.file.executable) await fs.chmod(destination, 0o755).catch(() => undefined);
            progress({
              phase: 'transfer',
              message: `复用已存在文件：${item.file.path}`,
              currentFile: item.file.path,
              index: index + 1,
              count: plan.length,
              transferredBytes: Math.min(transferred, totalBytes),
              totalBytes,
              percent: progressPercent(transferred, totalBytes),
            });
            continue;
          }
          const download = await access.fileDownload(
            target.appId,
            versionEntry,
            item.file.path,
            metaUrl,
          );
          progress({
            phase: 'transfer',
            message: `正在下载：${item.file.path}`,
            currentFile: item.file.path,
            index: index + 1,
            count: plan.length,
            transferredBytes: Math.min(transferred, totalBytes),
            totalBytes,
            percent: progressPercent(transferred, totalBytes),
          });
          const base = transferred;
          const result = await this.deps.http.downloadToFile(download.url, destination, {
            headers: download.headers,
            expectedSize: item.file.size,
            onProgress: (bytes) => {
              const current = base + bytes;
              progress({
                phase: 'transfer',
                message: `正在下载：${item.file.path}`,
                currentFile: item.file.path,
                index: index + 1,
                count: plan.length,
                transferredBytes: current,
                totalBytes,
                percent: progressPercent(current, totalBytes),
              });
            },
          });
          if (result.size !== item.file.size || result.md5 !== item.file.md5) {
            throw new AppError(
              'IO',
              `文件校验失败：${item.file.path}（预期 ${item.file.size} 字节/${item.file.md5}，实际 ${result.size} 字节/${result.md5}）`,
            );
          }
          downloadedBytes += result.size;
          transferred += result.size;
          if (item.file.executable) {
            await fs.chmod(destination, 0o755).catch(() => undefined);
          }
        }
      } else {
        const archive = versionEntry.archive;
        if (!archive) {
          throw new AppError('STATE', `版本 ${versionEntry.version} 为 zip 发布方式但缺少 archive 信息`);
        }
        const download = await access.archiveDownload(target.appId, versionEntry, metaUrl);
        const archivePath = path.join(operationDir, 'archive.zip');
        progress({
          phase: 'transfer',
          message: `正在下载压缩包：${archive.url}`,
          currentFile: archive.url,
          index: 1,
          count: 1,
          transferredBytes: 0,
          totalBytes: archive.size,
          percent: 0,
        });
        const result = await this.deps.http.downloadToFile(download.url, archivePath, {
          headers: download.headers,
          expectedSize: archive.size,
          onProgress: (bytes) => {
            progress({
              phase: 'transfer',
              message: '正在下载压缩包…',
              currentFile: archive.url,
              index: 1,
              count: 1,
              transferredBytes: bytes,
              totalBytes: archive.size,
              percent: progressPercent(bytes, archive.size),
            });
          },
        });
        if (result.size !== archive.size || result.md5 !== archive.md5) {
          throw new AppError(
            'IO',
            `压缩包校验失败（预期 ${archive.size} 字节/${archive.md5}，实际 ${result.size} 字节/${result.md5}）`,
          );
        }
        downloadedBytes += result.size;
        progress({ phase: 'extract', message: '正在解压压缩包…' });
        await extractZipArchive(archivePath, stagingDir, versionEntry.files, {
          onProgress: ({ path: filePath, index, count, extractedBytes: bytes }) => {
            progress({
              phase: 'extract',
              message: `正在解压：${filePath}`,
              currentFile: filePath,
              index,
              count,
              transferredBytes: bytes,
              totalBytes: versionEntry.totalSize,
              percent: progressPercent(index, count),
            });
          },
        });
      }

      // 4) 逐文件校验 staging
      progress({ phase: 'verify', message: '正在校验安装文件…' });
      await this.verifyStaging(stagingDir, versionEntry.files, progress);

      // 5) 提交：rename 切换版本目录 + 原子写 install.json
      progress({ phase: 'commit', message: '正在切换版本…' });
      await ensureDir(this.deps.state.versionsDir(target.channelId, target.appId));
      let backupDir: string | undefined;
      if (await pathExists(versionDir)) {
        backupDir = `${versionDir}.bak-${operationId}`;
        await fs.rename(versionDir, backupDir);
      }
      let committed = false;
      try {
        await fs.rename(stagingDir, versionDir);
        committed = true;
      } catch (error) {
        if (backupDir) {
          await fs.rename(backupDir, versionDir).catch(() => undefined);
        }
        throw AppError.from(error, 'IO');
      }
      const nowIso = this.deps.clock.now().toISOString();
      const installRecord: InstalledRecord = {
        schemaVersion: 1,
        kind: 'apphub-install',
        channelId: target.channelId,
        channelName: record.channelName,
        appId: target.appId,
        displayName: meta.displayName,
        version: versionEntry.version,
        platform,
        publishMode: versionEntry.publishMode,
        entry: versionEntry.entry,
        installedAt: installed?.installedAt ?? nowIso,
        updatedAt: nowIso,
        fileCount: versionEntry.fileCount,
        totalSize: versionEntry.totalSize,
        files: versionEntry.files,
        archive: versionEntry.archive ?? null,
      };
      try {
        await this.deps.state.writeInstallFile(installRecord);
      } catch (error) {
        // 指针写入失败：撤销新版本目录，恢复备份，保证旧版本可用
        if (committed) await removePath(versionDir).catch(() => undefined);
        if (backupDir) await fs.rename(backupDir, versionDir).catch(() => undefined);
        throw AppError.from(error);
      }
      if (backupDir) await removePath(backupDir).catch(() => undefined);
      await this.deps.state.upsertLibraryRecord(this.toIndexEntry(installRecord));
      progress({ phase: 'cleanup', message: '正在清理旧版本…' });
      await this.cleanupOldVersions(
        target.channelId,
        target.appId,
        versionEntry.version,
        progress,
      );
      progress({ phase: 'cleanup', message: '安装完成' });
      const app = await this.buildInfoFromInstall(installRecord);
      const result: InstallResult = {
        app,
        downloadedBytes,
        reusedBytes,
      };
      if (installed && installed.version !== versionEntry.version) {
        result.updatedFrom = installed.version;
      }
      this.deps.logger?.info('安装完成', {
        channelId: target.channelId,
        appId: target.appId,
        version: versionEntry.version,
        downloadedBytes,
        reusedBytes,
      });
      return result;
    } finally {
      await access.close();
      if (operationDir) {
        await this.deps.state.cleanupOperationDir(operationId).catch((error: unknown) => {
          this.deps.logger?.warn('清理安装临时目录失败', { reason: AppError.from(error).message });
        });
      }
    }
  }

  /** files 模式：决定每个目标文件是复用旧版本还是下载。 */
  private async planFiles(
    targetFiles: readonly FileEntry[],
    oldFiles: readonly FileEntry[],
    oldVersionDir: string | undefined,
  ): Promise<FilePlan[]> {
    const oldByPath = new Map(oldFiles.map((file) => [file.path, file]));
    const plan: FilePlan[] = [];
    for (const file of targetFiles) {
      const old = oldByPath.get(file.path);
      if (!old || !oldVersionDir || old.md5.toLowerCase() !== file.md5.toLowerCase() || old.size !== file.size) {
        plan.push({ file, action: 'download' });
        continue;
      }
      let oldPath: string;
      try {
        oldPath = safeJoin(oldVersionDir, file.path, '旧版本文件路径');
      } catch {
        plan.push({ file, action: 'download' });
        continue;
      }
      const stat = await statOrNull(oldPath);
      if (stat?.isFile() && stat.size === file.size) {
        // 复用前校验旧文件真实 MD5：旧版本被外部破坏时退回下载，避免安装必然失败
        try {
          const oldHash = await hashFile(oldPath);
          if (oldHash.md5 === file.md5) {
            plan.push({ file, action: 'reuse', oldPath });
            continue;
          }
        } catch {
          // 读取失败按需要下载处理
        }
      }
      plan.push({ file, action: 'download' });
    }
    // 旧版本里多余的文件不会进入新版本（保持版本目录干净）
    return plan;
  }

  /** 校验 staging 中的文件集合、大小与 MD5。 */
  private async verifyStaging(
    stagingDir: string,
    expectedFiles: readonly FileEntry[],
    progress: ReturnType<typeof createProgressEmitter>,
  ): Promise<void> {
    const actual = await walkFiles(stagingDir);
    const expectedPaths = new Set(expectedFiles.map((file) => file.path));
    for (const actualPath of actual) {
      if (!expectedPaths.has(actualPath)) {
        throw new AppError('IO', `安装文件包含未登记的文件：${actualPath}`);
      }
    }
    for (let index = 0; index < expectedFiles.length; index += 1) {
      const file = expectedFiles[index]!;
      const target = safeJoin(stagingDir, file.path, '安装文件路径');
      const stat = await statOrNull(target);
      if (!stat || !stat.isFile()) {
        throw new AppError('IO', `安装文件缺失：${file.path}`);
      }
      const hash = await hashFile(target);
      if (hash.size !== file.size || hash.md5 !== file.md5) {
        throw new AppError(
          'IO',
          `安装文件校验失败：${file.path}（预期 ${file.size}/${file.md5}，实际 ${hash.size}/${hash.md5}）`,
        );
      }
      progress({
        phase: 'verify',
        message: `正在校验：${file.path}`,
        currentFile: file.path,
        index: index + 1,
        count: expectedFiles.length,
        percent: progressPercent(index + 1, expectedFiles.length),
      });
    }
  }

  /** 保留最近 keepVersions 个版本，删除其余版本目录。 */
  private async cleanupOldVersions(
    channelId: string,
    appId: string,
    currentVersion: string,
    progress: ReturnType<typeof createProgressEmitter>,
  ): Promise<void> {
    const versionsDir = this.deps.state.versionsDir(channelId, appId);
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(versionsDir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw AppError.from(error, 'IO');
    }
    const keepCount = Math.max(1, Math.floor(this.deps.keepVersions) || 1);
    const versionNames = entries
      .filter((entry) => entry.isDirectory() && !entry.name.includes('.bak-') && isValidVersion(entry.name))
      .map((entry) => entry.name);
    const keep = new Set(sortVersionsDesc(versionNames).slice(0, keepCount));
    keep.add(currentVersion);
    for (const name of versionNames) {
      if (keep.has(name)) continue;
      await removePath(path.join(versionsDir, name));
      progress({ phase: 'cleanup', message: `已清理旧版本：${name}`, currentFile: name });
    }
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.includes('.bak-')) {
        await removePath(path.join(versionsDir, entry.name)).catch(() => undefined);
      }
    }
  }

  // -------------------------------------------------------------------------
  // 校验 / 卸载 / 启动
  // -------------------------------------------------------------------------

  async verify(channelId: string, appId: string): Promise<VerifyResult> {
    await this.deps.ready;
    const install = await this.deps.state.getInstallFile(channelId, appId);
    if (!install) throw new AppError('NOT_FOUND', `App 尚未安装：${appId}`);
    const versionDir = this.deps.state.versionDir(channelId, appId, install.version);
    const mismatches: VerifyResult['mismatches'] = [];
    const dirAvailable = await pathExists(versionDir);
    for (const file of install.files) {
      const target = safeJoin(versionDir, file.path, '版本文件路径');
      const stat = dirAvailable ? await statOrNull(target) : null;
      if (!stat || !stat.isFile()) {
        mismatches.push({ path: file.path, reason: 'missing', expectedMd5: file.md5 });
        continue;
      }
      if (stat.size !== file.size) {
        mismatches.push({ path: file.path, reason: 'size', expectedMd5: file.md5 });
        continue;
      }
      const hash = await hashFile(target);
      if (hash.md5 !== file.md5) {
        mismatches.push({
          path: file.path,
          reason: 'md5',
          expectedMd5: file.md5,
          actualMd5: hash.md5,
        });
      }
    }
    if (dirAvailable) {
      const actualFiles = await walkFiles(versionDir);
      const expected = new Set(install.files.map((file) => file.path));
      for (const actualPath of actualFiles) {
        if (!expected.has(actualPath)) mismatches.push({ path: actualPath, reason: 'extra' });
      }
    }
    return {
      ok: mismatches.length === 0,
      checkedFiles: install.files.length,
      mismatches,
    };
  }

  async uninstall(channelId: string, appId: string): Promise<void> {
    await this.deps.ready;
    const appRoot = this.deps.state.appRoot(channelId, appId);
    if (!(await pathExists(appRoot))) {
      throw new AppError('NOT_FOUND', `App 尚未安装：${appId}`);
    }
    await this.deps.state.removeAppDir(channelId, appId);
    await this.deps.state.removeLibraryRecord(channelId, appId);
    this.deps.logger?.info('已卸载 App', { channelId, appId });
  }

  async getLaunchDescriptor(channelId: string, appId: string): Promise<LaunchDescriptor> {
    await this.deps.ready;
    const install = await this.deps.state.getInstallFile(channelId, appId);
    if (!install) throw new AppError('NOT_FOUND', `App 尚未安装：${appId}`);
    if (!isValidVersion(install.version)) {
      throw new AppError('STATE', `安装记录中的版本号非法：${install.version}`);
    }
    const appRoot = this.deps.state.appRoot(channelId, appId);
    const versionDir = this.deps.state.versionDir(channelId, appId, install.version);
    const entryPath = safeJoin(versionDir, install.entry, '启动入口');
    const stat = await statOrNull(entryPath);
    if (!stat || !stat.isFile()) {
      throw new AppError('NOT_FOUND', `启动入口文件不存在：${install.entry}`);
    }
    // 符号链接逃逸防护：realpath 必须仍在版本目录内
    let realVersionDir = versionDir;
    let realEntryPath = entryPath;
    try {
      realVersionDir = await fs.realpath(versionDir);
      realEntryPath = await fs.realpath(entryPath);
    } catch (error) {
      throw AppError.from(error, 'IO');
    }
    if (
      realEntryPath !== realVersionDir &&
      !realEntryPath.startsWith(`${realVersionDir}${path.sep}`)
    ) {
      throw new AppError('SECURITY', '启动入口越出版本目录');
    }
    // 注意：返回构造出的原始路径（而不是 fs.realpath 结果）。realpath 只用于
    // 符号链接逃逸校验；在 Windows 上 realpath 可能返回 8.3 短路径
    // （如 C:\Users\RUNNER~1\...），直接返回会让安装路径/日志不稳定。
    return {
      appRoot,
      versionDir,
      entryPath,
      cwd: versionDir,
      args: [],
    };
  }

  // -------------------------------------------------------------------------
  // 内部辅助
  // -------------------------------------------------------------------------

  private toIndexEntry(record: InstalledRecord): LibraryIndexEntry {
    return {
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
    };
  }

  private async buildInfoFromIndex(record: LibraryIndexEntry): Promise<InstalledAppInfo> {
    const versionDir = this.deps.state.versionDir(record.channelId, record.appId, record.version);
    const installed = (await pathExists(versionDir)) && (await pathExists(this.deps.state.installFile(record.channelId, record.appId)));
    return {
      channelId: record.channelId,
      channelName: record.channelName,
      appId: record.appId,
      displayName: record.displayName,
      version: record.version,
      platform: record.platform,
      publishMode: record.publishMode,
      entry: record.entry,
      appRoot: this.deps.state.appRoot(record.channelId, record.appId),
      installPath: versionDir,
      installedAt: record.installedAt,
      updatedAt: record.updatedAt,
      fileCount: record.fileCount,
      totalSize: record.totalSize,
      status: installed ? 'installed' : 'broken',
    };
  }

  private async buildInfoFromInstall(record: InstalledRecord): Promise<InstalledAppInfo> {
    const versionDir = this.deps.state.versionDir(record.channelId, record.appId, record.version);
    const installed = await pathExists(versionDir);
    return {
      channelId: record.channelId,
      channelName: record.channelName,
      appId: record.appId,
      displayName: record.displayName,
      version: record.version,
      platform: record.platform,
      publishMode: record.publishMode,
      entry: record.entry,
      appRoot: this.deps.state.appRoot(record.channelId, record.appId),
      installPath: versionDir,
      installedAt: record.installedAt,
      updatedAt: record.updatedAt,
      fileCount: record.fileCount,
      totalSize: record.totalSize,
      status: installed ? 'installed' : 'broken',
    };
  }
}
