import { describe, expect, it } from 'vitest';
import { parseChannelFile, parseChannelPrivateFile } from '@apphub/protocol';
import {
  createChannel,
  expectAppError,
  pathExists,
  toPublishFiles,
  withHarness,
} from './support';

/**
 * 集成测试 A：频道生命周期（公开/私密、订阅者视角、import/export channel_pri）。
 *
 * 装置：内存存储 + 内存 fetch（见 support/harness.ts），owner / subscriber / admin
 * 分别是三个独立 dataDir 的 core 实例，等价于三台机器。
 */
describe('集成：频道生命周期', () => {
  it('创建公开频道：owner 角色、远端 channel.json 已写入且可被订阅者订阅', async (t) => {
    await withHarness(t, async (h) => {
      const publisher = await h.newCore('publisher');
      const detail = await createChannel(publisher, h, { name: '公开频道' });

      // 1) API 返回值
      expect(detail.id).toMatch(/^ch_[a-z0-9]{16,32}$/);
      expect(detail.name).toBe('公开频道');
      expect(detail.visibility).toBe('public');
      expect(detail.role).toBe('owner');
      expect(detail.source).toBe('owned');
      expect(detail.canPublish).toBe(true);
      expect(detail.appCount).toBe(0);
      expect(detail.subscribeUrl).toMatch(/^http:\/\/memory\.local\/channel\.json$/);

      // 2) 远端存储：channel.json 存在且通过协议校验
      const raw = await h.readText('channel.json');
      expect(raw, '公开频道必须写入根目录 channel.json').toBeTruthy();
      const channel = parseChannelFile(raw ?? '');
      expect(channel.id).toBe(detail.id);
      expect(channel.name).toBe('公开频道');
      expect(channel.visibility).toBe('public');
      expect(channel.apps).toHaveLength(0);
      expect(channel.access).toBeUndefined();

      // 3) 本地记录（owner 身份持久化）
      const list = await publisher.core.channels.list();
      expect(list).toHaveLength(1);
      expect(list[0]?.id).toBe(detail.id);
      expect(list[0]?.source).toBe('owned');
      expect(await pathExists(`${publisher.dataDir}/channels.json`)).toBe(true);

      // 4) 第二个 core（订阅者）通过 HTTP 订阅同一频道
      const subscriber = await h.newCore('subscriber');
      const subscribed = await subscriber.core.channels.subscribe({ url: detail.subscribeUrl });
      expect(subscribed.id).toBe(detail.id);
      expect(subscribed.role).toBe('subscriber');
      expect(subscribed.canPublish).toBe(false);
      expect(subscribed.source).toBe('subscribed');
      expect(subscribed.appCount).toBe(0);

      // 5) refresh 会更新 lastFetchedAt，且不改变角色
      const refreshed = await subscriber.core.channels.refresh(detail.id);
      expect(refreshed.lastFetchedAt).toBeTruthy();
      expect(refreshed.role).toBe('subscriber');

      // 6) 取消订阅只删本地记录，不影响远端
      await subscriber.core.channels.unsubscribe(detail.id);
      expect(await subscriber.core.channels.list()).toEqual([]);
      expect(await h.readText('channel.json')).toBeTruthy();

      // 7) 订阅者不能发布（公开频道只读语义）
      const srcDir = await h.writeSourceFiles('subscriber-src', { 'a.cmd': 'echo a\n' });
      await expectAppError(
        () =>
          subscriber.core.publishing.publish({
            channelId: detail.id,
            version: '1.0.0',
            platform: 'windows',
            publishMode: 'files',
            entry: 'a.cmd',
            files: toPublishFiles(srcDir, ['a.cmd']),
            app: { appId: 'sub-app', displayName: 'Sub App' },
          }),
        ['AUTH', 'NOT_FOUND', 'VALIDATION', 'STATE'],
      );
    });
  });

  it('私密频道：写入 _private/<channelId>/<accessKey>/ 且仅能力链接可订阅', async (t) => {
    await withHarness(t, async (h) => {
      const publisher = await h.newCore('publisher');
      const detail = await createChannel(publisher, h, { name: '私密频道', visibility: 'private' });

      // 1) 订阅链接是能力链接（含 accessKey），且 channel.json 位于 _private 前缀下
      expect(detail.visibility).toBe('private');
      expect(detail.subscribeUrl).toContain(`/_private/${detail.id}/`);
      const capability = /\/_private\/([^/]+)\/([^/]+)\/channel\.json$/.exec(detail.subscribeUrl);
      expect(capability, `私密频道订阅地址格式不符合能力链接约定：${detail.subscribeUrl}`).not.toBeNull();
      const capabilityChannelId = capability?.[1];
      const accessKey = capability?.[2] ?? '';
      expect(capabilityChannelId).toBe(detail.id);
      expect(accessKey.length).toBeGreaterThanOrEqual(16);
      expect(h.keys()).toContain(`_private/${detail.id}/${accessKey}/channel.json`);

      // 2) 根目录不得出现可被匿名发现的 channel.json
      expect(await h.readText('channel.json')).toBeNull();

      const privateRaw = await h.readText(`_private/${detail.id}/${accessKey}/channel.json`);
      expect(privateRaw).toBeTruthy();
      const channel = parseChannelFile(privateRaw ?? '');
      expect(channel.visibility).toBe('private');
      expect(channel.access).toEqual({ type: 'secret-url' });

      // 3) 订阅者用错误链接（去掉 accessKey）失败
      const subscriber = await h.newCore('subscriber');
      await expectAppError(
        () => subscriber.core.channels.subscribe({ url: h.httpUrl(`_private/${detail.id}/channel.json`) }),
        ['NETWORK', 'NOT_FOUND', 'VALIDATION', 'AUTH'],
      );

      // 4) 正确能力链接订阅成功
      const subscribed = await subscriber.core.channels.subscribe({ url: detail.subscribeUrl });
      expect(subscribed.id).toBe(detail.id);
      expect(subscribed.role).toBe('subscriber');
      expect(subscribed.visibility).toBe('private');

      // 5) 订阅者（未持有 channel_pri）不能导出私密配置
      await expectAppError(
        () => subscriber.core.channels.exportPrivateConfig(detail.id),
        ['AUTH', 'NOT_FOUND', 'VALIDATION', 'STATE'],
      );

      // 6) owner 导出的 channel_pri.json 符合协议（含 accessKey 与 storage）
      const priText = await publisher.core.channels.exportPrivateConfig(detail.id);
      const pri = parseChannelPrivateFile(priText);
      expect(pri.kind).toBe('apphub-channel-private');
      expect(pri.channelId).toBe(detail.id);
      expect(pri.accessKey).toBe(accessKey);
      expect(pri.storage.provider).toBe('local');
      expect(priText).not.toContain('password');
    });
  });

  it('私密频道：导入 channel_pri.json 后成为管理员并可发布', async (t) => {
    await withHarness(t, async (h) => {
      const owner = await h.newCore('owner');
      const detail = await createChannel(owner, h, { name: '私密发布频道', visibility: 'private' });
      const priText = await owner.core.channels.exportPrivateConfig(detail.id);

      // 管理员通过"私下分享的 channel_pri.json"获得发布权限
      const admin = await h.newCore('admin');
      const imported = await admin.core.channels.importPrivateConfig(priText);
      expect(imported.id).toBe(detail.id);
      expect(['owner', 'admin']).toContain(imported.role);
      expect(imported.canPublish).toBe(true);

      const srcDir = await h.writeSourceFiles('admin-src', {
        'tool.cmd': 'echo private tool\n',
        'data/info.txt': 'private payload\n',
      });
      const result = await admin.core.publishing.publish({
        channelId: detail.id,
        app: { appId: 'private-tool', displayName: 'Private Tool', author: 'Admin' },
        version: '1.0.0',
        platform: 'windows',
        publishMode: 'files',
        entry: 'tool.cmd',
        files: toPublishFiles(srcDir, ['tool.cmd', 'data/info.txt']),
        changelog: '管理员发布',
      });
      expect(result.appId).toBe('private-tool');

      // owner 刷新后应看到管理员发布的 App（channel.json 合并写回）
      const refreshed = await owner.core.channels.refresh(detail.id);
      expect(refreshed.appCount).toBe(1);
      expect(refreshed.apps.map((app) => app.appId)).toContain('private-tool');
    });
  });
});
