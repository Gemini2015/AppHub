import archiver from 'archiver';
import { createHash } from 'node:crypto';
import { createWriteStream, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import yauzl from 'yauzl';
import { AppError, LIMITS, normalizeRelativePath } from '@apphub/protocol';
import type { FileEntry } from '@apphub/protocol';
import { ensureDir, hashFile, lowerExtension, safeJoin, walkFiles } from './fs';

/**
 * ZIP 工具：检查、打包、安全解压。
 *
 * 安全约束（对应 docs/PROTOCOL.md §7.2 / ARCHITECTURE §4.3）：
 *  - 拒绝 zip-slip（绝对路径、`..`、盘符、Windows 保留名、空字节）；
 *  - 拒绝符号链接、加密条目、不支持的压缩算法、重复路径；
 *  - 限制条目数量与解压后总大小（zip bomb 防护）；
 *  - 解压/校验都逐文件执行 size+MD5 校验。
 *
 * `inspectZipArchive` / `createZipFromDirectory` 是导出给 Electron 主进程使用的纯函数工具，
 * 不依赖 AppHubCore 实例或 CoreContext。
 */

export interface ZipEntryInfo {
  path: string;
  size: number;
}

export interface ZipArchiveInspection {
  files: ZipEntryInfo[];
  suggestedEntry: string | null;
}

export interface CreatedZip {
  zipPath: string;
  cleanup(): Promise<void>;
}

export interface ZipHashResult {
  files: FileEntry[];
  archiveSize: number;
  archiveMd5: string;
}

/** 常见可执行入口扩展名（推荐入口时优先）。 */
const ENTRY_EXTENSIONS = ['.exe', '.cmd', '.bat', '.sh', '.app', '.com', '.bin'];

const UNIX_FILE_TYPE_MASK = 0o170000;
const UNIX_SYMLINK_TYPE = 0o120000;

function isDirectoryEntry(entry: yauzl.Entry): boolean {
  return entry.fileName.endsWith('/');
}

/** 从 externalFileAttributes 读取 unix mode（Windows 打包的 zip 高 16 位通常为 0）。 */
function unixMode(entry: yauzl.Entry): number {
  return (entry.externalFileAttributes >>> 16) & 0xffff;
}

function isSymlinkEntry(entry: yauzl.Entry): boolean {
  const mode = unixMode(entry);
  return mode !== 0 && (mode & UNIX_FILE_TYPE_MASK) === UNIX_SYMLINK_TYPE;
}

function isExecutableEntry(entry: yauzl.Entry, entryPath: string): boolean {
  const mode = unixMode(entry);
  if (mode !== 0 && (mode & 0o111) !== 0) return true;
  return ENTRY_EXTENSIONS.includes(lowerExtension(entryPath));
}

/** 校验并归一化 zip 条目路径（目录条目调用前已排除）。 */
function normalizeEntryPath(fileName: string): string {
  try {
    return normalizeRelativePath(fileName, 'ZIP 内路径');
  } catch (error) {
    const appError = AppError.from(error);
    throw new AppError(
      appError.code === 'VALIDATION' ? 'VALIDATION' : 'SECURITY',
      `非法 ZIP 条目：${fileName}`,
    );
  }
}

async function openZipFile(zipPath: string): Promise<yauzl.ZipFile> {
  try {
    const stat = await fs.stat(zipPath);
    if (!stat.isFile()) {
      throw new AppError('VALIDATION', `不是普通文件：${zipPath}`);
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('NOT_FOUND', `ZIP 文件不存在或不可读：${zipPath}`);
  }
  try {
    return await yauzl.openPromise(zipPath, {
      lazyEntries: true,
      autoClose: true,
      decodeStrings: true,
      validateEntrySizes: true,
      // 不用 yauzl 的严格文件名校验：统一由 normalizeRelativePath 判定，
      // 以便把 zip-slip/保留名等归类为 SECURITY 错误（并给出可读信息）。
      strictFileNames: false,
    });
  } catch (error) {
    throw new AppError(
      'VALIDATION',
      `不是合法的 ZIP 文件：${path.basename(zipPath)}（${AppError.from(error).message}）`,
    );
  }
}

interface ZipLimitsCounter {
  fileCount: number;
  totalSize: number;
}

function assertZipLimits(counters: ZipLimitsCounter, entryName: string): void {
  if (counters.fileCount > LIMITS.fileCount) {
    throw new AppError('VALIDATION', `ZIP 内文件数量超过上限（${LIMITS.fileCount}）`, { entryName });
  }
  if (counters.totalSize > LIMITS.totalSize) {
    throw new AppError(
      'VALIDATION',
      `ZIP 解压后总大小超过上限（${LIMITS.totalSize} 字节）`,
      { entryName },
    );
  }
}

/** 校验单个条目并返回安全的归一化路径；目录条目返回 null。 */
function prepareEntry(
  entry: yauzl.Entry,
  seen: Set<string>,
  counters: ZipLimitsCounter,
): { entryPath: string; size: number } | null {
  if (isDirectoryEntry(entry)) return null;
  if (isSymlinkEntry(entry)) {
    throw new AppError('SECURITY', `ZIP 内不允许符号链接：${entry.fileName}`);
  }
  if (entry.isEncrypted()) {
    throw new AppError('UNSUPPORTED', `不支持加密的 ZIP 条目：${entry.fileName}`);
  }
  if (!entry.canDecodeFileData()) {
    throw new AppError('UNSUPPORTED', `ZIP 条目使用了不支持的压缩算法：${entry.fileName}`);
  }
  if (!Number.isFinite(entry.uncompressedSize) || entry.uncompressedSize < 0) {
    throw new AppError('VALIDATION', `ZIP 条目大小非法：${entry.fileName}`);
  }
  const entryPath = normalizeEntryPath(entry.fileName);
  if (seen.has(entryPath)) {
    throw new AppError('VALIDATION', `ZIP 内存在重复路径：${entryPath}`);
  }
  seen.add(entryPath);
  counters.fileCount += 1;
  counters.totalSize += entry.uncompressedSize;
  assertZipLimits(counters, entryPath);
  return { entryPath, size: entry.uncompressedSize };
}

/** 打开条目读取流。 */
function openEntryStream(
  zipFile: yauzl.ZipFile,
  entry: yauzl.Entry,
  label: string,
): Promise<Readable> {
  return new Promise<Readable>((resolve, reject) => {
    zipFile.openReadStream(entry, (error, stream) => {
      if (error) reject(new AppError('IO', `读取 ZIP 条目失败：${label}（${error.message}）`));
      else resolve(stream);
    });
  });
}

interface ZipEntryContext {
  zipFile: yauzl.ZipFile;
  entry: yauzl.Entry;
  entryPath: string;
  size: number;
  /** 文件条目序号（从 1 开始，不含目录）。 */
  index: number;
}

/** 把 yauzl 的条目校验错误映射为 SECURITY（zip-slip），其它读取错误映射为 VALIDATION。 */
function mapZipReadError(zipPath: string, error: unknown): AppError {
  if (error instanceof AppError) return error;
  const appError = AppError.from(error);
  if (
    /invalid relative path|absolute path|invalid characters in fileName|invalid date/i.test(
      appError.message,
    )
  ) {
    return new AppError(
      'SECURITY',
      `ZIP 包含非法路径（zip-slip）：${path.basename(zipPath)}（${appError.message}）`,
    );
  }
  return new AppError(
    'VALIDATION',
    `读取 ZIP 失败：${path.basename(zipPath)}（${appError.message}）`,
  );
}

/** 顺序遍历 zip 的文件条目，执行统一安全校验后交给回调处理。 */
async function withZipFileEntries<T>(
  zipPath: string,
  visitor: (context: ZipEntryContext) => Promise<T>,
): Promise<T[]> {
  const zipFile = await openZipFile(zipPath);
  const seen = new Set<string>();
  const counters: ZipLimitsCounter = { fileCount: 0, totalSize: 0 };
  const results: T[] = [];
  try {
    let index = 0;
    for await (const entry of zipFile.eachEntry()) {
      const prepared = prepareEntry(entry, seen, counters);
      if (!prepared) continue;
      index += 1;
      results.push(
        await visitor({
          zipFile,
          entry,
          entryPath: prepared.entryPath,
          size: prepared.size,
          index,
        }),
      );
    }
    if (counters.fileCount === 0) {
      throw new AppError('VALIDATION', 'ZIP 内没有任何文件');
    }
    return results;
  } catch (error) {
    throw mapZipReadError(zipPath, error);
  } finally {
    zipFile.close();
  }
}

/** 读取条目内容并计算 size+MD5（不落盘）。 */
async function hashEntryStream(
  zipFile: yauzl.ZipFile,
  entry: yauzl.Entry,
  entryPath: string,
): Promise<{ size: number; md5: string }> {
  const stream = await openEntryStream(zipFile, entry, entryPath);
  const hash = createHash('md5');
  let actual = 0;
  for await (const chunk of stream) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    actual += buffer.length;
    hash.update(buffer);
  }
  if (actual !== entry.uncompressedSize) {
    throw new AppError('IO', `ZIP 条目大小不一致：${entryPath}`);
  }
  return { size: actual, md5: hash.digest('hex') };
}

/** 推荐启动入口：优先常见可执行扩展名（层级越浅越优先），否则第一个文件。 */
export function suggestEntryFromFiles(files: readonly ZipEntryInfo[]): string | null {
  if (files.length === 0) return null;
  const candidates = files.filter((file) => ENTRY_EXTENSIONS.includes(lowerExtension(file.path)));
  if (candidates.length > 0) {
    const sorted = [...candidates].sort((a, b) => {
      const depthA = a.path.split('/').length;
      const depthB = b.path.split('/').length;
      if (depthA !== depthB) return depthA - depthB;
      return a.path.localeCompare(b.path);
    });
    return sorted[0]!.path;
  }
  return files[0]!.path;
}

/**
 * 安全检查 zip 并列出内部文件（不读取/解压数据，速度快）。
 * desktop 主进程用它校验用户选择的 zip 并推荐入口。
 */
export async function inspectZipArchive(zipPath: string): Promise<ZipArchiveInspection> {
  const files = await withZipFileEntries<ZipEntryInfo>(zipPath, async (context) => ({
    path: context.entryPath,
    size: context.size,
  }));
  return { files, suggestedEntry: suggestEntryFromFiles(files) };
}

/** 安全检查 zip 并计算每个内部文件的 size+MD5（按 path 排序，内容稳定）。 */
export async function hashZipEntries(zipPath: string): Promise<FileEntry[]> {
  const files = await withZipFileEntries<FileEntry>(zipPath, async (context) => {
    const { size, md5 } = await hashEntryStream(context.zipFile, context.entry, context.entryPath);
    const entry: FileEntry = { path: context.entryPath, size, md5 };
    if (isExecutableEntry(context.entry, context.entryPath)) entry.executable = true;
    return entry;
  });
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

/** 计算 zip 内文件的 size+MD5 以及压缩包自身 size+MD5（发布 zip 模式使用）。 */
export async function inspectZipArchiveWithHash(zipPath: string): Promise<ZipHashResult> {
  const files = await hashZipEntries(zipPath);
  const archive = await hashFile(zipPath);
  return { files, archiveSize: archive.size, archiveMd5: archive.md5 };
}

/**
 * 安全解压到目标目录，并逐文件校验 size+MD5。
 *
 * @param expectedFiles app.meta.json / files.json 中登记的完整文件清单
 */
export async function extractZipArchive(
  zipPath: string,
  destDir: string,
  expectedFiles: readonly FileEntry[],
  options: {
    onProgress?: (event: {
      path: string;
      index: number;
      count: number;
      extractedBytes: number;
    }) => void;
  } = {},
): Promise<{ files: FileEntry[] }> {
  const expected = new Map<string, FileEntry>();
  for (const file of expectedFiles) {
    expected.set(normalizeRelativePath(file.path, '文件清单路径'), file);
  }
  const destRoot = path.resolve(destDir);
  await ensureDir(destRoot);
  const extracted: FileEntry[] = [];
  const seen = new Set<string>();
  let extractedBytes = 0;
  let index = 0;
  const totalCount = expected.size;

  const zipFile = await openZipFile(zipPath);
  try {
    for await (const entry of zipFile.eachEntry()) {
      if (isDirectoryEntry(entry)) continue;
      if (isSymlinkEntry(entry)) {
        throw new AppError('SECURITY', `ZIP 内不允许符号链接：${entry.fileName}`);
      }
      if (entry.isEncrypted()) {
        throw new AppError('UNSUPPORTED', `不支持加密的 ZIP 条目：${entry.fileName}`);
      }
      if (!entry.canDecodeFileData()) {
        throw new AppError('UNSUPPORTED', `ZIP 条目使用了不支持的压缩算法：${entry.fileName}`);
      }
      const entryPath = normalizeEntryPath(entry.fileName);
      if (seen.has(entryPath)) {
        throw new AppError('VALIDATION', `ZIP 内存在重复路径：${entryPath}`);
      }
      seen.add(entryPath);
      const expectedFile = expected.get(entryPath);
      if (!expectedFile) {
        throw new AppError('IO', `ZIP 包含未登记的文件：${entryPath}`);
      }
      if (entry.uncompressedSize !== expectedFile.size) {
        throw new AppError(
          'IO',
          `ZIP 条目大小与文件清单不一致：${entryPath}（清单 ${expectedFile.size}，压缩包 ${entry.uncompressedSize}）`,
        );
      }
      const targetPath = safeJoin(destRoot, entryPath, 'ZIP 条目路径');
      await ensureDir(path.dirname(targetPath));
      const hash = createHash('md5');
      const stream = await openEntryStream(zipFile, entry, entryPath);
      let actual = 0;
      await new Promise<void>((resolve, reject) => {
        const out = createWriteStream(targetPath);
        let dataEnded = false;
        const fail = (error: unknown): void => {
          stream.unpipe(out);
          out.destroy();
          reject(AppError.from(error, 'IO'));
        };
        out.on('error', fail);
        stream.on('error', fail);
        stream.on('data', (chunk: Buffer | string) => {
          const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
          actual += buffer.length;
          hash.update(buffer);
        });
        stream.on('end', () => {
          dataEnded = true;
          out.end();
        });
        out.on('close', () => {
          if (dataEnded) resolve();
        });
        stream.pipe(out);
      });
      if (actual !== expectedFile.size) {
        throw new AppError(
          'IO',
          `解压后大小不一致：${entryPath}（预期 ${expectedFile.size}，实际 ${actual}）`,
        );
      }
      const md5 = hash.digest('hex');
      if (md5 !== expectedFile.md5) {
        throw new AppError(
          'IO',
          `解压后 MD5 不一致：${entryPath}（预期 ${expectedFile.md5}，实际 ${md5}）`,
        );
      }
      if (expectedFile.executable) {
        await fs.chmod(targetPath, 0o755).catch(() => undefined);
      }
      extractedBytes += actual;
      index += 1;
      options.onProgress?.({ path: entryPath, index, count: totalCount, extractedBytes });
      extracted.push({ ...expectedFile, path: entryPath });
    }
    for (const expectedPath of expected.keys()) {
      if (!seen.has(expectedPath)) {
        throw new AppError('IO', `压缩包缺少文件：${expectedPath}`);
      }
    }
    return { files: extracted };
  } catch (error) {
    throw mapZipReadError(zipPath, error);
  } finally {
    zipFile.close();
  }
}

/**
 * 把本地目录打包为临时 zip（发布 zipFromDir 使用；亦供 desktop 测试）。
 * 调用方负责调用 cleanup()；符号链接会被拒绝。
 */
export async function createZipFromDirectory(dirPath: string): Promise<CreatedZip> {
  const sourceDir = path.resolve(dirPath);
  let stat: import('node:fs').Stats;
  try {
    stat = await fs.stat(sourceDir);
  } catch {
    throw new AppError('NOT_FOUND', `目录不存在：${dirPath}`);
  }
  if (!stat.isDirectory()) {
    throw new AppError('VALIDATION', `不是目录：${dirPath}`);
  }
  const relativeFiles = await walkFiles(sourceDir, { rejectSymlinks: true });
  if (relativeFiles.length === 0) {
    throw new AppError('VALIDATION', '待打包的目录为空');
  }
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'apphub-zip-'));
  const zipPath = path.join(tempDir, 'archive.zip');
  try {
    const output = createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 6 } });
    const finished = new Promise<void>((resolve, reject) => {
      output.on('close', resolve);
      output.on('error', reject);
      archive.on('error', reject);
      archive.on('warning', (error) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') reject(error);
      });
    });
    archive.pipe(output);
    for (const relativePath of relativeFiles) {
      const absolute = safeJoin(sourceDir, relativePath, '待打包文件路径');
      const fileStat = await fs.stat(absolute);
      if (!fileStat.isFile()) continue;
      archive.file(absolute, { name: relativePath, stats: fileStat });
    }
    await archive.finalize();
    await finished;
  } catch (error) {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    throw AppError.from(error, 'IO');
  }
  let cleaned = false;
  return {
    zipPath,
    cleanup: async () => {
      if (cleaned) return;
      cleaned = true;
      await fs
        .rm(tempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 })
        .catch(() => undefined);
    },
  };
}
