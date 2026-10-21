import { ERROR_CODES } from './constants';

export type ErrorCode = (typeof ERROR_CODES)[number];

/** 可跨进程/网络边界传递的错误结构。 */
export interface SerializedAppError {
  code: ErrorCode;
  message: string;
  details?: unknown;
}

/**
 * AppHub 统一错误类型。
 *
 * 所有对外 API 在失败时抛出 AppError（或由 AppError.from 包装后的错误），
 * 由 IPC 层序列化为 { code, message, details } 返回给渲染进程。
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;
  /** 用于跨包/跨 bundle 的可靠识别（instanceof 不可靠时兜底）。 */
  readonly isAppHubError = true;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.details = details;
  }

  toJSON(): SerializedAppError {
    const out: SerializedAppError = { code: this.code, message: this.message };
    if (this.details !== undefined) out.details = this.details;
    return out;
  }

  static from(err: unknown, fallbackCode: ErrorCode = 'INTERNAL'): AppError {
    if (err instanceof AppError) return err;
    if (
      typeof err === 'object' &&
      err !== null &&
      (err as { isAppHubError?: boolean }).isAppHubError === true
    ) {
      const e = err as { code?: ErrorCode; message?: string; details?: unknown };
      return new AppError(e.code ?? fallbackCode, e.message ?? String(err), e.details);
    }
    if (err instanceof Error) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return new AppError('NOT_FOUND', err.message, { cause: code });
      if (code === 'EACCES' || code === 'EPERM') return new AppError('AUTH', err.message, { cause: code });
      if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'ETIMEDOUT') {
        return new AppError('NETWORK', err.message, { cause: code });
      }
      return new AppError(fallbackCode, err.message);
    }
    return new AppError(fallbackCode, typeof err === 'string' ? err : '未知错误', { cause: String(err) });
  }
}

export function isAppError(err: unknown): err is AppError {
  if (err instanceof AppError) return true;
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { isAppHubError?: boolean }).isAppHubError === true
  );
}

export function serializeError(err: unknown): SerializedAppError {
  return AppError.from(err).toJSON();
}

/** 断言条件，失败时抛出指定 code 的 AppError。 */
export function assertApp(
  condition: unknown,
  code: ErrorCode,
  message: string,
  details?: unknown,
): asserts condition {
  if (!condition) throw new AppError(code, message, details);
}

/** 判断 error 是否具有给定的 code。 */
export function hasErrorCode(err: unknown, code: ErrorCode): boolean {
  return isAppError(err) && err.code === code;
}
