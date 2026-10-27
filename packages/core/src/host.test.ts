import { promises as fs } from 'node:fs';
import { request as httpRequest } from 'node:http';
import {
  createServer as createNetServer,
  type Server as NetServer,
} from 'node:net';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseChannelFile } from '@apphub/protocol';
import type { LocalHostStorageConfig } from '@apphub/protocol';
import {
  createFakeClock,
  createFakeLogger,
  createFakeSecretBox,
  createTempDir,
  pathExists,
  safeRemove,
} from '@apphub/testkit';
import { createStorageFactory } from '@apphub/storage';
import { createAppHubCore } from './index';
import { HostServer } from './host';
import type { AppHubCore, ChannelDetail, FetchLike } from './types';
import { expectAppError } from './test-helpers';

/**
 * `local-host`（本机 Host）测试。
 *
 * - HostServer 单元：真实临时目录 + 原始 HTTP 请求（避免 fetch/URL 客户端对 `..` 的归一化）；
 * - HostService：通过 createAppHubCore + 真实 createStorageFactory()（local-host 适配器真实落盘）；
 * - 端口全部用 127.0.0.1 绑定 / advertiseHost 固定，保证离线环境确定性。
 */

interface HostFixture {
  core: AppHubCore;
  dataDir: string;
  storageRoot: string;
  clock: ReturnType<typeof createFakeClock>;
  logger: ReturnType<typeof createFakeLogger>;
  close(): Promise<void>;
}

const fixtures: HostFixture[] = [];
const tempDirs: string[] = [];
const hostServers: HostServer[] = [];
const netServers: NetServer[] = [];

afterEach(async () => {
  for (const server of hostServers.splice(0)) {
    await server.stop().catch(() => undefined);
  }
  for (const server of netServers.splice(0)) {
    await closeNetServer(server);
  }
  for (const fixture of fixtures.splice(0).reverse()) {
    await fixture.close();
  }
  for (const dir of tempDirs.splice(0).reverse()) {
    await safeRemove(dir);
  }
});

async function tempDir(prefix = 'apphub-host-'): Promise<string> {
  const dir = await createTempDir(prefix);
  tempDirs.push(dir);
  return dir;
}

async function createHostFixture(): Promise<HostFixture> {
  const dataDir = await tempDir('apphub-host-data-');
  const storageRoot = await tempDir('apphub-host-storage-');
  const secretBox = createFakeSecretBox();
  const clock = createFakeClock('2026-02-01T00:00:00.000Z');
  const logger = createFakeLogger();
  const fetchImpl: FetchLike = (input, init) =>
    globalThis.fetch(typeof input === 'string' ? input : input.toString(), init);
  const core = createAppHubCore({
    dataDir,
    storageFactory: createStorageFactory(),
    secretBox,
    clock,
    logger,
    fetchImpl,
  });
  const fixture: HostFixture = {
    core,
    dataDir,
    storageRoot,
    clock,
    logger,
    close: async () => {
      await core.close();
      await safeRemove(dataDir);
      await safeRemove(storageRoot);
    },
  };
  fixtures.push(fixture);
  return fixture;
}

async function getFreePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createNetServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      server.close(() => resolve(address.port));
    });
  });
}

function occupyPort(port: number): Promise<NetServer> {
  return new Promise<NetServer>((resolve, reject) => {
    const server = createNetServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

function closeNetServer(server: NetServer): Promise<void> {
  return new Promise<void>((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });
}

function makeHostServer(rootDir: string, port: number, bindHost = '127.0.0.1'): HostServer {
  const server = new HostServer({ rootDir, port, bindHost });
  hostServers.push(server);
  return server;
}

interface RawResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** 原始 HTTP 请求：路径原样发送（用于验证服务端对 `..`/编码穿越的处理）。 */
function rawRequest(port: number, rawPath: string, method = 'GET'): Promise<RawResponse> {
  return new Promise<RawResponse>((resolve, reject) => {
    const request = httpRequest(
      { host: '127.0.0.1', port, path: rawPath, method, headers: { connection: 'close' } },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          body += chunk;
        });
        response.on('end', () => {
          const headers: Record<string, string> = {};
          for (const [key, value] of Object.entries(response.headers)) {
            if (typeof value === 'string') headers[key] = value;
            else if (Array.isArray(value)) headers[key] = value.join(', ');
          }
          resolve({ status: response.statusCode ?? 0, headers, body });
        });
      },
    );
    request.on('error', reject);
    request.end();
  });
}

