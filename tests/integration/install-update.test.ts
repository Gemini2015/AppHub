import path from 'node:path';
import { promises as fs } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { md5Hex } from '@apphub/testkit';
import {
  createChannel,
  expectAppError,
  findFilesBySuffix,
  pathExists,
  toPublishFiles,
  withHarness,
} from './support';

/**
 * 集成测试 D：本地库（安装 / 校验 / 更新 / 启动描述 / 卸载）。
 *
 * 对应 docs/ARCHITECTURE.md §3.4 / §3.5、docs/PROTOCOL.md §8：
 *  - 散文件更新按 MD5 复用未变化文件（断言 reusedBytes / downloadedBytes）；
 *  - verify 能发现被篡改的文件并返回具体 mismatch；
 *  - 安装失败（payload 损坏）时不留半成品、旧版本仍可用；
 *  - 卸载清理磁盘与索引。
 */
describe('集成：本地库安装 / 校验 / 更新 / 卸载', () => {
  const appId = 'lifecycle-app';
  const channelName = '本地库频道';

  it('安装 v1 → 校验 → 篡改检测 → 修复 → 更新 v2（MD5 复用）→ 启动描述 → 卸载', async (t) => {
    await withHarness(t, async (h) => {
      const publisher = await h.newCore('publisher');
      const channel = await createChannel(publisher, h, { name: channelName });

      const bigFile = Buffer.alloc(200 * 1024, 7);
      const srcV1 = await h.writeSourceFiles('lifecycle-v1', {
        'app.cmd': 'echo v1\n',
        'big.bin': bigFile,
        'data/config.ini': 'version=1\n',
      });
      await publisher.core.publishing.publish({
        channelId: channel.id,
        app: { appId, displayName: 'Lifecycle App' },
        version: '1.0.0',
        platform: 'windows',
        publishMode: 'files',
        entry: 'app.cmd',
        files: toPublishFiles(srcV1, ['app.cmd', 'big.bin', 'data/config.ini']),
      });

      const subscriber = await h.newCore('subscriber');
      await subscriber.core.channels.subscribe({ url: channel.subscribeUrl });

      // 1) 安装 v1
      const installed = await subscriber.core.library.install({ channelId: channel.id, appId });
      expect(installed.app.version).toBe('1.0.0');
      expect(installed.app.appId).toBe(appId);
      expect(installed.app.status).toBe('installed');
      expect(installed.downloadedBytes).toBeGreaterThan(0);

      const versionDirV1 = path.join(
        subscriber.dataDir,
        'library',
        channel.id,
        appId,
        'versions',
        '1.0.0',
      );
      expect(await pathExists(path.join(versionDirV1, 'app.cmd'))).toBe(true);
      expect(md5Hex(await fs.readFile(path.join(versionDirV1, 'big.bin')))).toBe(md5Hex(bigFile));
      expect((await findFilesBySuffix(subscriber.dataDir, `library/${channel.id}/${appId}/install.json`)).length).toBeGreaterThan(0);

      // 2) 校验通过
      const verified = await subscriber.core.library.verify(channel.id, appId);
      expect(verified.ok).toBe(true);
      expect(verified.checkedFiles).toBe(3);
      expect(verified.mismatches).toEqual([]);

      // 3) 篡改本地文件 → verify 失败并给出具体 mismatch
      const configPath = path.join(versionDirV1, 'data', 'config.ini');
      await fs.writeFile(configPath, 'version=1-tampered\n');
      const tampered = await subscriber.core.library.verify(channel.id, appId);
      expect(tampered.ok).toBe(false);
      expect(tampered.mismatches.some((item) => item.path === 'data/config.ini')).toBe(true);
      expect(tampered.mismatches.find((item) => item.path === 'data/config.ini')?.reason).toMatch(/md5|size/);

      // 4) force 重新安装修复本地文件
      const repaired = await subscriber.core.library.install({ channelId: channel.id, appId, force: true });
      expect(repaired.app.version).toBe('1.0.0');
      const verifiedAfterRepair = await subscriber.core.library.verify(channel.id, appId);
      expect(verifiedAfterRepair.ok).toBe(true);

      // 5) 发布 v1.1.0：只改两个小文件，big.bin 保持不变
      h.clock.advance(60_000);
      const srcV2 = await h.writeSourceFiles('lifecycle-v2', {
        'app.cmd': 'echo v1.1.0\n',
        'big.bin': bigFile,
        'data/config.ini': 'version=2\n',
      });
      await publisher.core.publishing.publish({
        channelId: channel.id,
        app: { appId, displayName: 'Lifecycle App' },
        version: '1.1.0',
        platform: 'windows',
        publishMode: 'files',
        entry: 'app.cmd',
        files: toPublishFiles(srcV2, ['app.cmd', 'big.bin', 'data/config.ini']),
        changelog: 'v1.1.0',
      });

      // 6) 检查更新
      const updates = await subscriber.core.library.checkUpdates();
      const item = updates.find((entry) => entry.channelId === channel.id && entry.appId === appId);
      expect(item).toBeDefined();
      expect(item?.currentVersion).toBe('1.0.0');
      expect(item?.latestVersion).toBe('1.1.0');
      expect(item?.updateAvailable).toBe(true);

      // 7) 更新：未变化的 big.bin 应被 MD5 复用
      const updated = await subscriber.core.library.update({ channelId: channel.id, appId });
      expect(updated.app.version).toBe('1.1.0');
      expect(updated.updatedFrom).toBe('1.0.0');
      expect(updated.reusedBytes).toBeGreaterThanOrEqual(bigFile.length);
      expect(updated.downloadedBytes).toBeLessThan(bigFile.length);
      expect(updated.app.status).toBe('installed');

      const verifiedV2 = await subscriber.core.library.verify(channel.id, appId);
      expect(verifiedV2.ok).toBe(true);
      expect(await fs.readFile(path.join(versionDirV1, '..', '1.1.0', 'app.cmd'), 'utf8')).toBe(
        'echo v1.1.0\n',
      );

      // 8) keepVersions 默认 2：旧版本目录仍保留（回滚能力）
      expect(await pathExists(versionDirV1)).toBe(true);

      // 9) 启动描述：entry 位于版本目录内且存在
      const descriptor = await subscriber.core.library.getLaunchDescriptor(channel.id, appId);
      expect(path.resolve(descriptor.entryPath).startsWith(path.resolve(descriptor.versionDir))).toBe(true);
      expect(await pathExists(descriptor.entryPath)).toBe(true);
      expect(descriptor.versionDir).toContain('1.1.0');
      expect(descriptor.cwd).toBe(descriptor.versionDir);

      // 10) 已是最新时 checkUpdates 不再提示更新
      const updatesAfter = await subscriber.core.library.checkUpdates();
      const itemAfter = updatesAfter.find((entry) => entry.appId === appId);
      expect(itemAfter?.updateAvailable).toBe(false);

      // 11) 卸载：磁盘与索引都清理
      const appRoot = path.join(subscriber.dataDir, 'library', channel.id, appId);
      await subscriber.core.library.uninstall(channel.id, appId);
      expect(await subscriber.core.library.list()).toEqual([]);
      expect(await pathExists(appRoot)).toBe(false);

      // 12) 卸载后再校验/卸载应报可读错误
      await expectAppError(
        () => subscriber.core.library.verify(channel.id, appId),
        ['NOT_FOUND', 'STATE'],
      );
      await expectAppError(
        () => subscriber.core.library.uninstall(channel.id, appId),
        ['NOT_FOUND', 'STATE'],
      );
    });
  });

  it('安装时 payload 损坏：失败回滚、不产生半成品版本；恢复后可正常安装', async (t) => {
    await withHarness(t, async (h) => {
      const publisher = await h.newCore('publisher');
      const channel = await createChannel(publisher, h);
      const content = 'echo payload\n';
      const srcDir = await h.writeSourceFiles('corrupt-src', { 'run.cmd': content });
      await publisher.core.publishing.publish({
        channelId: channel.id,
        app: { appId: 'corrupt-app', displayName: 'Corrupt App' },
        version: '1.0.0',
        platform: 'windows',
        publishMode: 'files',
        entry: 'run.cmd',
        files: toPublishFiles(srcDir, ['run.cmd']),
      });

      // 篡改远端 payload（channel.json/app.meta.json 仍指向原 MD5）
      h.injectBinary('corrupt-app/1.0.0/run.cmd', Buffer.from('corrupted payload\n'));

      const subscriber = await h.newCore('subscriber');
      await subscriber.core.channels.subscribe({ url: channel.subscribeUrl });

      await expectAppError(
        () => subscriber.core.library.install({ channelId: channel.id, appId: 'corrupt-app' }),
        ['VALIDATION', 'NETWORK', 'STORAGE', 'STATE', 'IO'],
      );

      // 失败后：本地库为空、没有半成品版本目录
      expect(await subscriber.core.library.list()).toEqual([]);
      expect(
        await findFilesBySuffix(
          subscriber.dataDir,
          `library/${channel.id}/corrupt-app/versions/1.0.0/run.cmd`,
        ),
      ).toEqual([]);

      // 恢复正确内容后重试成功
      h.injectText('corrupt-app/1.0.0/run.cmd', content);
      const installed = await subscriber.core.library.install({
        channelId: channel.id,
        appId: 'corrupt-app',
      });
      expect(installed.app.version).toBe('1.0.0');
      expect((await subscriber.core.library.verify(channel.id, 'corrupt-app')).ok).toBe(true);
    });
  });

  it('平台不匹配/未安装时的库操作返回可读错误', async (t) => {
    await withHarness(t, async (h) => {
      const publisher = await h.newCore('publisher');
      const channel = await createChannel(publisher, h);
      const srcDir = await h.writeSourceFiles('platform-src', { 'run.cmd': 'echo platform\n' });
      await publisher.core.publishing.publish({
        channelId: channel.id,
        app: { appId: 'platform-app', displayName: 'Platform App' },
        version: '1.0.0',
        platform: 'windows',
        publishMode: 'files',
        entry: 'run.cmd',
        files: toPublishFiles(srcDir, ['run.cmd']),
      });

      const subscriber = await h.newCore('subscriber');
      await subscriber.core.channels.subscribe({ url: channel.subscribeUrl });

      // 只发布了 windows 版本，请求 mac 平台应失败
      await expectAppError(
        () =>
          subscriber.core.library.install({
            channelId: channel.id,
            appId: 'platform-app',
            platform: 'mac',
          }),
        ['NOT_FOUND', 'VALIDATION', 'UNSUPPORTED', 'STATE'],
      );

      // 未安装时 verify / launch 也应报错
      await expectAppError(
        () => subscriber.core.library.verify(channel.id, 'platform-app'),
        ['NOT_FOUND', 'STATE'],
      );
      await expectAppError(
        () => subscriber.core.library.getLaunchDescriptor(channel.id, 'platform-app'),
        ['NOT_FOUND', 'STATE'],
      );
    });
  });
});
