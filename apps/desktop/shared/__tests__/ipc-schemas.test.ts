import { describe, expect, it } from 'vitest';
import {
  AppRefRequestSchema,
  ChannelIdRequestSchema,
  CreateChannelRequestSchema,
  EmptySchema,
  InstallRequestSchema,
  PickRequestSchema,
  PublishRequestSchema,
  SubscribeRequestSchema,
  UpdateAppMetaRequestSchema,
  UpdateChannelRequestSchema,
} from '../ipc-schemas';

/**
 * shared/ipc-schemas.ts 的主进程侧校验：
 * 重点是 strict 语义（拒绝多余字段）与协议字段校验，防止渲染进程投递未声明数据。
 */

const validChannelId = 'ch_0123456789abcdef';
const validAppId = 'demo-app';
const validStorage = {
  provider: 'local',
  rootDir: 'E:\\repo',
  publicBaseUrl: 'http://127.0.0.1:8080/',
};

describe('ipc-schemas：拒绝多余字段', () => {
  it('ChannelIdRequestSchema 拒绝多余字段', () => {
    const result = ChannelIdRequestSchema.safeParse({ channelId: validChannelId, extra: 1 });
    expect(result.success).toBe(false);
  });

  it('CreateChannelRequestSchema 拒绝多余字段与非法 visibility', () => {
    const ok = CreateChannelRequestSchema.safeParse({
      name: '测试频道',
      visibility: 'public',
      storage: validStorage,
    });
    expect(ok.success).toBe(true);

    const extra = CreateChannelRequestSchema.safeParse({
      name: '测试频道',
      visibility: 'public',
      storage: validStorage,
      admin: true,
    });
    expect(extra.success).toBe(false);

    const badVisibility = CreateChannelRequestSchema.safeParse({
      name: '测试频道',
      visibility: 'secret',
      storage: validStorage,
    });
    expect(badVisibility.success).toBe(false);
  });

  it('UpdateChannelRequestSchema.patch 拒绝多余字段', () => {
    const result = UpdateChannelRequestSchema.safeParse({
      channelId: validChannelId,
      patch: { name: '新名字', unknownField: 'x' },
    });
    expect(result.success).toBe(false);
  });

  it('InstallRequestSchema 拒绝多余字段与非法版本号', () => {
    const ok = InstallRequestSchema.safeParse({ channelId: validChannelId, appId: validAppId, force: true });
    expect(ok.success).toBe(true);

    const extra = InstallRequestSchema.safeParse({ channelId: validChannelId, appId: validAppId, foo: 1 });
    expect(extra.success).toBe(false);

    const badVersion = InstallRequestSchema.safeParse({
      channelId: validChannelId,
      appId: validAppId,
      version: 'not-semver',
    });
    expect(badVersion.success).toBe(false);
  });

  it('EmptySchema 拒绝非空对象', () => {
    expect(EmptySchema.safeParse(undefined).success).toBe(true);
    expect(EmptySchema.safeParse({}).success).toBe(true);
    expect(EmptySchema.safeParse({ sneaky: true }).success).toBe(false);
  });
});

describe('ipc-schemas：协议字段校验', () => {
  it('ChannelIdRequestSchema 拒绝非法频道 ID', () => {
    expect(ChannelIdRequestSchema.safeParse({ channelId: 'ch_zzz' }).success).toBe(false);
    expect(ChannelIdRequestSchema.safeParse({ channelId: 'ch_0123456789abcdef' }).success).toBe(true);
  });

  it('AppRefRequestSchema 拒绝非法 appId / 缺字段', () => {
    expect(AppRefRequestSchema.safeParse({ channelId: validChannelId, appId: validAppId }).success).toBe(true);
    expect(AppRefRequestSchema.safeParse({ channelId: validChannelId, appId: 'UPPER' }).success).toBe(false);
    expect(AppRefRequestSchema.safeParse({ channelId: validChannelId }).success).toBe(false);
  });

  it('SubscribeRequestSchema 只接受 http(s) URL，拒绝 ftp/file', () => {
    expect(SubscribeRequestSchema.safeParse({ url: 'https://example.com/channel.json' }).success).toBe(true);
    expect(SubscribeRequestSchema.safeParse({ url: 'http://example.com/channel.json' }).success).toBe(true);
    expect(SubscribeRequestSchema.safeParse({ url: 'ftp://example.com/channel.json' }).success).toBe(false);
    expect(SubscribeRequestSchema.safeParse({ url: 'file:///C:/channel.json' }).success).toBe(false);
    expect(SubscribeRequestSchema.safeParse({ url: 'not-a-url' }).success).toBe(false);
  });

  it('PublishRequestSchema 拒绝非法 entry / 非法平台 / 多余字段', () => {
    const base = {
      channelId: validChannelId,
      displayName: '示例 App',
      version: '1.0.0',
      platform: 'windows',
      publishMode: 'files',
      entry: 'app.exe',
      selectionId: 'sel-1',
    };
    expect(PublishRequestSchema.safeParse(base).success).toBe(true);
    expect(PublishRequestSchema.safeParse({ ...base, platform: 'android' }).success).toBe(false);
    expect(PublishRequestSchema.safeParse({ ...base, entry: '' }).success).toBe(false);
    expect(PublishRequestSchema.safeParse({ ...base, malware: true }).success).toBe(false);
    expect(PublishRequestSchema.safeParse({ ...base, version: 'abc' }).success).toBe(false);
  });

  it('UpdateAppMetaRequestSchema 的 homepage 只接受 http(s) 或空串', () => {
    const shape = { channelId: validChannelId, appId: validAppId, patch: {} };
    expect(UpdateAppMetaRequestSchema.safeParse(shape).success).toBe(true);
    expect(UpdateAppMetaRequestSchema.safeParse({ ...shape, patch: { homepage: 'https://example.com' } }).success).toBe(true);
    expect(UpdateAppMetaRequestSchema.safeParse({ ...shape, patch: { homepage: '' } }).success).toBe(true);
    expect(UpdateAppMetaRequestSchema.safeParse({ ...shape, patch: { homepage: 'javascript:alert(1)' } }).success).toBe(false);
  });

  it('PickRequestSchema 缺省 kind 为 files', () => {
    expect(PickRequestSchema.parse({})).toEqual({ kind: 'files' });
  });
});
