import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import type { NetworkInterfaceInfo } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppError, appendUrl, isAppError, LocalHostStorageConfigSchema } from '@apphub/protocol';
import type { LocalHostStorageConfig } from '@apphub/protocol';
import {
  createTempDir,
  getFreePort,
  pathExists,
  safeRemove,
  startStaticServer,
} from '@apphub/testkit';
import type { StaticServer } from '@apphub/testkit';
import { resolveLocalHostBaseUrls } from '../local-host-url';
import { LocalHostStorageAdapter } from './local-host';

async function expectAppError(
  operation: Promise<unknown> | (() => unknown),
  code: AppError['code'],
  messagePart?: string,
): Promise<AppError> {
  try {
    await (typeof operation === 'function' ? operation() : operation);
  } catch (error) {
    if (!isAppError(error)) throw new Error(`期望 AppError，实际抛出：${String(error)}`);
    expect(error.code).toBe(code);
    if (messagePart) expect(error.message).toContain(messagePart);
    return error;
  }
  throw new Error('期望抛出错误，但操作成功');
}

interface FakeInterface {
  address: string;
  internal?: boolean;
  family?: string | number;
}

/** 构造可注入的 networkInterfaces() 假实现。 */
function fakeInterfaces(byName: Record<string, FakeInterface[]>): () => NodeJS.Dict<NetworkInterfaceInfo[]> {
  return () => {
    const result: NodeJS.Dict<NetworkInterfaceInfo[]> = {};
    for (const [name, list] of Object.entries(byName)) {
      result[name] = list.map(
        (item) =>
          ({
            address: item.address,
            netmask: '255.255.255.0',
            family: item.family ?? 'IPv4',
            mac: '00:00:00:00:00:00',
            internal: item.internal ?? false,
          }) as unknown as NetworkInterfaceInfo,
      );
    }
    return result;
  };
}

function makeConfig(overrides: Partial<LocalHostStorageConfig> = {}): LocalHostStorageConfig {
  return LocalHostStorageConfigSchema.parse({
    provider: 'local-host',
    rootDir: 'E:\\tmp\\apphub-host-repo',
    ...overrides,
  });
}

