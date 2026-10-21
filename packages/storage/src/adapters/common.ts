import { AppError } from '@apphub/protocol';
import type { ErrorCode } from '@apphub/protocol';
import { assertStorageKey } from '../memory';

/**
 * 各 provider 共用的错误映射与 key 处理工具。
 *
 * 目标：
 *  - 所有对外错误都是 AppError，code 语义稳定（AUTH/NETWORK/NOT_FOUND/STORAGE/SECURITY/VALIDATION）；
 *  - 错误信息可读，但绝不包含凭据（密码/secretKey/session token）。
 */

/** Node 网络类 errno：统一映射为 NETWORK。 */
const NETWORK_ERRNO = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'ENETDOWN',
  'EADDRNOTAVAIL',
]);

/** 权限类 errno：统一映射为 AUTH。 */
const AUTH_ERRNO = new Set(['EACCES', 'EPERM']);

/** 取出错误上的 `code`（Node errno 为字符串，FTP/HTTP 状态码为数字）。 */
export function codeOf(error: unknown): unknown {
  if (typeof error === 'object' && error !== null) {
    return (error as { code?: unknown }).code;
  }
  return undefined;
}

export function errnoOf(error: unknown): string | undefined {
  const code = codeOf(error);
  return typeof code === 'string' ? code : undefined;
}

/** 可读的错误描述（不含任何配置/凭据）。 */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const code = errnoOf(error);
    const message = error.message || error.name;
    return code && !message.includes(code) ? `${message}（${code}）` : message;
  }
  if (typeof error === 'string' && error.length > 0) return error;
  return String(error);
}

function looksLikeTimeout(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /timeout|timed out/i.test(message);
}

function isNodeNetworkError(error: unknown): boolean {
  return NETWORK_ERRNO.has(errnoOf(error) ?? '') || looksLikeTimeout(error);
}

function baseMessage(action: string, error: unknown): string {
  return `${action}：${describeError(error)}`;
}

function withCause(appError: AppError, error: unknown): AppError {
  const code = errnoOf(error);
  if (!code || appError.details !== undefined) return appError;
  return new AppError(appError.code, appError.message, { cause: code });
}

/** 本地文件系统错误 → AppError。 */
export function mapFsError(error: unknown, action: string): AppError {
  if (error instanceof AppError) return error;
  const errno = errnoOf(error);
  const message = baseMessage(action, error);
  if (errno && AUTH_ERRNO.has(errno)) return withCause(new AppError('AUTH', message), error);
  if (errno && NETWORK_ERRNO.has(errno)) return withCause(new AppError('NETWORK', message), error);
  if (errno === 'ENOENT') return withCause(new AppError('NOT_FOUND', message), error);
  return withCause(new AppError('STORAGE', message), error);
}

/**
 * FTP "对象/目录不存在" 判定。
 *
 * 注意：FTP 协议里 550 同时表示"不存在"和"无权限"，不同服务器/不同命令的
 * 缺省响应码也不同（vsftpd 统一 550，ftp-srv 的 RETR 用 551、LIST 用 451），
 * 因此这里按常见实现放宽判定。适配器契约要求"不存在返回 null/[]"，这是可接受的权衡：
 * 真正的连接/鉴权失败仍会以 NETWORK/AUTH 抛出（见 mapFtpError）。
 */
const FTP_MISSING_CODES = new Set([450, 451, 550, 551, 552, 553]);

export function isFtpNotFound(error: unknown): boolean {
  const code = codeOf(error);
  return typeof code === 'number' && FTP_MISSING_CODES.has(code);
}

/** FTP 错误 → AppError：530→AUTH；网络 errno/超时→NETWORK；其余→STORAGE。 */
export function mapFtpError(error: unknown, action: string): AppError {
  if (error instanceof AppError) return error;
  const message = baseMessage(action, error);
  const code = codeOf(error);
  if (typeof code === 'number') {
    if (code === 530) return new AppError('AUTH', message, { ftpCode: code });
    // 421 服务不可用、425/426 数据连接异常，属于网络/连接问题
    if (code === 421 || code === 425 || code === 426) {
      return new AppError('NETWORK', message, { ftpCode: code });
    }
    return new AppError('STORAGE', message, { ftpCode: code });
  }
  if (isNodeNetworkError(error)) return withCause(new AppError('NETWORK', message), error);
  return withCause(new AppError('STORAGE', message), error);
}

