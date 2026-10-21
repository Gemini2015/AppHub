import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseChannelFile } from '@apphub/protocol';
import type { ChannelRecord } from './types';
import { readJsonFile, pathExists } from '@apphub/testkit';
import {
  createTestEnv,
  expectAppError,
  type TestEnv,
} from './test-helpers';

const envs: TestEnv[] = [];

async function newEnv(options: Parameters<typeof createTestEnv>[0] = {}): Promise<TestEnv> {
  const env = await createTestEnv(options);
  envs.push(env);
  return env;
}

afterEach(async () => {
  while (envs.length > 0) {
    const env = envs.pop()!;
    await env.dispose();
  }
});

async function readChannelRecords(env: TestEnv): Promise<ChannelRecord[]> {
  const data = await readJsonFile<{ channels: ChannelRecord[] }>(
    path.join(env.dataDir, 'channels.json'),
  );
  return data?.channels ?? [];
}

describe('ChannelService.create', () => {
  it('创建公开频道：probe、写入远端 channel.json、加密私有配置、本地记录与缓存', async () => {
    const env = await newEnv();
    const detail = await env.createChannel({ name: '公开频道', description: '描述' });

    expect(detail.id).toMatch(/^ch_[a-z0-9]{16,32}$/);
    expect(detail.role).toBe('owner');
    expect(detail.source).toBe('owned');
    expect(detail.canPublish).toBe(true);
    expect(detail.visibility).toBe('public');
    expect(detail.appCount).toBe(0);
    expect(detail.name).toBe('公开频道');
    expect(detail.description).toBe('描述');
    expect(detail.createdAt).toBe('2026-01-01T00:00:00.000Z');
    expect(detail.channel.kind).toBe('apphub-channel');
    expect(detail.channel.access).toBeUndefined();
    expect(detail.subscribeUrl).toBe('http://memory.local/channel.json');
    expect(env.probes.count).toBe(1);

    // 远端 channel.json 已写入且可校验
    const remote = parseChannelFile(env.readObjectText('channel.json')!);
    expect(remote.id).toBe(detail.id);
    expect(remote.name).toBe('公开频道');

    // 本地记录 + 缓存
    const records = await readChannelRecords(env);
    expect(records).toHaveLength(1);
    expect(records[0]!.channelId).toBe(detail.id);
    expect(records[0]!.role).toBe('owner');
    expect(records[0]!.source).toBe('owned');
    expect(
      await pathExists(path.join(env.dataDir, 'channels', detail.id, 'channel.json')),
    ).toBe(true);

    // 私有配置以密文落盘，且任何本地文件中都不应出现配置明文特征
    const secretsDir = path.join(env.dataDir, 'secrets', 'channel_pri');
    const files = await fs.readdir(secretsDir);
    expect(files).toEqual([`${detail.id}.enc`]);
    const cipher = await fs.readFile(path.join(secretsDir, files[0]!), 'utf8');
    expect(cipher.startsWith('fake:v1:')).toBe(true);
    expect(cipher.includes(env.storageRoot)).toBe(false);
  });

  it('创建私密频道：生成 accessKey、channel.json 带 access 标记、订阅链接为能力链接', async () => {
    const env = await newEnv();
    const detail = await env.createChannel({ visibility: 'private', name: '私密频道' });

    expect(detail.visibility).toBe('private');
    expect(detail.channel.access).toEqual({ type: 'secret-url' });
    expect(detail.subscribeUrl).toContain('/_private/');

    const pri = JSON.parse(await env.core.channels.exportPrivateConfig(detail.id)) as {
      accessKey?: string;
      visibility: string;
      storage: { provider: string };
    };
    expect(pri.visibility).toBe('private');
    expect(pri.accessKey).toMatch(/^[0-9a-f]{48}$/);
    expect(pri.storage.provider).toBe('local');

    const descriptorKey = `_private/${detail.id}/${pri.accessKey}/channel.json`;
    expect(detail.subscribeUrl).toBe(`http://memory.local/${descriptorKey}`);
    expect(env.readObject(descriptorKey)).not.toBeNull();
    const url = await env.core.channels.getSubscribeUrl(detail.id);
    expect(url).toBe(detail.subscribeUrl);
  });

  it('创建时校验输入：非法存储配置/空名称/非法可见性', async () => {
    const env = await newEnv();
    await expectAppError(
      env.core.channels.create({
        name: 'x',
        visibility: 'public',
        storage: { provider: 'local' } as never,
      }),
      'VALIDATION',
    );
    await expectAppError(env.createChannel({ name: '   ' }), 'VALIDATION');
    await expectAppError(env.createChannel({ visibility: 'server' as never }), 'VALIDATION');
    expect(await env.core.channels.list()).toHaveLength(0);
  });

  it('存储位置已有 channel.json 时拒绝重复创建（CONFLICT）', async () => {
    const env = await newEnv();
    await env.createChannel({ name: 'A' });
    const error = await expectAppError(env.createChannel({ name: 'B' }), 'CONFLICT');
    expect(error.message).toContain('已存在');
  });

  it('skipProbe=true 时不执行存储探测', async () => {
    const env = await newEnv();
    await env.core.channels.create({
      name: '跳过探测',
      visibility: 'public',
      storage: env.storageConfig(),
      skipProbe: true,
    });
    expect(env.probes.count).toBe(0);
  });

  it('存储探测失败时抛出 STORAGE 错误且不落盘任何记录', async () => {
    const env = await newEnv();
    env.faults.probe = () => {
      throw new Error('connection refused');
    };
    await expectAppError(env.createChannel({ name: '坏存储' }), 'STORAGE');
    expect(await env.core.channels.list()).toHaveLength(0);
    expect(await pathExists(path.join(env.dataDir, 'channels.json'))).toBe(false);
  });
});

