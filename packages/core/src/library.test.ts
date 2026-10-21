import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { appMetaKey, versionArchiveKey } from '@apphub/protocol';
import { createTempDir, md5Hex, pathExists, readJsonFile, safeRemove, writeZip } from '@apphub/testkit';
import type { PublishFileInput } from './types';
import {
  createTestEnv,
  expectAppError,
  recordProgress,
  type TestEnv,
} from './test-helpers';

const envs: TestEnv[] = [];
const tempDirs: string[] = [];

async function newEnv(options: Parameters<typeof createTestEnv>[0] = {}): Promise<TestEnv> {
  const env = await createTestEnv(options);
  envs.push(env);
  return env;
}

afterEach(async () => {
  while (envs.length > 0) await envs.pop()!.dispose();
  while (tempDirs.length > 0) await safeRemove(tempDirs.pop()!);
});

async function fixture(files: Record<string, string | Buffer>): Promise<{
  dir: string;
  inputs: PublishFileInput[];
}> {
  const dir = await createTempDir('apphub-lib-src-');
  tempDirs.push(dir);
  const inputs: PublishFileInput[] = [];
  for (const [relativePath, content] of Object.entries(files)) {
    const absolute = path.join(dir, ...relativePath.split('/'));
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, content);
    inputs.push({ sourcePath: absolute, targetPath: relativePath });
  }
  return { dir, inputs };
}

async function zipFixture(files: Record<string, string | Buffer>): Promise<string> {
  const dir = await createTempDir('apphub-lib-zip-');
  tempDirs.push(dir);
  const zipPath = path.join(dir, 'input.zip');
  await writeZip(zipPath, files);
  return zipPath;
}

const APP = { appId: 'demo', displayName: 'Demo App', description: '', author: 'Alice' };

interface PublishedSetup {
  publisher: TestEnv;
  reader: TestEnv;
  channelId: string;
}

async function setupFilesPublished(readerOptions: Parameters<typeof createTestEnv>[0] = {}): Promise<
  PublishedSetup & { inputs: PublishFileInput[] }
> {
  const publisher = await newEnv();
  const channel = await publisher.createChannel({ name: '库频道' });
  const { inputs } = await fixture({
    'app.exe': 'exe-v1',
    'resources/data.bin': 'data-v1',
  });
  await publisher.core.publishing.publish({
    channelId: channel.id,
    app: APP,
    version: '1.0.0',
    platform: 'windows',
    publishMode: 'files',
    entry: 'app.exe',
    files: inputs,
  });
  const reader = await newEnv({ objects: publisher.objects, ...readerOptions });
  await reader.core.channels.subscribe({ url: channel.subscribeUrl });
  return { publisher, reader, channelId: channel.id, inputs };
}

async function publishNewFilesVersion(
  publisher: TestEnv,
  channelId: string,
  version: string,
  files: Record<string, string | Buffer>,
): Promise<PublishFileInput[]> {
  const { inputs } = await fixture(files);
  await publisher.core.publishing.publish({
    channelId,
    app: { appId: 'demo', displayName: 'Demo App' },
    version,
    platform: 'windows',
    publishMode: 'files',
    entry: 'app.exe',
    files: inputs,
  });
  return inputs;
}

async function readInstallJson(reader: TestEnv, channelId: string) {
  return readJsonFile<Record<string, unknown>>(
    path.join(reader.dataDir, 'library', channelId, 'demo', 'install.json'),
  );
}

