import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { AppError } from '@apphub/protocol';
import { createTempDir, makeZipBuffer, pathExists, safeRemove, sleep } from '@apphub/testkit';
import { createAppHubCore, createZipFromDirectory, inspectZipArchive } from './index';
import { KeyedMutex } from './mutex';
import { hashFile, readJsonFile, safeJoin, writeJsonAtomic } from './fs';
import { redactUrl } from './errors';
import { createTestEnv, expectAppError, type TestEnv } from './test-helpers';

const envs: TestEnv[] = [];
const tempDirs: string[] = [];

async function newEnv(options: Parameters<typeof createTestEnv>[0] = {}): Promise<TestEnv> {
  const env = await createTestEnv(options);
  envs.push(env);
  return env;
}

async function tempDir(): Promise<string> {
  const dir = await createTempDir('apphub-infra-');
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (envs.length > 0) await envs.pop()!.dispose();
  while (tempDirs.length > 0) await safeRemove(tempDirs.pop()!);
});

/**
 * 把 zip 中某个条目标记为 unix 符号链接（改写中央目录的 externalFileAttributes）。
 * fflate 的公共 API 不暴露该属性，这里直接按 ZIP 中央目录结构改写，用于安全测试。
 */
function markZipEntryAsSymlink(zipBuffer: Buffer, entryName: string): Buffer {
  const buffer = Buffer.from(zipBuffer);
  const targetName = Buffer.from(entryName, 'utf8');
  const CENTRAL_SIGNATURE = 0x02014b50;
  for (let offset = 0; offset + 46 <= buffer.length; offset += 1) {
    if (buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE) continue;
    const nameLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 46;
    if (nameStart + nameLength > buffer.length) continue;
    const name = buffer.subarray(nameStart, nameStart + nameLength);
    if (!name.equals(targetName)) continue;
    // version made by：低字节 version=20，高字节 OS=3（Unix）
    buffer.writeUInt16LE(0x0314, offset + 4);
    // externalFileAttributes：高 16 位 = unix mode（S_IFLNK | 0777）
    buffer.writeUInt32LE((0o120777 << 16) >>> 0, offset + 38);
    return buffer;
  }
  throw new Error(`ZIP 中央目录中未找到条目：${entryName}`);
}

