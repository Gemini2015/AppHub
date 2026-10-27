import { promises as fs } from 'node:fs';
import { createServer as createNetServer, type Server as NetServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ChannelDetail, HostStatus } from '@apphub/core';
import { isAppError, type LocalHostStorageConfig } from '@apphub/protocol';
import { getFreePort, writeFileTree, writeZip } from '@apphub/testkit';
import { createRealHarness, expectAppError, toPublishFiles } from './support';
import type { RealHarness, RealPeer } from './support';

/**
 * 集成测试 G：本机 Host（provider = local-host）。
 *
 * 覆盖 docs/ARCHITECTURE.md §3.5 与 PROTOCOL §2 的本机托管能力：
 *  - create（local-host）→ 真实写盘 → host.start 起真实 HTTP → 订阅者通过 HTTP 订阅/安装/更新；
 *  - host.stop 后订阅者 refresh 失败；restart 后恢复；
 *  - 私密频道能力链接（_private/<id>/<accessKey>）可访问，公开路径/错误 accessKey 404；
 *  - zip 模式安装；端口冲突 CONFLICT；stop 后端口立即可复用；updateConfig 改端口/URL。
 *
 * 全部离线：Host 监听 127.0.0.1 + advertiseHost=127.0.0.1 保证确定性；
 * 端口一律用 @apphub/testkit 的 getFreePort() 获取，避免与开发机 8787 冲突。
 */

interface LocalHostChannelOptions {
  name?: string;
  visibility?: 'public' | 'private';
  rootDir: string;
  port: number;
  bindHost?: '0.0.0.0' | '127.0.0.1';
  advertiseHost?: string;
  publicBaseUrl?: string;
}

async function createLocalHostChannel(
  peer: RealPeer,
  options: LocalHostChannelOptions,
): Promise<ChannelDetail> {
  const config: LocalHostStorageConfig = {
    provider: 'local-host',
    rootDir: options.rootDir,
    port: options.port,
    bindHost: options.bindHost ?? '127.0.0.1',
    ...(options.advertiseHost ? { advertiseHost: options.advertiseHost } : {}),
    ...(options.publicBaseUrl ? { publicBaseUrl: options.publicBaseUrl } : {}),
  };
  return peer.core.channels.create({
    name: options.name ?? '本机 Host 频道',
    visibility: options.visibility ?? 'public',
    owner: { name: 'Host QA' },
    storage: config,
  });
}

/** 占用指定端口，用于验证端口冲突/端口释放。 */
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

/**
 * 启动 Host，并对"getFreePort 关闭 → Host listen"之间的极小竞争窗口做重试。
 *
 * 背景：测试并行运行时，`getFreePort()` 返回的端口在真正 listen 前可能被其它测试/进程短暂占用，
 * 表现为 CONFLICT（EADDRINUSE）。此时频道仍处于 stopped，可用 updateConfig 换一个端口重试；
 * 只对 CONFLICT 重试，其它错误原样抛出（端口冲突用例本身仍显式断言 CONFLICT，不走此 helper）。
 */
async function startHostResilient(
  peer: RealPeer,
  channelId: string,
  attempts = 3,
): Promise<HostStatus> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await peer.core.host.start(channelId);
    } catch (error) {
      if (attempt >= attempts || !isAppError(error) || error.code !== 'CONFLICT') throw error;
      await peer.core.host.updateConfig(channelId, { port: await getFreePort() });
    }
  }
}

/** 读取本机 Host 的 HTTP 响应（真实 global fetch；失败信息带上 URL 便于排查）。 */
async function fetchText(url: string): Promise<{ status: number; text: string }> {
  const response = await fetch(url);
  return { status: response.status, text: await response.text() };
}

async function publishFilesV1(peer: RealPeer, h: RealHarness, channelId: string) {
  const bigFile = Buffer.alloc(200 * 1024, 7);
  const srcDir = path.join(h.rootDir, 'sources', `host-v1-${Date.now()}`);
  await writeFileTree(srcDir, [
    { path: 'app.exe', content: 'MZ host v1\n' },
    { path: 'resources/中文 说明.txt', content: 'host v1 中文\n' },
    { path: 'resources/data/big.bin', content: bigFile },
  ]);
  await peer.core.publishing.publish({
    channelId,
    app: { appId: 'host-app', displayName: 'Host App', author: 'QA' },
    version: '1.0.0',
    platform: 'windows',
    publishMode: 'files',
    entry: 'app.exe',
    files: toPublishFiles(srcDir, ['app.exe', 'resources/中文 说明.txt', 'resources/data/big.bin']),
  });
  return { bigFile, srcDir };
}

