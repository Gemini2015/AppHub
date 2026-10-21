import path from 'node:path';
import { promises as fs } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { md5Hex, writeFileTree, writeZip } from '@apphub/testkit';
import {
  createRealHarness,
  expectAppError,
  pathExists,
  readRepoJson,
  requestedIncludes,
  startFtpHttpEnv,
} from './support';

/**
 * 集成测试 A/B（真实 provider）：FTP 写入 + 静态 HTTP 读取，模拟用户自建 ftp+nginx。
 *
 * A. 散文件全链路：create(ftp-http) → publish(files，嵌套目录/Unicode/大文件) →
 *    独立 dataDir 订阅者 subscribe(HTTP) → install → 校验 size/MD5 → publish v2 →
 *    checkUpdates → update（断言 MD5 复用）→ verify → uninstall。
 * B. zip 全链路：publish zip → 订阅 → 安装 → 更新 → 注入损坏 archive 后更新失败且旧版本可用
 *    → 重新发布正确 archive 后恢复成功。
 */
describe('集成（真实 FTP + HTTP）：公开频道全链路', () => {
  it('A: 散文件 create→publish→subscribe→install→update(MD5 复用)→verify→uninstall', async () => {
    const h = await createRealHarness();
    const env = await startFtpHttpEnv(h.rootDir);
    try {
      const owner = await h.newCore('owner');
      const channel = await owner.core.channels.create({
        name: 'FTP 公开频道',
        description: '真实 ftp-http 全链路',
        visibility: 'public',
        owner: { name: 'FTP Owner' },
        storage: env.storageConfig,
      });
      expect(channel.subscribeUrl.startsWith(env.staticServer.baseUrl)).toBe(true);
      expect(channel.subscribeUrl.endsWith('/channel.json')).toBe(true);

      // 1) 远端仓储：channel.json 已通过 FTP 写入 nginx 根目录
      const repoChannel = await readRepoJson<{ id: string; apps: unknown[] }>(env.repoDir, 'channel.json');
      expect(repoChannel?.id).toBe(channel.id);
      expect(repoChannel?.apps).toEqual([]);

      // 2) 发布 v1.0.0（嵌套目录 + Unicode 文件名 + 大文件）
      const bigFile = Buffer.alloc(300 * 1024, 11);
      const srcV1 = path.join(h.rootDir, 'sources', 'ftp-v1');
      await writeFileTree(srcV1, [
        { path: 'app.exe', content: 'MZ fake v1\n' },
        { path: 'resources/中文 说明.txt', content: 'v1 中文说明\n' },
        { path: 'resources/data/big.bin', content: bigFile },
      ]);
      const app = { appId: 'ftp-app', displayName: 'FTP App', author: 'QA' };
      const v1 = await owner.core.publishing.publish({
        channelId: channel.id,
        app,
        version: '1.0.0',
        platform: 'windows',
        publishMode: 'files',
        entry: 'app.exe',
        files: ['app.exe', 'resources/中文 说明.txt', 'resources/data/big.bin'].map((relative) => ({
          sourcePath: path.join(srcV1, ...relative.split('/')),
          targetPath: relative,
        })),
        changelog: 'FTP v1',
      });
      expect(v1.fileCount).toBe(3);
      expect(v1.files.find((file) => file.path === 'resources/中文 说明.txt')?.md5).toBe(
        md5Hex('v1 中文说明\n'),
      );
      // FTP 落盘后的真实文件存在（含 Unicode 文件名）
      expect(await pathExists(path.join(env.repoDir, 'ftp-app', '1.0.0', 'resources', '中文 说明.txt'))).toBe(
        true,
      );
      expect(await pathExists(path.join(env.repoDir, 'ftp-app', 'app.meta.json'))).toBe(true);

      // 3) 独立订阅者通过 HTTP 订阅并安装
      const subscriber = await h.newCore('subscriber');
      const subscribed = await subscriber.core.channels.subscribe({ url: channel.subscribeUrl });
      expect(subscribed.appCount).toBe(1);
      expect(subscribed.apps[0]?.appId).toBe('ftp-app');

      const installed = await subscriber.core.library.install({
        channelId: channel.id,
        appId: 'ftp-app',
      });
      expect(installed.app.version).toBe('1.0.0');
      expect(installed.downloadedBytes).toBeGreaterThanOrEqual(bigFile.length);

      const versionDirV1 = path.join(
        subscriber.dataDir,
        'library',
        channel.id,
        'ftp-app',
        'versions',
        '1.0.0',
      );
      expect(await fs.readFile(path.join(versionDirV1, 'resources', 'data', 'big.bin'))).toEqual(bigFile);
      expect((await subscriber.core.library.verify(channel.id, 'ftp-app')).ok).toBe(true);

      // 4) 确实走了真实 HTTP 下载（nginx 模拟）
      //    注：files.json 不是必须请求——协议允许客户端直接使用 app.meta.json 内嵌的 files 清单，
      //    这里的断言聚焦"确实通过 HTTP 拉取了元信息与 payload"。
      expect(requestedIncludes(h, 'app.meta.json')).toBe(true);
      expect(requestedIncludes(h, 'big.bin')).toBe(true);
      expect(
        h.httpRequests.some((url) => decodeURIComponent(url).includes('中文 说明.txt')),
      ).toBe(true);

      // 5) 发布 v1.1.0：只改两个小文件，big.bin 不变
      h.clock.advance(60_000);
      const srcV2 = path.join(h.rootDir, 'sources', 'ftp-v2');
      await writeFileTree(srcV2, [
        { path: 'app.exe', content: 'MZ fake v1.1.0\n' },
        { path: 'resources/中文 说明.txt', content: 'v1.1 中文说明\n' },
        { path: 'resources/data/big.bin', content: bigFile },
      ]);
      await owner.core.publishing.publish({
        channelId: channel.id,
        app,
        version: '1.1.0',
        platform: 'windows',
        publishMode: 'files',
        entry: 'app.exe',
        files: ['app.exe', 'resources/中文 说明.txt', 'resources/data/big.bin'].map((relative) => ({
          sourcePath: path.join(srcV2, ...relative.split('/')),
          targetPath: relative,
        })),
        changelog: 'FTP v1.1',
      });

      const updates = await subscriber.core.library.checkUpdates();
      const item = updates.find((entry) => entry.channelId === channel.id && entry.appId === 'ftp-app');
      expect(item?.latestVersion).toBe('1.1.0');
      expect(item?.updateAvailable).toBe(true);

      const updated = await subscriber.core.library.update({ channelId: channel.id, appId: 'ftp-app' });
      expect(updated.app.version).toBe('1.1.0');
      expect(updated.updatedFrom).toBe('1.0.0');
      // MD5 复用：未变化的大文件不应重新下载
      expect(updated.reusedBytes).toBeGreaterThanOrEqual(bigFile.length);
      expect(updated.downloadedBytes).toBeLessThan(bigFile.length);
      expect((await subscriber.core.library.verify(channel.id, 'ftp-app')).ok).toBe(true);

      const descriptor = await subscriber.core.library.getLaunchDescriptor(channel.id, 'ftp-app');
      expect(await pathExists(descriptor.entryPath)).toBe(true);
      expect(descriptor.versionDir).toContain('1.1.0');

      await subscriber.core.library.uninstall(channel.id, 'ftp-app');
      expect(await subscriber.core.library.list()).toEqual([]);
      expect(await pathExists(path.join(subscriber.dataDir, 'library', channel.id, 'ftp-app'))).toBe(false);
    } finally {
      await env.close();
      await h.dispose();
    }
  });

  it('A-错误：FTP 凭据错误时创建频道失败且不写脏数据', async () => {
    const h = await createRealHarness();
    const env = await startFtpHttpEnv(h.rootDir);
    try {
      const owner = await h.newCore('owner');
      const badConfig = {
        ...env.storageConfig,
        ftp: { ...env.storageConfig.ftp, password: 'wrong-password' },
      };
      await expectAppError(
        () =>
          owner.core.channels.create({
            name: '错误凭据频道',
            visibility: 'public',
            storage: badConfig,
          }),
        ['AUTH', 'STORAGE', 'NETWORK'],
      );
      // 不应留下 channel.json
      expect(await pathExists(path.join(env.repoDir, 'channel.json'))).toBe(false);
    } finally {
      await env.close();
      await h.dispose();
    }
  });

  it('B: zip 全链路 + 损坏 archive 时更新失败且旧版本可用', async () => {
    const h = await createRealHarness();
    const env = await startFtpHttpEnv(h.rootDir);
    try {
      const owner = await h.newCore('owner');
      const channel = await owner.core.channels.create({
        name: 'FTP zip 频道',
        visibility: 'public',
        owner: { name: 'Zip Owner' },
        storage: env.storageConfig,
      });
      const subscriber = await h.newCore('subscriber');
      await subscriber.core.channels.subscribe({ url: channel.subscribeUrl });

      const app = { appId: 'zip-ftp-app', displayName: 'Zip FTP App' };
      const zipDir = path.join(h.rootDir, 'sources');
      await fs.mkdir(zipDir, { recursive: true });
      const zipV1 = path.join(zipDir, 'v1.zip');
      await writeZip(zipV1, {
        'run.cmd': 'echo zip v1\n',
        'lib/data.bin': Buffer.alloc(64 * 1024, 5),
        'resources/中文.txt': 'zip 中文 v1\n',
      });
      const publishedV1 = await owner.core.publishing.publish({
        channelId: channel.id,
        app,
        version: '1.0.0',
        platform: 'windows',
        publishMode: 'zip',
        entry: 'run.cmd',
        zipPath: zipV1,
      });
      expect(publishedV1.archive?.format).toBe('zip');
      expect(publishedV1.publishMode).toBe('zip');

      const installedV1 = await subscriber.core.library.install({
        channelId: channel.id,
        appId: 'zip-ftp-app',
      });
      expect(installedV1.app.version).toBe('1.0.0');
      const versionDirV1 = path.join(
        subscriber.dataDir,
        'library',
        channel.id,
        'zip-ftp-app',
        'versions',
        '1.0.0',
      );
      expect(await fs.readFile(path.join(versionDirV1, 'run.cmd'), 'utf8')).toBe('echo zip v1\n');
      expect(await fs.readFile(path.join(versionDirV1, 'resources', '中文.txt'), 'utf8')).toBe(
        'zip 中文 v1\n',
      );
      expect((await subscriber.core.library.verify(channel.id, 'zip-ftp-app')).ok).toBe(true);

      // 发布 v1.1.0 zip → 更新
      h.clock.advance(60_000);
      const zipV2 = path.join(zipDir, 'v2.zip');
      await writeZip(zipV2, {
        'run.cmd': 'echo zip v1.1.0\n',
        'lib/data.bin': Buffer.alloc(64 * 1024, 6),
        'resources/中文.txt': 'zip 中文 v1.1\n',
      });
      await owner.core.publishing.publish({
        channelId: channel.id,
        app,
        version: '1.1.0',
        platform: 'windows',
        publishMode: 'zip',
        entry: 'run.cmd',
        zipPath: zipV2,
      });
      const updated = await subscriber.core.library.update({ channelId: channel.id, appId: 'zip-ftp-app' });
      expect(updated.app.version).toBe('1.1.0');
      expect((await subscriber.core.library.verify(channel.id, 'zip-ftp-app')).ok).toBe(true);

      // 发布 v2.0.0 zip，然后**注入损坏 archive**（写坏字节到 nginx 目录）
      h.clock.advance(60_000);
      const zipV3 = path.join(zipDir, 'v3.zip');
      await writeZip(zipV3, {
        'run.cmd': 'echo zip v2.0.0\n',
        'lib/data.bin': Buffer.alloc(32 * 1024, 7),
      });
      await owner.core.publishing.publish({
        channelId: channel.id,
        app,
        version: '2.0.0',
        platform: 'windows',
        publishMode: 'zip',
        entry: 'run.cmd',
        zipPath: zipV3,
      });
      const archivePathOnRepo = path.join(
        env.repoDir,
        'zip-ftp-app',
        '2.0.0',
        'zip-ftp-app-2.0.0.zip',
      );
      expect(await pathExists(archivePathOnRepo)).toBe(true);
      await fs.writeFile(archivePathOnRepo, Buffer.from('this is not a zip archive'));

      await expectAppError(
        () => subscriber.core.library.update({ channelId: channel.id, appId: 'zip-ftp-app' }),
        ['VALIDATION', 'NETWORK', 'STORAGE', 'STATE', 'IO'],
      );
      // 失败后旧版本仍可用
      expect((await subscriber.core.library.verify(channel.id, 'zip-ftp-app')).ok).toBe(true);
      expect(await fs.readFile(path.join(subscriber.dataDir, 'library', channel.id, 'zip-ftp-app', 'versions', '1.1.0', 'run.cmd'), 'utf8')).toBe(
        'echo zip v1.1.0\n',
      );

      // 恢复：重新发布**内容不同**的新版本 v2.0.1（不是幂等重试；
      // 外部坏字节属于"远端被篡改"，重新上传同内容会被幂等逻辑短路，这一点在 TESTING.md 已知限制中说明）
      h.clock.advance(60_000);
      const zipV4 = path.join(zipDir, 'v4.zip');
      await writeZip(zipV4, {
        'run.cmd': 'echo zip v2.0.1\n',
        'lib/data.bin': Buffer.alloc(32 * 1024, 8),
      });
      await owner.core.publishing.publish({
        channelId: channel.id,
        app,
        version: '2.0.1',
        platform: 'windows',
        publishMode: 'zip',
        entry: 'run.cmd',
        zipPath: zipV4,
      });
      const recovered = await subscriber.core.library.update({ channelId: channel.id, appId: 'zip-ftp-app' });
      expect(recovered.app.version).toBe('2.0.1');
      expect((await subscriber.core.library.verify(channel.id, 'zip-ftp-app')).ok).toBe(true);
    } finally {
      await env.close();
      await h.dispose();
    }
  });
});
