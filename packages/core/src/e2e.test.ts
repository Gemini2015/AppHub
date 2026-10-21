import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTempDir, safeRemove, writeZip } from '@apphub/testkit';
import type { PublishFileInput } from './types';
import { createTestEnv, expectAppError, type TestEnv } from './test-helpers';

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

async function fixture(files: Record<string, string | Buffer>): Promise<PublishFileInput[]> {
  const dir = await createTempDir('apphub-e2e-src-');
  tempDirs.push(dir);
  const inputs: PublishFileInput[] = [];
  for (const [relativePath, content] of Object.entries(files)) {
    const absolute = path.join(dir, ...relativePath.split('/'));
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, content);
    inputs.push({ sourcePath: absolute, targetPath: relativePath });
  }
  return inputs;
}

const APP = { appId: 'demo', displayName: 'Demo App', description: 'E2E', author: 'Alice' };

describe('端到端：创建 → 发布 → 订阅 → 安装 → 更新 → 校验 → 卸载', () => {
  it('公开频道 files 模式完整链路', async () => {
    const publisher = await newEnv();
    const channel = await publisher.createChannel({ name: 'E2E 公开频道' });
    const v1 = await fixture({ 'app.exe': 'v1-binary', 'resources/data.bin': 'shared-data' });
    await publisher.core.publishing.publish({
      channelId: channel.id,
      app: APP,
      version: '1.0.0',
      platform: 'windows',
      publishMode: 'files',
      entry: 'app.exe',
      files: v1,
      changelog: 'v1',
    });

    const reader = await newEnv({ objects: publisher.objects });
    const subscribed = await reader.core.channels.subscribe({ url: channel.subscribeUrl });
    expect(subscribed.apps).toHaveLength(1);
    expect(subscribed.apps[0]).toMatchObject({ appId: 'demo', latest: { windows: '1.0.0' } });

    const installed = await reader.core.library.install({
      channelId: channel.id,
      appId: 'demo',
    });
    expect(installed.app.version).toBe('1.0.0');
    expect(installed.downloadedBytes).toBe('v1-binary'.length + 'shared-data'.length);
    expect((await reader.core.library.verify(channel.id, 'demo')).ok).toBe(true);
    const descriptorV1 = await reader.core.library.getLaunchDescriptor(channel.id, 'demo');
    expect(descriptorV1.versionDir).toContain(path.join('versions', '1.0.0'));

    // 发布新版本
    const v2 = await fixture({ 'app.exe': 'v2-binary', 'resources/data.bin': 'shared-data' });
    await publisher.core.publishing.publish({
      channelId: channel.id,
      app: { appId: 'demo', displayName: 'Demo App' },
      version: '2.0.0',
      platform: 'windows',
      publishMode: 'files',
      entry: 'app.exe',
      files: v2,
      changelog: 'v2',
    });

    const checks = await reader.core.library.checkUpdates();
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({
      currentVersion: '1.0.0',
      latestVersion: '2.0.0',
      updateAvailable: true,
    });

    const updated = await reader.core.library.update({ channelId: channel.id, appId: 'demo' });
    expect(updated.app.version).toBe('2.0.0');
    expect(updated.updatedFrom).toBe('1.0.0');
    expect(updated.reusedBytes).toBe('shared-data'.length);
    expect(updated.downloadedBytes).toBe('v2-binary'.length);
    expect((await reader.core.library.verify(channel.id, 'demo')).ok).toBe(true);

    const installedList = await reader.core.library.list();
    expect(installedList).toHaveLength(1);
    expect(installedList[0]).toMatchObject({ version: '2.0.0', status: 'installed' });

    await reader.core.library.uninstall(channel.id, 'demo');
    expect(await reader.core.library.list()).toHaveLength(0);
    expect((await reader.core.channels.list())[0]!.appCount).toBe(1);
  });

  it('私密频道能力链接 + zip 模式完整链路（订阅者无需私有配置）', async () => {
    const publisher = await newEnv();
    const channel = await publisher.createChannel({ name: 'E2E 私密频道', visibility: 'private' });
    const zipDir = await createTempDir('apphub-e2e-zip-');
    tempDirs.push(zipDir);
    const zipPath = path.join(zipDir, 'app.zip');
    await writeZip(zipPath, { 'Game.exe': 'game-bin', 'lib/core.dll': 'dll-bytes' });
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
    // 订阅者拿到的是能力链接（含 accessKey），不需要 channel_pri.json
    const subscribed = await reader.core.channels.subscribe({ url: channel.subscribeUrl });
    expect(subscribed.visibility).toBe('private');
    expect(subscribed.role).toBe('subscriber');
    const pri = JSON.parse(
      await publisher.core.channels.exportPrivateConfig(channel.id),
    ) as { accessKey: string };
    expect(subscribed.subscribeUrl).toContain(pri.accessKey);
    // 私密频道的所有对象都在 _private/<channelId>/<accessKey>/ 前缀下
    const prefix = `_private/${channel.id}/${pri.accessKey}`;
    expect(publisher.readObject(`${prefix}/demo/app.meta.json`)).not.toBeNull();
    expect(publisher.readObject(`${prefix}/demo/1.0.0/files.json`)).not.toBeNull();
    expect(publisher.readObject(`${prefix}/demo/1.0.0/demo-1.0.0.zip`)).not.toBeNull();
    expect(publisher.readObject('demo/app.meta.json')).toBeNull();

    const installed = await reader.core.library.install({ channelId: channel.id, appId: 'demo' });
    expect(installed.app.publishMode).toBe('zip');
    expect((await reader.core.library.verify(channel.id, 'demo')).ok).toBe(true);
    const versionDir = installed.app.installPath;
    expect(await fs.readFile(path.join(versionDir, 'Game.exe'), 'utf8')).toBe('game-bin');
    const descriptor = await reader.core.library.getLaunchDescriptor(channel.id, 'demo');
    expect(descriptor.entryPath).toBe(path.join(versionDir, 'Game.exe'));

    // 订阅者不能发布
    await expectAppError(
      reader.core.publishing.publish({
        channelId: channel.id,
        app: APP,
        version: '9.0.0',
        platform: 'windows',
        publishMode: 'zip',
        entry: 'Game.exe',
        zipPath,
      }),
      'AUTH',
    );
  });

  it('owner 自己安装（存储适配器直连）完整链路', async () => {
    const env = await newEnv();
    const channel = await env.createChannel({ name: 'Owner 频道' });
    const files = await fixture({ 'app.exe': 'owner-exe' });
    await env.core.publishing.publish({
      channelId: channel.id,
      app: APP,
      version: '1.0.0',
      platform: 'windows',
      publishMode: 'files',
      entry: 'app.exe',
      files,
    });
    const result = await env.core.library.install({ channelId: channel.id, appId: 'demo' });
    expect(result.app.version).toBe('1.0.0');
    expect((await env.core.library.verify(channel.id, 'demo')).ok).toBe(true);
    const app = await env.core.publishing.getApp(channel.id, 'demo');
    expect(app.versions).toHaveLength(1);
  });

  it('两个订阅者并发安装同一频道互不影响', async () => {
    const publisher = await newEnv();
    const channel = await publisher.createChannel();
    const files = await fixture({ 'app.exe': 'concurrent' });
    await publisher.core.publishing.publish({
      channelId: channel.id,
      app: APP,
      version: '1.0.0',
      platform: 'windows',
      publishMode: 'files',
      entry: 'app.exe',
      files,
    });
    const readerA = await newEnv({ objects: publisher.objects });
    const readerB = await newEnv({ objects: publisher.objects });
    await readerA.core.channels.subscribe({ url: channel.subscribeUrl });
    await readerB.core.channels.subscribe({ url: channel.subscribeUrl });

    const [a, b] = await Promise.all([
      readerA.core.library.install({ channelId: channel.id, appId: 'demo' }),
      readerB.core.library.install({ channelId: channel.id, appId: 'demo' }),
    ]);
    expect(a.app.version).toBe('1.0.0');
    expect(b.app.version).toBe('1.0.0');
    expect((await readerA.core.library.verify(channel.id, 'demo')).ok).toBe(true);
    expect((await readerB.core.library.verify(channel.id, 'demo')).ok).toBe(true);
  });

  it('多平台发布后可分别安装对应平台版本', async () => {
    const publisher = await newEnv();
    const channel = await publisher.createChannel({ name: '多平台' });
    const win = await fixture({ 'app.exe': 'win' });
    const linux = await fixture({ 'app': 'linux' });
    await publisher.core.publishing.publish({
      channelId: channel.id,
      app: APP,
      version: '1.0.0',
      platform: 'windows',
      publishMode: 'files',
      entry: 'app.exe',
      files: win,
    });
    await publisher.core.publishing.publish({
      channelId: channel.id,
      app: { appId: 'demo', displayName: 'Demo App' },
      version: '1.1.0',
      platform: 'linux',
      publishMode: 'files',
      entry: 'app',
      files: linux,
    });
    const reader = await newEnv({ objects: publisher.objects });
    await reader.core.channels.subscribe({ url: channel.subscribeUrl });

    const linuxInstall = await reader.core.library.install({
      channelId: channel.id,
      appId: 'demo',
      platform: 'linux',
    });
    expect(linuxInstall.app.platform).toBe('linux');
    expect(linuxInstall.app.version).toBe('1.1.0');
    expect(linuxInstall.app.entry).toBe('app');
    expect((await reader.core.library.verify(channel.id, 'demo')).ok).toBe(true);
  });
});
