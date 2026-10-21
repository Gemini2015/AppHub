import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLogger } from './logger';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'apphub-logger-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('logger：文件日志', () => {
  it('写入 <logDir>/main.log 并包含 level/message/meta', async () => {
    const logger = createLogger({ logDir: tempDir, console: false });
    logger.info('启动完成', { version: '0.1.0' });
    logger.warn('提示信息');
    logger.error('失败信息', { code: 'IO' });
    await logger.flush();
    await logger.close();

    const content = await readFile(path.join(tempDir, 'main.log'), 'utf8');
    expect(content).toContain('[INFO] 启动完成');
    expect(content).toContain('"version":"0.1.0"');
    expect(content).toContain('[WARN] 提示信息');
    expect(content).toContain('[ERROR] 失败信息');
    expect(logger.logPath).toBe(path.join(tempDir, 'main.log'));
  });

  it('超过 maxBytes 时轮转出 main.log.1', async () => {
    const logger = createLogger({ logDir: tempDir, console: false, maxBytes: 120 });
    for (let index = 0; index < 8; index += 1) {
      logger.info(`第 ${index} 条日志：用于触发文件轮转的填充内容`);
    }
    await logger.flush();
    await logger.close();

    const files = await readdir(tempDir);
    expect(files).toContain('main.log');
    expect(files).toContain('main.log.1');
  });

  it('不可序列化的 meta 不会让日志抛错', async () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    const logger = createLogger({ logDir: tempDir, console: false });
    expect(() => logger.info('循环引用', circular)).not.toThrow();
    expect(() => logger.info('bigint', { value: 10n })).not.toThrow();
    await logger.flush();
    await logger.close();
    const content = await readFile(path.join(tempDir, 'main.log'), 'utf8');
    expect(content).toContain('循环引用');
  });

  it('未配置 logDir 时只输出控制台，logPath 为空', async () => {
    const logger = createLogger({ console: false });
    logger.info('only console');
    await logger.flush();
    expect(logger.logPath).toBeUndefined();
  });
});
