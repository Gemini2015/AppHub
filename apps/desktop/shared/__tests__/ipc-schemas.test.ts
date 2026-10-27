import { describe, expect, it } from 'vitest';
import {
  AppRefRequestSchema,
  ChangeDataDirRequestSchema,
  ChannelIdRequestSchema,
  CreateChannelRequestSchema,
  EmptySchema,
  HostUpdateConfigRequestSchema,
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

describe('ipc-schemas：本机 Host 配置', () => {
  const shape = (patch: unknown) => ({ channelId: validChannelId, patch });

  it('接受合法 patch（空 patch / 端口 / 监听范围 / advertiseHost / publicBaseUrl）', () => {
    expect(HostUpdateConfigRequestSchema.safeParse(shape({})).success).toBe(true);
    expect(HostUpdateConfigRequestSchema.safeParse(shape({ port: 8787 })).success).toBe(true);
    expect(HostUpdateConfigRequestSchema.safeParse(shape({ port: 65535 })).success).toBe(true);
    expect(HostUpdateConfigRequestSchema.safeParse(shape({ bindHost: '0.0.0.0' })).success).toBe(true);
    expect(HostUpdateConfigRequestSchema.safeParse(shape({ bindHost: '127.0.0.1' })).success).toBe(true);
    expect(HostUpdateConfigRequestSchema.safeParse(shape({ advertiseHost: '192.168.1.10' })).success).toBe(true);
    expect(HostUpdateConfigRequestSchema.safeParse(shape({ advertiseHost: 'apphub.local' })).success).toBe(true);
    expect(
      HostUpdateConfigRequestSchema.safeParse(shape({ publicBaseUrl: 'http://192.168.1.10:8787/' })).success,
    ).toBe(true);
  });

  it('允许用空字符串清除可选字段（advertiseHost / publicBaseUrl → core 视为清除）', () => {
    expect(HostUpdateConfigRequestSchema.safeParse(shape({ advertiseHost: '' })).success).toBe(true);
    expect(HostUpdateConfigRequestSchema.safeParse(shape({ publicBaseUrl: '' })).success).toBe(true);
    expect(
      HostUpdateConfigRequestSchema.safeParse(shape({ advertiseHost: '', publicBaseUrl: '', port: 8787 })).success,
    ).toBe(true);
    // 仅这两个可选字段支持清除语义，其它字段不允许空串
    expect(HostUpdateConfigRequestSchema.safeParse(shape({ bindHost: '' })).success).toBe(false);
    expect(HostUpdateConfigRequestSchema.safeParse({ channelId: '', patch: {} }).success).toBe(false);
  });

  it('拒绝非法端口（0 / 70000 / 小数）', () => {
    expect(HostUpdateConfigRequestSchema.safeParse(shape({ port: 0 })).success).toBe(false);
    expect(HostUpdateConfigRequestSchema.safeParse(shape({ port: 70000 })).success).toBe(false);
    expect(HostUpdateConfigRequestSchema.safeParse(shape({ port: 1.5 })).success).toBe(false);
    expect(HostUpdateConfigRequestSchema.safeParse(shape({ port: '8787' })).success).toBe(false);
  });

  it('拒绝带协议/端口/路径的 advertiseHost、纯空白与非法 bindHost', () => {
    expect(HostUpdateConfigRequestSchema.safeParse(shape({ advertiseHost: 'http://evil.example' })).success).toBe(false);
    expect(HostUpdateConfigRequestSchema.safeParse(shape({ advertiseHost: 'host:8080' })).success).toBe(false);
    expect(HostUpdateConfigRequestSchema.safeParse(shape({ advertiseHost: 'host/path' })).success).toBe(false);
    expect(HostUpdateConfigRequestSchema.safeParse(shape({ advertiseHost: '   ' })).success).toBe(false);
    expect(HostUpdateConfigRequestSchema.safeParse(shape({ bindHost: '192.168.1.2' })).success).toBe(false);
    expect(HostUpdateConfigRequestSchema.safeParse(shape({ bindHost: 'localhost' })).success).toBe(false);
  });

  it('拒绝非 http(s) publicBaseUrl / rootDir 变更 / 多余字段', () => {
    expect(HostUpdateConfigRequestSchema.safeParse(shape({ publicBaseUrl: 'ftp://example.com/' })).success).toBe(false);
    expect(HostUpdateConfigRequestSchema.safeParse(shape({ publicBaseUrl: 'not-a-url' })).success).toBe(false);
    expect(HostUpdateConfigRequestSchema.safeParse(shape({ publicBaseUrl: 123 })).success).toBe(false);
    expect(HostUpdateConfigRequestSchema.safeParse(shape({ rootDir: '/tmp/repo' })).success).toBe(false);
    expect(HostUpdateConfigRequestSchema.safeParse({ channelId: validChannelId, patch: {}, extra: 1 }).success).toBe(
      false,
    );
    expect(
      HostUpdateConfigRequestSchema.safeParse({ channelId: validChannelId, patch: { unknown: 1 } }).success,
    ).toBe(false);
    expect(HostUpdateConfigRequestSchema.safeParse({ channelId: 'bad', patch: {} }).success).toBe(false);
  });
});

describe('ipc-schemas：修改数据目录', () => {
  it('接受绝对路径（Windows/POSIX 形式）', () => {
    expect(ChangeDataDirRequestSchema.safeParse({ path: 'D:\\AppHubData' }).success).toBe(true);
    expect(ChangeDataDirRequestSchema.safeParse({ path: '/home/user/AppHubData' }).success).toBe(true);
    expect(ChangeDataDirRequestSchema.safeParse({ path: '  /home/user/data  ' }).success).toBe(true);
  });

  it('拒绝空/空白/非字符串/缺字段/多余字段', () => {
    expect(ChangeDataDirRequestSchema.safeParse({}).success).toBe(false);
    expect(ChangeDataDirRequestSchema.safeParse({ path: '' }).success).toBe(false);
    expect(ChangeDataDirRequestSchema.safeParse({ path: '   ' }).success).toBe(false);
    expect(ChangeDataDirRequestSchema.safeParse({ path: 123 }).success).toBe(false);
    expect(ChangeDataDirRequestSchema.safeParse({ path: null }).success).toBe(false);
    expect(ChangeDataDirRequestSchema.safeParse({ path: '/home/x', extra: 1 }).success).toBe(false);
  });

  it('拒绝超长路径（>4096）', () => {
    expect(ChangeDataDirRequestSchema.safeParse({ path: `/${'a'.repeat(4096)}` }).success).toBe(false);
  });
});
