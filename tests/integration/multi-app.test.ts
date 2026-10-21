import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseChannelFile } from '@apphub/protocol';
import { writeFileTree } from '@apphub/testkit';
import {
  createChannel,
  createRealHarness,
  expectAppError,
  startLocalEnv,
  toPublishFiles,
  withHarness,
} from './support';

/**
 * 集成测试 D：多 App / 多频道 / channel.json 合并写回。
 *
 * 核心关注点：channel.json 是频道内唯一总索引，任何一次发布都必须在
 * "重新读取远端 → 合并自己 → 写回" 下进行，不能丢掉别的 App（docs/ARCHITECTURE.md §7）。
 */
describe('集成：多 App 与 channel.json 合并', () => {
  it('交替发布两个 App：channel.json 同时保留两者，各自 latest 独立演进', async (t) => {
    await withHarness(t, async (h) => {
      const publisher = await h.newCore('publisher');
      const channel = await createChannel(publisher, h, { name: '多 App 频道' });

      const srcA = await h.writeSourceFiles('multi-a', { 'a.cmd': 'echo a1\n' });
      const srcB = await h.writeSourceFiles('multi-b', { 'b.cmd': 'echo b1\n' });

      await publisher.core.publishing.publish({
        channelId: channel.id,
        app: { appId: 'app-a', displayName: 'App A' },
        version: '1.0.0',
        platform: 'windows',
        publishMode: 'files',
        entry: 'a.cmd',
        files: toPublishFiles(srcA, ['a.cmd']),
      });
      await publisher.core.publishing.publish({
        channelId: channel.id,
        app: { appId: 'app-b', displayName: 'App B' },
        version: '1.0.0',
        platform: 'windows',
        publishMode: 'files',
        entry: 'b.cmd',
        files: toPublishFiles(srcB, ['b.cmd']),
      });

      h.clock.advance(30_000);
      const srcA2 = await h.writeSourceFiles('multi-a2', { 'a.cmd': 'echo a2\n' });
      await publisher.core.publishing.publish({
        channelId: channel.id,
        app: { appId: 'app-a', displayName: 'App A' },
        version: '2.0.0',
        platform: 'windows',
        publishMode: 'files',
        entry: 'a.cmd',
        files: toPublishFiles(srcA2, ['a.cmd']),
      });

      const channelFile = parseChannelFile((await h.readText('channel.json')) ?? '');
      expect(channelFile.apps.map((app) => app.appId).sort()).toEqual(['app-a', 'app-b']);
      const appARef = channelFile.apps.find((app) => app.appId === 'app-a');
      const appBRef = channelFile.apps.find((app) => app.appId === 'app-b');
      expect(appARef?.latest.windows).toBe('2.0.0');
      expect(appARef?.metaUrl).toBe('app-a/app.meta.json');
      expect(appBRef?.latest.windows).toBe('1.0.0');
      expect(appBRef?.displayName).toBe('App B');

      // 两个 App 的元信息独立存在
      const appBMeta = parseChannelFile((await h.readText('channel.json')) ?? '').apps.find(
        (app) => app.appId === 'app-b',
      );
      expect(appBMeta?.latest.windows).toBe('1.0.0');
      expect(h.keys()).toEqual(
        expect.arrayContaining(['app-a/app.meta.json', 'app-b/app.meta.json']),
      );
    });
  });

  it('并发发布两个不同 App：串行合并后 channel.json 不丢 App', async (t) => {
    await withHarness(t, async (h) => {
      const publisher = await h.newCore('publisher');
      const channel = await createChannel(publisher, h, { name: '并发合并频道' });
      const srcA = await h.writeSourceFiles('concurrent-a', { 'a.cmd': 'echo a\n' });
      const srcB = await h.writeSourceFiles('concurrent-b', { 'b.cmd': 'echo b\n' });

      const results = await Promise.allSettled([
        publisher.core.publishing.publish({
          channelId: channel.id,
          app: { appId: 'concurrent-a', displayName: 'Concurrent A' },
          version: '1.0.0',
          platform: 'windows',
          publishMode: 'files',
          entry: 'a.cmd',
          files: toPublishFiles(srcA, ['a.cmd']),
        }),
        publisher.core.publishing.publish({
          channelId: channel.id,
          app: { appId: 'concurrent-b', displayName: 'Concurrent B' },
          version: '1.0.0',
          platform: 'windows',
          publishMode: 'files',
          entry: 'b.cmd',
          files: toPublishFiles(srcB, ['b.cmd']),
        }),
      ]);
      const rejected = results.filter((result) => result.status === 'rejected');
      expect(rejected, `并发发布不应抛错：${JSON.stringify(rejected.map((r) => String((r as PromiseRejectedResult).reason)))}`).toEqual(
        [],
      );

      const channelFile = parseChannelFile((await h.readText('channel.json')) ?? '');
      const appIds = channelFile.apps.map((app) => app.appId).sort();
      // 两个 App 都必须出现在总索引中（channel.json 无并发丢更新）
      expect(appIds).toEqual(['concurrent-a', 'concurrent-b']);
    });
  });

  it('多频道隔离：同一 appId 在不同频道互不影响', async () => {
    const h = await createRealHarness();
    const env = await startLocalEnv(h.rootDir);
    try {
      const repoOne = path.join(env.repoDir, 'channel-one-repo');
      const repoTwo = path.join(env.repoDir, 'channel-two-repo');
      const publisher = await h.newCore('publisher');
      const channelOne = await publisher.core.channels.create({
        name: '频道一',
        visibility: 'public',
        storage: {
          provider: 'local',
          rootDir: repoOne,
          publicBaseUrl: new URL('channel-one-repo/', env.staticServer.baseUrl).toString(),
        },
      });
      const channelTwo = await publisher.core.channels.create({
        name: '频道二',
        visibility: 'public',
        storage: {
          provider: 'local',
          rootDir: repoTwo,
          publicBaseUrl: new URL('channel-two-repo/', env.staticServer.baseUrl).toString(),
        },
      });
      expect(channelOne.id).not.toBe(channelTwo.id);

      const srcOne = path.join(h.rootDir, 'sources', 'channel-one-src');
      const srcTwo = path.join(h.rootDir, 'sources', 'channel-two-src');
      await writeFileTree(srcOne, [{ path: 'app.cmd', content: 'echo from-channel-one\n' }]);
      await writeFileTree(srcTwo, [{ path: 'app.cmd', content: 'echo from-channel-two\n' }]);
      const app = { appId: 'same-app', displayName: 'Same App' };
      await publisher.core.publishing.publish({
        channelId: channelOne.id,
        app,
        version: '1.0.0',
        platform: 'windows',
        publishMode: 'files',
        entry: 'app.cmd',
        files: ['app.cmd'].map((relative) => ({
          sourcePath: path.join(srcOne, relative),
          targetPath: relative,
        })),
      });
      await publisher.core.publishing.publish({
        channelId: channelTwo.id,
        app,
        version: '1.0.0',
        platform: 'windows',
        publishMode: 'files',
        entry: 'app.cmd',
        files: ['app.cmd'].map((relative) => ({
          sourcePath: path.join(srcTwo, relative),
          targetPath: relative,
        })),
      });

      const subscriber = await h.newCore('subscriber');
      await subscriber.core.channels.subscribe({ url: channelOne.subscribeUrl });
      await subscriber.core.channels.subscribe({ url: channelTwo.subscribeUrl });
      const installedOne = await subscriber.core.library.install({
        channelId: channelOne.id,
        appId: 'same-app',
      });
      const installedTwo = await subscriber.core.library.install({
        channelId: channelTwo.id,
        appId: 'same-app',
      });
      expect(installedOne.app.version).toBe('1.0.0');
      expect(installedTwo.app.version).toBe('1.0.0');
      expect(installedOne.app.appRoot).not.toBe(installedTwo.app.appRoot);

      const fs = await import('node:fs/promises');
      const contentOne = await fs.readFile(path.join(installedOne.app.installPath, 'app.cmd'), 'utf8');
      const contentTwo = await fs.readFile(path.join(installedTwo.app.installPath, 'app.cmd'), 'utf8');
      expect(contentOne).toBe('echo from-channel-one\n');
      expect(contentTwo).toBe('echo from-channel-two\n');

      // 卸载其中一个不影响另一个
      await subscriber.core.library.uninstall(channelOne.id, 'same-app');
      expect(await subscriber.core.library.list()).toHaveLength(1);
      expect((await subscriber.core.library.verify(channelTwo.id, 'same-app')).ok).toBe(true);
    } finally {
      await env.close();
      await h.dispose();
    }
  });

  it('同一个 App 的版本冲突/幂等规则在多 App 场景下仍然成立', async (t) => {
    await withHarness(t, async (h) => {
      const publisher = await h.newCore('publisher');
      const channel = await createChannel(publisher, h);
      const srcA = await h.writeSourceFiles('conflict-multi-a', { 'a.cmd': 'echo stable\n' });
      const publishA = {
        channelId: channel.id,
        app: { appId: 'stable-app', displayName: 'Stable App' },
        version: '1.0.0',
        platform: 'windows' as const,
        publishMode: 'files' as const,
        entry: 'a.cmd',
        files: toPublishFiles(srcA, ['a.cmd']),
      };
      await publisher.core.publishing.publish(publishA);
      // 幂等：完全相同的内容重复发布成功
      await publisher.core.publishing.publish(publishA);

      // 另一个 App 正常发布，不受影响
      const srcB = await h.writeSourceFiles('conflict-multi-b', { 'b.cmd': 'echo b\n' });
      await publisher.core.publishing.publish({
        channelId: channel.id,
        app: { appId: 'other-app', displayName: 'Other App' },
        version: '1.0.0',
        platform: 'windows',
        publishMode: 'files',
        entry: 'b.cmd',
        files: toPublishFiles(srcB, ['b.cmd']),
      });

      const changed = await h.writeSourceFiles('conflict-multi-a2', { 'a.cmd': 'echo changed\n' });
      await expectAppError(
        () =>
          publisher.core.publishing.publish({
            ...publishA,
            files: toPublishFiles(changed, ['a.cmd']),
          }),
        ['CONFLICT'],
      );

      const channelFile = parseChannelFile((await h.readText('channel.json')) ?? '');
      expect(channelFile.apps.map((app) => app.appId).sort()).toEqual(['other-app', 'stable-app']);
      const detail = await publisher.core.publishing.getApp(channel.id, 'stable-app');
      expect(detail.versions).toHaveLength(1);
    });
  });
});