let channelSequence = 0;

interface LocalHostChannelOptions {
  name?: string;
  visibility?: 'public' | 'private';
  port: number;
  bindHost?: '0.0.0.0' | '127.0.0.1';
  advertiseHost?: string;
  publicBaseUrl?: string;
  rootDir?: string;
}

async function createLocalHostChannel(
  fixture: HostFixture,
  options: LocalHostChannelOptions,
): Promise<ChannelDetail> {
  channelSequence += 1;
  const rootDir = options.rootDir ?? path.join(fixture.storageRoot, `repo-${channelSequence}`);
  const config: LocalHostStorageConfig = {
    provider: 'local-host',
    rootDir,
    port: options.port,
    bindHost: options.bindHost ?? '127.0.0.1',
    ...(options.advertiseHost ? { advertiseHost: options.advertiseHost } : {}),
    ...(options.publicBaseUrl ? { publicBaseUrl: options.publicBaseUrl } : {}),
  };
  return fixture.core.channels.create({
    name: options.name ?? `本机频道 ${channelSequence}`,
    visibility: options.visibility ?? 'public',
    storage: config,
    skipProbe: false,
  });
}

/** 用核心发布一个 files 模式的 App（真实写入 local-host rootDir）。 */
async function publishDemoApp(fixture: HostFixture, channelId: string): Promise<void> {
  const sourceDir = await tempDir('apphub-host-src-');
  const sourcePath = path.join(sourceDir, 'app.exe');
  await fs.writeFile(sourcePath, 'hello-local-host');
  await fixture.core.publishing.publish({
    channelId,
    app: { appId: 'demo', displayName: 'Demo App' },
    version: '1.0.0',
    platform: 'windows',
    publishMode: 'files',
    entry: 'app.exe',
    files: [{ sourcePath, targetPath: 'app.exe' }],
  });
}

