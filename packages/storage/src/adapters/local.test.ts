import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppError, isAppError, LocalStorageConfigSchema } from '@apphub/protocol';
import type { LocalStorageConfig } from '@apphub/protocol';
import { createTempDir, pathExists, safeRemove, startStaticServer } from '@apphub/testkit';
import type { StaticServer } from '@apphub/testkit';
import { LocalStorageAdapter } from './local';

async function expectAppError(
  operation: Promise<unknown>,
  code: AppError['code'],
  messagePart?: string,
): Promise<AppError> {
  try {
    await operation;
  } catch (error) {
    if (!isAppError(error)) throw new Error(`期望 AppError，实际抛出：${String(error)}`);
    expect(error.code).toBe(code);
    if (messagePart) expect(error.message).toContain(messagePart);
    return error;
  }
  throw new Error('期望抛出错误，但操作成功');
}

describe('LocalStorageAdapter', () => {
  let tempDir: string;
  let adapter: LocalStorageAdapter;

  function makeAdapter(overrides: Partial<LocalStorageConfig> = {}): LocalStorageAdapter {
    const config = LocalStorageConfigSchema.parse({
      provider: 'local',
      rootDir: path.join(tempDir, 'repo'),
      publicBaseUrl: 'http://127.0.0.1:1/',
      ...overrides,
    });
    return new LocalStorageAdapter(config);
  }

  beforeEach(async () => {
    tempDir = await createTempDir('apphub-local-test-');
    adapter = makeAdapter();
  });

  afterEach(async () => {
    await adapter.close();
    await safeRemove(tempDir);
  });

  it('probe 自动创建 rootDir，且重复 probe 幂等', async () => {
    const rootDir = adapter.rootDir;
    expect(await pathExists(rootDir)).toBe(false);

    await adapter.probe();
    expect(await pathExists(rootDir)).toBe(true);
    expect((await fs.stat(rootDir)).isDirectory()).toBe(true);

    await adapter.probe();
    expect(await adapter.list('')).toEqual([]);
  });

  it('CRUD：文本/二进制写入、读取、exists、stat、delete', async () => {
    await adapter.probe();
    await adapter.writeText('channel.json', JSON.stringify({ name: '示例频道' }));
    expect(await adapter.readText('channel.json')).toBe(JSON.stringify({ name: '示例频道' }));

    const binary = Buffer.from([0, 1, 2, 3, 255, 254, 128]);
    await adapter.writeBinary('app/1.0.0/foobar.exe', binary, { executable: true });
    expect(await adapter.readBinary('app/1.0.0/foobar.exe')).toEqual(binary);
    expect(await adapter.exists('app/1.0.0/foobar.exe')).toBe(true);

    const stat = await adapter.stat('app/1.0.0/foobar.exe');
    expect(stat?.size).toBe(binary.length);
    expect(stat?.modifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    await adapter.delete('app/1.0.0/foobar.exe');
    expect(await adapter.exists('app/1.0.0/foobar.exe')).toBe(false);
    expect(await adapter.readBinary('app/1.0.0/foobar.exe')).toBeNull();
    expect(await adapter.stat('app/1.0.0/foobar.exe')).toBeNull();
    // 幂等删除
    await expect(adapter.delete('app/1.0.0/foobar.exe')).resolves.toBeUndefined();
  });

  it('嵌套目录 + list 前缀语义与内存实现一致', async () => {
    await adapter.probe();
    await adapter.writeText('channel.json', '{}');
    await adapter.writeText('app/1.0.0/files.json', '{}');
    await adapter.writeText('app/1.0.0/resources/a.txt', 'a');
    await adapter.writeText('app/2.0.0/files.json', '{}');

    expect((await adapter.list('')).map((entry) => entry.key)).toEqual([
      'app/1.0.0/files.json',
      'app/1.0.0/resources/a.txt',
      'app/2.0.0/files.json',
      'channel.json',
    ]);
    expect((await adapter.list('app/')).map((entry) => entry.key)).toEqual([
      'app/1.0.0/files.json',
      'app/1.0.0/resources/a.txt',
      'app/2.0.0/files.json',
    ]);
    expect((await adapter.list('app/1.0.0/')).map((entry) => entry.key)).toEqual([
      'app/1.0.0/files.json',
      'app/1.0.0/resources/a.txt',
    ]);
    // 不带结尾斜杠时等价于 "前缀 + /"（与 MemoryStorageAdapter 一致）
    expect((await adapter.list('app/1.0.0')).map((entry) => entry.key)).toEqual([
      'app/1.0.0/files.json',
      'app/1.0.0/resources/a.txt',
    ]);
    expect(await adapter.list('not-exists/')).toEqual([]);
    expect(await adapter.list('nothing')).toEqual([]);

    const stat = await adapter.stat('app/1.0.0/resources/a.txt');
    expect(stat?.size).toBe(1);
  });

  it('getDownloadUrl 生成的地址可通过静态服务器真实下载（含 Unicode 路径）', async () => {
    const rootDir = adapter.rootDir;
    await adapter.probe();
    await adapter.writeBinary('app/1.0.1/中文 文件.bin', Buffer.from('下载内容-中文'));
    const server: StaticServer = await startStaticServer(rootDir);
    try {
      const config = LocalStorageConfigSchema.parse({
        provider: 'local',
        rootDir,
        publicBaseUrl: server.baseUrl,
      });
      const httpAdapter = new LocalStorageAdapter(config);
      const url = await httpAdapter.getDownloadUrl('app/1.0.1/中文 文件.bin');
      expect(url.startsWith(server.baseUrl)).toBe(true);
      expect(url).not.toContain('?');
      const response = await fetch(url);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('下载内容-中文');
      expect(server.requests.some((request) => decodeURIComponent(request).includes('中文 文件.bin'))).toBe(
        true,
      );
      await httpAdapter.close();
    } finally {
      await server.close();
    }
  });

  it('拒绝非法 key（绝对逃逸、..、空字符、Windows 保留名），且不会写出 rootDir', async () => {
    await adapter.probe();
    const outsideFile = path.join(tempDir, 'outside.txt');
    const escapeKeys = ['../outside.txt', 'a/../../outside.txt', 'a\\..\\..\\outside.txt', 'nul', 'CON.txt'];

    for (const key of escapeKeys) {
      await expectAppError(adapter.writeText(key, 'evil'), 'SECURITY');
      await expectAppError(adapter.readText(key), 'SECURITY');
      await expectAppError(adapter.getDownloadUrl(key), 'SECURITY');
    }
    await expectAppError(adapter.writeText('', 'empty'), 'VALIDATION');
    await expectAppError(adapter.writeText('bad\0key', 'nul-byte'), 'SECURITY');
    expect(await pathExists(outsideFile)).toBe(false);
  });

  it('probe 在 rootDir 不可用（路径被普通文件占用）时抛出 STORAGE', async () => {
    const filePath = path.join(tempDir, 'blocked');
    await fs.writeFile(filePath, 'occupied');
    const broken = makeAdapter({ rootDir: filePath });
    try {
      await expectAppError(broken.probe(), 'STORAGE');
    } finally {
      await broken.close();
    }
  });

  it('stat 对目录 key 返回 null，writeBinary 拒绝非 Buffer 数据', async () => {
    await adapter.probe();
    await adapter.writeText('dir/file.txt', 'x');
    expect(await adapter.stat('dir')).toBeNull();

    await expectAppError(
      adapter.writeBinary('dir/bad.bin', 'not-a-buffer' as unknown as Buffer),
      'VALIDATION',
    );
    await expectAppError(adapter.writeText('dir/bad.txt', 123 as unknown as string), 'VALIDATION');
  });
});