describe('集成：本机 Host（local-host）', () => {
  it('公开频道全链路：创建→发布→start→订阅→安装→更新→stop 失败→restart 恢复→卸载', async () => {
    const h = await createRealHarness();
    try {
      const owner = await h.newCore('owner');
      const port = await getFreePort();
      const rootDir = path.join(h.rootDir, 'host-public-repo');
      const channel = await createLocalHostChannel(owner, {
        name: 'Host 公开频道',
        rootDir,
        port,
        advertiseHost: '127.0.0.1',
      });

      // 1) 创建后订阅地址由 local-host 配置推导（advertiseHost 优先）
      expect(channel.subscribeUrl).toBe(`http://127.0.0.1:${port}/channel.json`);
      expect(await fs.readFile(path.join(rootDir, 'channel.json'), 'utf8')).toContain(channel.id);

      // 2) 发布 v1.0.0（嵌套目录 + Unicode + 大文件）
      const { bigFile } = await publishFilesV1(owner, h, channel.id);
      expect(await fs.readFile(path.join(rootDir, 'host-app', '1.0.0', 'app.exe'), 'utf8')).toBe(
        'MZ host v1\n',
      );

      // 3) 启动 Host：真实监听 + URL 形状
      const started = await startHostResilient(owner, channel.id);
      expect(started.running).toBe(true);
      expect(started.port).toBe(started.configuredPort);
      expect(started.urls.channelUrl).toBe(`http://127.0.0.1:${started.port}/channel.json`);
      expect(started.urls.localChannelUrl).toBe(started.urls.channelUrl);
      const channelResponse = await fetchText(started.urls.channelUrl);
      expect(channelResponse.status).toBe(200);
      expect(JSON.parse(channelResponse.text).id).toBe(channel.id);

      // 4) 独立订阅者（另一 dataDir）通过真实 HTTP 订阅 + 安装 + 校验
      const subscriber = await h.newCore('subscriber');
      const subscribed = await subscriber.core.channels.subscribe({ url: started.urls.channelUrl });
      expect(subscribed.appCount).toBe(1);
      expect(subscribed.apps[0]?.appId).toBe('host-app');

      const installed = await subscriber.core.library.install({
        channelId: channel.id,
        appId: 'host-app',
      });
      expect(installed.app.version).toBe('1.0.0');
      const versionDirV1 = path.join(
        subscriber.dataDir,
        'library',
        channel.id,
        'host-app',
        'versions',
        '1.0.0',
      );
      expect(await fs.readFile(path.join(versionDirV1, 'resources', 'data', 'big.bin'))).toEqual(bigFile);
      expect((await subscriber.core.library.verify(channel.id, 'host-app')).ok).toBe(true);

      // 5) 发布 v1.1.0 → checkUpdates → update（断言 MD5 复用）
      h.clock.advance(60_000);
      const srcV2 = path.join(h.rootDir, 'sources', 'host-v2');
      await writeFileTree(srcV2, [
        { path: 'app.exe', content: 'MZ host v1.1\n' },
        { path: 'resources/中文 说明.txt', content: 'host v1.1 中文\n' },
        { path: 'resources/data/big.bin', content: bigFile },
      ]);
      await owner.core.publishing.publish({
        channelId: channel.id,
        app: { appId: 'host-app', displayName: 'Host App' },
        version: '1.1.0',
        platform: 'windows',
        publishMode: 'files',
        entry: 'app.exe',
        files: toPublishFiles(srcV2, ['app.exe', 'resources/中文 说明.txt', 'resources/data/big.bin']),
      });
      const updates = await subscriber.core.library.checkUpdates();
      const item = updates.find((entry) => entry.channelId === channel.id && entry.appId === 'host-app');
      expect(item?.updateAvailable).toBe(true);
      expect(item?.latestVersion).toBe('1.1.0');

      const updated = await subscriber.core.library.update({
        channelId: channel.id,
        appId: 'host-app',
      });
      expect(updated.app.version).toBe('1.1.0');
      expect(updated.reusedBytes).toBeGreaterThanOrEqual(bigFile.length);
      expect(updated.downloadedBytes).toBeLessThan(bigFile.length);
      expect((await subscriber.core.library.verify(channel.id, 'host-app')).ok).toBe(true);

      // 6) 停止 Host：HTTP 不可达；订阅者 refresh 报 NETWORK 类错误
      const stopped = await owner.core.host.stop(channel.id);
      expect(stopped.running).toBe(false);
      expect(stopped.port).toBeNull();
      await expect(fetch(started.urls.channelUrl)).rejects.toThrow();
      await expectAppError(
        () => subscriber.core.channels.refresh(channel.id),
        ['NETWORK', 'STORAGE', 'NOT_FOUND'],
      );

      // 7) 重新启动：HTTP 恢复；订阅者 refresh 成功
      const restarted = await startHostResilient(owner, channel.id);
      expect(restarted.running).toBe(true);
      expect((await fetch(restarted.urls.channelUrl)).status).toBe(200);
      const refreshed = await subscriber.core.channels.refresh(channel.id);
      expect(refreshed.appCount).toBe(1);

      // 8) 卸载
      await subscriber.core.library.uninstall(channel.id, 'host-app');
      expect(await subscriber.core.library.list()).toEqual([]);
      await owner.core.host.stop(channel.id);
    } finally {
      await h.dispose();
    }
  });

  it('私密频道：能力链接可访问；公开路径/错误 accessKey 404；订阅者可读不可发布', async () => {
    const h = await createRealHarness();
    try {
      const owner = await h.newCore('owner');
      const port = await getFreePort();
      const rootDir = path.join(h.rootDir, 'host-private-repo');
      const channel = await createLocalHostChannel(owner, {
        name: 'Host 私密频道',
        visibility: 'private',
        rootDir,
        port,
        advertiseHost: '127.0.0.1',
      });

      // 发布一个小 App（local-host 写盘不依赖 Host 是否运行）
      const srcDir = path.join(h.rootDir, 'sources', 'host-private-src');
      await writeFileTree(srcDir, [{ path: 'private.exe', content: 'MZ private\n' }]);
      await owner.core.publishing.publish({
        channelId: channel.id,
        app: { appId: 'private-host-app', displayName: 'Private Host App' },
        version: '1.0.0',
        platform: 'windows',
        publishMode: 'files',
        entry: 'private.exe',
        files: toPublishFiles(srcDir, ['private.exe']),
      });

      const started = await startHostResilient(owner, channel.id);
      const capabilityUrl = started.urls.channelUrl;
      expect(capabilityUrl).toContain(`/_private/${channel.id}/`);
      expect(capabilityUrl.endsWith('/channel.json')).toBe(true);

      const privateConfig = JSON.parse(
        await owner.core.channels.exportPrivateConfig(channel.id),
      ) as { accessKey: string };
      expect(capabilityUrl).toContain(privateConfig.accessKey);

      // 1) 能力链接可访问（私密频道返回 visibility=private）
      const okResponse = await fetchText(capabilityUrl);
      expect(okResponse.status).toBe(200);
      expect(JSON.parse(okResponse.text).visibility).toBe('private');

      // 2) 公开路径（无 _private 前缀）404
      const origin = new URL(capabilityUrl).origin;
      expect((await fetch(`${origin}/channel.json`)).status).toBe(404);

      // 3) 错误 accessKey 404
      const tamperedUrl = capabilityUrl.replace(privateConfig.accessKey, 'a'.repeat(32));
      expect(tamperedUrl).not.toBe(capabilityUrl);
      expect((await fetch(tamperedUrl)).status).toBe(404);

      // 4) 订阅者：错误链接订阅失败；正确能力链接成功并安装
      const subscriber = await h.newCore('subscriber');
      await expectAppError(
        () => subscriber.core.channels.subscribe({ url: tamperedUrl }),
        ['NETWORK', 'NOT_FOUND', 'VALIDATION'],
      );
      const subscribed = await subscriber.core.channels.subscribe({ url: capabilityUrl });
      expect(subscribed.role).toBe('subscriber');
      expect(subscribed.visibility).toBe('private');

      const installed = await subscriber.core.library.install({
        channelId: channel.id,
        appId: 'private-host-app',
      });
      expect(installed.app.version).toBe('1.0.0');
      expect((await subscriber.core.library.verify(channel.id, 'private-host-app')).ok).toBe(true);

      // 5) 非管理员发布仍被拒绝（权限模型不因 local-host 改变）
      await expectAppError(
        () =>
          subscriber.core.publishing.publish({
            channelId: channel.id,
            app: { appId: 'forbidden-app', displayName: 'Forbidden App' },
            version: '1.0.0',
            platform: 'windows',
            publishMode: 'files',
            entry: 'private.exe',
            files: toPublishFiles(srcDir, ['private.exe']),
          }),
        ['AUTH', 'NOT_FOUND', 'VALIDATION', 'STATE'],
      );

      await owner.core.host.stop(channel.id);
    } finally {
      await h.dispose();
    }
  });

  it('zip 模式：发布 zip → start → 订阅者安装并校验解压内容', async () => {
    const h = await createRealHarness();
    try {
      const owner = await h.newCore('owner');
      const port = await getFreePort();
      const rootDir = path.join(h.rootDir, 'host-zip-repo');
      const channel = await createLocalHostChannel(owner, {
        name: 'Host zip 频道',
        rootDir,
        port,
        advertiseHost: '127.0.0.1',
      });

      const sources = path.join(h.rootDir, 'sources');
      await fs.mkdir(sources, { recursive: true });
      const zipPath = path.join(sources, 'host-zip-app.zip');
      await writeZip(zipPath, {
        'run.cmd': 'echo host zip\n',
        'resources/中文.txt': 'host zip 中文\n',
      });
      const published = await owner.core.publishing.publish({
        channelId: channel.id,
        app: { appId: 'host-zip-app', displayName: 'Host Zip App' },
        version: '1.0.0',
        platform: 'windows',
        publishMode: 'zip',
        entry: 'run.cmd',
        zipPath,
      });
      expect(published.archive?.format).toBe('zip');

      const started = await startHostResilient(owner, channel.id);
      expect((await fetch(started.urls.channelUrl)).status).toBe(200);

      const subscriber = await h.newCore('subscriber');
      await subscriber.core.channels.subscribe({ url: started.urls.channelUrl });
      const installed = await subscriber.core.library.install({
        channelId: channel.id,
        appId: 'host-zip-app',
      });
      expect(installed.app.version).toBe('1.0.0');
      const versionDir = path.join(
        subscriber.dataDir,
        'library',
        channel.id,
        'host-zip-app',
        'versions',
        '1.0.0',
      );
      expect(await fs.readFile(path.join(versionDir, 'run.cmd'), 'utf8')).toBe('echo host zip\n');
      expect(await fs.readFile(path.join(versionDir, 'resources', '中文.txt'), 'utf8')).toBe(
        'host zip 中文\n',
      );
      expect((await subscriber.core.library.verify(channel.id, 'host-zip-app')).ok).toBe(true);
      await owner.core.host.stop(channel.id);
    } finally {
      await h.dispose();
    }
  });

  it('端口冲突：start 抛 CONFLICT 并记录 lastError；释放端口后启动成功', async () => {
    const h = await createRealHarness();
    try {
      const owner = await h.newCore('owner');
      const port = await getFreePort();
      const blocker = await occupyPort(port);
      try {
        const channel = await createLocalHostChannel(owner, {
          name: 'Host 冲突频道',
          rootDir: path.join(h.rootDir, 'host-conflict-repo'),
          port,
          advertiseHost: '127.0.0.1',
        });
        const error = await expectAppError(() => owner.core.host.start(channel.id), ['CONFLICT']);
        expect(error.message).toContain('已被占用');
        const failed = await owner.core.host.status(channel.id);
        expect(failed.running).toBe(false);
        expect(failed.lastError?.code).toBe('CONFLICT');

        await closeNetServer(blocker);
        const started = await startHostResilient(owner, channel.id);
        expect(started.running).toBe(true);
        expect(started.port).toBe(started.configuredPort);
        expect((await owner.core.host.status(channel.id)).lastError).toBeUndefined();
        expect((await fetch(started.urls.channelUrl)).status).toBe(200);
        await owner.core.host.stop(channel.id);
      } finally {
        await closeNetServer(blocker);
      }
    } finally {
      await h.dispose();
    }
  });

  it('stop 后端口立即释放（可被占用）且可用同一端口重新启动', async () => {
    const h = await createRealHarness();
    try {
      const owner = await h.newCore('owner');
      const port = await getFreePort();
      const channel = await createLocalHostChannel(owner, {
        name: 'Host 端口复用频道',
        rootDir: path.join(h.rootDir, 'host-reuse-repo'),
        port,
        advertiseHost: '127.0.0.1',
      });

      const first = await owner.core.host.start(channel.id);
      expect((await fetch(first.urls.channelUrl)).status).toBe(200);
      await owner.core.host.stop(channel.id);

      // 占用成功 == 证明端口确实已释放（而不是仅标记停止）
      const probe = await occupyPort(port);
      await closeNetServer(probe);

      const second = await owner.core.host.start(channel.id);
      expect(second.running).toBe(true);
      expect(second.port).toBe(port);
      expect((await fetch(second.urls.channelUrl)).status).toBe(200);
      await owner.core.host.stopAll();
    } finally {
      await h.dispose();
    }
  });

  it('updateConfig：运行中拒绝（STATE）；停止后改端口/advertiseHost 后 URL 与监听端口同步', async () => {
    const h = await createRealHarness();
    try {
      const owner = await h.newCore('owner');
      const portA = await getFreePort();
      const rootDir = path.join(h.rootDir, 'host-config-repo');
      const channel = await createLocalHostChannel(owner, {
        name: 'Host 配置频道',
        rootDir,
        port: portA,
        advertiseHost: '127.0.0.1',
      });

      const started = await startHostResilient(owner, channel.id);
      expect(started.port).toBe(started.configuredPort);
      await expectAppError(
        () => owner.core.host.updateConfig(channel.id, { port: 45678 }),
        ['STATE'],
      );

      await owner.core.host.stop(channel.id);
      const portB = await getFreePort();
      const reconfigured = await owner.core.host.updateConfig(channel.id, {
        port: portB,
        advertiseHost: 'localhost',
      });
      expect(reconfigured.configuredPort).toBe(portB);
      expect(reconfigured.urls.channelUrl).toBe(`http://localhost:${portB}/channel.json`);
      // rootDir 不可修改
      await expectAppError(
        () => owner.core.host.updateConfig(channel.id, { rootDir: path.join(h.rootDir, 'other') } as never),
        ['VALIDATION'],
      );

      const restarted = await startHostResilient(owner, channel.id);
      expect(restarted.port).toBe(restarted.configuredPort);
      expect(restarted.urls.channelUrl).toBe(`http://localhost:${restarted.port}/channel.json`);
      // localhost 与 127.0.0.1 等价：监听 127.0.0.1 时用回环地址验证
      expect((await fetch(restarted.urls.localChannelUrl)).status).toBe(200);

      // 清空 advertiseHost 后回退到本机地址
      await owner.core.host.stop(channel.id);
      const cleared = await owner.core.host.updateConfig(channel.id, { advertiseHost: '' });
      expect(cleared.urls.channelUrl).toBe(`http://127.0.0.1:${restarted.configuredPort}/channel.json`);
      await owner.core.host.stopAll();
    } finally {
      await h.dispose();
    }
  });

  it('非 local-host 频道不托管：status/start 抛 UNSUPPORTED，list 不包含', async () => {
    const h = await createRealHarness();
    try {
      const owner = await h.newCore('owner');
      // 普通 local 频道（静态 HTTP 由外部 nginx 提供，与 Host 无关）
      const plain = await owner.core.channels.create({
        name: '普通 local 频道',
        visibility: 'public',
        storage: {
          provider: 'local',
          rootDir: path.join(h.rootDir, 'plain-local-repo'),
          publicBaseUrl: 'http://127.0.0.1:1/',
        },
      });
      expect(await owner.core.host.list()).toEqual([]);
      await expectAppError(() => owner.core.host.status(plain.id), ['UNSUPPORTED']);
      await expectAppError(() => owner.core.host.start(plain.id), ['UNSUPPORTED']);
      await expectAppError(() => owner.core.host.stop(plain.id), ['UNSUPPORTED']);
      await expectAppError(
        () => owner.core.host.updateConfig(plain.id, { port: 12345 }),
        ['UNSUPPORTED'],
      );
      await expectAppError(() => owner.core.host.status('ch_ffffffffffffffffffff'), ['NOT_FOUND']);
    } finally {
      await h.dispose();
    }
  });
});
