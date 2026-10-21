import path from 'node:path';
import { promises as fs } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { writeFileTree } from '@apphub/testkit';
import { createRealHarness, requestedIncludes, startS3Env } from './support';

/**
 * 集成测试 E：S3（s3rver，模拟 MinIO）provider 全链路。
 *
 * create(s3，公开桶 publicBaseUrl) → publish(files) → 订阅者通过匿名 HTTP
 * （s3rver path-style 地址）→ install → verify → publish v2 → update。
 */
describe('集成（真实 S3/MinIO 兼容）：全链路', () => {
  it('s3 provider：创建→发布→订阅→安装→校验→更新', async () => {
    const h = await createRealHarness();
    const env = await startS3Env(h.rootDir);
    try {
      const owner = await h.newCore('owner');
      const channel = await owner.core.channels.create({
        name: 'S3 频道',
        visibility: 'public',
        owner: { name: 'S3 Owner' },
        storage: env.storageConfig,
      });
      // 订阅链接由 adapter.getDownloadUrl 生成：publicBaseUrl + prefix + key
      expect(channel.subscribeUrl.startsWith(env.publicBaseUrl)).toBe(true);
      expect(channel.subscribeUrl).toBe(`${env.publicBaseUrl}channel.json`);

      // 公开桶地址确实可直接匿名 GET（模拟 MinIO 公开读策略）
      const channelResponse = await h.fetchImpl(channel.subscribeUrl);
      expect(channelResponse.status).toBe(200);

      const app = { appId: 's3-app', displayName: 'S3 App' };
      const srcV1 = path.join(h.rootDir, 'sources', 's3-v1');
      await writeFileTree(srcV1, [
        { path: 's3tool.exe', content: 'MZ s3 v1\n' },
        { path: 'resources/说明.txt', content: 's3 v1 说明\n' },
      ]);
      await owner.core.publishing.publish({
        channelId: channel.id,
        app,
        version: '1.0.0',
        platform: 'windows',
        publishMode: 'files',
        entry: 's3tool.exe',
        files: ['s3tool.exe', 'resources/说明.txt'].map((relative) => ({
          sourcePath: path.join(srcV1, ...relative.split('/')),
          targetPath: relative,
        })),
      });

      const subscriber = await h.newCore('subscriber');
      const subscribed = await subscriber.core.channels.subscribe({ url: channel.subscribeUrl });
      expect(subscribed.appCount).toBe(1);

      const installed = await subscriber.core.library.install({ channelId: channel.id, appId: 's3-app' });
      expect(installed.app.version).toBe('1.0.0');
      const versionDir = path.join(subscriber.dataDir, 'library', channel.id, 's3-app', 'versions', '1.0.0');
      expect(await fs.readFile(path.join(versionDir, 's3tool.exe'), 'utf8')).toBe('MZ s3 v1\n');
      expect((await subscriber.core.library.verify(channel.id, 's3-app')).ok).toBe(true);
      // 真实走了 s3rver 的 HTTP 下载（bucket path-style 地址）
      expect(requestedIncludes(h, '/apphub-e2e/')).toBe(true);

      // v1.1.0 更新
      h.clock.advance(60_000);
      const srcV2 = path.join(h.rootDir, 'sources', 's3-v2');
      await writeFileTree(srcV2, [
        { path: 's3tool.exe', content: 'MZ s3 v1.1.0\n' },
        { path: 'resources/说明.txt', content: 's3 v1.1 说明\n' },
      ]);
      await owner.core.publishing.publish({
        channelId: channel.id,
        app,
        version: '1.1.0',
        platform: 'windows',
        publishMode: 'files',
        entry: 's3tool.exe',
        files: ['s3tool.exe', 'resources/说明.txt'].map((relative) => ({
          sourcePath: path.join(srcV2, ...relative.split('/')),
          targetPath: relative,
        })),
      });
      const updated = await subscriber.core.library.update({ channelId: channel.id, appId: 's3-app' });
      expect(updated.app.version).toBe('1.1.0');
      expect((await subscriber.core.library.verify(channel.id, 's3-app')).ok).toBe(true);

      await subscriber.core.library.uninstall(channel.id, 's3-app');
      expect((await subscriber.core.library.list()).length).toBe(0);
    } finally {
      await env.close();
      await h.dispose();
    }
  });
});