describe('HostServer - HTTP 行为与安全', () => {
  async function setupRoot(): Promise<{ rootDir: string; outsideDir: string }> {
    const parent = await tempDir('apphub-host-http-');
    const rootDir = path.join(parent, 'root');
    const outsideDir = path.join(parent, 'outside');
    await fs.mkdir(path.join(rootDir, 'dir'), { recursive: true });
    await fs.mkdir(outsideDir, { recursive: true });
    await fs.writeFile(path.join(rootDir, 'channel.json'), '{"kind":"apphub-channel"}');
    await fs.writeFile(path.join(rootDir, 'readme.txt'), 'hello text');
    await fs.writeFile(path.join(rootDir, 'page.html'), '<html>hi</html>');
    await fs.writeFile(path.join(rootDir, 'app.zip'), Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    await fs.writeFile(path.join(rootDir, 'app.exe'), Buffer.from([0x4d, 0x5a]));
    await fs.writeFile(path.join(rootDir, 'blob.unknown'), Buffer.from([1, 2, 3]));
    await fs.writeFile(path.join(rootDir, 'dir', 'inside.txt'), 'inside');
    await fs.writeFile(path.join(rootDir, '.hidden'), 'hidden');
    await fs.mkdir(path.join(rootDir, '.git'), { recursive: true });
    await fs.writeFile(path.join(rootDir, '.git', 'config'), 'git config');
    await fs.writeFile(path.join(rootDir, 'channel_pri.json'), '{"secret":true}');
    await fs.mkdir(path.join(rootDir, 'sub'), { recursive: true });
    await fs.writeFile(path.join(rootDir, 'sub', 'channel_pri.json'), '{"secret":true}');
    await fs.writeFile(path.join(outsideDir, 'secret.txt'), 'TOP-SECRET');
    return { rootDir, outsideDir };
  }

  it('GET 返回文件内容与安全响应头（Content-Type/Cache-Control/nosniff/Length）', async () => {
    const { rootDir } = await setupRoot();
    const server = makeHostServer(rootDir, 0);
    const port = await server.start();

    const json = await rawRequest(port, '/channel.json');
    expect(json.status).toBe(200);
    expect(json.body).toBe('{"kind":"apphub-channel"}');
    expect(json.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(json.headers['cache-control']).toBe('no-cache');
    expect(json.headers['x-content-type-options']).toBe('nosniff');
    expect(json.headers['content-length']).toBe(String(Buffer.byteLength(json.body)));

    expect((await rawRequest(port, '/readme.txt')).headers['content-type']).toBe(
      'text/plain; charset=utf-8',
    );
    expect((await rawRequest(port, '/page.html')).headers['content-type']).toBe(
      'text/html; charset=utf-8',
    );
    expect((await rawRequest(port, '/app.zip')).headers['content-type']).toBe('application/zip');
    expect((await rawRequest(port, '/app.exe')).headers['content-type']).toBe(
      'application/octet-stream',
    );
    expect((await rawRequest(port, '/blob.unknown')).headers['content-type']).toBe(
      'application/octet-stream',
    );
  });

  it('HEAD 只返回响应头，不返回 body', async () => {
    const { rootDir } = await setupRoot();
    const port = await makeHostServer(rootDir, 0).start();
    const head = await rawRequest(port, '/readme.txt', 'HEAD');
    expect(head.status).toBe(200);
    expect(head.headers['content-length']).toBe(String('hello text'.length));
    expect(head.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(head.body).toBe('');
  });

  it('忽略 query string', async () => {
    const { rootDir } = await setupRoot();
    const port = await makeHostServer(rootDir, 0).start();
    const response = await rawRequest(port, '/channel.json?v=1&t=123');
    expect(response.status).toBe(200);
    expect(response.body).toContain('apphub-channel');
  });

  it('仅允许 GET/HEAD，其它方法返回 405 + Allow', async () => {
    const { rootDir } = await setupRoot();
    const port = await makeHostServer(rootDir, 0).start();
    const response = await rawRequest(port, '/channel.json', 'POST');
    expect(response.status).toBe(405);
    expect(response.headers['allow']).toBe('GET, HEAD');
    expect(response.body).toContain('405');
  });

  it('根路径/目录/不存在文件一律 404（无目录列表）', async () => {
    const { rootDir } = await setupRoot();
    const port = await makeHostServer(rootDir, 0).start();
    expect((await rawRequest(port, '/')).status).toBe(404);
    expect((await rawRequest(port, '//')).status).toBe(404);
    expect((await rawRequest(port, '/dir')).status).toBe(404);
    expect((await rawRequest(port, '/dir/')).status).toBe(404);
    expect((await rawRequest(port, '/missing.txt')).status).toBe(404);
  });

  it('拒绝隐藏路径（任一段以 . 开头）', async () => {
    const { rootDir } = await setupRoot();
    const port = await makeHostServer(rootDir, 0).start();
    expect((await rawRequest(port, '/.hidden')).status).toBe(404);
    expect((await rawRequest(port, '/.git/config')).status).toBe(404);
    expect((await rawRequest(port, '/%2egit/config')).status).toBe(404);
    expect((await rawRequest(port, '/dir/../.hidden')).status).toBe(404);
  });

  it('拒绝 channel_pri.json（含子目录）', async () => {
    const { rootDir } = await setupRoot();
    const port = await makeHostServer(rootDir, 0).start();
    const direct = await rawRequest(port, '/channel_pri.json');
    expect(direct.status).toBe(404);
    expect(direct.body).not.toContain('secret');
    expect((await rawRequest(port, '/sub/channel_pri.json')).status).toBe(404);
    expect(
      (await rawRequest(port, '/_private/ch_0123456789abcdef0123/key/channel_pri.json')).status,
    ).toBe(404);
  });

  it('拒绝路径穿越与编码穿越（不泄露 rootDir 之外的文件）', async () => {
    const { rootDir } = await setupRoot();
    const port = await makeHostServer(rootDir, 0).start();
    const probes = [
      '/../secret.txt',
      '/%2e%2e%2fsecret.txt',
      '/%2E%2E/secret.txt',
      '/dir/../../secret.txt',
      '/..%5csecret.txt',
      '/%2e%2e%5csecret.txt',
      '//../secret.txt',
    ];
    for (const probe of probes) {
      const response = await rawRequest(port, probe);
      expect(response.status, `rawPath=${probe}`).toBe(404);
      expect(response.body, `rawPath=${probe}`).not.toContain('TOP-SECRET');
    }
  });

  it('拒绝符号链接（父目录 junction 逃逸 / 文件链接）', async () => {
    const { rootDir, outsideDir } = await setupRoot();
    const port = await makeHostServer(rootDir, 0).start();

    let createdDirLink = false;
    try {
      await fs.symlink(outsideDir, path.join(rootDir, 'linkdir'), 'junction');
      createdDirLink = true;
    } catch {
      // Windows 非开发者模式可能不允许创建链接：跳过该子断言
    }
    if (createdDirLink) {
      const viaDirLink = await rawRequest(port, '/linkdir/secret.txt');
      expect(viaDirLink.status).toBe(404);
      expect(viaDirLink.body).not.toContain('TOP-SECRET');
    }

    let createdFileLink = false;
    try {
      await fs.symlink(
        path.join(outsideDir, 'secret.txt'),
        path.join(rootDir, 'link.txt'),
        'file',
      );
      createdFileLink = true;
    } catch {
      // 同上
    }
    if (createdFileLink) {
      const viaFileLink = await rawRequest(port, '/link.txt');
      expect(viaFileLink.status).toBe(404);
      expect(viaFileLink.body).not.toContain('TOP-SECRET');
    }
  });

  it('start 幂等；stop 幂等且端口立即可复用', async () => {
    const rootDir = await tempDir('apphub-host-port-');
    await fs.writeFile(path.join(rootDir, 'channel.json'), '{}');
    const first = makeHostServer(rootDir, 0);
    const port = await first.start();
    expect(await first.start()).toBe(port);
    expect(first.running).toBe(true);
    expect(first.port).toBe(port);

    await first.stop();
    await first.stop();
    expect(first.running).toBe(false);
    expect(first.port).toBeNull();

    const second = makeHostServer(rootDir, port);
    await expect(second.start()).resolves.toBe(port);
    expect(second.running).toBe(true);
  });

  it('端口被占用时 start 抛 CONFLICT（可读提示）', async () => {
    const rootDir = await tempDir('apphub-host-busy-');
    const port = await getFreePort();
    const blocker = await occupyPort(port);
    netServers.push(blocker);
    const server = new HostServer({ rootDir, port, bindHost: '127.0.0.1' });
    const error = await expectAppError(server.start(), 'CONFLICT');
    expect(error.message).toContain('已被占用');
    expect(error.message).toContain(String(port));
    await closeNetServer(blocker);
  });
});

describe('HostService - 状态与 URL', () => {
  it('list/status（停止状态）：包含 local-host 频道并给出本机 URL', async () => {
    const fixture = await createHostFixture();
    const port = await getFreePort();
    const detail = await createLocalHostChannel(fixture, { port });

    const list = await fixture.core.host.list();
    expect(list).toHaveLength(1);
    const status = list[0]!;
    expect(status).toMatchObject({
      channelId: detail.id,
      channelName: detail.name,
      visibility: 'public',
      running: false,
      configuredPort: port,
      port: null,
      bindHost: '127.0.0.1',
    });
    expect(status.urls.channelUrl).toBe(`http://127.0.0.1:${port}/channel.json`);
    expect(status.urls.localChannelUrl).toBe(`http://127.0.0.1:${port}/channel.json`);
    expect(status.urls.lanChannelUrls).toEqual([]);

    const single = await fixture.core.host.status(detail.id);
    expect(single).toEqual(status);
  });

  it('默认 0.0.0.0 的 URL 形状：advertiseHost 首选 + LAN 候选；私密频道带 accessKey', async () => {
    const fixture = await createHostFixture();
    const port = await getFreePort();
    const publicChannel = await createLocalHostChannel(fixture, {
      port,
      bindHost: '0.0.0.0',
      advertiseHost: '127.0.0.1',
    });
    const publicStatus = await fixture.core.host.status(publicChannel.id);
    expect(publicStatus.bindHost).toBe('0.0.0.0');
    expect(publicStatus.urls.channelUrl).toBe(`http://127.0.0.1:${port}/channel.json`);
    expect(publicStatus.urls.localChannelUrl).toBe(`http://127.0.0.1:${port}/channel.json`);
    expect(Array.isArray(publicStatus.urls.lanChannelUrls)).toBe(true);
    for (const lanUrl of publicStatus.urls.lanChannelUrls) {
      expect(lanUrl).toMatch(new RegExp(`^http://.+:${port}/channel\\.json$`));
    }

    const privatePort = await getFreePort();
    const privateChannel = await createLocalHostChannel(fixture, {
      port: privatePort,
      visibility: 'private',
      bindHost: '0.0.0.0',
      advertiseHost: '127.0.0.1',
    });
    const pri = JSON.parse(
      await fixture.core.channels.exportPrivateConfig(privateChannel.id),
    ) as { accessKey: string };
    const privateStatus = await fixture.core.host.status(privateChannel.id);
    expect(privateStatus.visibility).toBe('private');
    expect(privateStatus.urls.channelUrl).toBe(
      `http://127.0.0.1:${privatePort}/_private/${privateChannel.id}/${pri.accessKey}/channel.json`,
    );
    expect(privateStatus.urls.localChannelUrl).toContain('/_private/');
  });

  it('非 local-host 频道不托管：list 排除，status/start/stop/updateConfig 抛 UNSUPPORTED', async () => {
    const fixture = await createHostFixture();
    const localRoot = path.join(fixture.storageRoot, 'plain-local');
    const plain = await fixture.core.channels.create({
      name: '普通目录频道',
      visibility: 'public',
      storage: {
        provider: 'local',
        rootDir: localRoot,
        publicBaseUrl: 'http://127.0.0.1:9/',
      },
    });
    const list = await fixture.core.host.list();
    expect(list.some((status) => status.channelId === plain.id)).toBe(false);

    await expectAppError(fixture.core.host.status(plain.id), 'UNSUPPORTED');
    await expectAppError(fixture.core.host.start(plain.id), 'UNSUPPORTED');
    await expectAppError(fixture.core.host.stop(plain.id), 'UNSUPPORTED');
    await expectAppError(fixture.core.host.updateConfig(plain.id, { port: 12345 }), 'UNSUPPORTED');
  });

  it('未知频道抛 NOT_FOUND', async () => {
    const fixture = await createHostFixture();
    await expectAppError(fixture.core.host.status('ch_0123456789abcdef0123'), 'NOT_FOUND');
    await expectAppError(fixture.core.host.start('ch_0123456789abcdef0123'), 'NOT_FOUND');
  });

  it('start：running/实际端口/startedAt，重复 start 幂等', async () => {
    const fixture = await createHostFixture();
    const port = await getFreePort();
    const detail = await createLocalHostChannel(fixture, { port });
    const started = await fixture.core.host.start(detail.id);
    expect(started.running).toBe(true);
    expect(started.port).toBe(port);
    expect(started.configuredPort).toBe(port);
    expect(started.startedAt).toBe('2026-02-01T00:00:00.000Z');
    expect(started.urls.channelUrl).toBe(`http://127.0.0.1:${port}/channel.json`);

    fixture.clock.advance(5_000);
    const again = await fixture.core.host.start(detail.id);
    expect(again.port).toBe(port);
    expect(again.startedAt).toBe('2026-02-01T00:00:00.000Z');
    expect((await fixture.core.host.list())[0]!.running).toBe(true);
  });

  it('stop：幂等；停止后状态 port=null 且 URL 仍按配置给出', async () => {
    const fixture = await createHostFixture();
    const port = await getFreePort();
    const detail = await createLocalHostChannel(fixture, { port });
    await fixture.core.host.start(detail.id);
    const stopped = await fixture.core.host.stop(detail.id);
    expect(stopped.running).toBe(false);
    expect(stopped.port).toBeNull();
    expect(stopped.configuredPort).toBe(port);
    expect(stopped.urls.channelUrl).toBe(`http://127.0.0.1:${port}/channel.json`);
    const again = await fixture.core.host.stop(detail.id);
    expect(again.running).toBe(false);
  });
});

describe('HostService - 启动链路与失败恢复', () => {
  it('创建 local-host 频道 → 发布文件 → start → fetch channel.json/app 文件 → stop', async () => {
    const fixture = await createHostFixture();
    const port = await getFreePort();
    const detail = await createLocalHostChannel(fixture, { port });
    await publishDemoApp(fixture, detail.id);

    const started = await fixture.core.host.start(detail.id);
    expect(started.running).toBe(true);
    // 创建时推导的订阅地址与实际运行地址一致
    expect(detail.subscribeUrl).toBe(started.urls.channelUrl);

    const channelResponse = await fetch(started.urls.channelUrl);
    expect(channelResponse.status).toBe(200);
    expect(channelResponse.headers.get('content-type')).toContain('application/json');
    const channelFile = parseChannelFile(await channelResponse.text());
    expect(channelFile.apps).toHaveLength(1);
    expect(channelFile.apps[0]).toMatchObject({ appId: 'demo', latest: { windows: '1.0.0' } });

    const appFileUrl = new URL('demo/1.0.0/app.exe', started.urls.channelUrl).toString();
    const appResponse = await fetch(appFileUrl);
    expect(appResponse.status).toBe(200);
    expect(await appResponse.text()).toBe('hello-local-host');
    expect(appResponse.headers.get('cache-control')).toBe('no-cache');

    await fixture.core.host.stop(detail.id);
    await expect(fetch(started.urls.channelUrl)).rejects.toThrow();
  });

  it('私密频道 start 后能力链接可访问，公开路径不可见', async () => {
    const fixture = await createHostFixture();
    const port = await getFreePort();
    const detail = await createLocalHostChannel(fixture, { port, visibility: 'private' });
    await publishDemoApp(fixture, detail.id);
    const pri = JSON.parse(await fixture.core.channels.exportPrivateConfig(detail.id)) as {
      accessKey: string;
    };

    const started = await fixture.core.host.start(detail.id);
    expect(started.urls.channelUrl).toContain(`/_private/${detail.id}/${pri.accessKey}/`);

    const capability = await fetch(started.urls.channelUrl);
    expect(capability.status).toBe(200);
    const channelFile = parseChannelFile(await capability.text());
    expect(channelFile.visibility).toBe('private');

    const publicPath = await fetch(`http://127.0.0.1:${port}/channel.json`);
    expect(publicPath.status).toBe(404);
    const privateMeta = await fetch(
      `http://127.0.0.1:${port}/_private/${detail.id}/${pri.accessKey}/demo/app.meta.json`,
    );
    expect(privateMeta.status).toBe(200);
  });

  it('端口冲突：start 抛 CONFLICT 并记录 lastError，释放端口后成功并清除', async () => {
    const fixture = await createHostFixture();
    const port = await getFreePort();
    const blocker = await occupyPort(port);
    netServers.push(blocker);
    const detail = await createLocalHostChannel(fixture, { port });

    const error = await expectAppError(fixture.core.host.start(detail.id), 'CONFLICT');
    expect(error.message).toContain('已被占用');
    const failed = await fixture.core.host.status(detail.id);
    expect(failed.running).toBe(false);
    expect(failed.lastError).toEqual({ code: 'CONFLICT', message: error.message });

    await closeNetServer(blocker);
    const started = await fixture.core.host.start(detail.id);
    expect(started.running).toBe(true);
    expect(started.port).toBe(port);
    const recovered = await fixture.core.host.status(detail.id);
    expect(recovered.lastError).toBeUndefined();
  });

  it('stopAll 停止全部 Host；core.close() 停止全部并释放端口', async () => {
    const fixture = await createHostFixture();
    const portA = await getFreePort();
    const portB = await getFreePort();
    const channelA = await createLocalHostChannel(fixture, { port: portA, name: 'A' });
    const channelB = await createLocalHostChannel(fixture, { port: portB, name: 'B' });
    const startedA = await fixture.core.host.start(channelA.id);
    const startedB = await fixture.core.host.start(channelB.id);
    expect((await fixture.core.host.list()).filter((status) => status.running)).toHaveLength(2);

    await fixture.core.host.stopAll();
    expect((await fixture.core.host.list()).every((status) => !status.running)).toBe(true);
    await expect(fetch(startedA.urls.channelUrl)).rejects.toThrow();
    await expect(fetch(startedB.urls.channelUrl)).rejects.toThrow();

    await fixture.core.host.start(channelA.id);
    await fixture.core.close();
    await expect(fetch(startedA.urls.channelUrl)).rejects.toThrow();
  });

  it('unsubscribe 自动停止该频道的 Host（best-effort 清理）', async () => {
    const fixture = await createHostFixture();
    const port = await getFreePort();
    const detail = await createLocalHostChannel(fixture, { port });
    const started = await fixture.core.host.start(detail.id);
    expect((await fetch(started.urls.channelUrl)).status).toBe(200);

    await fixture.core.channels.unsubscribe(detail.id);
    await expect(fetch(started.urls.channelUrl)).rejects.toThrow();
    expect(await fixture.core.host.list()).toHaveLength(0);
  });
});

describe('HostService - updateConfig', () => {
  it('运行中拒绝修改（STATE），停止后修改端口/advertiseHost 并重算 URL 与订阅地址', async () => {
    const fixture = await createHostFixture();
    const port = await getFreePort();
    const detail = await createLocalHostChannel(fixture, { port });
    await fixture.core.host.start(detail.id);
    await expectAppError(fixture.core.host.updateConfig(detail.id, { port: 4567 }), 'STATE');
    await fixture.core.host.stop(detail.id);

    const newPort = await getFreePort();
    const updated = await fixture.core.host.updateConfig(detail.id, {
      port: newPort,
      advertiseHost: '127.0.0.1',
    });
    expect(updated.running).toBe(false);
    expect(updated.port).toBeNull();
    expect(updated.configuredPort).toBe(newPort);
    expect(updated.urls.channelUrl).toBe(`http://127.0.0.1:${newPort}/channel.json`);
    expect(updated.urls.localChannelUrl).toBe(`http://127.0.0.1:${newPort}/channel.json`);

    // 本地频道记录 / getSubscribeUrl 同步更新
    const reloaded = await fixture.core.channels.get(detail.id);
    expect(reloaded.subscribeUrl).toBe(`http://127.0.0.1:${newPort}/channel.json`);
    const pri = JSON.parse(await fixture.core.channels.exportPrivateConfig(detail.id)) as {
      storage: { port: number; bindHost: string; advertiseHost?: string };
    };
    expect(pri.storage.port).toBe(newPort);
    expect(pri.storage.advertiseHost).toBe('127.0.0.1');
  });

  it('publicBaseUrl 覆盖首选地址，local 候选保持回环', async () => {
    const fixture = await createHostFixture();
    const port = await getFreePort();
    const detail = await createLocalHostChannel(fixture, { port });
    const updated = await fixture.core.host.updateConfig(detail.id, {
      publicBaseUrl: 'http://example.com/repo',
    });
    expect(updated.urls.channelUrl).toBe('http://example.com/repo/channel.json');
    expect(updated.urls.localChannelUrl).toBe(`http://127.0.0.1:${port}/channel.json`);
    expect((await fixture.core.channels.get(detail.id)).subscribeUrl).toBe(
      'http://example.com/repo/channel.json',
    );

    // 清空 publicBaseUrl 后回退到回环地址
    const cleared = await fixture.core.host.updateConfig(detail.id, { publicBaseUrl: '' });
    expect(cleared.urls.channelUrl).toBe(`http://127.0.0.1:${port}/channel.json`);
  });

  it('非法 patch 抛 VALIDATION，rootDir 不可修改', async () => {
    const fixture = await createHostFixture();
    const port = await getFreePort();
    const detail = await createLocalHostChannel(fixture, { port });

    await expectAppError(fixture.core.host.updateConfig(detail.id, { port: 0 }), 'VALIDATION');
    await expectAppError(fixture.core.host.updateConfig(detail.id, { port: 70000 }), 'VALIDATION');
    await expectAppError(
      fixture.core.host.updateConfig(detail.id, { port: 1.5 }),
      'VALIDATION',
    );
    await expectAppError(
      fixture.core.host.updateConfig(detail.id, { advertiseHost: 'http://evil.com' }),
      'VALIDATION',
    );
    await expectAppError(
      fixture.core.host.updateConfig(detail.id, { publicBaseUrl: 'ftp://example.com/' }),
      'VALIDATION',
    );
    await expectAppError(
      fixture.core.host.updateConfig(detail.id, { rootDir: '/tmp/other' } as never),
      'VALIDATION',
    );

    // 失败不应破坏原配置
    const status = await fixture.core.host.status(detail.id);
    expect(status.configuredPort).toBe(port);
    expect(status.urls.channelUrl).toBe(`http://127.0.0.1:${port}/channel.json`);
    const pri = JSON.parse(await fixture.core.channels.exportPrivateConfig(detail.id)) as {
      storage: { rootDir: string; port: number };
    };
    expect(pri.storage.port).toBe(port);
    expect(await pathExists(pri.storage.rootDir)).toBe(true);
  });
});