describe('LibraryService.install - files 模式', () => {
  it('订阅者安装 files 版本：下载文件、写 install.json/索引、返回下载统计', async () => {
    const { publisher, reader, channelId } = await setupFilesPublished();
    const result = await reader.core.library.install({ channelId, appId: 'demo' });

    expect(result.app.version).toBe('1.0.0');
    expect(result.app.status).toBe('installed');
    expect(result.app.channelId).toBe(channelId);
    expect(result.app.platform).toBe('windows');
    expect(result.downloadedBytes).toBe('exe-v1'.length + 'data-v1'.length);
    expect(result.reusedBytes).toBe(0);
    expect(result.updatedFrom).toBeUndefined();

    const versionDir = path.join(reader.dataDir, 'library', channelId, 'demo', 'versions', '1.0.0');
    expect(await fs.readFile(path.join(versionDir, 'app.exe'), 'utf8')).toBe('exe-v1');
    expect(await fs.readFile(path.join(versionDir, 'resources', 'data.bin'), 'utf8')).toBe('data-v1');

    const install = await readInstallJson(reader, channelId);
    expect(install.version).toBe('1.0.0');
    expect(install.entry).toBe('app.exe');
    expect((install.files as { path: string }[]).map((file) => file.path).sort()).toEqual([
      'app.exe',
      'resources/data.bin',
    ]);

    const list = await reader.core.library.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ appId: 'demo', version: '1.0.0', status: 'installed' });

    const descriptor = await reader.core.library.getLaunchDescriptor(channelId, 'demo');
    expect(descriptor.entryPath).toBe(path.join(versionDir, 'app.exe'));
    expect(descriptor.cwd).toBe(versionDir);
    expect(descriptor.args).toEqual([]);
    expect(descriptor.appRoot).toBe(path.join(reader.dataDir, 'library', channelId, 'demo'));
    void publisher;
  });

  it('owner 通过存储适配器下载安装（不依赖频道 HTTP 地址）', async () => {
    const env = await newEnv();
    const channel = await env.createChannel({ name: 'owner 库' });
    const { inputs } = await fixture({ 'app.exe': 'owner' });
    await env.core.publishing.publish({
      channelId: channel.id,
      app: APP,
      version: '1.0.0',
      platform: 'windows',
      publishMode: 'files',
      entry: 'app.exe',
      files: inputs,
    });
    const result = await env.core.library.install({ channelId: channel.id, appId: 'demo' });
    expect(result.app.version).toBe('1.0.0');
    expect(
      await fs.readFile(
        path.join(env.dataDir, 'library', channel.id, 'demo', 'versions', '1.0.0', 'app.exe'),
        'utf8',
      ),
    ).toBe('owner');
  });

  it('更新时按 MD5 复用未变化文件，仅下载差异文件', async () => {
    const { publisher, reader, channelId } = await setupFilesPublished();
    await reader.core.library.install({ channelId, appId: 'demo' });
    await publishNewFilesVersion(publisher, channelId, '1.1.0', {
      'app.exe': 'exe-v2',
      'resources/data.bin': 'data-v1', // 未变化 → 复用
    });

    const updated = await reader.core.library.update({ channelId, appId: 'demo' });
    expect(updated.app.version).toBe('1.1.0');
    expect(updated.updatedFrom).toBe('1.0.0');
    expect(updated.reusedBytes).toBe('data-v1'.length);
    expect(updated.downloadedBytes).toBe('exe-v2'.length);
    expect(
      await fs.readFile(
        path.join(reader.dataDir, 'library', channelId, 'demo', 'versions', '1.1.0', 'app.exe'),
        'utf8',
      ),
    ).toBe('exe-v2');
    expect(
      await fs.readFile(
        path.join(
          reader.dataDir,
          'library',
          channelId,
          'demo',
          'versions',
          '1.1.0',
          'resources',
          'data.bin',
        ),
        'utf8',
      ),
    ).toBe('data-v1');
  });

  it('旧版本文件被破坏（同大小不同内容）时复用前校验 MD5，退回重新下载', async () => {
    const { publisher, reader, channelId } = await setupFilesPublished();
    await reader.core.library.install({ channelId, appId: 'demo' });
    const oldDataPath = path.join(
      reader.dataDir,
      'library',
      channelId,
      'demo',
      'versions',
      '1.0.0',
      'resources',
      'data.bin',
    );
    await fs.writeFile(oldDataPath, 'data-vX'); // 与 'data-v1' 同大小但内容不同
    await publishNewFilesVersion(publisher, channelId, '1.1.0', {
      'app.exe': 'exe-v2',
      'resources/data.bin': 'data-v1',
    });

    const updated = await reader.core.library.update({ channelId, appId: 'demo' });
    expect(updated.reusedBytes).toBe(0);
    expect(updated.downloadedBytes).toBe('exe-v2'.length + 'data-v1'.length);
    expect((await reader.core.library.verify(channelId, 'demo')).ok).toBe(true);
  });

  it('已是最新版本时 install 直接返回；force 会重新校验并复用文件', async () => {
    const { reader, channelId } = await setupFilesPublished();
    await reader.core.library.install({ channelId, appId: 'demo' });

    const noop = await reader.core.library.install({ channelId, appId: 'demo' });
    expect(noop.downloadedBytes).toBe(0);
    expect(noop.reusedBytes).toBe(0);

    const forced = await reader.core.library.install({ channelId, appId: 'demo', force: true });
    expect(forced.app.version).toBe('1.0.0');
    expect(forced.downloadedBytes).toBe(0);
    expect(forced.reusedBytes).toBe('exe-v1'.length + 'data-v1'.length);
  });

  it('支持指定版本安装，并在平台/版本不匹配时给出错误', async () => {
    const { publisher, reader, channelId } = await setupFilesPublished();
    await publishNewFilesVersion(publisher, channelId, '1.1.0', {
      'app.exe': 'exe-v2',
      'resources/data.bin': 'data-v1',
    });

    const old = await reader.core.library.install({
      channelId,
      appId: 'demo',
      version: '1.0.0',
    });
    expect(old.app.version).toBe('1.0.0');

    await expectAppError(
      reader.core.library.install({ channelId, appId: 'demo', version: '9.9.9' }),
      'NOT_FOUND',
    );
    await expectAppError(
      reader.core.library.install({ channelId, appId: 'demo', version: '1.0.0', platform: 'linux' }),
      'VALIDATION',
    );
    await expectAppError(
      reader.core.library.install({ channelId, appId: 'demo', platform: 'linux' }),
      'NOT_FOUND',
    );
    await expectAppError(
      reader.core.library.install({ channelId, appId: 'nope' }),
      'NOT_FOUND',
    );
    await expectAppError(
      reader.core.library.update({ channelId, appId: 'nope' }),
      'NOT_FOUND',
    );
  });

  it('update 在未安装时抛 NOT_FOUND', async () => {
    const { reader, channelId } = await setupFilesPublished();
    await expectAppError(
      reader.core.library.update({ channelId, appId: 'demo' }),
      'NOT_FOUND',
    );
  });

  it('安装进度事件包含 prepare/fetch/transfer/verify/commit，且字节进度单调', async () => {
    const { reader, channelId } = await setupFilesPublished();
    const recorder = recordProgress();
    await reader.core.library.install({
      channelId,
      appId: 'demo',
      onProgress: recorder.listener,
    });
    const phases = recorder.phases();
    for (const expected of ['prepare', 'fetch', 'transfer', 'verify', 'commit', 'cleanup']) {
      expect(phases).toContain(expected);
    }
    const transfers = recorder.events.filter((event) => event.phase === 'transfer');
    expect(transfers.length).toBeGreaterThan(0);
    const bytes = transfers.map((event) => event.transferredBytes ?? 0);
    for (let index = 1; index < bytes.length; index += 1) {
      expect(bytes[index]!).toBeGreaterThanOrEqual(bytes[index - 1]!);
    }
    expect(transfers.at(-1)!.percent).toBe(100);
  });

  it('文件下载损坏（size/MD5 不符）时失败回滚，旧版本保持可用', async () => {
    const { publisher, reader, channelId } = await setupFilesPublished();
    await reader.core.library.install({ channelId, appId: 'demo' });
    await publishNewFilesVersion(publisher, channelId, '1.1.0', {
      'app.exe': 'exe-v2',
      'resources/data.bin': 'data-v2',
    });
    reader.setFetchHook(({ key }) =>
      key === 'demo/1.1.0/app.exe'
        ? new Response(Buffer.from('corrupted-content'), {
            status: 200,
            headers: { 'content-length': String('corrupted-content'.length) },
          })
        : undefined,
    );

    const error = await expectAppError(
      reader.core.library.update({ channelId, appId: 'demo' }),
      'IO',
    );
    expect(error.message).toMatch(/校验失败|不一致/);

    const install = await readInstallJson(reader, channelId);
    expect(install.version).toBe('1.0.0');
    const verify = await reader.core.library.verify(channelId, 'demo');
    expect(verify.ok).toBe(true);
    // 临时目录已清理
    expect(await fs.readdir(path.join(reader.dataDir, 'tmp'))).toHaveLength(0);
  });
});

