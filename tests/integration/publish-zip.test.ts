import path from 'node:path';
import { promises as fs } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseAppMetaFile, parseFilesFile } from '@apphub/protocol';
import { makeZipBuffer, md5Hex, writeZip } from '@apphub/testkit';
import {
  createChannel,
  expectAppError,
  findFilesBySuffix,
  pathExists,
  withHarness,
} from './support';

/**
 * 集成测试 C：zip 发布（docs/PROTOCOL.md §7.2）。
 *
 * 覆盖：zipPath / zipFromDir 两种输入、archive 元信息、内部文件清单、
 * zip-slip 恶意路径拒绝、订阅者安装 zip 版本后的本地文件正确性。
 */
describe('集成：zip 发布', () => {
  it('发布 zip（zipPath）：archive size/md5 正确、files 为包内清单', async (t) => {
    await withHarness(t, async (h) => {
      const publisher = await h.newCore('publisher');
      const channel = await createChannel(publisher, h, { name: 'zip 频道' });

      const innerFiles: Record<string, string | Buffer> = {
        'run.sh': '#!/bin/sh\necho zip app\n',
        'lib/data.bin': Buffer.alloc(1024, 9),
        'config/app.ini': 'mode=zip\n',
      };
      const zipPath = path.join(h.rootDir, 'sources', 'zip-app.zip');
      await writeZip(zipPath, innerFiles);
      const zipStat = await fs.stat(zipPath);

      const result = await publisher.core.publishing.publish({
        channelId: channel.id,
        app: { appId: 'zip-app', displayName: 'Zip App', description: 'zip 集成测试' },
        version: '1.0.0',
        platform: 'windows',
        publishMode: 'zip',
        entry: 'run.sh',
        zipPath,
        changelog: 'zip 首个版本',
      });

      // 1) 结果中的 archive 元信息与源 zip 一致
      expect(result.publishMode).toBe('zip');
      expect(result.archive).not.toBeNull();
      expect(result.archive?.format).toBe('zip');
      expect(result.archive?.size).toBe(zipStat.size);
      expect(result.archive?.md5).toBe(md5Hex(await fs.readFile(zipPath)));
      expect(result.archive?.url).toContain('1.0.0/');
      expect(result.archive?.url.endsWith('.zip')).toBe(true);
      expect(result.files.map((file) => file.path).sort()).toEqual(
        ['config/app.ini', 'lib/data.bin', 'run.sh'].sort(),
      );

      // 2) 存储布局：zip + files.json + app.meta.json + channel.json
      expect(h.keys()).toEqual(
        expect.arrayContaining([
          'zip-app/1.0.0/zip-app-1.0.0.zip',
          'zip-app/1.0.0/files.json',
          'zip-app/app.meta.json',
          'channel.json',
        ]),
      );

      // 3) files.json：files 为包内文件，archive 指向 zip
      const filesFile = parseFilesFile((await h.readText('zip-app/1.0.0/files.json')) ?? '');
      expect(filesFile.publishMode).toBe('zip');
      expect(filesFile.archive?.format).toBe('zip');
      expect(filesFile.files.map((file) => file.path).sort()).toEqual(
        ['config/app.ini', 'lib/data.bin', 'run.sh'].sort(),
      );
      // 包内文件 MD5 由解压后的内容计算，应与原始内容一致
      const runFile = filesFile.files.find((file) => file.path === 'run.sh');
      expect(runFile?.md5).toBe(md5Hex('#!/bin/sh\necho zip app\n'));

      const meta = parseAppMetaFile((await h.readText('zip-app/app.meta.json')) ?? '');
      expect(meta.publishMode).toBe('zip');
      expect(meta.versions[0]?.archive?.format).toBe('zip');
    });
  });

  it('发布 zip（zipFromDir）：目录自动打包并登记新版本', async (t) => {
    await withHarness(t, async (h) => {
      const publisher = await h.newCore('publisher');
      const channel = await createChannel(publisher, h);
      const sourceDir = await h.writeSourceFiles('zip-from-dir', {
        'app.exe': 'MZ fake exe',
        'resources/locale.txt': 'zh-CN\n',
      });

      const result = await publisher.core.publishing.publish({
        channelId: channel.id,
        app: { appId: 'dir-zip-app', displayName: 'Dir Zip App' },
        version: '1.0.0',
        platform: 'windows',
        publishMode: 'zip',
        entry: 'app.exe',
        zipFromDir: sourceDir,
      });

      expect(result.publishMode).toBe('zip');
      expect(result.archive).not.toBeNull();
      expect(h.keys()).toContain('dir-zip-app/1.0.0/dir-zip-app-1.0.0.zip');
      const meta = parseAppMetaFile((await h.readText('dir-zip-app/app.meta.json')) ?? '');
      expect(meta.latest.windows).toBe('1.0.0');
      expect(meta.versions[0]?.files.map((file) => file.path).sort()).toEqual([
        'app.exe',
        'resources/locale.txt',
      ]);
    });
  });

  it('拒绝 zip-slip 恶意路径，错误信息可读且不写入任何元信息', async (t) => {
    await withHarness(t, async (h) => {
      const publisher = await h.newCore('publisher');
      const channel = await createChannel(publisher, h);

      const evilZip = path.join(h.rootDir, 'sources', 'evil.zip');
      await fs.mkdir(path.dirname(evilZip), { recursive: true });
      await fs.writeFile(
        evilZip,
        makeZipBuffer({
          '../evil.sh': 'pwned\n',
          'run.sh': '#!/bin/sh\n',
        }),
      );

      await expectAppError(
        () =>
          publisher.core.publishing.publish({
            channelId: channel.id,
            app: { appId: 'evil-app', displayName: 'Evil App' },
            version: '1.0.0',
            platform: 'windows',
            publishMode: 'zip',
            entry: 'run.sh',
            zipPath: evilZip,
          }),
        ['SECURITY', 'VALIDATION'],
      );

      // 不应留下 app.meta.json / channel.json 登记（避免"元信息指向不存在文件"）
      expect(h.keys().filter((key) => key.startsWith('evil-app/'))).toEqual([]);
      expect(await h.readText('channel.json')).not.toContain('evil-app');
    });
  });

  it('订阅者安装 zip 版本：解压后的文件内容与 size/MD5 一致', async (t) => {
    await withHarness(t, async (h) => {
      const publisher = await h.newCore('publisher');
      const channel = await createChannel(publisher, h);
      const inner: Record<string, string> = {
        'run.sh': '#!/bin/sh\necho install me\n',
        'config/app.ini': 'mode=zip\n',
      };
      const zipPath = path.join(h.rootDir, 'sources', 'installable.zip');
      await writeZip(zipPath, inner);

      await publisher.core.publishing.publish({
        channelId: channel.id,
        app: { appId: 'zip-install-app', displayName: 'Zip Install App' },
        version: '1.0.0',
        platform: 'windows',
        publishMode: 'zip',
        entry: 'run.sh',
        zipPath,
      });

      const subscriber = await h.newCore('subscriber');
      await subscriber.core.channels.subscribe({ url: channel.subscribeUrl });
      const installed = await subscriber.core.library.install({
        channelId: channel.id,
        appId: 'zip-install-app',
      });
      expect(installed.app.version).toBe('1.0.0');
      expect(installed.downloadedBytes).toBeGreaterThan(0);

      const entryMatches = await findFilesBySuffix(
        subscriber.dataDir,
        `library/${channel.id}/zip-install-app/versions/1.0.0/run.sh`,
      );
      expect(entryMatches).toHaveLength(1);
      const entryPath = entryMatches[0] as string;
      expect(await fs.readFile(entryPath, 'utf8')).toBe(inner['run.sh']);
      const configPath = path.join(path.dirname(entryPath), 'config', 'app.ini');
      expect(await fs.readFile(configPath, 'utf8')).toBe(inner['config/app.ini']);

      const verified = await subscriber.core.library.verify(channel.id, 'zip-install-app');
      expect(verified.ok).toBe(true);
      expect(await pathExists(entryPath)).toBe(true);
    });
  });
});
