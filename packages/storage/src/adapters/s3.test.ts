import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import net from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppError, isAppError, S3StorageConfigSchema } from '@apphub/protocol';
import type { S3StorageConfig } from '@apphub/protocol';
import { listFilesRecursive, startS3TestServer } from '@apphub/testkit';
import type { S3TestServer } from '@apphub/testkit';
import { S3StorageAdapter } from './s3';

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

describe('S3StorageAdapter', () => {
  let server: S3TestServer;
  let adapter: S3StorageAdapter;

  function makeConfig(overrides: Partial<S3StorageConfig> = {}): S3StorageConfig {
    return S3StorageConfigSchema.parse({
      provider: 's3',
      endpoint: server.endpoint,
      region: 'us-east-1',
      bucket: server.bucket,
      accessKey: server.accessKey,
      secretKey: server.secretKey,
      pathStyle: true,
      secure: false,
      prefix: 'apphub/',
      ...overrides,
    });
  }

  beforeAll(async () => {
    server = await startS3TestServer({ buckets: ['apphub-test'] });
  });

  afterAll(async () => {
    await server.close();
  });

  beforeEach(async () => {
    adapter = new S3StorageAdapter(makeConfig());
    // 清空桶内对象，保证每个测试的 list 断言互不影响
    for (const entry of await adapter.list('')) {
      await adapter.delete(entry.key);
    }
  });

  afterEach(async () => {
    await adapter.close();
  });

  it('probe 校验 bucket 存在；bucket 不存在时 probe 抛 NOT_FOUND', async () => {
    await expect(adapter.probe()).resolves.toBeUndefined();

    const missingBucket = new S3StorageAdapter(makeConfig({ bucket: 'no-such-bucket' }));
    try {
      const error = await expectAppError(missingBucket.probe(), 'NOT_FOUND');
      expect(error.message).toContain('no-such-bucket');
    } finally {
      await missingBucket.close();
    }
  });

  it('CRUD：文本/二进制、exists、stat、delete 幂等；对象按 prefix 真实落盘', async () => {
    await adapter.writeText('channel.json', '{"name":"S3 频道"}');
    expect(await adapter.readText('channel.json')).toBe('{"name":"S3 频道"}');
    expect(await adapter.exists('channel.json')).toBe(true);

    const binary = Buffer.from([0, 1, 2, 3, 255, 254, 128]);
    await adapter.writeBinary('app/1.0.0/foobar.exe', binary, { contentType: 'application/octet-stream' });
    expect(await adapter.readBinary('app/1.0.0/foobar.exe')).toEqual(binary);

    const stat = await adapter.stat('app/1.0.0/foobar.exe');
    expect(stat?.size).toBe(binary.length);
    expect(stat?.modifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // s3rver 把对象数据以文件形式存到 <directory>/<bucket>/<objectName>._S3rver_object
    const storedFiles = await listFilesRecursive(server.directory);
    expect(storedFiles).toContain(
      `${server.bucket}/apphub/app/1.0.0/foobar.exe._S3rver_object`,
    );

    await adapter.delete('app/1.0.0/foobar.exe');
    expect(await adapter.exists('app/1.0.0/foobar.exe')).toBe(false);
    expect(await adapter.readBinary('app/1.0.0/foobar.exe')).toBeNull();
    expect(await adapter.stat('app/1.0.0/foobar.exe')).toBeNull();
    await expect(adapter.delete('app/1.0.0/foobar.exe')).resolves.toBeUndefined();
  });

  it('缺失对象返回 null / false，而不是抛错', async () => {
    expect(await adapter.readText('missing.json')).toBeNull();
    expect(await adapter.readBinary('missing/deep.bin')).toBeNull();
    expect(await adapter.exists('missing.json')).toBe(false);
    expect(await adapter.stat('missing.json')).toBeNull();
  });

  it('1MB 二进制往返一致', async () => {
    const payload = randomBytes(1024 * 1024);
    await adapter.writeBinary('app/1.0.0/big.bin', payload);
    const readBack = await adapter.readBinary('app/1.0.0/big.bin');
    expect(readBack).not.toBeNull();
    expect(readBack!.equals(payload)).toBe(true);
    expect((await adapter.stat('app/1.0.0/big.bin'))?.size).toBe(payload.length);
  });

  it('list 递归列出前缀下对象（返回值不含配置的 prefix）', async () => {
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
    expect(await adapter.list('not-exists/')).toEqual([]);
  });

  it('配置 publicBaseUrl 时生成公开下载地址，且地址可直接 GET（匿名读）', async () => {
    const publicBaseUrl = `${server.endpoint}/${server.bucket}/`;
    const publicAdapter = new S3StorageAdapter(makeConfig({ publicBaseUrl }));
    try {
      await publicAdapter.writeBinary('app/1.0.1/中文 文件.bin', Buffer.from('公开下载内容'));
      const url = await publicAdapter.getDownloadUrl('app/1.0.1/中文 文件.bin');
      expect(url.startsWith(publicBaseUrl)).toBe(true);
      // prefix + key 都在公开地址里
      expect(decodeURIComponent(url)).toBe(
        `${publicBaseUrl}apphub/app/1.0.1/中文 文件.bin`,
      );

      const response = await fetch(url);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('公开下载内容');
    } finally {
      await publicAdapter.close();
    }
  });

  it('未配置 publicBaseUrl 时返回可用的预签名 URL（7 天有效）', async () => {
    await adapter.writeText('app/1.0.0/files.json', '{"kind":"apphub-files"}');
    const url = await adapter.getDownloadUrl('app/1.0.0/files.json');
    expect(url.startsWith(server.endpoint)).toBe(true);
    expect(url).toContain('X-Amz-Signature');
    expect(url).toContain('X-Amz-Expires=604800');

    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"kind":"apphub-files"}');
  });

  it('错误凭据 probe 抛 AUTH，且错误信息不含 secretKey', async () => {
    const bad = new S3StorageAdapter(makeConfig({ accessKey: 'BADKEY', secretKey: 'bad-secret-key' }));
    try {
      const error = await expectAppError(bad.probe(), 'AUTH');
      expect(error.message).not.toContain('bad-secret-key');
      expect(error.message).not.toContain(server.secretKey);
    } finally {
      await bad.close();
    }
  });

  it('连接失败（端口未监听）probe 抛 NETWORK', async () => {
    const closedPort = await getUnusedPort();
    const unreachable = new S3StorageAdapter(
      makeConfig({ endpoint: `http://127.0.0.1:${closedPort}` }),
    );
    try {
      await expectAppError(unreachable.probe(), 'NETWORK');
    } finally {
      await unreachable.close();
    }
  });

  it('endpoint 带子路径时抛 UNSUPPORTED（minio SDK 不支持 path 形式 endpoint）', async () => {
    const invalid = new S3StorageAdapter(makeConfig({ endpoint: `${server.endpoint}/s3` }));
    try {
      const error = await expectAppError(invalid.probe(), 'UNSUPPORTED');
      expect(error.message).toContain('/s3');
    } finally {
      await invalid.close();
    }
  });

  it('拒绝非法 key 与非法 prefix', async () => {
    for (const key of ['../escape.txt', 'app/../../escape.txt', 'nul', 'a\0b']) {
      await expectAppError(adapter.writeText(key, 'evil'), 'SECURITY');
      await expectAppError(adapter.readText(key), 'SECURITY');
      await expectAppError(adapter.getDownloadUrl(key), 'SECURITY');
    }
    await expectAppError(adapter.writeText('', 'empty'), 'VALIDATION');

    expect(() => new S3StorageAdapter(makeConfig({ prefix: '../escape/' }))).toThrow(AppError);
  });

  it('prefix 为空时对象直接位于桶根目录', async () => {
    const noPrefix = new S3StorageAdapter(makeConfig({ prefix: '' }));
    try {
      await noPrefix.writeText('channel.json', '{}');
      const storedFiles = await listFilesRecursive(server.directory);
      expect(storedFiles).toContain(`${server.bucket}/channel.json._S3rver_object`);
      expect(await noPrefix.readText('channel.json')).toBe('{}');
      expect((await noPrefix.list('')).map((entry) => entry.key)).toContain('channel.json');
    } finally {
      await noPrefix.delete('channel.json');
      await noPrefix.close();
    }
  });
});