describe('LibraryService.install - zip 模式', () => {
  it('安装 zip 版本：校验压缩包后安全解压并按文件清单校验', async () => {
    const publisher = await newEnv();
    const channel = await publisher.createChannel({ name: 'zip 频道' });
    const zipPath = await zipFixture({ 'Game.exe': 'game-v1', 'data/pack.bin': 'pack-v1' });
    await publisher.core.publishing.publish({
      channelId: channel.id,
      app: APP,
      version: '1.0.0',
      platform: 'windows',
      publishMode: 'zip',
      entry: 'Game.exe',
      zipPath,
    });
    const reader = await newEnv({ objects: publisher.objects });
    await reader.core.channels.subscribe({ url: channel.subscribeUrl });

    const result = await reader.core.library.install({ channelId: channel.id, appId: 'demo' });
    expect(result.app.version).toBe('1.0.0');
    const versionDir = path.join(
      reader.dataDir,
      'library',
      channel.id,
      'demo',
      'versions',
      '1.0.0',
    );
    expect(await fs.readFile(path.join(versionDir, 'Game.exe'), 'utf8')).toBe('game-v1');
    expect(await fs.readFile(path.join(versionDir, 'data', 'pack.bin'), 'utf8')).toBe('pack-v1');
    const verify = await reader.core.library.verify(channel.id, 'demo');
    expect(verify.ok).toBe(true);
    const descriptor = await reader.core.library.getLaunchDescriptor(channel.id, 'demo');
    expect(descriptor.entryPath).toBe(path.join(versionDir, 'Game.exe'));
  });

  it('压缩包校验失败时回滚，旧版本安装保持可用', async () => {
    const publisher = await newEnv();
    const channel = await publisher.createChannel({ name: 'zip 回滚' });
    const zipV1 = await zipFixture({ 'Game.exe': 'v1' });
    await publisher.core.publishing.publish({
      channelId: channel.id,
      app: APP,
      version: '1.0.0',
      platform: 'windows',
      publishMode: 'zip',
      entry: 'Game.exe',
      zipPath: zipV1,
    });
    const reader = await newEnv({ objects: publisher.objects });
    await reader.core.channels.subscribe({ url: channel.subscribeUrl });
    await reader.core.library.install({ channelId: channel.id, appId: 'demo' });

    const zipV2 = await zipFixture({ 'Game.exe': 'v2-longer-content' });
    await publisher.core.publishing.publish({
      channelId: channel.id,
      app: { appId: 'demo', displayName: 'Demo App' },
      version: '2.0.0',
      platform: 'windows',
      publishMode: 'zip',
      entry: 'Game.exe',
      zipPath: zipV2,
    });

    reader.setFetchHook(({ key }) => {
      if (!key.endsWith('.zip')) return undefined;
      const object = reader.objects.get(key);
      if (!object || object.data.length === 0) return undefined;
      const corrupted = Buffer.from(object.data);
      corrupted[corrupted.length - 1] = corrupted[corrupted.length - 1]! ^ 0xff;
      return new Response(corrupted, {
        status: 200,
        headers: { 'content-length': String(corrupted.length) },
      });
    });

    await expectAppError(reader.core.library.update({ channelId: channel.id, appId: 'demo' }), 'IO');
    const install = await readInstallJson(reader, channel.id);
    expect(install.version).toBe('1.0.0');
    expect(await pathExists(path.join(reader.dataDir, 'library', channel.id, 'demo', 'versions', '2.0.0'))).toBe(false);
    expect((await reader.core.library.verify(channel.id, 'demo')).ok).toBe(true);
  });
});

