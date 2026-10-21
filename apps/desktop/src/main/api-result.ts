import { AppError } from '@apphub/protocol';
import type { Logger } from './logger';
import type { ApiError, ApiResult } from '../../shared/ipc';

/**
 * IPC 层统一结果包装与错误序列化。
 *
 * 约定（见 docs/ARCHITECTURE.md §6 / shared/ipc.ts）：
 *  - 成功：`{ ok: true, value }`
 *  - 失败：`{ ok: false, error: { code, message, details? } }`
 *  - 永远不把 Error 实例 / 栈信息 / Node 错误对象直接 reject 给渲染进程。
 */

/** 把任意异常序列化为可跨 IPC 传输的错误结构（details 必须 JSON 可序列化）。 */
export function toApiError(err: unknown): ApiError {
  const appError = AppError.from(err);
  const error: ApiError = { code: appError.code, message: appError.message };
  const details = sanitizeDetails(appError.details);
  if (details !== undefined) error.details = details;
  return error;
}

/**
 * details 只允许 JSON 可序列化的值；不可序列化时丢弃（避免 IPC 结构化克隆失败/泄露内部对象）。
 */
export function sanitizeDetails(details: unknown): unknown {
  if (details === undefined) return undefined;
  try {
    const json = JSON.stringify(details);
    if (typeof json !== 'string') return undefined;
    return JSON.parse(json) as unknown;
  } catch {
    return undefined;
  }
}

export function okResult<T>(value: T): ApiResult<T> {
  return { ok: true, value };
}

export function errorResult(err: unknown): ApiResult<never> {
  return { ok: false, error: toApiError(err) };
}

/**
 * 执行一个 IPC handler 主体并包装结果。
 * 失败时记录日志（仅记录 code/message，不记录入参，避免凭据/路径进入日志）。
 */
export async function runApi<T>(
  logger: Logger,
  label: string,
  run: () => Promise<T> | T,
  onError?: (error: ApiError) => void,
): Promise<ApiResult<T>> {
  try {
    return okResult(await run());
  } catch (err) {
    const error = toApiError(err);
    logger.error(`IPC ${label} 失败`, { code: error.code, message: error.message });
    onError?.(error);
    return { ok: false, error };
  }
}
