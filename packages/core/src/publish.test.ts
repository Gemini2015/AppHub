import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  appMetaKey,
  parseAppMetaFile,
  parseChannelFile,
  parseFilesFile,
  versionArchiveKey,
  versionFilesKey,
} from '@apphub/protocol';
import type { AppMetaFile } from '@apphub/protocol';
import { createTempDir, md5Hex, pathExists, safeRemove, writeZip } from '@apphub/testkit';
import type { PublishFileInput, PublishResult } from './types';
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
  const dir = await createTempDir('apphub-publish-src-');
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
  const dir = await createTempDir('apphub-publish-zip-');
  tempDirs.push(dir);
  const zipPath = path.join(dir, 'input.zip');
  await writeZip(zipPath, files);
  return zipPath;
}

async function createChannel(env: TestEnv, visibility: 'public' | 'private' = 'public') {
  return env.createChannel({ name: '发布频道', visibility });
}

const DEMO_APP = { appId: 'demo', displayName: 'Demo', description: '示例', author: 'Alice' };

function basePublish(channelId: string, inputs: PublishFileInput[], overrides: Record<string, unknown> = {}) {
  return {
    channelId,
    app: DEMO_APP,
    version: '1.0.0',
    platform: 'windows' as const,
    publishMode: 'files' as const,
    entry: 'app.exe',
    files: inputs,
    changelog: '首个版本',
    ...overrides,
  };
}

