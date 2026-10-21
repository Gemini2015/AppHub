import { AppError, isAppError } from '@apphub/protocol';
import type { ErrorCode } from '@apphub/protocol';

/**
 * 错误归一化与对外服务包装。
 *
 * 约定：core 的所有公共 API 失败时抛出 AppError；内部实现可以抛出任意错误，
 * 由 wrapService 统一转换成 AppError（保留已有 AppError 的 code）。
 */

export function toAppError(error: unknown, fallback: ErrorCode = 'INTERNAL'): AppError {
  if (isAppError(error)) return error as AppError;
  return AppError.from(error, fallback);
}

/**
 * 把存储层/底层错误包装成指定 code 的 AppError。
 * 已经是 AppError 时保留原 code（例如路径安全错误不应被降级成 STORAGE）。
 */
export function wrapError(label: string, error: unknown, fallback: ErrorCode = 'STORAGE'): AppError {
  const appError = toAppError(error, fallback);
  if (appError.code === fallback || appError.code !== 'INTERNAL') return appError;
  return new AppError(fallback, `${label}：${appError.message}`);
}

/** 执行异步操作并按默认 code 包装非 AppError 的异常（保留 AppError）。 */
export async function runWithErrorLabel<T>(
  label: string,
  fn: () => Promise<T>,
  fallback: ErrorCode = 'STORAGE',
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw wrapError(label, error, fallback);
  }
}

/**
 * 把服务的所有方法包一层错误归一化。
 * 只处理函数属性；其它属性（含 getter 结果）原样透传。
 */
export function wrapService<T extends object>(service: T): T {
  return new Proxy(service, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        let result: unknown;
        try {
          result = (value as (...innerArgs: unknown[]) => unknown).apply(target, args);
        } catch (error) {
          throw toAppError(error);
        }
        if (result instanceof Promise) {
          return result.catch((error: unknown) => {
            throw toAppError(error);
          });
        }
        return result;
      };
    },
  });
}

/**
 * 对 URL 做脱敏，用于错误信息与日志：
 *  - 去掉查询串与 fragment（S3 预签名参数 / Basic token 等）；
 *  - 隐藏 `_private/<channelId>/<accessKey>/` 中的 accessKey；
 *  - 隐藏 userinfo。
 */
export function redactUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    url.username = url.username ? '***' : '';
    url.password = url.password ? '***' : '';
    url.search = '';
    url.hash = '';
    const pathname = url.pathname.replace(/(\/_private\/[^/]+)\/[^/]+\//, '$1/***/');
    return `${url.origin}${pathname}`;
  } catch {
    return '<非法地址>';
  }
}

/** HTTP 状态码对应的可读说明。 */
export function describeHttpStatus(status: number): string {
  if (status === 401) return '需要身份验证（HTTP 401）';
  if (status === 403) return '没有访问权限（HTTP 403）';
  if (status === 404) return '资源不存在（HTTP 404）';
  if (status === 408) return '请求超时（HTTP 408）';
  if (status === 429) return '请求过于频繁（HTTP 429）';
  if (status >= 500) return `远端服务错误（HTTP ${status}）`;
  return `请求失败（HTTP ${status}）`;
}