describe('resolveLocalHostBaseUrls', () => {
  const twoNic = fakeInterfaces({
    eth0: [{ address: '192.168.1.10' }],
    wlan0: [{ address: '10.0.0.5' }],
  });

  it('bindHost=0.0.0.0：收集全部非 internal IPv4，preferred 取首个 LAN，local 恒为回环', () => {
    const config = makeConfig({ bindHost: '0.0.0.0', port: 8787 });
    const urls = resolveLocalHostBaseUrls(config, {
      networkInterfaces: fakeInterfaces({
        lo: [{ address: '127.0.0.1', internal: true }],
        eth0: [{ address: '192.168.1.10' }, { address: 'fe80::1', family: 'IPv6' }],
        wlan0: [{ address: '10.0.0.5' }],
        // 重复 IP 只保留一次
        eth1: [{ address: '10.0.0.5' }],
      }),
    });

    expect(urls.localBaseUrl).toBe('http://127.0.0.1:8787/');
    expect(urls.lanBaseUrls).toEqual(['http://192.168.1.10:8787/', 'http://10.0.0.5:8787/']);
    expect(urls.preferredBaseUrl).toBe('http://192.168.1.10:8787/');
    // 三个字段都保证尾随 `/`
    expect(urls.preferredBaseUrl.endsWith('/')).toBe(true);
    expect(urls.localBaseUrl.endsWith('/')).toBe(true);
    for (const url of urls.lanBaseUrls) expect(url.endsWith('/')).toBe(true);
  });

  it('bindHost=0.0.0.0 但没有可用网卡（全部 internal/无接口）时回退 127.0.0.1', () => {
    const config = makeConfig({ bindHost: '0.0.0.0' });
    expect(
      resolveLocalHostBaseUrls(config, {
        networkInterfaces: fakeInterfaces({ lo: [{ address: '127.0.0.1', internal: true }] }),
      }),
    ).toEqual({
      preferredBaseUrl: 'http://127.0.0.1:8787/',
      localBaseUrl: 'http://127.0.0.1:8787/',
      lanBaseUrls: [],
    });
    expect(
      resolveLocalHostBaseUrls(config, { networkInterfaces: () => ({}) }),
    ).toEqual({
      preferredBaseUrl: 'http://127.0.0.1:8787/',
      localBaseUrl: 'http://127.0.0.1:8787/',
      lanBaseUrls: [],
    });
  });

  it('bindHost=127.0.0.1：lanBaseUrls 恒为空，preferred 回退本地回环', () => {
    const config = makeConfig({ bindHost: '127.0.0.1', port: 9000 });
    const urls = resolveLocalHostBaseUrls(config, { networkInterfaces: twoNic });
    expect(urls.lanBaseUrls).toEqual([]);
    expect(urls.preferredBaseUrl).toBe('http://127.0.0.1:9000/');
    expect(urls.localBaseUrl).toBe('http://127.0.0.1:9000/');
  });

  it('publicBaseUrl 覆盖优先，并自动补尾斜杠', () => {
    const config = makeConfig({
      bindHost: '0.0.0.0',
      port: 8787,
      publicBaseUrl: 'https://apps.example.com/app_repo',
    });
    const urls = resolveLocalHostBaseUrls(config, { networkInterfaces: twoNic });
    expect(urls.preferredBaseUrl).toBe('https://apps.example.com/app_repo/');
    // 覆盖 publicBaseUrl 不影响本机/LAN 候选地址
    expect(urls.localBaseUrl).toBe('http://127.0.0.1:8787/');
    expect(urls.lanBaseUrls).toEqual(['http://192.168.1.10:8787/', 'http://10.0.0.5:8787/']);
  });

  it('advertiseHost 次优先：preferred 用 advertiseHost，LAN 候选仍然保留', () => {
    const config = makeConfig({ bindHost: '0.0.0.0', port: 8787, advertiseHost: 'apphub.local' });
    const urls = resolveLocalHostBaseUrls(config, { networkInterfaces: twoNic });
    expect(urls.preferredBaseUrl).toBe('http://apphub.local:8787/');
    expect(urls.lanBaseUrls).toEqual(['http://192.168.1.10:8787/', 'http://10.0.0.5:8787/']);
  });

  it('options.port 覆盖 config.port：所有地址都使用注入端口', () => {
    const config = makeConfig({ bindHost: '0.0.0.0', port: 8787, advertiseHost: 'apphub.local' });
    const urls = resolveLocalHostBaseUrls(config, { port: 9123, networkInterfaces: twoNic });
    expect(urls.localBaseUrl).toBe('http://127.0.0.1:9123/');
    expect(urls.preferredBaseUrl).toBe('http://apphub.local:9123/');
    expect(urls.lanBaseUrls).toEqual(['http://192.168.1.10:9123/', 'http://10.0.0.5:9123/']);
  });

  it('防御：非法端口 / 非法 publicBaseUrl / 非法 advertiseHost / 网卡读取失败都抛 AppError', async () => {
    await expectAppError(() => resolveLocalHostBaseUrls({ ...makeConfig(), port: 0 }), 'VALIDATION');
    await expectAppError(() => resolveLocalHostBaseUrls({ ...makeConfig(), port: 70_000 }), 'VALIDATION');
    await expectAppError(
      () => resolveLocalHostBaseUrls(makeConfig(), { port: 1.5 }),
      'VALIDATION',
    );
    await expectAppError(
      () => resolveLocalHostBaseUrls({ ...makeConfig(), publicBaseUrl: 'ftp://example.com/' }),
      'VALIDATION',
    );
    await expectAppError(
      () => resolveLocalHostBaseUrls({ ...makeConfig(), advertiseHost: 'http://bad/path' }),
      'VALIDATION',
    );
    await expectAppError(
      () =>
        resolveLocalHostBaseUrls(makeConfig(), {
          networkInterfaces: () => {
            throw new Error('网卡信息不可用');
          },
        }),
      'INTERNAL',
      '网卡信息不可用',
    );
  });

  it('防御：advertiseHost 为 IPv6 字面量时自动加方括号', () => {
    const urls = resolveLocalHostBaseUrls({
      ...makeConfig({ bindHost: '127.0.0.1' }),
      advertiseHost: '::1',
    });
    expect(urls.preferredBaseUrl).toBe('http://[::1]:8787/');
  });
});