describe('ChannelService.list / get / update', () => {
  it('list 返回本地频道摘要（含 appCount 与 canPublish）', async () => {
    const env = await newEnv();
    const created = await env.createChannel({ name: 'Zeta' });
    const list = await env.core.channels.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: created.id,
      name: 'Zeta',
      role: 'owner',
      canPublish: true,
      source: 'owned',
      appCount: 0,
    });
    expect(list[0]!.lastFetchedAt).toBeTruthy();
  });

  it('get 对不存在的频道抛 NOT_FOUND', async () => {
    const env = await newEnv();
    await expectAppError(env.core.channels.get('ch_0123456789abcdef0123'), 'NOT_FOUND');
  });

  it('get 在缓存缺失时自动从远端刷新', async () => {
    const env = await newEnv();
    const detail = await env.createChannel();
    await fs.rm(path.join(env.dataDir, 'channels', detail.id), { recursive: true, force: true });
    const loaded = await env.core.channels.get(detail.id);
    expect(loaded.name).toBe(detail.name);
    expect(loaded.channel.id).toBe(detail.id);
  });

  it('update 合并名称/描述/所有者并保留其它 App 引用', async () => {
    const env = await newEnv();
    const detail = await env.createChannel();
    const appRef = {
      appId: 'foo',
      name: 'foo',
      displayName: 'Foo',
      description: '',
      author: '',
      entry: 'foo.exe',
      platforms: ['windows' as const],
      publishMode: 'files' as const,
      latest: { windows: '1.0.0' },
      metaUrl: 'foo/app.meta.json',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const remote = { ...detail.channel, apps: [appRef] };
    env.setObject('channel.json', `${JSON.stringify(remote, null, 2)}\n`);

    env.clock.advance(5000);
    const updated = await env.core.channels.update(detail.id, {
      name: '新名称',
      description: '新描述',
      owner: { name: 'Alice', contact: 'a@example.com' },
    });
    expect(updated.name).toBe('新名称');
    expect(updated.description).toBe('新描述');
    expect(updated.channel.owner.name).toBe('Alice');
    expect(updated.channel.apps).toHaveLength(1);
    expect(updated.channel.apps[0]!.appId).toBe('foo');
    expect(updated.updatedAt).toBe('2026-01-01T00:00:05.000Z');

    const remoteAfter = parseChannelFile(env.readObjectText('channel.json')!);
    expect(remoteAfter.name).toBe('新名称');
    expect(remoteAfter.apps[0]!.appId).toBe('foo');

    const list = await env.core.channels.list();
    expect(list[0]!.name).toBe('新名称');
  });

  it('订阅者调用 update 抛 AUTH', async () => {
    const publisher = await newEnv();
    const detail = await publisher.createChannel();
    const reader = await newEnv({ objects: publisher.objects });
    await reader.core.channels.subscribe({ url: detail.subscribeUrl });
    await expectAppError(reader.core.channels.update(detail.id, { name: 'x' }), 'AUTH');
  });
});

