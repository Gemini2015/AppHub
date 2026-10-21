import { promises as fs } from 'node:fs';
import path from 'node:path';
import { AppError, appendUrl } from '@apphub/protocol';
import type { LocalStorageConfig } from '@apphub/protocol';
import { assertStorageKey } from '../memory';
import type {
  StorageAdapter,
  StorageAdapterProvider,
  StorageEntry,
  StorageStat,
  StorageWriteOptions,
} from '../types';
import { errnoOf, mapFsError, normalizeListPrefix } from './common';

/**
 * 本地目录存储适配器（发布目标 = 某个本地目录，读取走 nginx / 任意静态服务器）。
 *
 * - `rootDir`：写入的本地根目录（probe 时自动创建）；
 * - `publicBaseUrl`：该目录对外暴露的 HTTP 根地址，用于 getDownloadUrl；
 * - 所有 key 都必须是安全的相对 POSIX 路径，且解析后的绝对路径必须仍在 rootDir 内
 *   （即使未来 assertStorageKey 的规则放宽，也能靠二次校验兜底）。
 */
export class LocalStorageAdapter implements StorageAdapter {
  readonly provider: StorageAdapterProvider = 'local';
  readonly config: LocalStorageConfig;
  private readonly rootAbs: string;

  constructor(config: LocalStorageConfig) {
    if (!config || typeof config.rootDir !== 'string' || config.rootDir.trim().length === 0) {
      throw new AppError('VALIDATION', '本地存储配置缺少 rootDir');
    }
    this.config = config;
    this.rootAbs = path.resolve(config.rootDir);
  }

  /** 解析后的 rootDir 绝对路径（测试/诊断用，不含凭据）。 */
  get rootDir(): string {
    return this.rootAbs;
  }