describe('LibraryService.verify / uninstall / list', () => {
  it('verify 检测缺失、MD5/大小变化与多余文件', async () => {
    const { reader, channelId } = await setupFilesPublished();
    await reader.core.library.install({ channelId, appId: 'demo' });
    expect((await reader.core.library.verify(channelId, 'demo')).ok).toBe(true);

    const versionDir = path.join(reader.dataDir, 'library', channelId, 'demo', 'versions', '1.0.0');
    // 保持大小不变、修改内容 → 应报告 md5 不一致
    await fs.writeFile(path.join(versionDir, 'app.exe'), 'exe-vX');
    await fs.rm(path.join(versionDir, 'resources', 'data.bin'));
    await fs.writeFile(path.join(versionDir, 'extra.txt'), 'extra');
    const result = await reader.core.library.verify(channelId, 'demo');
    expect(result.ok).toBe(false);
    expect(result.checkedFiles).toBe(2);
    const reasons = new Map(result.mismatches.map((mismatch) => [mismatch.path, mismatch.reason]));
    expect(reasons.get('app.exe')).toBe('md5');
    expect(reasons.get('resources/data.bin')).toBe('missing');
    expect(reasons.get('extra.txt')).toBe('extra');
  });

  it('verify 报告文件大小不一致（size）', async () => {
    const { reader, channelId } = await setupFilesPublished();
    await reader.core.library.install({ channelId, appId: 'demo' });
    const versionDir = path.join(reader.dataDir, 'library', channelId, 'demo', 'versions', '1.0.0');
    await fs.writeFile(path.join(versionDir, 'resources', 'data.bin'), 'short');
    const result = await reader.core.library.verify(channelId, 'demo');
    expect(result.ok).toBe(false);
    expect(result.mismatches.find((mismatch) => mismatch.path === 'resources/data.bin')?.reason).toBe(
      'size',
    );
  });

  it('uninstall 删除 App 目录与索引，之后 launch/verify 报 NOT_FOUND', async () => {
    const { reader, channelId } = await setupFilesPublished();
    await reader.core.library.install({ channelId, appId: 'demo' });
    const appRoot = path.join(reader.dataDir, 'library', channelId, 'demo');
    expect(await pathExists(appRoot)).toBe(true);

    await reader.core.library.uninstall(channelId, 'demo');
    expect(await pathExists(appRoot)).toBe(false);
    expect(await reader.core.library.list()).toHaveLength(0);
    await expectAppError(reader.core.library.verify(channelId, 'demo'), 'NOT_FOUND');
    await expectAppError(reader.core.library.getLaunchDescriptor(channelId, 'demo'), 'NOT_FOUND');
    await expectAppError(reader.core.library.uninstall(channelId, 'demo'), 'NOT_FOUND');
  });

  it('取消订阅频道后仍可校验/卸载已安装 App（本地库操作不依赖频道记录）', async () => {
    const { reader, channelId } = await setupFilesPublished();
    await reader.core.library.install({ channelId, appId: 'demo' });
    await reader.core.channels.unsubscribe(channelId);
    expect((await reader.core.library.verify(channelId, 'demo')).ok).toBe(true);
    const descriptor = await reader.core.library.getLaunchDescriptor(channelId, 'demo');
    expect(descriptor.entryPath.length).toBeGreaterThan(0);
    await reader.core.library.uninstall(channelId, 'demo');
    expect(await reader.core.library.list()).toHaveLength(0);
  });

  it('library/index.json 损坏时从 install.json 重建', async () => {
    const { reader, channelId } = await setupFilesPublished();
    await reader.core.library.install({ channelId, appId: 'demo' });
    await fs.writeFile(path.join(reader.dataDir, 'library', 'index.json'), 'not-json');
    const list = await reader.core.library.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.appId).toBe('demo');
    // 重建后的索引已写回
    const index = await readJsonFile<{ apps: { appId: string }[] }>(
      path.join(reader.dataDir, 'library', 'index.json'),
    );
    expect(index.apps[0]!.appId).toBe('demo');
  });

  it('getLaunchDescriptor 拒绝安装记录中的路径逃逸（SECURITY）', async () => {
    const { reader, channelId } = await setupFilesPublished();
    await reader.core.library.install({ channelId, appId: 'demo' });
    const installPath = path.join(reader.dataDir, 'library', channelId, 'demo', 'install.json');
    const raw = JSON.parse(await fs.readFile(installPath, 'utf8')) as Record<string, unknown>;
    raw.entry = '../../evil.exe';
    await fs.writeFile(installPath, JSON.stringify(raw));
    const error = await expectAppError(
      reader.core.library.getLaunchDescriptor(channelId, 'demo'),
      'SECURITY',
    );
    expect(error.message.length).toBeGreaterThan(0);
  });

  it('keepVersions 可注入：仅保留最近 N 个版本目录', async () => {
    const publisher = await newEnv();
    const channel = await publisher.createChannel({ name: 'keep 版本' });
    const v1 = await fixture({ 'app.exe': 'v1' });
    await publisher.core.publishing.publish({
      channelId: channel.id,
      app: APP,
      version: '1.0.0',
      platform: 'windows',
      publishMode: 'files',
      entry: 'app.exe',
      files: v1.inputs,
    });
    const reader = await newEnv({ objects: publisher.objects, keepVersions: 2 });
    await reader.core.channels.subscribe({ url: channel.subscribeUrl });
    await reader.core.library.install({ channelId: channel.id, appId: 'demo' });

    for (const version of ['1.1.0', '1.2.0']) {
      await publishNewFilesVersion(publisher, channel.id, version, { 'app.exe': version });
      await reader.core.library.update({ channelId: channel.id, appId: 'demo' });
    }

    const versionsDir = path.join(reader.dataDir, 'library', channel.id, 'demo', 'versions');
    const dirs = (await fs.readdir(versionsDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(dirs).toEqual(['1.1.0', '1.2.0']);
  });
});

describe('LibraryService.checkUpdates', () => {
  it('基于刷新后的 channel.json 检测可用更新', async () => {
    const { publisher, reader, channelId } = await setupFilesPublished();
    await reader.core.library.install({ channelId, appId: 'demo' });

    let checks = await reader.core.library.checkUpdates();
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({
      channelId,
      appId: 'demo',
      currentVersion: '1.0.0',
      latestVersion: '1.0.0',
      updateAvailable: false,
    });

    await publishNewFilesVersion(publisher, channelId, '1.1.0', {
      'app.exe': 'exe-v2',
      'resources/data.bin': 'data-v1',
    });
    checks = await reader.core.library.checkUpdates();
    expect(checks[0]).toMatchObject({
      currentVersion: '1.0.0',
      latestVersion: '1.1.0',
      updateAvailable: true,
    });

    await reader.core.library.update({ channelId, appId: 'demo' });
    checks = await reader.core.library.checkUpdates();
    expect(checks[0]!.updateAvailable).toBe(false);
    expect(checks[0]!.latestVersion).toBe('1.1.0');
  });

  it('刷新失败时容忍并使用本地缓存，不抛错', async () => {
    const { reader, channelId } = await setupFilesPublished();
    await reader.core.library.install({ channelId, appId: 'demo' });
    reader.setFetchHook(() => new Response('offline', { status: 503 }));
    const checks = await reader.core.library.checkUpdates();
    expect(checks).toHaveLength(1);
    expect(checks[0]!.channelId).toBe(channelId);
    expect(reader.logger.entries.some((entry) => entry.level === 'warn')).toBe(true);
  });
});

describe('LibraryService.setup 边界', () => {
  it('同版本并发安装串行化，不会产生半安装状态', async () => {
    const { reader, channelId } = await setupFilesPublished();
    const results = await Promise.all([
      reader.core.library.install({ channelId, appId: 'demo' }),
      reader.core.library.install({ channelId, appId: 'demo' }),
    ]);
    expect(results.map((result) => result.app.version)).toEqual(['1.0.0', '1.0.0']);
    expect((await reader.core.library.verify(channelId, 'demo')).ok).toBe(true);
    expect(await reader.core.library.list()).toHaveLength(1);
  });

  it('archive md5 记录在 meta 中与实际上传内容一致（zip 发布 → 安装链路）', async () => {
    const publisher = await newEnv();
    const channel = await publisher.createChannel();
    const zipPath = await zipFixture({ 'Game.exe': 'content' });
    const zipBytes = await fs.readFile(zipPath);
    await publisher.core.publishing.publish({
      channelId: channel.id,
      app: APP,
      version: '1.0.0',
      platform: 'windows',
      publishMode: 'zip',
      entry: 'Game.exe',
      zipPath,
    });
    const metaText = publisher.readObjectText(appMetaKey('demo'))!;
    expect(metaText).toContain(md5Hex(zipBytes));
    expect(publisher.readObject(versionArchiveKey('demo', '1.0.0', 'demo-1.0.0.zip'))).not.toBeNull();
  });
});