const S3_NOT_FOUND_CODES = new Set(['NoSuchKey', 'NotFound', 'NoSuchBucket', 'NoSuchObject']);
const S3_AUTH_CODES = new Set([
  'AccessDenied',
  'InvalidAccessKeyId',
  'SignatureDoesNotMatch',
  'AllAccessDisabled',
  'AccountProblem',
  'ExpiredToken',
  'InvalidToken',
  'AccessKeyRequired',
  'SecretKeyRequired',
]);

function statusCodeOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const status = (error as { statusCode?: unknown; status?: unknown }).statusCode ?? (error as { status?: unknown }).status;
  return typeof status === 'number' ? status : undefined;
}

/** S3 错误判定：错误码/HTTP 状态表示对象不存在。 */
export function isS3NotFound(error: unknown): boolean {
  const code = errnoOf(error);
  if (code && S3_NOT_FOUND_CODES.has(code)) return true;
  return statusCodeOf(error) === 404;
}

/** S3 错误 → AppError：鉴权类→AUTH；网络类→NETWORK；缺失→NOT_FOUND；其余→STORAGE。 */
export function mapS3Error(error: unknown, action: string): AppError {
  if (error instanceof AppError) return error;
  const message = baseMessage(action, error);
  const code = errnoOf(error);
  const status = statusCodeOf(error);
  if (code === 'InvalidEndpointError' || code === 'InvalidPortError' || code === 'InvalidBucketNameError' || code === 'InvalidPrefixError') {
    return new AppError('VALIDATION', message, { s3Code: code });
  }
  if (isNodeNetworkError(error)) return withCause(new AppError('NETWORK', message), error);
  if (status === 401) return new AppError('AUTH', message, { statusCode: status });
  if (status === 403 || (code !== undefined && S3_AUTH_CODES.has(code))) {
    return new AppError('AUTH', message, { statusCode: status, s3Code: code });
  }
  if (isS3NotFound(error)) {
    return new AppError('NOT_FOUND', message, { statusCode: status, s3Code: code });
  }
  return new AppError('STORAGE', message, { statusCode: status, s3Code: code });
}

/**
 * 归一化 `list(prefix)` 的前缀，语义与 MemoryStorageAdapter 保持一致：
 *  - 空前缀 = 频道根目录（列出全部对象）；
 *  - 其余前缀去掉首尾 `/` 后必须通过 assertStorageKey，并以 `/` 结尾作为匹配前缀。
 */
export function normalizeListPrefix(prefix: string): string {
  if (prefix === undefined || prefix === null) return '';
  if (typeof prefix !== 'string') {
    throw new AppError('VALIDATION', '存储对象前缀必须是字符串');
  }
  if (prefix.length === 0) return '';
  const trimmed = prefix.replace(/^\/+/, '').replace(/\/+$/, '');
  if (trimmed === '') return '';
  return `${assertStorageKey(trimmed)}/`;
}

/** 归一化目录前缀（用于 rootDir / object prefix）：空串表示根目录。 */
export function normalizeDirPrefix(prefix: string, label: string): string {
  if (prefix === undefined || prefix === null) return '';
  if (typeof prefix !== 'string') {
    throw new AppError('VALIDATION', `${label}必须是字符串`);
  }
  const trimmed = prefix.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
  if (trimmed === '') return '';
  try {
    return assertStorageKey(trimmed);
  } catch (error) {
    if (error instanceof AppError) {
      throw new AppError('VALIDATION', `${label}非法：${prefix}（${error.message}）`);
    }
    throw error;
  }
}

/** 确保错误为 AppError（供适配器内部兜底）。 */
export function asAppError(error: unknown, action: string, fallback: ErrorCode = 'STORAGE'): AppError {
  if (error instanceof AppError) return error;
  return new AppError(fallback, baseMessage(action, error));
}