describe('PublishService.publish - files 模式', () => {
  it('发布 files：远端布局、files.json、app.meta.json、channel.json 全部正确', async () => {
    const env = await newEnv();
    const channel = await createChannel(env);
    const { inputs } = await fixture({
      'app.exe': 'exe-content',
      'resources/app.ini': 'ini-content',
    });
    const result = await env.core.publishing.publish(basePublish(channel.id, inputs));

    expect(result.appId).toBe('demo');
    expect(result.version).toBe('1.0.0');
    expect(result.platform).toBe('windows');
    expect(result.publishMode).toBe('files');
    expect(result.metaUrl).toBe('demo/app.meta.json');
    expect(result.fileCount).toBe(2);
    expect(result.totalSize).toBe('exe-content'.length + 'ini-content'.length);
    expect(result.archive).toBeNull();
    expect(result.channelUpdatedAt).toBe('2026-01-01T00:00:00.000Z');

    // 版本目录内文件
    expect(env.readObjectText('demo/1.0.0/app.exe')).toBe('exe-content');
    expect(env.readObjectText('demo/1.0.0/resources/app.ini')).toBe('ini-content');

    // files.json
    const filesJson = parseFilesFile(env.readObjectText(versionFilesKey('demo', '1.0.0'))!);
    expect(filesJson.appId).toBe('demo');
    expect(filesJson.entry).toBe('app.exe');
    expect(filesJson.fileCount).toBe(2);
    expect(filesJson.files.map((file) => file.path)).toEqual(['app.exe', 'resources/app.ini']);
    expect(filesJson.files[0]!.md5).toBe(md5Hex('exe-content'));
    expect(filesJson.archive).toBeNull();

    // app.meta.json
    const meta = parseAppMetaFile(env.readObjectText(appMetaKey('demo'))!);
    expect(meta.channelId).toBe(channel.id);
    expect(meta.publishMode).toBe('files');
    expect(meta.latest).toEqual({ windows: '1.0.0' });
    expect(meta.platforms).toEqual(['windows']);
    expect(meta.versions).toHaveLength(1);
    expect(meta.versions[0]!.changelog).toBe('首个版本');
    expect(meta.versions[0]!.downloadBaseUrl).toBe('1.0.0/');

    // channel.json
    const channelFile = parseChannelFile(env.readObjectText('channel.json')!);
    expect(channelFile.apps).toHaveLength(1);
    expect(channelFile.apps[0]).toMatchObject({
      appId: 'demo',
      displayName: 'Demo',
      publishMode: 'files',
      latest: { windows: '1.0.0' },
      metaUrl: 'demo/app.meta.json',
    });

    // 本地缓存与记录同步
    const detail = await env.core.channels.get(channel.id);
    expect(detail.appCount).toBe(1);
    expect(detail.apps[0]!.appId).toBe('demo');
  });

  it('写入顺序必须为 payload → files.json → app.meta.json → channel.json', async () => {
    const env = await newEnv();
    const channel = await createChannel(env);
    const { inputs } = await fixture({ 'app.exe': 'exe', 'lib/data.bin': 'data' });
    const writesBefore = env.writes.length;
    await env.core.publishing.publish(basePublish(channel.id, inputs));

    const writes = env.writes
      .slice(writesBefore)
      .filter((record) => record.op !== 'delete')
      .map((record) => record.key);
    const payloadIndex = Math.max(
      writes.indexOf('demo/1.0.0/app.exe'),
      writes.indexOf('demo/1.0.0/lib/data.bin'),
    );
    const filesIndex = writes.indexOf('demo/1.0.0/files.json');
    const metaIndex = writes.indexOf('demo/app.meta.json');
    const channelIndex = writes.indexOf('channel.json');
    expect(payloadIndex).toBeGreaterThanOrEqual(0);
    expect(filesIndex).toBeGreaterThan(payloadIndex);
    expect(metaIndex).toBeGreaterThan(filesIndex);
    expect(channelIndex).toBeGreaterThan(metaIndex);
  });

  it('发布新版本：保留历史、latest 按 semver 最大、可补发旧版本', async () => {
    const env = await newEnv();
    const channel = await createChannel(env);
    const first = await fixture({ 'app.exe': 'v1' });
    const second = await fixture({ 'app.exe': 'v2' });
    const old = await fixture({ 'app.exe': 'v0' });

    await env.core.publishing.publish(basePublish(channel.id, first.inputs, { version: '1.0.0' }));
    env.clock.advance(1000);
    await env.core.publishing.publish(basePublish(channel.id, second.inputs, { version: '1.1.0' }));
    env.clock.advance(1000);
    const oldResult = await env.core.publishing.publish(
      basePublish(channel.id, old.inputs, { version: '0.9.0' }),
    );

    const meta = parseAppMetaFile(env.readObjectText(appMetaKey('demo'))!);
    expect(meta.versions.map((item) => item.version)).toEqual(['1.1.0', '1.0.0', '0.9.0']);
    expect(meta.latest).toEqual({ windows: '1.1.0' });
    expect(oldResult.version).toBe('0.9.0');
  });

  it('多平台发布：versions 全局唯一、latest 按平台分别计算、platforms 取并集', async () => {
    const env = await newEnv();
    const channel = await createChannel(env);
    const win = await fixture({ 'app.exe': 'win' });
    const linux = await fixture({ 'app': 'linux' });

    await env.core.publishing.publish(basePublish(channel.id, win.inputs, { version: '1.0.0' }));
    await env.core.publishing.publish(
      basePublish(channel.id, linux.inputs, {
        version: '1.1.0',
        platform: 'linux',
        entry: 'app',
        files: linux.inputs,
      }),
    );

    const meta = parseAppMetaFile(env.readObjectText(appMetaKey('demo'))!);
    expect(meta.platforms).toEqual(['windows', 'linux']);
    expect(meta.latest).toEqual({ windows: '1.0.0', linux: '1.1.0' });
    const channelFile = parseChannelFile(env.readObjectText('channel.json')!);
    expect(channelFile.apps[0]!.latest).toEqual({ windows: '1.0.0', linux: '1.1.0' });
    expect(channelFile.apps[0]!.platforms).toEqual(['windows', 'linux']);
  });

  it('同版本同内容再次发布 = 幂等成功，且不重复上传 payload/元信息', async () => {
    const env = await newEnv();
    const channel = await createChannel(env);
    const { inputs } = await fixture({ 'app.exe': 'same' });
    const first = await env.core.publishing.publish(basePublish(channel.id, inputs));
    expect(first.version).toBe('1.0.0');

    const writesBefore = env.writes.length;
    const second = await env.core.publishing.publish(basePublish(channel.id, inputs));
    expect(second.totalSize).toBe(first.totalSize);
    expect(second.files).toEqual(first.files);

    const newWrites = env.writes.slice(writesBefore).map((record) => record.key);
    expect(newWrites).not.toContain('demo/1.0.0/app.exe');
    expect(newWrites).not.toContain('demo/1.0.0/files.json');
    expect(newWrites).not.toContain('demo/app.meta.json');
    expect(newWrites).toContain('channel.json');
  });

  it('同版本不同内容：默认 CONFLICT；overwrite=true 覆盖并替换版本条目', async () => {
    const env = await newEnv();
    const channel = await createChannel(env);
    const a = await fixture({ 'app.exe': 'A' });
    const b = await fixture({ 'app.exe': 'B' });
    await env.core.publishing.publish(basePublish(channel.id, a.inputs));

    const conflict = await expectAppError(
      env.core.publishing.publish(basePublish(channel.id, b.inputs)),
      'CONFLICT',
    );
    expect(conflict.message).toContain('1.0.0');

    const overwritten = await env.core.publishing.publish(
      basePublish(channel.id, b.inputs, { overwrite: true }),
    );
    expect(overwritten.files[0]!.md5).toBe(md5Hex('B'));
    const meta = parseAppMetaFile(env.readObjectText(appMetaKey('demo'))!);
    expect(meta.versions).toHaveLength(1);
    expect(meta.versions[0]!.files[0]!.md5).toBe(md5Hex('B'));
    expect(env.readObjectText('demo/1.0.0/app.exe')).toBe('B');
  });

  it('publishMode 与已有 App 不一致时抛 CONFLICT（创建后不可切换）', async () => {
    const env = await newEnv();
    const channel = await createChannel(env);
    const files = await fixture({ 'app.exe': 'x' });
    await env.core.publishing.publish(basePublish(channel.id, files.inputs));

    const zipPath = await zipFixture({ 'app.exe': 'x' });
    const error = await expectAppError(
      env.core.publishing.publish(
        basePublish(channel.id, [], {
          version: '2.0.0',
          publishMode: 'zip',
          zipPath,
          entry: 'app.exe',
        }),
      ),
      'CONFLICT',
    );
    expect(error.message).toContain('发布方式');
  });

  it('entry 不在文件列表 / 目标路径重复或逃逸 / 源文件缺失时拒绝', async () => {
    const env = await newEnv();
    const channel = await createChannel(env);
    const { inputs } = await fixture({ 'app.exe': 'x', 'other.txt': 'y' });

    await expectAppError(
      env.core.publishing.publish(basePublish(channel.id, inputs, { entry: 'nope.exe' })),
      'VALIDATION',
    );
    await expectAppError(
      env.core.publishing.publish(basePublish(channel.id, inputs, { entry: '../app.exe' })),
      'SECURITY',
    );
    await expectAppError(
      env.core.publishing.publish(
        basePublish(channel.id, [
          { sourcePath: inputs[0]!.sourcePath, targetPath: 'same.txt' },
          { sourcePath: inputs[1]!.sourcePath, targetPath: 'same.txt' },
        ], { entry: 'same.txt' }),
      ),
      'VALIDATION',
    );
    await expectAppError(
      env.core.publishing.publish(
        basePublish(channel.id, [
          { sourcePath: path.join(channel.id, 'missing.bin'), targetPath: 'missing.bin' },
        ], { entry: 'missing.bin' }),
      ),
      'NOT_FOUND',
    );
    // 失败发布不应留下任何 App 元信息
    expect(env.readObject(appMetaKey('demo'))).toBeNull();
    expect(parseChannelFile(env.readObjectText('channel.json')!).apps).toHaveLength(0);
  });

  it('订阅者无发布权限（AUTH）', async () => {
    const publisher = await newEnv();
    const channel = await publisher.createChannel();
    const reader = await newEnv({ objects: publisher.objects });
    await reader.core.channels.subscribe({ url: channel.subscribeUrl });
    const { inputs } = await fixture({ 'app.exe': 'x' });
    await expectAppError(
      reader.core.publishing.publish(basePublish(channel.id, inputs)),
      'AUTH',
    );
  });
});