describe('ZIP 工具（inspectZipArchive / createZipFromDirectory）', () => {
  it('inspectZipArchive 列出文件大小并推荐 .exe 作为入口', async () => {
    const dir = await tempDir();
    const zipPath = path.join(dir, 'app.zip');
    await fs.writeFile(
      zipPath,
      makeZipBuffer({
        'readme.txt': 'hello',
        'bin/game.exe': 'exe-binary',
        'tools/helper.exe': 'helper',
        'deep/nested/tool.exe': 'deep',
      }),
    );
    const inspection = await inspectZipArchive(zipPath);
    expect(inspection.files.map((file) => file.path).sort()).toEqual([
      'bin/game.exe',
      'deep/nested/tool.exe',
      'readme.txt',
      'tools/helper.exe',
    ]);
    const byPath = new Map(inspection.files.map((file) => [file.path, file.size]));
    expect(byPath.get('readme.txt')).toBe(5);
    expect(byPath.get('bin/game.exe')).toBe('exe-binary'.length);
    expect(inspection.suggestedEntry).toBe('bin/game.exe');
  });

  it('没有已知可执行扩展名时推荐第一个文件', async () => {
    const dir = await tempDir();
    const zipPath = path.join(dir, 'data.zip');
    await fs.writeFile(zipPath, makeZipBuffer({ 'data.bin': 'bb', 'readme.txt': 'a' }));
    const inspection = await inspectZipArchive(zipPath);
    expect(inspection.files[0]).toEqual({ path: 'data.bin', size: 2 });
    expect(inspection.suggestedEntry).toBe('data.bin');
  });

  it('inspectZipArchive 拒绝 zip-slip / 空压缩包 / 不存在的文件', async () => {
    const dir = await tempDir();
    const slipZip = path.join(dir, 'slip.zip');
    await fs.writeFile(slipZip, makeZipBuffer({ '../evil.txt': 'evil' }));
    const error = await expectAppError(inspectZipArchive(slipZip), 'SECURITY');
    expect(error.message).toContain('zip-slip');

    const emptyZip = path.join(dir, 'empty.zip');
    await fs.writeFile(emptyZip, makeZipBuffer({}));
    await expectAppError(inspectZipArchive(emptyZip), 'VALIDATION');

    await expectAppError(inspectZipArchive(path.join(dir, 'missing.zip')), 'NOT_FOUND');
    const notZip = path.join(dir, 'not.zip');
    await fs.writeFile(notZip, 'definitely not a zip');
    await expectAppError(inspectZipArchive(notZip), 'VALIDATION');
  });

  it('拒绝 zip 内的符号链接条目（SECURITY）', async () => {
    const dir = await tempDir();
    const zipPath = path.join(dir, 'symlink.zip');
    const buffer = markZipEntryAsSymlink(
      makeZipBuffer({ link: '../outside', 'ok.txt': 'ok' }),
      'link',
    );
    await fs.writeFile(zipPath, buffer);
    const error = await expectAppError(inspectZipArchive(zipPath), 'SECURITY');
    expect(error.message).toContain('符号链接');
  });

  it('createZipFromDirectory 打包目录并支持 cleanup（幂等）', async () => {
    const dir = await tempDir();
    const nested = path.join(dir, 'src', 'bin');
    await fs.mkdir(nested, { recursive: true });
    await fs.writeFile(path.join(dir, 'src', 'readme.txt'), 'hi');
    await fs.writeFile(path.join(nested, 'run.exe'), 'run');

    const created = await createZipFromDirectory(path.join(dir, 'src'));
    expect(await pathExists(created.zipPath)).toBe(true);
    const inspection = await inspectZipArchive(created.zipPath);
    expect(inspection.files.map((file) => file.path).sort()).toEqual(['bin/run.exe', 'readme.txt']);
    expect(inspection.suggestedEntry).toBe('bin/run.exe');

    const zipDir = path.dirname(created.zipPath);
    await created.cleanup();
    expect(await pathExists(zipDir)).toBe(false);
    await created.cleanup();
  });

  it('createZipFromDirectory 拒绝空目录/不存在的目录', async () => {
    const dir = await tempDir();
    await expectAppError(createZipFromDirectory(path.join(dir, 'nope')), 'NOT_FOUND');
    const empty = path.join(dir, 'empty');
    await fs.mkdir(empty);
    await expectAppError(createZipFromDirectory(empty), 'VALIDATION');
  });

  it('createZipFromDirectory 拒绝符号链接（若当前环境允许创建链接）', async () => {
    const dir = await tempDir();
    const root = path.join(dir, 'root');
    const outside = path.join(dir, 'outside');
    await fs.mkdir(root);
    await fs.mkdir(outside);
    await fs.writeFile(path.join(root, 'ok.txt'), 'ok');
    try {
      await fs.symlink(outside, path.join(root, 'link'), 'junction');
    } catch {
      return; // Windows 非开发者模式下可能创建链接失败，跳过该断言
    }
    const error = await expectAppError(createZipFromDirectory(root), 'SECURITY');
    expect(error.message).toContain('符号链接');
  });
});

