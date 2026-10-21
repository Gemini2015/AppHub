import { AppError } from '@apphub/protocol';
import { createFakeLogger } from '@apphub/testkit';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** 可切换可用性的 safeStorage 替身（vi.mock 工厂与测试共享 hoisted 状态）。 */
const state = vi.hoisted(() => ({
  available: true,
  encryptCalls: [] as string[],
  decryptCalls: [] as string[],
}));

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => state.available,
    encryptString: (plain: string) => {
      state.encryptCalls.push(plain);
      return Buffer.from(`ENC:${plain}`, 'utf8');
    },
    decryptString: (payload: Buffer) => {
      const text = payload.toString('utf8');
      state.decryptCalls.push(text);
      if (!text.startsWith('ENC:')) throw new Error('bad cipher');
      return text.slice('ENC:'.length);
    },
  },
}));

import { SECRET_PLAIN_PREFIX, SECRET_SAFE_PREFIX, createSecretBox } from './secret-box';

describe('secret-box：safeStorage 可用', () => {
  beforeEach(() => {
    state.available = true;
    state.encryptCalls.length = 0;
    state.decryptCalls.length = 0;
  });

  it('encrypt 使用 safe:v1: 前缀 + base64，并调用 safeStorage', async () => {
    const logger = createFakeLogger();
    const box = createSecretBox({ logger });
    const cipher = await box.encrypt('{"password":"s3cr3t"}');
    expect(cipher.startsWith(SECRET_SAFE_PREFIX)).toBe(true);
    expect(state.encryptCalls).toEqual(['{"password":"s3cr3t"}']);
    // 密文中不应出现明文凭据
    expect(cipher).not.toContain('s3cr3t');
    expect(logger.entries.filter((entry) => entry.level === 'warn')).toHaveLength(0);
  });

  it('decrypt 能还原 safe:v1: 密文', async () => {
    const logger = createFakeLogger();
    const box = createSecretBox({ logger });
    const plain = 'ftp://user:pass@example.com';
    const cipher = await box.encrypt(plain);
    await expect(box.decrypt(cipher)).resolves.toBe(plain);
    expect(state.decryptCalls).toHaveLength(1);
  });

  it('未知前缀 / 非法 base64 抛 AppError(STATE)', async () => {
    const box = createSecretBox({ logger: createFakeLogger() });
    await expect(box.decrypt('unknown:v1:abcd')).rejects.toMatchObject({ code: 'STATE' });
    await expect(box.decrypt(`${SECRET_SAFE_PREFIX}not-base64!!`)).rejects.toMatchObject({ code: 'STATE' });
    await expect(box.decrypt('')).rejects.toMatchObject({ code: 'STATE' });
  });

  it('safeStorage 解密失败（例如跨机器拷贝）抛 STATE，不泄露内部错误对象', async () => {
    const box = createSecretBox({ logger: createFakeLogger() });
    const bad = `${SECRET_SAFE_PREFIX}${Buffer.from('NOT-ENCRYPTED', 'utf8').toString('base64')}`;
    await expect(box.decrypt(bad)).rejects.toMatchObject({ code: 'STATE' });
  });
});

describe('secret-box：safeStorage 不可用（降级）', () => {
  beforeEach(() => {
    state.available = false;
  });

  it('加密降级为 plain:v1: base64，并 logger.warn（只警告一次）', async () => {
    const logger = createFakeLogger();
    const box = createSecretBox({ logger });
    const first = await box.encrypt('secret-1');
    const second = await box.encrypt('secret-2');
    expect(first.startsWith(SECRET_PLAIN_PREFIX)).toBe(true);
    expect(first).toBe(`${SECRET_PLAIN_PREFIX}${Buffer.from('secret-1', 'utf8').toString('base64')}`);
    expect(second.startsWith(SECRET_PLAIN_PREFIX)).toBe(true);
    const warnings = logger.entries.filter((entry) => entry.level === 'warn');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain('safeStorage');
  });

  it('plain:v1: 密文始终可解密', async () => {
    const box = createSecretBox({ logger: createFakeLogger() });
    const cipher = await box.encrypt('配置内容');
    expect(cipher.startsWith(SECRET_PLAIN_PREFIX)).toBe(true);
    await expect(box.decrypt(cipher)).resolves.toBe('配置内容');
  });

  it('没有加密能力时拒绝解密 safe:v1 密文（不静默降级）', async () => {
    const box = createSecretBox({ logger: createFakeLogger() });
    const cipher = `${SECRET_SAFE_PREFIX}${Buffer.from('whatever').toString('base64')}`;
    await expect(box.decrypt(cipher)).rejects.toBeInstanceOf(AppError);
    await expect(box.decrypt(cipher)).rejects.toMatchObject({ code: 'STATE' });
  });
});