  /** 校验 key 并把 key 解析为 rootDir 内的绝对路径；逃逸时抛 SECURITY。 */
  private resolveKey(key: string): { key: string; absPath: string } {
    const normalized = assertStorageKey(key);
    const absPath = path.resolve(this.rootAbs, ...normalized.split('/'));
    const relative = path.relative(this.rootAbs, absPath);
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new AppError('SECURITY', `存储对象 key 逃逸出 rootDir：${key}`);
    }
    return { key: normalized, absPath };
  }

  async probe(): Promise<void> {
    try {
      await fs.mkdir(this.rootAbs, { recursive: true });
      // 目录存在不足以保证可写（只读挂载/权限位），实际写一个探针文件最可靠。
      const probePath = path.join(
        this.rootAbs,
        `.apphub-probe-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      );
      await fs.writeFile(probePath, 'apphub-probe', 'utf8');
      await fs.unlink(probePath);
    } catch (error) {
      throw mapFsError(error, `本地存储探测失败（rootDir=${this.rootAbs}）`);
    }
  }

  async readText(key: string): Promise<string | null> {
    const binary = await this.readBinary(key);
    return binary === null ? null : binary.toString('utf8');
  }

  async readBinary(key: string): Promise<Buffer | null> {
    const { key: normalized, absPath } = this.resolveKey(key);
    try {
      return await fs.readFile(absPath);
    } catch (error) {
      if (errnoOf(error) === 'ENOENT') return null;
      throw mapFsError(error, `读取本地对象失败：${normalized}`);
    }
  }

  async exists(key: string): Promise<boolean> {
    const { key: normalized, absPath } = this.resolveKey(key);
    try {
      const stat = await fs.stat(absPath);
      return stat.isFile();
    } catch (error) {
      if (errnoOf(error) === 'ENOENT') return false;
      throw mapFsError(error, `检查本地对象失败：${normalized}`);
    }
  }

  async stat(key: string): Promise<StorageStat | null> {
    const { key: normalized, absPath } = this.resolveKey(key);
    try {
      const stat = await fs.stat(absPath);
      if (!stat.isFile()) return null;
      return { size: stat.size, modifiedAt: stat.mtime.toISOString() };
    } catch (error) {
      if (errnoOf(error) === 'ENOENT') return null;
      throw mapFsError(error, `读取本地对象元信息失败：${normalized}`);
    }
  }

  async list(prefix: string): Promise<StorageEntry[]> {
    const normalizedPrefix = normalizeListPrefix(prefix);
    const directoryKey = normalizedPrefix.replace(/\/+$/, '');
    const directoryAbs =
      directoryKey === ''
        ? this.rootAbs
        : path.resolve(this.rootAbs, ...assertStorageKey(directoryKey).split('/'));
    const relativeToRoot = path.relative(this.rootAbs, directoryAbs);
    if (relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) {
      throw new AppError('SECURITY', `存储前缀逃逸出 rootDir：${prefix}`);
    }

    try {
      const stat = await fs.stat(directoryAbs);
      if (!stat.isDirectory()) return [];
    } catch (error) {
      if (errnoOf(error) === 'ENOENT') return [];
      throw mapFsError(error, `列出本地存储失败：${prefix}`);
    }

    const entries: StorageEntry[] = [];
    await this.walk(directoryAbs, directoryKey === '' ? '' : `${directoryKey}/`, entries);
    return entries
      .filter((entry) => entry.key.startsWith(normalizedPrefix))
      .sort((a, b) => a.key.localeCompare(b.key));
  }

  private async walk(dirAbs: string, keyPrefix: string, out: StorageEntry[]): Promise<void> {
    let dirents;
    try {
      dirents = await fs.readdir(dirAbs, { withFileTypes: true });
    } catch (error) {
      throw mapFsError(error, `遍历本地存储目录失败：${keyPrefix || '/'}`);
    }
    for (const dirent of dirents.sort((a, b) => a.name.localeCompare(b.name))) {
      const absPath = path.join(dirAbs, dirent.name);
      const key = `${keyPrefix}${dirent.name}`;
      if (dirent.isDirectory()) {
        await this.walk(absPath, `${key}/`, out);
      } else if (dirent.isFile()) {
        const stat = await fs.stat(absPath);
        out.push({ key, size: stat.size, modifiedAt: stat.mtime.toISOString() });
      }
      // 符号链接等特殊文件跳过：避免通过链接读取 rootDir 之外的内容
    }
  }

  async writeText(key: string, content: string): Promise<void> {
    if (typeof content !== 'string') {
      throw new AppError('VALIDATION', 'writeText 需要字符串内容');
    }
    await this.writeBinary(key, Buffer.from(content, 'utf8'), { contentType: 'application/json' });
  }

  async writeBinary(key: string, data: Buffer, options?: StorageWriteOptions): Promise<void> {
    if (!Buffer.isBuffer(data)) {
      throw new AppError('VALIDATION', 'writeBinary 需要 Buffer 数据');
    }
    const { key: normalized, absPath } = this.resolveKey(key);
    try {
      await fs.mkdir(path.dirname(absPath), { recursive: true });
      await fs.writeFile(absPath, data);
      if (options?.executable && process.platform !== 'win32') {
        await fs.chmod(absPath, 0o755);
      }
    } catch (error) {
      throw mapFsError(error, `写入本地对象失败：${normalized}`);
    }
  }

  async delete(key: string): Promise<void> {
    const { key: normalized, absPath } = this.resolveKey(key);
    try {
      await fs.unlink(absPath);
    } catch (error) {
      const errno = errnoOf(error);
      if (errno === 'ENOENT') return; // 幂等：对象不存在视为删除成功
      if (errno === 'EISDIR') {
        throw new AppError('STORAGE', `删除本地对象失败：${normalized} 是目录而不是文件`);
      }
      throw mapFsError(error, `删除本地对象失败：${normalized}`);
    }
  }

  async getDownloadUrl(key: string): Promise<string> {
    return appendUrl(this.config.publicBaseUrl, assertStorageKey(key));
  }

  async close(): Promise<void> {
    // 本地目录无需释放连接
  }
}
