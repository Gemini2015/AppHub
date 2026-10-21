import { ACCESS_KEY_PATTERN, APP_ID_PATTERN, CHANNEL_ID_PATTERN } from './constants';
import { AppError } from './errors';

/**
 * ID / 随机值生成。
 *
 * 使用 WebCrypto（Node 20+ 与浏览器均可用）保证跨环境一致；
 * 不引入 node:crypto，保持协议包纯净。
 */

interface WebCryptoLike {
  getRandomValues<T extends ArrayBufferView>(array: T): T;
}

function getCrypto(): WebCryptoLike {
  const webcrypto = (globalThis as { crypto?: WebCryptoLike }).crypto;
  if (!webcrypto || typeof webcrypto.getRandomValues !== 'function') {
    throw new AppError('INTERNAL', '当前运行环境不支持安全随机数（WebCrypto）');
  }
  return webcrypto;
}

/** 生成随机十六进制串。 */
export function randomHex(byteLength = 16): string {
  if (!Number.isInteger(byteLength) || byteLength <= 0 || byteLength > 64) {
    throw new AppError('VALIDATION', `随机字节数非法：${byteLength}`);
  }
  const bytes = new Uint8Array(byteLength);
  getCrypto().getRandomValues(bytes);
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

/** 生成频道 ID，形如 `ch_1f0a...`（20 位十六进制）。 */
export function newChannelId(): string {
  return `ch_${randomHex(10)}`;
}

/** 生成私密频道访问密钥（48 位十六进制，URL 安全）。 */
export function newAccessKey(): string {
  return randomHex(24);
}

export function isChannelId(value: string): boolean {
  return CHANNEL_ID_PATTERN.test(value);
}

export function isAccessKey(value: string): boolean {
  return ACCESS_KEY_PATTERN.test(value);
}

export function isAppId(value: string): boolean {
  return APP_ID_PATTERN.test(value);
}

/**
 * 用户输入（如 "Foo Bar 工具"）转为合法 App 标识。
 * 无法产生合法标识时回退为 `app-<随机>`。
 */
export function slugifyAppName(input: string): string {
  const normalized = typeof input === 'string' ? input : '';
  const slug = normalized
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/[._-]{2,}/g, (match) => match[0] ?? '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/[^a-z0-9]+$/, '')
    .slice(0, 48)
    .replace(/[^a-z0-9]+$/, '');
  if (slug.length === 0) return `app-${randomHex(4)}`;
  return APP_ID_PATTERN.test(slug) ? slug : `app-${randomHex(4)}`;
}
