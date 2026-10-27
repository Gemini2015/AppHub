import { Readable, Writable } from 'node:stream';
import { Client } from 'basic-ftp';
import type { FileInfo } from 'basic-ftp';
import path from 'node:path';
import { AppError, appendUrl } from '@apphub/protocol';
import type { FtpHttpStorageConfig } from '@apphub/protocol';
import { assertStorageKey } from '../memory';
import type {
  StorageAdapter,
  StorageAdapterProvider,
  StorageEntry,
  StorageStat,
  StorageWriteOptions,
} from '../types';
import {
  isFtpNotFound,
  mapFtpError,
  normalizeDirPrefix,
  normalizeListPrefix,
} from './common';

/** POSIX 版 path.dirname / basename，FTP 远端路径始终使用 `/` 分隔。 */
const remotePath = path.posix;

/** 判断 FTP 错误是否属于可重试的瞬时网络/传输失败（连接已坏时自动重连一次）。 */
function isRetryableFtpFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /timeout|timed out|closed|transfer strategies|ECONNRESET|EPIPE|socket hang up|421|425|426/i.test(
    message,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function normalizeRemoteRoot(pwd: string): string {
  let normalized = pwd.replace(/\\/g, '/').trim();
  if (normalized === '') return '/';
  if (!normalized.startsWith('/')) normalized = `/${normalized}`;
  normalized = normalized.replace(/\/+$/, '');
  return normalized === '' ? '/' : normalized;
}

/**
 * FTP 写入 + HTTP 读取适配器（对应需求中的 "FTP + nginx" 组合）。
 *
 * 连接策略：惰性建立单连接，所有操作通过内部串行队列执行（basic-ftp 的 Client 非并发安全）；
 * 连接因网络错误被关闭后，下一次操作自动重连。
 *
 * rootDir：FTP 登录目录下的子目录（空串 = 登录目录本身）。连接后 `cd` 进去，
 * 适配器内部一律使用"相对 rootDir 的 `/` 路径"再拼成远端绝对路径。
 */
export class FtpHttpStorageAdapter implements StorageAdapter {
  readonly provider: StorageAdapterProvider = 'ftp-http';
  readonly config: FtpHttpStorageConfig;

  private client: Client | null = null;
  /** 串行队列：保证同一时刻只有一个 FTP 命令序列在跑。 */
  private queue: Promise<void> = Promise.resolve();
  private remoteRoot = '/';
  private closed = false;

  constructor(config: FtpHttpStorageConfig) {
    this.config = config;
    // 提前校验 rootDir（非法时在工厂 create 阶段就抛出可读错误）
    normalizeDirPrefix(config.ftp.rootDir, 'FTP rootDir');
  }

  // ------------------------------------------------------------------ 连接管理

  private async connect(): Promise<Client> {
    if (this.client && !this.client.closed) return this.client;

    const { ftp } = this.config;
    if (ftp.passive === false) {
      throw new AppError(
        'UNSUPPORTED',
        'FTP 适配器仅支持被动模式（passive=true）：basic-ftp 不支持主动模式，请改用被动模式',
      );
    }

    const client = new Client(ftp.timeoutMs ?? 20_000);
    try {
      await client.access({
        host: ftp.host,
        port: ftp.port,
        user: ftp.user,
        password: ftp.password,
        secure: ftp.secure,
      });
      const rootDir = normalizeDirPrefix(ftp.rootDir, 'FTP rootDir');
      if (rootDir !== '') {
        await client.ensureDir(`/${rootDir}`);
      }
      this.remoteRoot = normalizeRemoteRoot(await client.pwd());
      this.client = client;
      return client;
    } catch (error) {
      client.close();
      this.client = null;
      throw mapFtpError(error, `连接 FTP 服务器失败（${ftp.host}:${ftp.port}）`);
    }
  }

  /** 串行执行一次 FTP 操作；失败统一映射为 AppError，连接已坏时下次自动重连。 */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    if (this.closed) {
      return Promise.reject(new AppError('STATE', 'FTP 存储适配器已关闭'));
    }
    const run = this.queue.then(task);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async withClient<T>(action: string, task: (client: Client) => Promise<T>): Promise<T> {
    return this.enqueue(async () => {
      let lastError: unknown;
      // 长连接可能被服务器/网络中间设备关闭；若操作开始时已有连接，
      // 对瞬时错误（timeout/transfer strategies 等）重连并重试一次。
      // 每次操作都是幂等的（覆盖写/读/删/列目录），重试不会造成副作用。
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const hadConnection = this.client !== null && !this.client.closed;
        try {
          const client = await this.connect();
          return await task(client);
        } catch (error) {
          const mapped = mapFtpError(error, action);
          if (this.client?.closed) this.client = null;
          lastError = mapped;
          if (attempt < 2 && hadConnection && isRetryableFtpFailure(error)) {
            this.resetClient();
            await sleep(300);
            continue;
          }
          throw mapped;
        }
      }
      throw lastError instanceof AppError ? lastError : mapFtpError(lastError, action);
    });
  }

  private resetClient(): void {
    const client = this.client;
    this.client = null;
    if (client) {
      try {
        client.close();
      } catch {
        // 已因错误关闭
      }
    }
  }

  private remotePathOf(key: string): string {
    const base = this.remoteRoot === '/' ? '' : this.remoteRoot;
    return `${base}/${key}`;
  }

  /**
   * 进入对象所在远端目录执行操作，结束后把 CWD 复位到 rootDir。
   * basic-ftp 的相对读写都基于 CWD，复位可以避免后续操作受前一次操作影响。
   */
  private async withRemoteDir<T>(client: Client, dirKey: string, task: () => Promise<T>): Promise<T> {
    await client.ensureDir(this.remotePathOf(dirKey));
    try {
      return await task();
    } finally {
      try {
        await client.cd(this.remoteRoot);
      } catch {
        // 目录已被删除或连接已关闭时忽略；下一次操作会按需重连/重建目录
      }
    }
  }

  /** 拆分 key 为"父目录 + 文件名"，父目录为空表示 rootDir 本身。 */
  private splitKey(key: string): { dirKey: string; name: string } {
    const dirKey = remotePath.dirname(key);
    const name = remotePath.basename(key);
    return { dirKey: dirKey === '.' ? '' : dirKey, name };
  }

  // ------------------------------------------------------------------ 读写

  private async readRemote(client: Client, normalizedKey: string): Promise<Buffer> {
    // 用远端绝对路径直接 RETR：读取操作不创建任何目录（与其它 provider 一致，纯读无副作用）
    const remote = this.remotePathOf(normalizedKey);
    const chunks: Buffer[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
    });
    await client.downloadTo(sink, remote);
    return Buffer.concat(chunks);
  }

  async readText(key: string): Promise<string | null> {
    const binary = await this.readBinary(key);
    return binary === null ? null : binary.toString('utf8');
  }

  async readBinary(key: string): Promise<Buffer | null> {
    const normalized = assertStorageKey(key);
    return this.withClient(`读取 FTP 对象失败：${normalized}`, async (client) => {
      try {
        return await this.readRemote(client, normalized);
      } catch (error) {
        if (isFtpNotFound(error)) return null;
        throw error;
      }
    });
  }

  async exists(key: string): Promise<boolean> {
    const normalized = assertStorageKey(key);
    return this.withClient(`检查 FTP 对象失败：${normalized}`, async (client) => {
      try {
        await client.size(this.remotePathOf(normalized));
        return true;
      } catch (error) {
        if (isFtpNotFound(error)) return false;
        throw error;
      }
    });
  }

  async stat(key: string): Promise<StorageStat | null> {
    const normalized = assertStorageKey(key);
    const remote = this.remotePathOf(normalized);
    return this.withClient(`读取 FTP 对象元信息失败：${normalized}`, async (client) => {
      let size: number;
      try {
        size = await client.size(remote);
      } catch (error) {
        if (isFtpNotFound(error)) return null;
        throw error;
      }
      let modifiedAt: string | undefined;
      try {
        // MDTM 不是所有 FTP 服务器都支持；拿不到时间不影响 stat 的核心语义
        modifiedAt = (await client.lastMod(remote)).toISOString();
      } catch {
        modifiedAt = undefined;
      }
      return { size, modifiedAt };
    });
  }

  async list(prefix: string): Promise<StorageEntry[]> {
    const normalizedPrefix = normalizeListPrefix(prefix);
    const directoryKey = normalizedPrefix.replace(/\/+$/, '');
    return this.withClient(`列出 FTP 目录失败：${prefix}`, async (client) => {
      let rootEntries: FileInfo[];
      try {
        rootEntries = await client.list(this.remotePathOf(directoryKey));
      } catch (error) {
        if (isFtpNotFound(error)) return [];
        throw error;
      }

      const entries: StorageEntry[] = [];
      const walk = async (items: FileInfo[], keyPrefix: string): Promise<void> => {
        for (const item of items) {
          const key = `${keyPrefix}${item.name}`;
          if (item.isDirectory) {
            const childItems = await client.list(this.remotePathOf(key));
            await walk(childItems, `${key}/`);
          } else if (item.isFile) {
            entries.push({
              key,
              size: item.size,
              modifiedAt: item.modifiedAt?.toISOString(),
            });
          }
        }
      };
      await walk(rootEntries, directoryKey === '' ? '' : `${directoryKey}/`);

      return entries
        .filter((entry) => entry.key.startsWith(normalizedPrefix))
        .sort((a, b) => a.key.localeCompare(b.key));
    });
  }

  async writeText(key: string, content: string): Promise<void> {
    if (typeof content !== 'string') {
      throw new AppError('VALIDATION', 'writeText 需要字符串内容');
    }
    await this.writeBinary(key, Buffer.from(content, 'utf8'), { contentType: 'application/json' });
  }

  async writeBinary(key: string, data: Buffer, _options?: StorageWriteOptions): Promise<void> {
    if (!Buffer.isBuffer(data)) {
      throw new AppError('VALIDATION', 'writeBinary 需要 Buffer 数据');
    }
    const normalized = assertStorageKey(key);
    const { dirKey, name } = this.splitKey(normalized);
    await this.withClient(`写入 FTP 对象失败：${normalized}`, async (client) => {
      await this.withRemoteDir(client, dirKey, async () => {
        await client.uploadFrom(Readable.from([data]), name);
      });
    });
  }

  async delete(key: string): Promise<void> {
    const normalized = assertStorageKey(key);
    const remote = this.remotePathOf(normalized);
    await this.withClient(`删除 FTP 对象失败：${normalized}`, async (client) => {
      // ignoreErrorCodes=true：对象不存在时删除视为成功（与内存实现的幂等语义一致）
      await client.remove(remote, true);
    });
  }

  // ------------------------------------------------------------------ 其他

  /** 探测：连接（含自动创建 rootDir）+ 列出 rootDir，失败给出可读 AppError。 */
  async probe(): Promise<void> {
    await this.withClient('FTP 存储探测失败', async (client) => {
      await client.list(this.remotePathOf(''));
    });
  }

  async getDownloadUrl(key: string): Promise<string> {
    return appendUrl(this.config.http.baseUrl, assertStorageKey(key));
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.queue.catch(() => undefined);
    const client = this.client;
    this.client = null;
    if (client) {
      try {
        client.close();
      } catch {
        // 已经因错误关闭
      }
    }
  }
}
