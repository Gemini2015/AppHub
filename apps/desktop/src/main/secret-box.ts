import { AppError } from '@apphub/protocol';
import { safeStorage } from 'electron';
import type { SecretBox } from '@apphub/core';
import type { Logger } from './logger';

/**
 * 基于 Electron safeStorage 的 core.SecretBox 实现。
 *
 * - 可用时：`safe:v1:` + safeStorage.encryptString(plain) 的 base64；
 *   Windows 走 DPAPI、macOS 走 Keychain、Linux 走 secret service；
 * - 不可用时（例如无 keyring 的 Linux/CI）：降级为 `plain:v1:` + base64，并 logger.warn；
 *   降级是"可用性优先"的折中，UI/日志中会明确提示本机凭据未加密。
 * - 未知前缀 / 解不开的密文一律抛 AppError('STATE')，绝不静默返回错误明文。
 */

export const SECRET_SAFE_PREFIX = 'safe:v1:';
export const SECRET_PLAIN_PREFIX = 'plain:v1:';

/** 便于测试注入的 safeStorage 子集。 */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export interface SecretBoxOptions {
  logger: Logger;
  /** 缺省使用 Electron 的 safeStorage（测试可注入替身）。 */
  safeStorage?: SafeStorageLike;
}

function isBase64(value: string): boolean {
  if (value.length === 0) return false;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  return value.length % 4 === 0;
}

function decodeBase64Utf8(value: string, label: string): string {
  if (!isBase64(value)) {
    throw new AppError('STATE', `${label}格式非法（不是有效的 base64）`);
  }
  return Buffer.from(value, 'base64').toString('utf8');
}

export function createSecretBox(options: SecretBoxOptions): SecretBox {
  const logger = options.logger;
  const backend = options.safeStorage ?? safeStorage;
  let warnedFallback = false;

  function useSafeStorage(): boolean {
    try {
      return backend.isEncryptionAvailable() === true;
    } catch {
      return false;
    }
  }

  function warnFallback(): void {
    if (warnedFallback) return;
    warnedFallback = true;
    logger.warn(
      '系统安全存储（safeStorage）不可用，频道凭据将使用 plain:v1 明文 base64 存储；' +
        '请为系统安装 keyring/credential manager，或在无敏感凭据的环境中使用。',
    );
  }

  return {
    async encrypt(plain: string): Promise<string> {
      const text = typeof plain === 'string' ? plain : String(plain);
      if (useSafeStorage()) {
        try {
          const encrypted = backend.encryptString(text);
          return `${SECRET_SAFE_PREFIX}${encrypted.toString('base64')}`;
        } catch (err) {
          logger.warn('safeStorage 加密失败，本次降级为 plain:v1', {
            message: err instanceof Error ? err.message : String(err),
          });
          warnedFallback = true;
        }
      } else {
        warnFallback();
      }
      return `${SECRET_PLAIN_PREFIX}${Buffer.from(text, 'utf8').toString('base64')}`;
    },

    async decrypt(cipher: string): Promise<string> {
      if (typeof cipher !== 'string' || cipher.length === 0) {
        throw new AppError('STATE', '密文为空或格式非法');
      }
      if (cipher.startsWith(SECRET_SAFE_PREFIX)) {
        if (!useSafeStorage()) {
          throw new AppError('STATE', '当前系统安全存储不可用，无法解密 safe:v1 凭据');
        }
        const encoded = cipher.slice(SECRET_SAFE_PREFIX.length);
        if (!isBase64(encoded)) {
          throw new AppError('STATE', 'safe:v1 密文格式非法');
        }
        try {
          return backend.decryptString(Buffer.from(encoded, 'base64'));
        } catch (err) {
          throw new AppError('STATE', 'safe:v1 凭据解密失败（可能来自其他机器/用户）', {
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
      if (cipher.startsWith(SECRET_PLAIN_PREFIX)) {
        return decodeBase64Utf8(cipher.slice(SECRET_PLAIN_PREFIX.length), 'plain:v1 密文');
      }
      throw new AppError('STATE', '未知的密文格式（期望 safe:v1: 或 plain:v1: 前缀）');
    },
  };
}
