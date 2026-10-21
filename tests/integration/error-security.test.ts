import { describe, expect, it } from 'vitest';
import type { ChannelFile } from '@apphub/protocol';
import { parseChannelFile } from '@apphub/protocol';
import { createChannel, expectAppError, findFilesBySuffix, toPublishFiles, withHarness } from './support';

/**
 * 集成测试 E：错误处理与安全边界。
 *
 * 关注"坏输入/坏数据/越权/凭据泄露"这些真实世界会发生的场景，
 * 而不是只测 happy path（docs/PROTOCOL.md §9、ARCHITECTURE.md §4.3）。
 */
describe('集成：错误处理与安全', () => {
  it('订阅：坏 JSON / 缺字段 / 重复 App / 非法 metaUrl 都被拒绝（VALIDATION）', async (t) => {
    await withHarness(t, async (h) => {
      const publisher = await h.newCore('publisher');
      const channel = await createChannel(publisher, h);
      const srcDir = await h.writeSourceFiles('bad-channel-src', { 'a.cmd': 'echo a\n' });
      await publisher.core.publishing.publish({
        channelId: channel.id,
        app: { appId: 'good-app', displayName: 'Good App' },
        version: '1.0.0',
        platform: 'windows',
        publishMode: 'files',
        entry: 'a.cmd',
        files: toPublishFiles(srcDir, ['a.cmd']),
      });
      const goodChannelText = (await h.readText('channel.json')) as string;
      const goodChannel = parseChannelFile(goodChannelText);

      // 1) 非法 JSON
      const subscriber = await h.newCore('subscriber');
      h.injectText('channel.json', '{ this is not json');
      await expectAppError(
        () => subscriber.core.channels.subscribe({ url: channel.subscribeUrl }),
        ['VALIDATION'],
      );

      // 2) 缺字段（schema 不满足）
      h.injectText('channel.json', JSON.stringify({ schemaVersion: 1, kind: 'apphub-channel' }));
      await expectAppError(
        () => subscriber.core.channels.subscribe({ url: channel.subscribeUrl }),
        ['VALIDATION'],
      );

      // 3) 重复登记同一个 App
      const duplicated: ChannelFile = {
        ...goodChannel,
        apps: [goodChannel.apps[0]!, { ...goodChannel.apps[0]! }],
      };
      h.injectText('channel.json', JSON.stringify(duplicated));
      await expectAppError(
        () => subscriber.core.channels.subscribe({ url: channel.subscribeUrl }),
        ['VALIDATION'],
      );

      // 4) metaUrl 路径穿越
      const traversed: ChannelFile = {
        ...goodChannel,
        apps: [{ ...goodChannel.apps[0]!, metaUrl: '../../evil/app.meta.json' }],
      };
      h.injectText('channel.json', JSON.stringify(traversed));
      await expectAppError(
        () => subscriber.core.channels.subscribe({ url: channel.subscribeUrl }),
        ['VALIDATION', 'SECURITY'],
      );

      // 5) 非法 appId
      const badAppId = {
        ...goodChannel,
        apps: [{ ...goodChannel.apps[0]!, appId: '../evil' }],
      };
      h.injectText('channel.json', JSON.stringify(badAppId));
      await expectAppError(
        () => subscriber.core.channels.subscribe({ url: channel.subscribeUrl }),
        ['VALIDATION', 'SECURITY'],
      );

      // 6) 恢复合法内容后可正常订阅（证明上面失败是数据问题，不是实现坏了）
      h.injectText('channel.json', goodChannelText);
      const subscribed = await subscriber.core.channels.subscribe({ url: channel.subscribeUrl });
      expect(subscribed.id).toBe(channel.id);
      expect(subscribed.appCount).toBe(1);
    });
  });

  it('订阅：不可达 / 非 http(s) 地址返回可读错误且不外联', async (t) => {
    await withHarness(t, async (h) => {
      const subscriber = await h.newCore('subscriber');

      // 外部域名：harness 的 fetchImpl 会拒绝非 memory.local 请求（离线约束）
      await expectAppError(
        () => subscriber.core.channels.subscribe({ url: 'http://example.com/channel.json' }),
        ['NETWORK', 'STORAGE', 'VALIDATION'],
      );

      // 非 http(s) 协议必须被协议层拒绝
      await expectAppError(
        () => subscriber.core.channels.subscribe({ url: 'ftp://example.com/channel.json' }),
        ['VALIDATION', 'SECURITY', 'NETWORK'],
      );

      // memory 存储中不存在的对象 → 404
      await expectAppError(
        () => subscriber.core.channels.subscribe({ url: h.httpUrl('no-such/channel.json') }),
        ['NETWORK', 'NOT_FOUND'],
      );
    });
  });

  it('凭据安全：secretKey 不进入日志、channel_pri 密文与本地记录', async (t) => {
    await withHarness(t, async (h) => {
      const secret = 'S3_SECRET_DO_NOT_LEAK_0123456789';
      const publisher = await h.newCore('publisher');
      const detail = await publisher.core.channels.create({
        name: '凭据测试频道',
        visibility: 'private',
        owner: { name: 'QA' },
        storage: {
          provider: 's3',
          endpoint: 'http://127.0.0.1:9000',
          region: 'us-east-1',
          bucket: 'apphub-tests',
          accessKey: 'AKIA_TEST_ACCESS_KEY',
          secretKey: secret,
          pathStyle: true,
          secure: false,
          prefix: '',
        },
      });
      expect(detail.id).toMatch(/^ch_/);

      // 1) 日志中不得出现明文 secret
      const logText = JSON.stringify(h.logger.entries);
      expect(logText).not.toContain(secret);

      // 2) 返回给调用方的 ChannelDetail 不得包含 secret
      expect(JSON.stringify(detail)).not.toContain(secret);

      // 3) channel_pri.json 以密文落盘，磁盘文件中不得出现明文 secret
      const encFiles = await findFilesBySuffix(publisher.dataDir, '.enc');
      expect(encFiles.length).toBeGreaterThan(0);
      for (const encFile of encFiles) {
        const raw = (await import('node:fs')).readFileSync(encFile);
        expect(raw.toString('utf8')).not.toContain(secret);
      }

      // 4) 本地 channels.json 也不存凭据
      const channelsFiles = await findFilesBySuffix(publisher.dataDir, 'channels.json');
      expect(channelsFiles.length).toBeGreaterThan(0);
      for (const channelsFile of channelsFiles) {
        const raw = (await import('node:fs')).readFileSync(channelsFile, 'utf8');
        expect(raw).not.toContain(secret);
      }

      // 5) 校验失败的错误信息也不应回显 secret
      const error = await expectAppError(
        () =>
          publisher.core.channels.create({
            name: '非法配置频道',
            visibility: 'public',
            storage: {
              provider: 's3',
              region: 'us-east-1',
              // bucket 非法（空串）→ VALIDATION；错误细节里不得回显 secretKey
              bucket: '',
              accessKey: 'AKIA_TEST_ACCESS_KEY',
              secretKey: secret,
              pathStyle: true,
              secure: false,
              prefix: '',
            },
          }),
        ['VALIDATION'],
      );
      expect(JSON.stringify({ message: error.message, details: error.details })).not.toContain(secret);
    });
  });

  it('发布与安装的越权/错误输入不会污染频道元信息', async (t) => {
    await withHarness(t, async (h) => {
      const publisher = await h.newCore('publisher');
      const channel = await createChannel(publisher, h);
      const srcDir = await h.writeSourceFiles('perm-src', { 'a.cmd': 'echo a\n' });

      // 发布到不存在的频道
      await expectAppError(
        () =>
          publisher.core.publishing.publish({
            channelId: 'ch_00000000000000000000',
            app: { appId: 'ghost-app', displayName: 'Ghost App' },
            version: '1.0.0',
            platform: 'windows',
            publishMode: 'files',
            entry: 'a.cmd',
            files: toPublishFiles(srcDir, ['a.cmd']),
          }),
        ['NOT_FOUND', 'VALIDATION', 'AUTH', 'STATE'],
      );

      // 频道元信息保持干净（没有 ghost-app 残留）
      const channelText = (await h.readText('channel.json')) ?? '';
      expect(channelText).not.toContain('ghost-app');

      // 订阅者（非 owner）发布被拒绝（公开频道只读语义）
      const subscriber = await h.newCore('subscriber');
      await subscriber.core.channels.subscribe({ url: channel.subscribeUrl });
      await expectAppError(
        () =>
          subscriber.core.publishing.publish({
            channelId: channel.id,
            app: { appId: 'ghost-app', displayName: 'Ghost App' },
            version: '1.0.0',
            platform: 'windows',
            publishMode: 'files',
            entry: 'a.cmd',
            files: toPublishFiles(srcDir, ['a.cmd']),
          }),
        ['AUTH', 'NOT_FOUND', 'VALIDATION', 'STATE'],
      );
      expect((await h.readText('channel.json')) ?? '').not.toContain('ghost-app');
    });
  });
});