describe('PublishService.publish - zip 模式', () => {
  it('发布 zip：校验内部文件并上传压缩包，files.json/meta.archive 记录压缩包信息', async () => {
    const env = await newEnv();
    const channel = await createChannel(env);
    const zipPath = await zipFixture({ 'Game.exe': 'game-binary', 'data/pack.bin': 'pack' });
    const zipBytes = await fs.readFile(zipPath);

    const result = await env.core.publishing.publish(
      basePublish(channel.id, [], {
        publishMode: 'zip',
        zipPath,
        entry: 'Game.exe',
        version: '2.0.0',
      }),
    );
    expect(result.publishMode).toBe('zip');
    expect(result.archive).not.toBeNull();
    expect(result.archive!.url).toBe('2.0.0/demo-2.0.0.zip');
    expect(result.archive!.md5).toBe(md5Hex(zipBytes));
    expect(result.archive!.size).toBe(zipBytes.length);

    expect(env.readObject(versionArchiveKey('demo', '2.0.0', 'demo-2.0.0.zip'))).not.toBeNull();
    const filesJson = parseFilesFile(env.readObjectText(versionFilesKey('demo', '2.0.0'))!);
    expect(filesJson.files.map((file) => file.path).sort()).toEqual(['Game.exe', 'data/pack.bin']);
    const gameEntry = filesJson.files.find((file) => file.path === 'Game.exe')!;
    expect(gameEntry.md5).toBe(md5Hex('game-binary'));
    expect(filesJson.archive?.md5).toBe(md5Hex(zipBytes));

    const meta = parseAppMetaFile(env.readObjectText(appMetaKey('demo'))!);
    expect(meta.versions[0]!.archive?.size).toBe(zipBytes.length);
    expect(meta.versions[0]!.files.map((file) => file.path).sort()).toEqual([
      'Game.exe',
      'data/pack.bin',
    ]);
  });

  it('zipFromDir 自动打包目录后发布', async () => {
    const env = await newEnv();
    const channel = await createChannel(env);
    const dir = await createTempDir('apphub-zip-from-dir-');
    tempDirs.push(dir);
    await fs.mkdir(path.join(dir, 'bin'), { recursive: true });
    await fs.writeFile(path.join(dir, 'bin', 'run.exe'), 'run');
    await fs.writeFile(path.join(dir, 'readme.txt'), 'hi');

    const result = await env.core.publishing.publish(
      basePublish(channel.id, [], {
        publishMode: 'zip',
        zipFromDir: dir,
        entry: 'bin/run.exe',
        version: '3.0.0',
      }),
    );
    expect(result.fileCount).toBe(2);
    expect(env.readObjectText(versionFilesKey('demo', '3.0.0'))).not.toBeNull();
    expect(env.readObject(versionArchiveKey('demo', '3.0.0', 'demo-3.0.0.zip'))).not.toBeNull();
  });

  it('zip 模式校验：entry 不在压缩包 / zipPath 与 zipFromDir 冲突 / 与 files 混用', async () => {
    const env = await newEnv();
    const channel = await createChannel(env);
    const zipPath = await zipFixture({ 'Game.exe': 'x' });
    const dir = await createTempDir('apphub-zip-dir-');
    tempDirs.push(dir);
    await fs.writeFile(path.join(dir, 'Game.exe'), 'x');

    await expectAppError(
      env.core.publishing.publish(
        basePublish(channel.id, [], { publishMode: 'zip', zipPath, entry: 'Missing.exe', version: '1.0.0' }),
      ),
      'VALIDATION',
    );
    await expectAppError(
      env.core.publishing.publish(
        basePublish(channel.id, [], {
          publishMode: 'zip',
          zipPath,
          zipFromDir: dir,
          entry: 'Game.exe',
          version: '1.0.0',
        }),
      ),
      'VALIDATION',
    );
    const files = await fixture({ 'Game.exe': 'x' });
    await expectAppError(
      env.core.publishing.publish(
        basePublish(channel.id, files.inputs, {
          publishMode: 'zip',
          zipPath,
          entry: 'Game.exe',
          version: '1.0.0',
        }),
      ),
      'VALIDATION',
    );
  });

  it('zip 模式会拒绝包含 zip-slip 路径的压缩包（SECURITY）', async () => {
    const env = await newEnv();
    const channel = await createChannel(env);
    const zipPath = await zipFixture({ '../evil.exe': 'evil', 'ok.exe': 'ok' });
    await expectAppError(
      env.core.publishing.publish(
        basePublish(channel.id, [], {
          publishMode: 'zip',
          zipPath,
          entry: 'ok.exe',
          version: '1.0.0',
        }),
      ),
      'SECURITY',
    );
  });
});