describe('ChannelService.subscribe / refresh', () => {
  it('订阅公开频道：记录缓存、角色为 subscriber、不可发布', async () => {
    const publisher = await newEnv();
    const detail = await publisher.createChannel({ name: '公开订阅' });
    const reader = await newEnv({ objects: publisher.objects });

    const subscribed = await reader.core.channels.subscribe({ url: detail.subscribeUrl });
    expect(subscribed.id).toBe(detail.id);
    expect(subscribed.role).toBe('subscriber');
    expect(subscribed.source).toBe('subscribed');
    expect(subscribed.canPublish).toBe(false);
    expect(subscribed.channel.name).toBe('公开订阅');
    expect(
      await pathExists(path.join(reader.dataDir, 'channels', detail.id, 'channel.json')),
    ).toBe(true);
    expect(reader.fetchRequests).toContain('channel.json');

    const list = await reader.core.channels.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.canPublish).toBe(false);
  });

  it('订阅私密频道能力链接可用；缺少 accessKey 的地址被拒绝', async () => {
    const publisher = await newEnv();
    const detail = await publisher.createChannel({ visibility: 'private' });
    const reader = await newEnv({ objects: publisher.objects });

    const subscribed = await reader.core.channels.subscribe({ url: detail.subscribeUrl });
    expect(subscribed.role).toBe('subscriber');
    expect(subscribed.visibility).toBe('private');

    // 把私密 channel.json 内容暴露到公开路径，构造"看似公开"的错误地址
    const pri = JSON.parse(await publisher.core.channels.exportPrivateConfig(detail.id)) as {
      accessKey: string;
    };
    const descriptor = publisher.readObjectText(`_private/${detail.id}/${pri.accessKey}/channel.json`);
    reader.setObject('channel.json', descriptor!);
    const error = await expectAppError(
      reader.core.channels.subscribe({ url: 'http://memory.local/channel.json' }),
      'VALIDATION',
    );
    expect(error.message).toContain('_private');
  });

  it('订阅地址中的频道 ID 与 channel.json 不一致时拒绝', async () => {
    const publisher = await newEnv();
    const detail = await publisher.createChannel({ visibility: 'private' });
    const reader = await newEnv({ objects: publisher.objects });
    const pri = JSON.parse(await publisher.core.channels.exportPrivateConfig(detail.id)) as {
      accessKey: string;
    };
    const descriptor = env_or_throw(publisher.readObjectText(
      `_private/${detail.id}/${pri.accessKey}/channel.json`,
    ));
    const fakeKey = `_private/ch_aaaaaaaaaaaaaaaa/${pri.accessKey}/channel.json`;
    reader.setObject(fakeKey, descriptor);
    await expectAppError(
      reader.core.channels.subscribe({ url: `http://memory.local/${fakeKey}` }),
      'VALIDATION',
    );
  });

  it('订阅非法 URL / 非 JSON / schema 不合法时给出可读 VALIDATION 错误', async () => {
    const env = await newEnv();
    await expectAppError(env.core.channels.subscribe({ url: 'ftp://example.com/channel.json' }), 'VALIDATION');
    await expectAppError(env.core.channels.subscribe({ url: 'http://memory.local/other.json' }), 'VALIDATION');

    env.setFetchHook(() => new Response('<html>not json</html>', { status: 200 }));
    await expectAppError(env.core.channels.subscribe({ url: 'http://memory.local/channel.json' }), 'VALIDATION');

    env.setFetchHook(() => new Response('{"schemaVersion":1}', { status: 200 }));
    await expectAppError(env.core.channels.subscribe({ url: 'http://memory.local/channel.json' }), 'VALIDATION');
  });

  it('订阅 headers 加密持久化，刷新时继续携带', async () => {
    const publisher = await newEnv();
    const detail = await publisher.createChannel();
    const reader = await newEnv({ objects: publisher.objects });
    let seenAuthorization: string | null = null;
    reader.setFetchHook(({ init }) => {
      const headers = new Headers(init?.headers as Record<string, string> | undefined);
      seenAuthorization = headers.get('authorization');
      if (seenAuthorization !== 'Bearer secret-token') {
        return new Response('unauthorized', { status: 401, statusText: 'Unauthorized' });
      }
      return undefined;
    });
    await expectAppError(
      reader.core.channels.subscribe({ url: detail.subscribeUrl }),
      'AUTH',
    );
    const subscribed = await reader.core.channels.subscribe({
      url: detail.subscribeUrl,
      headers: { Authorization: 'Bearer secret-token' },
    });
    expect(subscribed.id).toBe(detail.id);
    expect(seenAuthorization).toBe('Bearer secret-token');

    // headers 加密落盘（本地 channels.json 不出现明文 token）
    const raw = await fs.readFile(path.join(reader.dataDir, 'channels.json'), 'utf8');
    expect(raw).not.toContain('Bearer secret-token');
    expect(raw).toContain('fake:v1:');

    // 刷新继续携带 headers
    await reader.core.channels.refresh(detail.id);
    expect(seenAuthorization).toBe('Bearer secret-token');
  });

  it('refresh 更新缓存与 lastFetchedAt；refreshAll 对失败频道容忍', async () => {
    const publisher = await newEnv();
    const publicChannel = await publisher.createChannel({ name: '公开' });
    const privateChannel = await publisher.createChannel({ name: '私有', visibility: 'private' });
    const reader = await newEnv({ objects: publisher.objects });
    await reader.core.channels.subscribe({ url: publicChannel.subscribeUrl });
    await reader.core.channels.subscribe({ url: privateChannel.subscribeUrl });

    // 远端改名
    const pri = JSON.parse(
      await publisher.core.channels.exportPrivateConfig(privateChannel.id),
    ) as { accessKey: string };
    const privateKey = `_private/${privateChannel.id}/${pri.accessKey}/channel.json`;
    const remotePrivate = parseChannelFile(publisher.readObjectText(privateKey)!);
    publisher.setObject(privateKey, `${JSON.stringify({ ...remotePrivate, name: '私有-改名' }, null, 2)}\n`);

    reader.clock.advance(10_000);
    const refreshed = await reader.core.channels.refresh(privateChannel.id);
    expect(refreshed.name).toBe('私有-改名');
    expect(refreshed.lastFetchedAt).toBe('2026-01-01T00:00:10.000Z');

    // 让私密频道刷新失败（公开频道正常）
    reader.setFetchHook(({ key }) =>
      key.startsWith('_private/') ? new Response('server error', { status: 500 }) : undefined,
    );
    const all = await reader.core.channels.refreshAll();
    expect(all).toHaveLength(2);
    expect(reader.logger.entries.some((entry) => entry.level === 'warn')).toBe(true);
  });

  it('unsubscribe 删除本地记录与缓存（远端不受影响）', async () => {
    const publisher = await newEnv();
    const detail = await publisher.createChannel();
    const reader = await newEnv({ objects: publisher.objects });
    await reader.core.channels.subscribe({ url: detail.subscribeUrl });

    await reader.core.channels.unsubscribe(detail.id);
    expect(await reader.core.channels.list()).toHaveLength(0);
    expect(
      await pathExists(path.join(reader.dataDir, 'channels', detail.id)),
    ).toBe(false);
    expect(publisher.readObject('channel.json')).not.toBeNull();
  });
});

