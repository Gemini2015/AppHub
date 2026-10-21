import path from 'node:path';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { AppError, DEFAULTS } from '@apphub/protocol';
import type { Clock, FetchLike } from './types';
import { describeHttpStatus, redactUrl, toAppError } from './errors';
import { ensureDir, progressPercent, removePath } from './fs';

/**
 * 基于注入 fetchImpl 的 HTTP 客户端。
 *
 * 职责：
 *  - 合并默认 headers 与调用方 headers；
 *  - 超时（响应头阶段 + 下载空闲阶段）与错误码映射（NOT_FOUND/AUTH/NETWORK）；
 *  - 文本读取与带进度的二进制下载；
 *  - 错误信息/日志中的 URL 一律脱敏，绝不泄露 accessKey / 凭据。
 */

export interface HttpClientOptions {
  fetchImpl: FetchLike;
  defaultHeaders?: Record<string, string>;
  /** 响应头阶段超时（默认 DEFAULTS.httpTimeoutMs）。 */
  timeoutMs?: number;
  /** 下载空闲超时（默认 DEFAULTS.httpTimeoutMs，收到数据即重置）。 */
  idleTimeoutMs?: number;
}

export interface FetchTextOptions {
  headers?: Record<string, string>;
  /** 覆盖本次请求的响应头阶段超时。 */
  timeoutMs?: number;
  /** 供日志/错误信息使用的可读标签（不含凭据）。 */
  label?: string;
}

export interface DownloadOptions {
  headers?: Record<string, string>;
  /** 期望大小（用于进度总量与提前失败）。 */
  expectedSize?: number;
  onProgress?: (transferredBytes: number, totalBytes: number | undefined) => void;
}

export interface DownloadResult {
  size: number;
  md5: string;
}

function mergeHeaders(
  ...sources: (Record<string, string> | undefined)[]
): Record<string, string> | undefined {
  const merged: Record<string, string> = {};
  let hasAny = false;
  for (const source of sources) {
    if (!source) continue;
    for (const [key, value] of Object.entries(source)) {
      if (typeof value !== 'string') continue;
      merged[key] = value;
      hasAny = true;
    }
  }
  return hasAny ? merged : undefined;
}

export class HttpClient {
  private readonly fetchImpl: FetchLike;
  private readonly defaultHeaders?: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly idleTimeoutMs: number;

  constructor(options: HttpClientOptions) {
    this.fetchImpl = options.fetchImpl;
    this.defaultHeaders = options.defaultHeaders;
    this.timeoutMs = options.timeoutMs ?? DEFAULTS.httpTimeoutMs;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULTS.httpTimeoutMs;
  }

  async fetchText(url: string, options: FetchTextOptions = {}): Promise<string> {
    const response = await this.openResponse(url, options);
    try {
      return await response.text();
    } catch (error) {
      throw new AppError(
        'NETWORK',
        `读取响应内容失败：${redactUrl(url)}（${AppError.from(error).message}）`,
      );
    }
  }

