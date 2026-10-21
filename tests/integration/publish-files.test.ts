import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseAppMetaFile, parseChannelFile, parseFilesFile } from '@apphub/protocol';
import {
  createChannel,
  expectAppError,
  toPublishFiles,
  withHarness,
} from './support';

/**
 * 集成测试 B：散文件（files）发布。
 *
 * 覆盖 docs/PROTOCOL.md §7.1 / §7.3：
 *  - 上传顺序 payload → files.json → app.meta.json → channel.json；
 *  - 版本历史合并、latest 按 semver 计算；
 *  - 幂等重试、同版本冲突、overwrite、publishMode 不可切换、旧版本补发；
 *  - entry 必须属于文件列表、目标路径安全校验。
 */
describe('集成：散文件发布（files 模式）', () => {
  it('发布 v1.0.0：写入顺序正确、协议文件可解析、channel.json 登记 App', async (t) => {
    await withHarness(t, async (h) => {
      const publisher = await h.newCore('publisher');
      const channel = await createChannel(publisher, h, { name: '发布频道' });
      const srcDir = await h.writeSourceFiles('files-v1', {
        'hello.cmd': 'echo hello v1\n',
        'resources/说明.txt': '说明 v1\n',
      });
      const files = toPublishFiles(srcDir, ['hello.cmd', 'resources/说明.txt']);

      h.clearWrites();
      const result = await publisher.core.publishing.publish({
        channelId: channel.id,
        app: { appId: 'hello-app', displayName: 'Hello App', description: '集成测试 App', author: 'QA' },
        version: '1.0.0',
        platform: 'windows',
        publishMode: 'files',
        entry: 'hello.cmd',
        files,
        changelog: '首个版本',
      });

      expect(result.appId).toBe('hello-app');
      expect(result.version).toBe('1.0.0');
      expect(result.platform).toBe('windows');
      expect(result.publishMode).toBe('files');
      expect(result.fileCount).toBe(2);
      expect(result.files).toHaveLength(2);
      expect(result.totalSize).toBe(result.files.reduce((sum, file) => sum + file.size, 0));
      expect(result.archive).toBeNull();

      // 1) 存储布局（docs/ARCHITECTURE.md §4.1）
      expect(h.keys()).toEqual(
        expect.arrayContaining([
          'channel.json',
          'hello-app/app.meta.json',
          'hello-app/1.0.0/files.json',
          'hello-app/1.0.0/hello.cmd',
          'hello-app/1.0.0/resources/说明.txt',
        ]),
      );

      // 2) 上传顺序：payload → files.json → app.meta.json → channel.json
      const lastChannelWrite = h.storageWrites.lastIndexOf('channel.json');
      expect(lastChannelWrite).toBe(h.storageWrites.length - 1);
      const filesJsonIndex = h.storageWrites.indexOf('hello-app/1.0.0/files.json');
      const metaIndex = h.storageWrites.indexOf('hello-app/app.meta.json');
      const payloadIndex = h.storageWrites.indexOf('hello-app/1.0.0/hello.cmd');
      expect(payloadIndex).toBeGreaterThanOrEqual(0);
      expect(payloadIndex).toBeLessThan(filesJsonIndex);
      expect(filesJsonIndex).toBeLessThan(metaIndex);
      expect(metaIndex).toBeLessThan(lastChannelWrite);

      // 3) files.json / app.meta.json / channel.json 均通过协议严格校验
      const filesFile = parseFilesFile((await h.readText('hello-app/1.0.0/files.json')) ?? '');
      expect(filesFile.fileCount).toBe(2);
      expect(filesFile.entry).toBe('hello.cmd');

      const meta = parseAppMetaFile((await h.readText('hello-app/app.meta.json')) ?? '');
      expect(meta.latest).toEqual({ windows: '1.0.0' });
      expect(meta.platforms).toEqual(['windows']);
      expect(meta.versions).toHaveLength(1);
      expect(meta.versions[0]?.filesUrl).toBe('1.0.0/files.json');
      expect(meta.versions[0]?.downloadBaseUrl).toBe('1.0.0/');

      const channelFile = parseChannelFile((await h.readText('channel.json')) ?? '');
      expect(channelFile.apps).toHaveLength(1);
      const appRef = channelFile.apps[0];
      expect(appRef?.appId).toBe('hello-app');
      expect(appRef?.metaUrl).toBe('hello-app/app.meta.json');
      expect(appRef?.latest).toEqual({ windows: '1.0.0' });

      // 4) 发布结果里的元信息与远端一致
      expect(result.metaUrl).toBe('hello-app/app.meta.json');
      expect(result.channelUpdatedAt).toBe(channelFile.updatedAt);
    });
  });

  it('发布 v1.1.0：合并版本历史、latest 更新、getApp 按 semver 降序返回', async (t) => {
    await withHarness(t, async (h) => {
      const publisher = await h.newCore('publisher');
      const channel = await createChannel(publisher, h);
      const app = { appId: 'multi-version', displayName: 'Multi Version' };

      const src1 = await h.writeSourceFiles('mv-v1', { 'app.cmd': 'echo v1\n' });
      await publisher.core.publishing.publish({
        channelId: channel.id,
        app,
        version: '1.0.0',
        platform: 'windows',
        publishMode: 'files',
        entry: 'app.cmd',
        files: toPublishFiles(src1, ['app.cmd']),
      });

      const src2 = await h.writeSourceFiles('mv-v2', { 'app.cmd': 'echo v1.1.0\n', 'new.txt': 'new\n' });
      await publisher.core.publishing.publish({
        channelId: channel.id,
        app: { appId: 'multi-version', displayName: 'Multi Version' },
        version: '1.1.0',
        platform: 'windows',
        publishMode: 'files',
        entry: 'app.cmd',
        files: toPublishFiles(src2, ['app.cmd', 'new.txt']),
        changelog: '第二版',
      });

      // 补发一个旧版本（不改变 latest，但仍登记历史）
      const src0 = await h.writeSourceFiles('mv-v0', { 'app.cmd': 'echo v0.9.0\n' });
      await publisher.core.publishing.publish({
        channelId: channel.id,
        app: { appId: 'multi-version', displayName: 'Multi Version' },
        version: '0.9.0',
        platform: 'windows',
        publishMode: 'files',
        entry: 'app.cmd',
        files: toPublishFiles(src0, ['app.cmd']),
      });

      const detail = await publisher.core.publishing.getApp(channel.id, 'multi-version');
      expect(detail.meta.latest.windows).toBe('1.1.0');
      expect(detail.versions).toHaveLength(3);
      expect(detail.versions.map((version) => version.version)).toEqual(['1.1.0', '1.0.0', '0.9.0']);

      const channelFile = parseChannelFile((await h.readText('channel.json')) ?? '');
      expect(channelFile.apps[0]?.latest).toEqual({ windows: '1.1.0' });
    });
  });

  it('幂等重试与冲突：相同内容重复发布成功，不同内容报 CONFLICT，overwrite 可覆盖', async (t) => {
    await withHarness(t, async (h) => {
      const publisher = await h.newCore('publisher');
      const channel = await createChannel(publisher, h);
      const app = { appId: 'conflict-app', displayName: 'Conflict App' };
      const srcDir = await h.writeSourceFiles('conflict-v1', { 'run.cmd': 'echo stable\n' });
      const publishInput = {
        channelId: channel.id,
        app,
        version: '1.0.0',
        platform: 'windows' as const,
        publishMode: 'files' as const,
        entry: 'run.cmd',
        files: toPublishFiles(srcDir, ['run.cmd']),
      };

      await publisher.core.publishing.publish(publishInput);

      // 完全一致 → 幂等成功，不报错、不新增版本
      const second = await publisher.core.publishing.publish(publishInput);
      expect(second.version).toBe('1.0.0');
      const afterIdempotent = await publisher.core.publishing.getApp(channel.id, 'conflict-app');
      expect(afterIdempotent.versions).toHaveLength(1);

      // 同版本但内容不同 → CONFLICT
      const changedDir = await h.writeSourceFiles('conflict-v1-changed', { 'run.cmd': 'echo changed\n' });
      await expectAppError(
        () =>
          publisher.core.publishing.publish({
            ...publishInput,
            files: toPublishFiles(changedDir, ['run.cmd']),
          }),
        ['CONFLICT'],
      );

      // overwrite=true → 整版本覆盖，元信息中的 MD5 更新
      const overwritten = await publisher.core.publishing.publish({
        ...publishInput,
        files: toPublishFiles(changedDir, ['run.cmd']),
        overwrite: true,
      });
      expect(overwritten.version).toBe('1.0.0');
      const meta = parseAppMetaFile((await h.readText('conflict-app/app.meta.json')) ?? '');
      const versionEntry = meta.versions.find((version) => version.version === '1.0.0');
      expect(versionEntry?.files[0]?.path).toBe('run.cmd');
      expect(versionEntry?.files[0]?.size).toBe('echo changed\n'.length);

      // publishMode 创建后不可切换：files App 用 zip 再发布 → CONFLICT
      const zipSource = await h.writeSourceFiles('conflict-zip', { 'run.cmd': 'echo zip\n' });
      // 生成 zip 只需一个可用文件；用 testkit 的 writeZip
      const { writeZip } = await import('@apphub/testkit');
      const zipPath = path.join(h.rootDir, 'sources', 'conflict.zip');
      await writeZip(zipPath, { 'run.cmd': 'echo zip\n' });
      void zipSource;
      await expectAppError(
        () =>
          publisher.core.publishing.publish({
            channelId: channel.id,
            app: { appId: 'conflict-app', displayName: 'Conflict App' },
            version: '1.0.1',
            platform: 'windows',
            publishMode: 'zip',
            entry: 'run.cmd',
            zipPath,
          }),
        ['CONFLICT'],
      );
    });
  });

  it('发布输入校验：entry 不在文件列表、targetPath 越权都要被拒绝且不写坏元信息', async (t) => {
    await withHarness(t, async (h) => {
      const publisher = await h.newCore('publisher');
      const channel = await createChannel(publisher, h);
      const srcDir = await h.writeSourceFiles('invalid-src', { 'ok.cmd': 'echo ok\n' });

      // entry 不在文件列表
      await expectAppError(
        () =>
          publisher.core.publishing.publish({
            channelId: channel.id,
            app: { appId: 'bad-app', displayName: 'Bad App' },
            version: '1.0.0',
            platform: 'windows',
            publishMode: 'files',
            entry: 'missing.cmd',
            files: toPublishFiles(srcDir, ['ok.cmd']),
          }),
        ['VALIDATION', 'SECURITY'],
      );
      expect(h.keys().filter((key) => key.startsWith('bad-app/'))).toEqual([]);

      // targetPath 路径穿越
      await expectAppError(
        () =>
          publisher.core.publishing.publish({
            channelId: channel.id,
            app: { appId: 'bad-app', displayName: 'Bad App' },
            version: '1.0.0',
            platform: 'windows',
            publishMode: 'files',
            entry: 'ok.cmd',
            files: [{ sourcePath: path.join(srcDir, 'ok.cmd'), targetPath: '../evil.cmd' }],
          }),
        ['VALIDATION', 'SECURITY'],
      );

      // 非法 semver
      await expectAppError(
        () =>
          publisher.core.publishing.publish({
            channelId: channel.id,
            app: { appId: 'bad-app', displayName: 'Bad App' },
            version: '1.0',
            platform: 'windows',
            publishMode: 'files',
            entry: 'ok.cmd',
            files: toPublishFiles(srcDir, ['ok.cmd']),
          }),
        ['VALIDATION'],
      );

      // 不存在的频道
      await expectAppError(
        () =>
          publisher.core.publishing.publish({
            channelId: 'ch_ffffffffffffffffffff',
            app: { appId: 'bad-app', displayName: 'Bad App' },
            version: '1.0.0',
            platform: 'windows',
            publishMode: 'files',
            entry: 'ok.cmd',
            files: toPublishFiles(srcDir, ['ok.cmd']),
          }),
        ['NOT_FOUND', 'VALIDATION', 'AUTH', 'STATE'],
      );
    });
  });

  it('updateMeta 修改展示信息会同步写回 app.meta.json 与 channel.json', async (t) => {
    await withHarness(t, async (h) => {
      const publisher = await h.newCore('publisher');
      const channel = await createChannel(publisher, h);
      const srcDir = await h.writeSourceFiles('meta-src', { 'run.cmd': 'echo meta\n' });
      await publisher.core.publishing.publish({
        channelId: channel.id,
        app: { appId: 'meta-app', displayName: 'Meta App' },
        version: '1.0.0',
        platform: 'windows',
        publishMode: 'files',
        entry: 'run.cmd',
        files: toPublishFiles(srcDir, ['run.cmd']),
      });

      await publisher.core.publishing.updateMeta(channel.id, 'meta-app', {
        displayName: 'Meta App 改名',
        description: '新的描述',
      });

      const meta = parseAppMetaFile((await h.readText('meta-app/app.meta.json')) ?? '');
      expect(meta.displayName).toBe('Meta App 改名');
      expect(meta.description).toBe('新的描述');
      const channelFile = parseChannelFile((await h.readText('channel.json')) ?? '');
      expect(channelFile.apps[0]?.displayName).toBe('Meta App 改名');
    });
  });

  it('getApp 对不存在的 App 返回 NOT_FOUND', async (t) => {
    await withHarness(t, async (h) => {
      const publisher = await h.newCore('publisher');
      const channel = await createChannel(publisher, h);
      await expectAppError(
        () => publisher.core.publishing.getApp(channel.id, 'no-such-app'),
        ['NOT_FOUND'],
      );
    });
  });
});
