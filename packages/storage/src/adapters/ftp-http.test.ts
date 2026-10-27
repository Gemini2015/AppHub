import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { AddressInfo } from 'node:net';
import net from 'node:net';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppError, FtpHttpStorageConfigSchema, isAppError } from '@apphub/protocol';
import type { FtpHttpStorageConfig } from '@apphub/protocol';
import {
  createTempDir,
  listFilesRecursive,
  pathExists,
  safeRemove,
  startFtpTestServer,
  startStaticServer,
} from '@apphub/testkit';
import type { FtpTestServer, StaticServer } from '@apphub/testkit';
import { FtpHttpStorageAdapter } from './ftp-http';

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

/** 取一个当前没有进程监听的本地端口（用于验证连接失败路径）。 */
async function getUnusedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe('FtpHttpStorageAdapter', () => {
  const rootDirSetting = 'app_repo/';
  let tempDir: string;
  let repoDir: string;
  let ftpServer: FtpTestServer;
  let staticServer: StaticServer;
  let adapter: FtpHttpStorageAdapter;

  function makeConfig(overrides: Partial<FtpHttpStorageConfig['ftp']> = {}): FtpHttpStorageConfig {
    return FtpHttpStorageConfigSchema.parse({
      provider: 'ftp-http',
      ftp: {
        host: ftpServer.host,
        port: ftpServer.port,
        user: ftpServer.user,
        password: ftpServer.password,
        rootDir: rootDirSetting,
        // GitHub Actions Windows runner 可能较慢；给 socket 留出更充足的超时。
        timeoutMs: 60_000,
        ...overrides,
      },
      http: { baseUrl: staticServer.baseUrl },
    });
  }

  beforeAll(async () => {
    tempDir = await createTempDir('apphub-ftp-test-');
    repoDir = path.join(tempDir, 'app_repo');
    staticServer = await startStaticServer(repoDir);
    ftpServer = await startFtpTestServer({ rootDir: tempDir });
  });

  afterAll(async () => {
    await ftpServer.close();
    await staticServer.close();
    await safeRemove(tempDir);
  });

  beforeEach(() => {
    adapter = new FtpHttpStorageAdapter(makeConfig());
  });

  afterEach(async () => {
    await adapter.close();
    await fs.rm(repoDir, { recursive: true, force: true });
  });

  it('probe 连接 FTP 并自动创建 rootDir，重复 probe 幂等', async () => {
    expect(await pathExists(repoDir)).toBe(false);
    await adapter.probe();
    expect(await pathExists(repoDir)).toBe(true);
    expect(await adapter.list('')).toEqual([]);
    await adapter.probe();
    expect(await adapter.list('')).toEqual([]);
  });

  it('CRUD：写文本/二进制、读回、exists、stat、delete 幂等', async () => {
    await adapter.probe();
    await adapter.writeText('channel.json', '{"name":"示例频道"}');
    expect(await adapter.readText('channel.json')).toBe('{"name":"示例频道"}');

    const binary = Buffer.from([0, 1, 2, 3, 255, 254, 128]);
    await adapter.writeText('app/1.0.0/files.json', '{}');
    await adapter.writeBinary('app/1.0.0/foobar.exe', binary);
    expect(await adapter.readBinary('app/1.0.0/foobar.exe')).toEqual(binary);
    expect(await adapter.exists('app/1.0.0/foobar.exe')).toBe(true);

    const stat = await adapter.stat('app/1.0.0/foobar.exe');
    expect(stat?.size).toBe(binary.length);
    expect(stat?.modifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    await adapter.delete('app/1.0.0/foobar.exe');
    expect(await adapter.exists('app/1.0.0/foobar.exe')).toBe(false);
    expect(await adapter.readBinary('app/1.0.0/foobar.exe')).toBeNull();
    expect(await adapter.stat('app/1.0.0/foobar.exe')).toBeNull();
    await expect(adapter.delete('app/1.0.0/foobar.exe')).resolves.toBeUndefined();
  });

  it('写入深层路径时自动创建父目录（FTP 侧真实落盘）', async () => {
    await adapter.writeBinary('app/1.0.0/resources/nested/data.bin', Buffer.from('deep'));
    const localFile = path.join(repoDir, 'app', '1.0.0', 'resources', 'nested', 'data.bin');
    expect(await pathExists(localFile)).toBe(true);
    expect(await fs.readFile(localFile, 'utf8')).toBe('deep');
  });

  it('Unicode 文件名与空格往返正常，并可通过 HTTP 下载', async () => {
    const key = 'app/1.0.0/中文 文件.txt';
    await adapter.writeText(key, '中文内容 with spaces');
    expect(await adapter.readText(key)).toBe('中文内容 with spaces');
    expect(await adapter.exists(key)).toBe(true);

    const entries = await adapter.list('app/1.0.0/');
    expect(entries.map((entry) => entry.key)).toEqual([key]);

    const url = await adapter.getDownloadUrl(key);
    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('中文内容 with spaces');
  });

  it('1MB 二进制往返一致', async () => {
    const payload = randomBytes(1024 * 1024);
    await adapter.writeBinary('app/1.0.0/big.bin', payload);
    const readBack = await adapter.readBinary('app/1.0.0/big.bin');
    expect(readBack).not.toBeNull();
    expect(readBack!.length).toBe(payload.length);
    expect(readBack!.equals(payload)).toBe(true);
    expect((await adapter.stat('app/1.0.0/big.bin'))?.size).toBe(payload.length);
  });

  it('缺失对象返回 null / false，而不是抛错；读取缺失路径不会创建目录', async () => {
    await adapter.probe();
    expect(await adapter.readText('missing.json')).toBeNull();
    expect(await adapter.readBinary('missing/deep.bin')).toBeNull();
    expect(await adapter.exists('missing.json')).toBe(false);
    expect(await adapter.stat('missing.json')).toBeNull();
    expect(await pathExists(path.join(repoDir, 'missing'))).toBe(false);
  });

  it('list 递归列出前缀下全部对象，前缀语义与内存实现一致', async () => {
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
    expect((await adapter.list('app/1.0.0')).map((entry) => entry.key)).toEqual([
      'app/1.0.0/files.json',
      'app/1.0.0/resources/a.txt',
    ]);
    expect(await adapter.list('not-exists/')).toEqual([]);
  });

  it('并发写入被串行化：并行写 12 个对象后全部可正确读取', async () => {
    await adapter.probe();
    const payloads = new Map<string, Buffer>();
    for (let index = 0; index < 12; index += 1) {
      const key = `app/1.0.0/dir${index % 4}/file-${index}.bin`;
      payloads.set(key, randomBytes(2048 + index));
    }

    await Promise.all(
      [...payloads.entries()].map(([key, data]) => adapter.writeBinary(key, data)),
    );

    for (const [key, data] of payloads) {
      const readBack = await adapter.readBinary(key);
      expect(readBack, key).not.toBeNull();
      expect(readBack!.equals(data), key).toBe(true);
    }

    // 读写交错：同一批对象并行读取，内容仍然正确
    const readResults = await Promise.all([...payloads.keys()].map((key) => adapter.readBinary(key)));
    readResults.forEach((result, index) => {
      const key = [...payloads.keys()][index]!;
      expect(result!.equals(payloads.get(key)!), key).toBe(true);
    });
  });

  it('错误凭据 probe 抛 AUTH，且错误信息不含密码', async () => {
    const wrong = new FtpHttpStorageAdapter(makeConfig({ password: 'wrong-password-123' }));
    try {
      const error = await expectAppError(wrong.probe(), 'AUTH');
      expect(error.message).not.toContain('wrong-password-123');
      expect(error.message).not.toContain(ftpServer.password);
      expect(error.message).toContain('530');
    } finally {
      await wrong.close();
    }
  });

  it('连接失败（端口未监听）probe 抛 NETWORK', async () => {
    const closedPort = await getUnusedPort();
    const unreachable = new FtpHttpStorageAdapter(makeConfig({ port: closedPort }));
    try {
      const error = await expectAppError(unreachable.probe(), 'NETWORK');
      expect(error.message).not.toContain(ftpServer.password);
    } finally {
      await unreachable.close();
    }
  });

  it('拒绝非法 key，且不会写出 rootDir 之外', async () => {
    await adapter.probe();
    const outsideFile = path.join(tempDir, 'outside.txt');
    for (const key of ['../outside.txt', 'app/../../outside.txt', 'nul', 'a\0b']) {
      await expectAppError(adapter.writeText(key, 'evil'), 'SECURITY');
      await expectAppError(adapter.readText(key), 'SECURITY');
      await expectAppError(adapter.getDownloadUrl(key), 'SECURITY');
    }
    await expectAppError(adapter.writeText('', 'empty'), 'VALIDATION');
    expect(await pathExists(outsideFile)).toBe(false);
  });

  it('非法 rootDir 在构造时抛 VALIDATION', () => {
    expect(() => new FtpHttpStorageAdapter(makeConfig({ rootDir: '../escape' }))).toThrow(AppError);
    try {
      new FtpHttpStorageAdapter(makeConfig({ rootDir: '../escape' }));
    } catch (error) {
      expect(isAppError(error) && error.code).toBe('VALIDATION');
    }
  });

  it('passive=false 时 probe 抛 UNSUPPORTED（basic-ftp 仅支持被动模式）', async () => {
    const activeMode = new FtpHttpStorageAdapter(makeConfig({ passive: false }));
    try {
      await expectAppError(activeMode.probe(), 'UNSUPPORTED');
    } finally {
      await activeMode.close();
    }
  });

  it('close 后继续操作抛 STATE；重复 close 不抛错', async () => {
    await adapter.probe();
    await adapter.close();
    await expect(adapter.close()).resolves.toBeUndefined();
    await expectAppError(adapter.readText('channel.json'), 'STATE');
  });

  it('FTP 写入的文件确实落在 rootDir 下（供 nginx 静态服务读取）', async () => {
    await adapter.writeText('app/1.0.0/files.json', '{"kind":"apphub-files"}');
    const files = await listFilesRecursive(repoDir);
    expect(files).toContain('app/1.0.0/files.json');
  });
});