describe('本地文件与状态基础设施', () => {
  it('writeJsonAtomic/readJsonFile 往返，损坏 JSON 抛 STATE', async () => {
    const dir = await tempDir();
    const filePath = path.join(dir, 'nested', 'state.json');
    await writeJsonAtomic(filePath, { hello: 'world', list: [1, 2, 3] });
    const data = await readJsonFile<{ hello: string; list: number[] }>(filePath, 'state.json');
    expect(data).toEqual({ hello: 'world', list: [1, 2, 3] });
    expect(await readJsonFile(path.join(dir, 'missing.json'), 'missing.json')).toBeNull();

    await fs.writeFile(filePath, '{broken');
    await expectAppError(readJsonFile(filePath, 'state.json'), 'STATE');
    await fs.writeFile(filePath, '[]');
    await expectAppError(readJsonFile(filePath, 'state.json'), 'STATE');
  });

  it('safeJoin 阻止路径逃逸与绝对路径', () => {
    // 使用与平台无关的绝对路径根（Windows 的 C:\... 在 Linux 上不是绝对路径，
    // 会导致该用例在 Linux CI 上失败）。
    const root = path.resolve('apphub-safejoin-root');
    expect(safeJoin(root, 'a/b.txt')).toBe(path.join(root, 'a', 'b.txt'));
    expect(() => safeJoin(root, '../evil.txt')).toThrow(AppError);
    expect(() => safeJoin(root, 'a/../../evil.txt')).toThrow(AppError);
    expect(() => safeJoin(root, 'C:/Windows/system32')).toThrow(AppError);
    expect(() => safeJoin(root, '/etc/passwd')).toThrow(AppError);
    expect(() => safeJoin(root, '\\\\server\\share\\evil')).toThrow(AppError);
  });

  it('writeFileAtomic 在目标文件短暂被占用时重试成功（Windows EPERM/EBUSY 兼容）', async () => {
    const dir = await tempDir();
    const filePath = path.join(dir, 'atomic.json');
    await writeJsonAtomic(filePath, { version: 1 });

    // 持有目标文件句柄期间尝试原子替换：Windows 上可能返回 EPERM/EBUSY，
    // writeFileAtomic 应重试；句柄释放后成功（其它平台会直接成功，同样通过）。
    const handle = await fs.open(filePath, 'r');
    const pending = writeJsonAtomic(filePath, { version: 2 });
    const observed = pending.then(
      () => undefined,
      (error: unknown) => error,
    );
    await sleep(50);
    await handle.close();
    const outcome = await observed;
    expect(outcome).toBeUndefined();
    expect(await readJsonFile<{ version: number }>(filePath, 'atomic.json')).toEqual({
      version: 2,
    });
  });

  it('hashFile 计算 size+MD5（流式）', async () => {
    const dir = await tempDir();
    const filePath = path.join(dir, 'blob.bin');
    const content = Buffer.from('x'.repeat(10_000));
    await fs.writeFile(filePath, content);
    const result = await hashFile(filePath);
    expect(result.size).toBe(10_000);
    expect(result.md5).toBe(createHash('md5').update(content).digest('hex'));
  });

  it('KeyedMutex 同 key 串行、不同 key 并行', async () => {
    const mutex = new KeyedMutex();
    const order: string[] = [];
    await Promise.all([
      mutex.runExclusive('same', async () => {
        order.push('a:start');
        await sleep(20);
        order.push('a:end');
      }),
      mutex.runExclusive('same', async () => {
        order.push('b:start');
      }),
      mutex.runExclusive('other', async () => {
        order.push('c:start');
      }),
    ]);
    expect(order.indexOf('b:start')).toBeGreaterThan(order.indexOf('a:end'));
    expect(order).toContain('c:start');
    expect(mutex.pendingKeys()).toHaveLength(0);
  });

  it('KeyedMutex 前一个任务抛错不会阻塞后续任务', async () => {
    const mutex = new KeyedMutex();
    const failing = mutex.runExclusive('k', async () => {
      throw new Error('boom');
    });
    await expect(failing).rejects.toThrow('boom');
    const value = await mutex.runExclusive('k', async () => 42);
    expect(value).toBe(42);
  });

  it('redactUrl 隐藏 accessKey、查询串与 userinfo', () => {
    const redacted = redactUrl(
      'https://user:pass@example.com/repo/_private/ch_0123456789abcdef0123/secretkey0123456789/channel.json?X-Amz-Signature=abc',
    );
    expect(redacted).not.toContain('secretkey0123456789');
    expect(redacted).not.toContain('X-Amz-Signature');
    expect(redacted).not.toContain('pass');
    expect(redacted).toContain('_private/ch_0123456789abcdef0123/***/channel.json');
    expect(redactUrl('not a url')).toBe('<非法地址>');
  });
});

describe('createAppHubCore 上下文校验', () => {
  it('校验 dataDir/storageFactory/secretBox/keepVersions', async () => {
    const env = await newEnv();
    expect(() => createAppHubCore({ dataDir: '' } as never)).toThrow(AppError);
    expect(() =>
      createAppHubCore({ dataDir: env.dataDir, storageFactory: env.factory } as never),
    ).toThrow(AppError);
    expect(() =>
      createAppHubCore({
        dataDir: env.dataDir,
        storageFactory: env.factory,
        secretBox: env.secretBox,
        keepVersions: 0,
        fetchImpl: env.fetch,
      }),
    ).toThrow(AppError);
    expect(() =>
      createAppHubCore({
        dataDir: env.dataDir,
        storageFactory: env.factory,
        secretBox: env.secretBox,
        fetchImpl: env.fetch,
      }),
    ).not.toThrow();
  });

  it('暴露绝对 dataDir，空环境 list 返回空数组且 close 幂等', async () => {
    const env = await newEnv();
    expect(env.core.dataDir).toBe(path.resolve(env.dataDir));
    expect(await env.core.channels.list()).toEqual([]);
    expect(await env.core.library.list()).toEqual([]);
    expect(await env.core.library.checkUpdates()).toEqual([]);
    await env.core.close();
    await env.core.close();
  });

  it('进度回调抛异常不会中断发布流程', async () => {
    const env = await newEnv();
    const channel = await env.createChannel();
    const dir = await tempDir();
    const source = path.join(dir, 'app.exe');
    await fs.writeFile(source, 'x');
    const result = await env.core.publishing.publish({
      channelId: channel.id,
      app: { appId: 'demo', displayName: 'Demo' },
      version: '1.0.0',
      platform: 'windows',
      publishMode: 'files',
      entry: 'app.exe',
      files: [{ sourcePath: source, targetPath: 'app.exe' }],
      onProgress: () => {
        throw new Error('UI 崩溃');
      },
    });
    expect(result.version).toBe('1.0.0');
  });
});