function env_or_throw(value: string | null): string {
  if (value === null) throw new Error('期望对象存在');
  return value;
}

describe('ChannelService 私有配置导入导出', () => {
  it('export/import 往返授予 admin 发布权限，且配置以密文保存', async () => {
    const publisher = await newEnv();
    const detail = await publisher.createChannel({ visibility: 'private' });
    const exported = await publisher.core.channels.exportPrivateConfig(detail.id);
    const pri = JSON.parse(exported) as { channelId: string; accessKey: string };
    expect(pri.channelId).toBe(detail.id);

    const admin = await newEnv({ objects: publisher.objects });
    const imported = await admin.core.channels.importPrivateConfig(exported);
    expect(imported.id).toBe(detail.id);
    expect(imported.role).toBe('admin');
    expect(imported.canPublish).toBe(true);
    expect(imported.source).toBe('subscribed');

    // 再次导出应得到等价内容
    const exportedAgain = await admin.core.channels.exportPrivateConfig(detail.id);
    expect(JSON.parse(exportedAgain)).toEqual(JSON.parse(exported));

    // 本地只有密文
    const cipher = await fs.readFile(
      path.join(admin.dataDir, 'secrets', 'channel_pri', `${detail.id}.enc`),
      'utf8',
    );
    expect(cipher.startsWith('fake:v1:')).toBe(true);
    expect(cipher).not.toContain(pri.accessKey);
  });

  it('import 非法 JSON / 频道不可达 / probe 失败均给出可读错误', async () => {
    const env = await newEnv();
    await expectAppError(env.core.channels.importPrivateConfig('not json'), 'VALIDATION');
    await expectAppError(env.core.channels.importPrivateConfig('{"kind":"x"}'), 'VALIDATION');

    const publisher = await newEnv();
    const detail = await publisher.createChannel({ visibility: 'private' });
    const exported = await publisher.core.channels.exportPrivateConfig(detail.id);
    const reader = await newEnv({ objects: publisher.objects });
    reader.setFetchHook(() => new Response('not found', { status: 404, statusText: 'Not Found' }));
    const error = await expectAppError(reader.core.channels.importPrivateConfig(exported), 'NOT_FOUND');
    expect(error.message).toContain('无法访问频道描述文件');

    const probeEnv = await newEnv({ objects: publisher.objects });
    probeEnv.faults.probe = () => {
      throw new Error('probe failed');
    };
    await expectAppError(probeEnv.core.channels.importPrivateConfig(exported), 'STORAGE');
  });

  it('exportPrivateConfig 对订阅者抛 AUTH、对缺失私有配置抛 NOT_FOUND', async () => {
    const publisher = await newEnv();
    const detail = await publisher.createChannel();
    const reader = await newEnv({ objects: publisher.objects });
    await reader.core.channels.subscribe({ url: detail.subscribeUrl });
    await expectAppError(reader.core.channels.exportPrivateConfig(detail.id), 'AUTH');

    const owner = await newEnv();
    const owned = await owner.createChannel();
    await fs.rm(path.join(owner.dataDir, 'secrets', 'channel_pri', `${owned.id}.enc`));
    await expectAppError(owner.core.channels.exportPrivateConfig(owned.id), 'NOT_FOUND');
  });

  it('错误信息中不泄露私密频道 accessKey', async () => {
    const publisher = await newEnv();
    const detail = await publisher.createChannel({ visibility: 'private' });
    const pri = JSON.parse(await publisher.core.channels.exportPrivateConfig(detail.id)) as {
      accessKey: string;
    };
    const reader = await newEnv();
    // 让远端不存在该频道对象（fetch 404）
    const error = await expectAppError(
      reader.core.channels.subscribe({ url: detail.subscribeUrl }),
      'NOT_FOUND',
    );
    expect(error.message).not.toContain(pri.accessKey);
    expect(error.message).toContain('***');
  });
});