describe('PublishService - 进度 / 失败注入 / getApp / updateMeta', () => {
  it('发布进度事件包含 prepare/transfer/commit，且字节进度单调递增到 100%', async () => {
    const env = await newEnv();
    const channel = await createChannel(env);
    const { inputs } = await fixture({ 'app.exe': 'a'.repeat(100), 'lib/b.bin': 'b'.repeat(200) });
    const recorder = recordProgress();
    await env.core.publishing.publish({ ...basePublish(channel.id, inputs), onProgress: recorder.listener });

    const phases = recorder.phases();
    expect(phases).toContain('prepare');
    expect(phases).toContain('transfer');
    expect(phases).toContain('commit');
    const transfers = recorder.events.filter((event) => event.phase === 'transfer');
    expect(transfers.length).toBe(2);
    const bytes = transfers.map((event) => event.transferredBytes ?? 0);
    expect(bytes[0]!).toBeLessThanOrEqual(bytes[1]!);
    expect(transfers.at(-1)!.percent).toBe(100);
  });

  it('app.meta.json 写入失败时 channel.json 不被登记（不产生指向缺失文件的元信息）', async () => {
    const env = await newEnv();
    const channel = await createChannel(env);
    const { inputs } = await fixture({ 'app.exe': 'x' });
    env.faults.writeText = (key) => {
      if (key.endsWith('app.meta.json')) throw new Error('disk full');
    };
    await expectAppError(env.core.publishing.publish(basePublish(channel.id, inputs)), 'STORAGE');
    expect(parseChannelFile(env.readObjectText('channel.json')!).apps).toHaveLength(0);
    // payload 可能已上传，但没有 app.meta.json / channel 引用
    expect(env.readObject(appMetaKey('demo'))).toBeNull();
    expect(env.readObject(versionFilesKey('demo', '1.0.0'))).not.toBeNull();
  });

  it('payload 上传失败时不会写 files.json / app.meta.json', async () => {
    const env = await newEnv();
    const channel = await createChannel(env);
    const { inputs } = await fixture({ 'app.exe': 'x' });
    env.faults.writeBinary = () => {
      throw new Error('upload failed');
    };
    await expectAppError(env.core.publishing.publish(basePublish(channel.id, inputs)), 'STORAGE');
    expect(env.readObject(appMetaKey('demo'))).toBeNull();
    expect(env.readObject(versionFilesKey('demo', '1.0.0'))).toBeNull();
    expect(parseChannelFile(env.readObjectText('channel.json')!).apps).toHaveLength(0);
  });

  it('getApp（owner）读取远端元信息并按 semver 降序返回版本', async () => {
    const env = await newEnv();
    const channel = await createChannel(env);
    const v1 = await fixture({ 'app.exe': '1' });
    const v2 = await fixture({ 'app.exe': '2' });
    await env.core.publishing.publish(basePublish(channel.id, v1.inputs, { version: '1.0.0' }));
    await env.core.publishing.publish(basePublish(channel.id, v2.inputs, { version: '1.2.0' }));

    const detail = await env.core.publishing.getApp(channel.id, 'demo');
    expect(detail.channelId).toBe(channel.id);
    expect(detail.app.displayName).toBe('Demo');
    expect(detail.versions.map((item) => item.version)).toEqual(['1.2.0', '1.0.0']);
    await expectAppError(env.core.publishing.getApp(channel.id, 'nope'), 'NOT_FOUND');
  });

  it('getApp（owner）远端读取失败时回退本地缓存', async () => {
    const env = await newEnv();
    const channel = await createChannel(env);
    const { inputs } = await fixture({ 'app.exe': 'x' });
    await env.core.publishing.publish(basePublish(channel.id, inputs));
    await env.core.publishing.getApp(channel.id, 'demo'); // 写入本地缓存
    env.deleteObject(appMetaKey('demo'));
    const cached = await env.core.publishing.getApp(channel.id, 'demo');
    expect(cached.app.displayName).toBe('Demo');
    expect(cached.versions).toHaveLength(1);
    expect(env.logger.entries.some((entry) => entry.level === 'warn')).toBe(true);
  });

  it('getApp（subscriber）走 HTTP，失败时回退本地缓存', async () => {
    const publisher = await newEnv();
    const channel = await publisher.createChannel();
    const { inputs } = await fixture({ 'app.exe': 'x' });
    await publisher.core.publishing.publish(basePublish(channel.id, inputs));
    const reader = await newEnv({ objects: publisher.objects });
    await reader.core.channels.subscribe({ url: channel.subscribeUrl });

    const detail = await reader.core.publishing.getApp(channel.id, 'demo');
    expect(detail.app.appId).toBe('demo');
    expect(reader.fetchRequests).toContain('demo/app.meta.json');

    // 第一次读取成功已写缓存；让后续 HTTP 失败并断言回退缓存
    reader.setFetchHook(({ key }) =>
      key === 'demo/app.meta.json' ? new Response('boom', { status: 500 }) : undefined,
    );
    const cached = await reader.core.publishing.getApp(channel.id, 'demo');
    expect(cached.app.displayName).toBe('Demo');
    expect(reader.logger.entries.some((entry) => entry.level === 'warn')).toBe(true);
  });

  it('updateMeta 修改展示信息并同步 channel.json / 校验入口', async () => {
    const env = await newEnv();
    const channel = await createChannel(env);
    const { inputs } = await fixture({ 'app.exe': 'x', 'other.exe': 'y' });
    await env.core.publishing.publish(basePublish(channel.id, inputs));
    env.clock.advance(2000);

    const updated = await env.core.publishing.updateMeta(channel.id, 'demo', {
      displayName: '新名字',
      description: '新描述',
      entry: 'other.exe',
      homepage: 'https://example.com/demo',
    });
    expect(updated.app.displayName).toBe('新名字');
    expect(updated.app.entry).toBe('other.exe');
    expect(updated.meta.homepage).toBe('https://example.com/demo');

    const meta = parseAppMetaFile(env.readObjectText(appMetaKey('demo'))!);
    expect(meta.displayName).toBe('新名字');
    expect(meta.entry).toBe('other.exe');
    const channelFile = parseChannelFile(env.readObjectText('channel.json')!);
    expect(channelFile.apps[0]!.displayName).toBe('新名字');
    expect(channelFile.apps[0]!.entry).toBe('other.exe');

    await expectAppError(
      env.core.publishing.updateMeta(channel.id, 'demo', { entry: 'missing.exe' }),
      'VALIDATION',
    );
    await expectAppError(
      env.core.publishing.updateMeta(channel.id, 'demo', { homepage: 'ftp://x' }),
      'VALIDATION',
    );
  });

  it('updateMeta 发布图标并兼容订阅者权限限制', async () => {
    const env = await newEnv();
    const channel = await createChannel(env);
    const { inputs } = await fixture({ 'app.exe': 'x' });
    await env.core.publishing.publish(basePublish(channel.id, inputs));

    const iconDir = await createTempDir('apphub-icon-');
    tempDirs.push(iconDir);
    const iconPath = path.join(iconDir, 'logo.png');
    await fs.writeFile(iconPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const updated = await env.core.publishing.updateMeta(channel.id, 'demo', {
      iconSourcePath: iconPath,
    });
    expect(updated.meta.iconUrl).toBe('icon.png');
    expect(env.readObject('demo/icon.png')).not.toBeNull();

    const reader = await newEnv({ objects: env.objects });
    await reader.core.channels.subscribe({ url: channel.subscribeUrl });
    await expectAppError(
      reader.core.publishing.updateMeta(channel.id, 'demo', { displayName: 'nope' }),
      'AUTH',
    );
  });

  it('并发发布同一版本不同内容时只允许一个成功（keyed mutex + 冲突检测）', async () => {
    const env = await newEnv();
    const channel = await createChannel(env);
    const a = await fixture({ 'app.exe': 'A' });
    const b = await fixture({ 'app.exe': 'B' });
    const results = await Promise.allSettled([
      env.core.publishing.publish(basePublish(channel.id, a.inputs)),
      env.core.publishing.publish(basePublish(channel.id, b.inputs)),
    ]);
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const reason = (rejected[0] as PromiseRejectedResult).reason as { code?: string };
    expect(reason.code).toBe('CONFLICT');
    const meta: AppMetaFile = parseAppMetaFile(env.readObjectText(appMetaKey('demo'))!);
    expect(meta.versions).toHaveLength(1);
  });

  it('同频道两个不同 App 真并发发布：channel.json 合并不丢 App（频道级串行回归）', async () => {
    const env = await newEnv();
    const channel = await createChannel(env);
    const sourceA = await fixture({ 'a.exe': 'aaa' });
    const sourceB = await fixture({ 'b.exe': 'bbb' });

    // 多轮并发，覆盖 Windows 上并发写同一 channel.json 缓存/远端合并的竞争窗口
    for (let round = 0; round < 5; round += 1) {
      const version = `1.0.${round}`;
      const results = await Promise.allSettled([
        env.core.publishing.publish({
          channelId: channel.id,
          app: { appId: 'app-a', displayName: 'App A' },
          version,
          platform: 'windows',
          publishMode: 'files',
          entry: 'a.exe',
          files: sourceA.inputs,
        }),
        env.core.publishing.publish({
          channelId: channel.id,
          app: { appId: 'app-b', displayName: 'App B' },
          version,
          platform: 'windows',
          publishMode: 'files',
          entry: 'b.exe',
          files: sourceB.inputs,
        }),
      ]);
      const rejected = results.filter((result) => result.status === 'rejected');
      expect(
        rejected.map((result) => (result as PromiseRejectedResult).reason),
        `第 ${round} 轮并发发布不应失败`,
      ).toEqual([]);

      const channelFile = parseChannelFile(env.readObjectText('channel.json')!);
      expect(channelFile.apps.map((app) => app.appId).sort()).toEqual(['app-a', 'app-b']);
      expect(parseAppMetaFile(env.readObjectText(appMetaKey('app-a'))!).latest).toEqual({
        windows: version,
      });
      expect(parseAppMetaFile(env.readObjectText(appMetaKey('app-b'))!).latest).toEqual({
        windows: version,
      });
    }

    // 并发写本地缓存也不应丢 App（Windows 上并发 rename 会 EPERM）
    const cached = parseChannelFile(
      await fs.readFile(path.join(env.dataDir, 'channels', channel.id, 'channel.json'), 'utf8'),
    );
    expect(cached.apps.map((app) => app.appId).sort()).toEqual(['app-a', 'app-b']);
    expect(env.logger.entries.filter((entry) => entry.level === 'error')).toHaveLength(0);
  });

  it('同频道 publish 与 updateMeta 并发：channel.json 不丢 App 且展示信息生效', async () => {
    const env = await newEnv();
    const channel = await createChannel(env);
    const demoSource = await fixture({ 'app.exe': 'demo' });
    await env.core.publishing.publish(basePublish(channel.id, demoSource.inputs));

    const otherSource = await fixture({ 'b.exe': 'other' });
    const results = await Promise.allSettled([
      env.core.publishing.publish({
        channelId: channel.id,
        app: { appId: 'other-app', displayName: 'Other App' },
        version: '2.0.0',
        platform: 'windows',
        publishMode: 'files',
        entry: 'b.exe',
        files: otherSource.inputs,
      }),
      env.core.publishing.updateMeta(channel.id, 'demo', { displayName: 'Demo 改名' }),
    ]);
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);

    const channelFile = parseChannelFile(env.readObjectText('channel.json')!);
    expect(channelFile.apps.map((app) => app.appId).sort()).toEqual(['demo', 'other-app']);
    expect(channelFile.apps.find((app) => app.appId === 'demo')!.displayName).toBe('Demo 改名');
  });

  it('发布自定义 archiveName 并保留 App 展示字段', async () => {
    const env = await newEnv();
    const channel = await createChannel(env);
    const zipPath = await zipFixture({ 'Game.exe': 'x' });
    const result: PublishResult = await env.core.publishing.publish(
      basePublish(channel.id, [], {
        publishMode: 'zip',
        zipPath,
        entry: 'Game.exe',
        archiveName: 'custom.zip',
        version: '4.0.0',
      }),
    );
    expect(result.archive!.url).toBe('4.0.0/custom.zip');
    expect(await pathExists(path.join(env.storageRoot, 'noop'))).toBe(false); // 占位（真实存储为内存）
    expect(env.readObject('demo/4.0.0/custom.zip')).not.toBeNull();
    const meta = parseAppMetaFile(env.readObjectText(appMetaKey('demo'))!);
    expect(meta.displayName).toBe('Demo');
    expect(meta.author).toBe('Alice');
  });
});
