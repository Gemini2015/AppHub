import path from 'node:path';
import { promises as fs } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { md5Hex, writeFileTree } from '@apphub/testkit';
import { createRealHarness, expectAppError, pathExists, requestedIncludes, startLocalEnv } from './support';

/**
 * 集成测试 F：本地目录 provider + 静态服务器（模拟 nginx 指向本地目录）。
 *
 * create(local) → publish(files) → subscribe(HTTP) → install → verify →
 * publish v2 → update → verify → uninstall，全部离线进程内完成。
 */
describe('集成（真实 local + 静态服务器）：全链路', () => {
  it('local provider：创建→发布→订阅→安装→更新→校验→卸载', async () => {
    const h = await createRealHarness();
    const env = await startLocalEnv(h.rootDir);
    try {
      const owner = await h.newCore('owner');
      const channel = await owner.core.channels.create({
        name: '本地目录频道',
        visibility: 'public',
        owner: { name: 'Local Owner' },
        storage: env.storageConfig,
      });
      expect(channel.subscribeUrl.startsWith(env.staticServer.baseUrl)).toBe(true);

      const app = { appId: 'local-app', displayName: 'Local App' };
      const srcV1 = path.join(h.rootDir, 'sources', 'local-v1');
      await writeFileTree(srcV1, [
        { path: 'tool.exe', content: 'MZ local v1\n' },
        { path: 'data/说明.txt', content: 'local v1\n' },
      ]);
      await owner.core.publishing.publish({
        channelId: channel.id,
        app,
        version: '1.0.0',
        platform: 'windows',
        publishMode: 'files',
        entry: 'tool.exe',
        files: ['tool.exe', 'data/说明.txt'].map((relative) => ({
          sourcePath: path.join(srcV1, ...relative.split('/')),
          targetPath: relative,
        })),
      });

      // owner 写的就是 nginx 根目录下的真实文件
      expect(await pathExists(path.join(env.repoDir, 'local-app', '1.0.0', 'tool.exe'))).toBe(true);
      const rawChannel = JSON.parse(
        await fs.readFile(path.join(env.repoDir, 'channel.json'), 'utf8'),
      ) as { apps: { latest: Record<string, string> }[] };
      expect(rawChannel.apps[0]?.latest.windows).toBe('1.0.0');

      // 订阅者（独立 dataDir）走 HTTP
      const subscriber = await h.newCore('subscriber');
      const subscribed = await subscriber.core.channels.subscribe({ url: channel.subscribeUrl });
      expect(subscribed.appCount).toBe(1);
      const installed = await subscriber.core.library.install({ channelId: channel.id, appId: 'local-app' });
      expect(installed.app.version).toBe('1.0.0');

      const versionDir = path.join(subscriber.dataDir, 'library', channel.id, 'local-app', 'versions', '1.0.0');
      const entryContent = await fs.readFile(path.join(versionDir, 'tool.exe'));
      expect(md5Hex(entryContent)).toBe(md5Hex('MZ local v1\n'));
      expect((await subscriber.core.library.verify(channel.id, 'local-app')).ok).toBe(true);
      expect(requestedIncludes(h, 'app.meta.json')).toBe(true);

      // 发布 v1.1.0 → 更新
      h.clock.advance(60_000);
      const srcV2 = path.join(h.rootDir, 'sources', 'local-v2');
      await writeFileTree(srcV2, [
        { path: 'tool.exe', content: 'MZ local v1.1.0\n' },
        { path: 'data/说明.txt', content: 'local v1.1\n' },
      ]);
      await owner.core.publishing.publish({
        channelId: channel.id,
        app,
        version: '1.1.0',
        platform: 'windows',
        publishMode: 'files',
        entry: 'tool.exe',
        files: ['tool.exe', 'data/说明.txt'].map((relative) => ({
          sourcePath: path.join(srcV2, ...relative.split('/')),
          targetPath: relative,
        })),
      });
      const updated = await subscriber.core.library.update({ channelId: channel.id, appId: 'local-app' });
      expect(updated.app.version).toBe('1.1.0');
      expect((await subscriber.core.library.verify(channel.id, 'local-app')).ok).toBe(true);

      await subscriber.core.library.uninstall(channel.id, 'local-app');
      expect(await subscriber.core.library.list()).toEqual([]);
    } finally {
      await env.close();
      await h.dispose();
    }
  });

  it('local provider：publicBaseUrl 不可达时订阅失败给出可读错误', async () => {
    const h = await createRealHarness();
    const env = await startLocalEnv(h.rootDir);
    try {
      const owner = await h.newCore('owner');
      const channel = await owner.core.channels.create({
        name: '本地只写频道',
        visibility: 'public',
        storage: env.storageConfig,
      });
      const subscriber = await h.newCore('subscriber');
      // 用一个不存在的路径构造 404，模拟 nginx 配置错误
      await expectAppError(
        () => subscriber.core.channels.subscribe({ url: new URL('missing/channel.json', env.staticServer.baseUrl).toString() }),
        ['NETWORK', 'NOT_FOUND', 'VALIDATION'],
      );
      // owner 视角频道仍然正常
      expect((await owner.core.channels.get(channel.id)).id).toBe(channel.id);
    } finally {
      await env.close();
      await h.dispose();
    }
  });
});