describe('CoreContext.defaultHeaders 默认请求头', () => {
  it('默认请求头会附加到订阅与刷新的 HTTP 请求', async () => {
    const publisher = await newEnv();
    const detail = await publisher.createChannel({ name: '默认头频道' });
    const reader = await newEnv({
      objects: publisher.objects,
      defaultHeaders: { 'X-AppHub-Token': 'abc123' },
    });
    const seen: (string | null)[] = [];
    reader.setFetchHook(({ init }) => {
      const headers = new Headers(init?.headers as Record<string, string> | undefined);
      seen.push(headers.get('x-apphub-token'));
      return undefined;
    });
    await reader.core.channels.subscribe({ url: detail.subscribeUrl });
    expect(seen).toContain('abc123');
    seen.length = 0;
    await reader.core.channels.refresh(detail.id);
    expect(seen).toContain('abc123');
  });
});

describe('S3 prefix 订阅地址一致性（与存储适配器行为对齐）', () => {  it('S3 + prefix 时订阅地址统一来自适配器 getDownloadUrl（包含 prefix）', async () => {
    const prefix = 'apphub/';
    const env = await newEnv({
      getDownloadUrlOverride: async (key) => `http://memory.local/${prefix}${key}`,
    });
    const s3Config = {
      provider: 's3' as const,
      bucket: 'bucket',
      accessKey: 'access-key',
      secretKey: 'secret-key',
      prefix,
      publicBaseUrl: 'http://memory.local/',
      region: 'us-east-1',
      pathStyle: true,
      secure: false,
    };

    const publicChannel = await env.createChannel({ storage: s3Config });
    expect(publicChannel.subscribeUrl).toBe('http://memory.local/apphub/channel.json');
    // 与适配器 getDownloadUrl 的行为完全一致（core 不自行拼接 baseUrl）
    const adapter = env.factory.create(s3Config);
    try {
      expect(await adapter.getDownloadUrl('channel.json')).toBe(publicChannel.subscribeUrl);
    } finally {
      await adapter.close();
    }
    expect(await env.core.channels.getSubscribeUrl(publicChannel.id)).toBe(
      publicChannel.subscribeUrl,
    );

    // 私密频道：能力链接同样包含 prefix 与 accessKey
    const privateChannel = await env.createChannel({
      storage: s3Config,
      visibility: 'private',
    });
    const pri = JSON.parse(
      await env.core.channels.exportPrivateConfig(privateChannel.id),
    ) as { accessKey: string };
    expect(privateChannel.subscribeUrl).toBe(
      `http://memory.local/apphub/_private/${privateChannel.id}/${pri.accessKey}/channel.json`,
    );
  });
});