describe('LocalHostStorageAdapter', () => {
  let tempDir: string;
  let adapter: LocalHostStorageAdapter | undefined;
  let staticServer: StaticServer | undefined;

  function makeAdapter(
    overrides: Partial<LocalHostStorageConfig> = {},
    options?: Parameters<typeof resolveLocalHostBaseUrls>[1],
  ): LocalHostStorageAdapter {
    const created = new LocalHostStorageAdapter(
      makeConfig({ rootDir: path.join(tempDir, 'repo'), ...overrides }),
      options,
    );
    adapter = created;
    return created;
  }

  beforeEach(async () => {
    tempDir = await createTempDir('apphub-local-host-test-');
  });

  afterEach(async () => {
    await adapter?.close();
    adapter = undefined;
    await staticServer?.close();
    staticServer = undefined;
    await safeRemove(tempDir);
  });

  it('provider/config/urls：报告 local-host 配置，URL 由 local-host 规则推导', () => {
    const config = makeConfig({
      rootDir: path.join(tempDir, 'repo'),
      port: 8787,
      bindHost: '0.0.0.0',
    });
    const localHost = new LocalHostStorageAdapter(config, {
      networkInterfaces: fakeInterfaces({ eth0: [{ address: '192.168.1.10' }] }),
    });
    adapter = localHost;

    expect(localHost.provider).toBe('local-host');
    expect(localHost.config).toBe(config);
    expect(localHost.urls.preferredBaseUrl).toBe('http://192.168.1.10:8787/');
    expect(localHost.urls.localBaseUrl).toBe('http://127.0.0.1:8787/');
    expect(localHost.urls.lanBaseUrls).toEqual(['http://192.168.1.10:8787/']);
  });

  it('probe 自动创建 rootDir 且不绑定端口（端口被其他进程占用也能 probe）', async () => {
    const occupiedPort = await getFreePort();
    const blocker = createServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once('error', reject);
      blocker.listen(occupiedPort, '127.0.0.1', () => resolve());
    });
    try {
      const localHost = makeAdapter({ port: occupiedPort, bindHost: '127.0.0.1' });
      const rootDir = path.join(tempDir, 'repo');
      expect(await pathExists(rootDir)).toBe(false);
      await localHost.probe();
      expect(await pathExists(rootDir)).toBe(true);
      expect(await localHost.list('')).toEqual([]);
      await localHost.probe();
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });

  it('CRUD 全部委托本地目录实现（真实落盘）', async () => {
    const localHost = makeAdapter({ bindHost: '127.0.0.1' });
    await localHost.writeText('channel.json', '{"name":"本机频道"}');
    expect(await localHost.readText('channel.json')).toBe('{"name":"本机频道"}');
    expect(await localHost.exists('channel.json')).toBe(true);

    const binary = Buffer.from([0, 1, 2, 3, 255, 254]);
    await localHost.writeBinary('app/1.0.0/foobar.exe', binary, { executable: true });
    expect(await localHost.readBinary('app/1.0.0/foobar.exe')).toEqual(binary);
    expect((await localHost.stat('app/1.0.0/foobar.exe'))?.size).toBe(binary.length);

    expect(await pathExists(path.join(tempDir, 'repo', 'app', '1.0.0', 'foobar.exe'))).toBe(true);

    await localHost.delete('app/1.0.0/foobar.exe');
    expect(await localHost.exists('app/1.0.0/foobar.exe')).toBe(false);
    expect(await localHost.readBinary('app/1.0.0/foobar.exe')).toBeNull();
    expect(await localHost.stat('app/1.0.0/foobar.exe')).toBeNull();
    await expect(localHost.delete('app/1.0.0/foobar.exe')).resolves.toBeUndefined();
  });

  it('list 前缀语义与 local/memory 一致', async () => {
    const localHost = makeAdapter({ bindHost: '127.0.0.1' });
    await localHost.writeText('channel.json', '{}');
    await localHost.writeText('app/1.0.0/files.json', '{}');
    await localHost.writeText('app/1.0.0/resources/a.txt', 'a');

    expect((await localHost.list('')).map((entry) => entry.key)).toEqual([
      'app/1.0.0/files.json',
      'app/1.0.0/resources/a.txt',
      'channel.json',
    ]);
    expect((await localHost.list('app/1.0.0/')).map((entry) => entry.key)).toEqual([
      'app/1.0.0/files.json',
      'app/1.0.0/resources/a.txt',
    ]);
    expect(await localHost.list('not-exists/')).toEqual([]);
  });

  it('getDownloadUrl = preferredBaseUrl + key，可经真实静态服务器 HTTP GET 下载', async () => {
    const rootDir = path.join(tempDir, 'repo');
    staticServer = await startStaticServer(rootDir);
    // 模拟 core 的 HostService：静态服务器监听在 config.port 上，advertiseHost 指向本机回环
    const localHost = makeAdapter({
      port: staticServer.port,
      bindHost: '127.0.0.1',
      advertiseHost: '127.0.0.1',
    });

    await localHost.writeText('app/1.0.1/中文 文件.txt', '本机 Host 下载内容');
    const url = await localHost.getDownloadUrl('app/1.0.1/中文 文件.txt');
    // 与协议的 appendUrl 完全一致（路径按 `/` 分段做 URL 编码）
    expect(url).toBe(
      appendUrl(`http://127.0.0.1:${staticServer.port}/`, 'app/1.0.1/中文 文件.txt'),
    );
    expect(decodeURIComponent(url)).toBe(
      `http://127.0.0.1:${staticServer.port}/app/1.0.1/中文 文件.txt`,
    );

    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('本机 Host 下载内容');
    expect(staticServer.requests.some((request) => decodeURIComponent(request).includes('中文 文件.txt'))).toBe(
      true,
    );
  });

  it('构造参数 options.port 可覆盖 URL 端口（实际监听端口 ≠ config.port 的场景）', async () => {
    const rootDir = path.join(tempDir, 'repo');
    staticServer = await startStaticServer(rootDir);
    const localHost = makeAdapter(
      { port: 8787, bindHost: '127.0.0.1' },
      { port: staticServer.port },
    );
    await localHost.writeText('channel.json', '{"ok":true}');
    const url = await localHost.getDownloadUrl('channel.json');
    expect(url).toBe(`http://127.0.0.1:${staticServer.port}/channel.json`);
    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"ok":true}');
  });

  it('拒绝非法 key（路径逃逸/空字符/保留名），且不会写出 rootDir', async () => {
    const localHost = makeAdapter({ bindHost: '127.0.0.1' });
    const outsideFile = path.join(tempDir, 'outside.txt');
    for (const key of ['../outside.txt', 'app/../../outside.txt', 'nul', 'a\0b']) {
      await expectAppError(localHost.writeText(key, 'evil'), 'SECURITY');
      await expectAppError(localHost.readText(key), 'SECURITY');
      await expectAppError(localHost.getDownloadUrl(key), 'SECURITY');
    }
    await expectAppError(localHost.writeText('', 'empty'), 'VALIDATION');
    expect(await pathExists(outsideFile)).toBe(false);
  });

  it('getFreePort 返回的端口可以被立即监听（testkit 辅助函数自检）', async () => {
    const port = await getFreePort();
    expect(Number.isInteger(port)).toBe(true);
    expect(port).toBeGreaterThan(0);
    const server = createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => resolve());
      });
      expect((server.address() as AddressInfo).port).toBe(port);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