  private async openResponse(url: string, options: FetchTextOptions): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? this.timeoutMs);
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method: 'GET',
          headers: mergeHeaders(this.defaultHeaders, options.headers),
          signal: controller.signal,
          redirect: 'follow',
        });
      } catch (error) {
        const appError = toAppError(error, 'NETWORK');
        if (controller.signal.aborted) {
          throw new AppError(
            'NETWORK',
            `请求超时（${options.timeoutMs ?? this.timeoutMs}ms）：${redactUrl(url)}`,
          );
        }
        if (appError.code === 'NETWORK' || appError.code === 'INTERNAL') {
          throw new AppError(
            'NETWORK',
            `网络请求失败：${redactUrl(url)}（${appError.message}）`,
          );
        }
        throw appError;
      }
      if (!response.ok) {
        const code =
          response.status === 401 || response.status === 403
            ? 'AUTH'
            : response.status === 404
              ? 'NOT_FOUND'
              : 'NETWORK';
        throw new AppError(code, `${describeHttpStatus(response.status)}：${redactUrl(url)}`, {
          status: response.status,
        });
      }
      return response;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 下载到本地文件（流式写入并计算 MD5）。
   * 失败时删除半成品文件并抛出 AppError（NOT_FOUND/AUTH/NETWORK/IO）。
   */
  async downloadToFile(url: string, destPath: string, options: DownloadOptions = {}): Promise<DownloadResult> {
    await ensureDir(path.dirname(destPath));
    const controller = new AbortController();
    let headerTimeout: ReturnType<typeof setTimeout> | undefined = setTimeout(
      () => controller.abort(),
      this.timeoutMs,
    );
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let handle: import('node:fs/promises').FileHandle | undefined;
    let size = 0;
    const hash = createHash('md5');
    const totalFromExpected = options.expectedSize;
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method: 'GET',
          headers: mergeHeaders(this.defaultHeaders, options.headers),
          signal: controller.signal,
          redirect: 'follow',
        });
      } catch (error) {
        const appError = toAppError(error, 'NETWORK');
        if (controller.signal.aborted) {
          throw new AppError('NETWORK', `请求超时：${redactUrl(url)}`);
        }
        throw new AppError('NETWORK', `下载请求失败：${redactUrl(url)}（${appError.message}）`);
      }
      if (!response.ok) {
        const code =
          response.status === 401 || response.status === 403
            ? 'AUTH'
            : response.status === 404
              ? 'NOT_FOUND'
              : 'NETWORK';
        throw new AppError(code, `${describeHttpStatus(response.status)}：${redactUrl(url)}`, {
          status: response.status,
        });
      }
      if (headerTimeout) {
        clearTimeout(headerTimeout);
        headerTimeout = undefined;
      }
      const contentLengthHeader = response.headers.get('content-length');
      const contentLength =
        contentLengthHeader !== null && Number.isFinite(Number(contentLengthHeader))
          ? Number(contentLengthHeader)
          : undefined;
      const totalBytes = totalFromExpected ?? contentLength;
      handle = await fs.open(destPath, 'w');
      const touchIdle = (): void => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => controller.abort(), this.idleTimeoutMs);
      };
      touchIdle();
      options.onProgress?.(0, totalBytes);
      const body = response.body;
      if (!body) {
        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length > 0) {
          await handle.write(buffer);
          hash.update(buffer);
          size += buffer.length;
          options.onProgress?.(size, totalBytes);
        }
      } else {
        const reader = body.getReader();
        for (;;) {
          let chunk: { done: boolean; value?: Uint8Array };
          try {
            chunk = await reader.read();
          } catch (error) {
            if (controller.signal.aborted) {
              throw new AppError('NETWORK', `下载超时（长时间无数据）：${redactUrl(url)}`);
            }
            throw new AppError('NETWORK', `下载中断：${redactUrl(url)}（${AppError.from(error).message}）`);
          }
          if (chunk.done) break;
          const value = chunk.value;
          if (!value || value.length === 0) continue;
          const buffer = Buffer.from(value);
          hash.update(buffer);
          size += buffer.length;
          await handle.write(buffer);
          touchIdle();
          options.onProgress?.(size, totalBytes);
        }
      }
      if (totalBytes !== undefined && totalBytes !== size) {
        throw new AppError(
          'IO',
          `下载大小与预期不一致（预期 ${totalBytes} 字节，实际 ${size} 字节）：${redactUrl(url)}`,
        );
      }
      return { size, md5: hash.digest('hex') };
    } catch (error) {
      if (idleTimer) clearTimeout(idleTimer);
      if (headerTimeout) clearTimeout(headerTimeout);
      if (handle) await handle.close().catch(() => undefined);
      await removePath(destPath);
      if (error instanceof AppError) throw error;
      throw toAppError(error, 'NETWORK');
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      if (headerTimeout) clearTimeout(headerTimeout);
      if (handle) await handle.close().catch(() => undefined);
    }
  }

  /** 进度百分比辅助（供调用方复用）。 */
  static percent(transferred: number, total: number | undefined): number | undefined {
    return progressPercent(transferred, total);
  }
}

/** 系统时钟（未注入 Clock 时使用）。 */
export const systemClock: Clock = {
  now: () => new Date(),
};
