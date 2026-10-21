import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { AppError, normalizeRelativePath, randomHex } from '@apphub/protocol';

/**
 * 本地文件系统工具。
 *
 * 所有写入都采用"临时文件 + rename"的原子方式；所有"由远端数据推导出的本地路径"
 * 必须经过 safeJoin，确保不会逃出 dataDir。
 */

/** 原子写入任意内容（tmp + rename）。 */
export async function writeFileAtomic(filePath: string, data: string | Uint8Array): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${randomHex(4)}.tmp`);
  try {
    await fs.writeFile(tmpPath, data);
    await fs.rename(tmpPath, filePath);
  } catch (error) {
    await removePath(tmpPath);
    throw AppError.from(error, 'IO');
  }
}

/** 原子写入 JSON（2 空格缩进 + 结尾换行）。 */
export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  let text: string;
  try {
    text = `${JSON.stringify(value, null, 2)}\n`;
  } catch (error) {
    throw new AppError('INTERNAL', `JSON 序列化失败：${AppError.from(error).message}`);
  }
  await writeFileAtomic(filePath, text);
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    ((error as NodeJS.ErrnoException).code === 'ENOENT' ||
      (error as NodeJS.ErrnoException).code === 'ENOTDIR')
  );
}

/** 读取并解析 JSON；文件不存在返回 null；内容损坏抛 STATE。 */
export async function readJsonFile<T = unknown>(filePath: string, label: string): Promise<T | null> {
  let text: string;
  try {
    text = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw AppError.from(error, 'IO');
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new AppError('STATE', `${label} 已损坏（不是合法 JSON）：${AppError.from(error).message}`);
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new AppError('STATE', `${label} 已损坏（顶层必须是对象）`);
  }
  return data as T;
}

/** 读取文本；文件不存在返回 null。 */
export async function readTextFileOrNull(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw AppError.from(error, 'IO');
  }
}

/** 文件是否存在。 */
export async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

/** stat，不存在返回 null。 */
export async function statOrNull(target: string): Promise<import('node:fs').Stats | null> {
  try {
    return await fs.stat(target);
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw AppError.from(error, 'IO');
  }
}

/** 递归删除，忽略不存在。 */
export async function removePath(target: string): Promise<void> {
  try {
    await fs.rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
  } catch (error) {
    if (isNotFoundError(error)) return;
    throw AppError.from(error, 'IO');
  }
}

/** 创建目录（递归）。 */
export async function ensureDir(dir: string): Promise<void> {
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch (error) {
    throw AppError.from(error, 'IO');
  }
}

/**
 * 将相对路径安全地拼接到根目录下。
 * 任何绝对路径、`..`、Windows 保留名或越界结果都会抛 SECURITY/VALIDATION。
 */
export function safeJoin(rootDir: string, relativePath: string, label = '路径'): string {
  const normalized = normalizeRelativePath(relativePath, label);
  const root = path.resolve(rootDir);
  const target = path.resolve(root, ...normalized.split('/'));
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new AppError('SECURITY', `${label}逃逸出允许的目录：${relativePath}`);
  }
  return target;
}

/** 本地绝对路径转 POSIX 相对路径。 */
export function toPosixPath(target: string): string {
  return target.split(path.sep).join('/');
}

/** 确保父目录存在后复制文件。 */
export async function copyFileEnsured(source: string, target: string): Promise<void> {
  await ensureDir(path.dirname(target));
  try {
    await fs.copyFile(source, target);
  } catch (error) {
    throw AppError.from(error, 'IO');
  }
}

export interface FileHash {
  size: number;
  md5: string;
}

/** 流式计算文件 size + MD5（大文件不会整体读入内存）。 */
export async function hashFile(filePath: string): Promise<FileHash> {
  const hash = createHash('md5');
  let size = 0;
  const stream = createReadStream(filePath);
  try {
    for await (const chunk of stream) {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      size += buffer.length;
      hash.update(buffer);
    }
  } catch (error) {
    stream.destroy();
    throw AppError.from(error, 'IO');
  }
  return { size, md5: hash.digest('hex') };
}

/** 读取文件 Buffer，并把 ENOENT 映射成 NOT_FOUND。 */
export async function readFileBuffer(filePath: string, label = '文件'): Promise<Buffer> {
  try {
    return await fs.readFile(filePath);
  } catch (error) {
    if (isNotFoundError(error)) throw new AppError('NOT_FOUND', `${label}不存在：${filePath}`);
    throw AppError.from(error, 'IO');
  }
}

export interface WalkFilesOptions {
  /** true 时遇到符号链接直接抛 SECURITY（打包目录时使用）。 */
  rejectSymlinks?: boolean;
  /** 相对路径前缀（默认空）。 */
  prefix?: string;
}

/** 递归列出目录下所有文件（POSIX 相对路径，排序稳定）。 */
export async function walkFiles(rootDir: string, options: WalkFilesOptions = {}): Promise<string[]> {
  const out: string[] = [];
  const root = path.resolve(rootDir);
  async function walk(dir: string, prefix: string): Promise<void> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      throw AppError.from(error, 'IO');
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(dir, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        if (options.rejectSymlinks) {
          throw new AppError('SECURITY', `不支持符号链接：${relative}`);
        }
        out.push(relative);
      } else if (entry.isDirectory()) {
        await walk(absolute, relative);
      } else if (entry.isFile()) {
        out.push(relative);
      }
    }
  }
  await walk(root, options.prefix ?? '');
  return out.sort((a, b) => a.localeCompare(b));
}

/** 计算进度百分比（0-100，无法估算时返回 undefined）。 */
export function progressPercent(transferred: number, total: number | undefined): number | undefined {
  if (total === undefined || !Number.isFinite(total) || total <= 0) return undefined;
  const percent = Math.round((transferred / total) * 100);
  return Math.max(0, Math.min(100, percent));
}

/** 生成一个进程内唯一后缀，用于临时目录名。 */
export function uniqueSuffix(): string {
  return `${process.pid}-${Date.now().toString(36)}-${randomHex(4)}`;
}

/** 文件扩展名（小写，含点）；无扩展名返回空串。 */
export function lowerExtension(target: string): string {
  return path.extname(target).toLowerCase();
}
