import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempDir, safeRemove } from '@apphub/testkit';
import { parseAppMetaFile, parseChannelFile } from '@apphub/protocol';
import { repairDuplicateApp } from '../../scripts/repair-duplicate-app';

const CHANNEL_ID = 'ch_0123456789abcdef';
const NOW = '2026-10-28T00:00:00.000Z';
const MD5 = 'd41d8cd98f00b204e9800998ecf8427e';

function versionEntry(version: string) {
  return {
    version,
    platform: 'windows',
    publishMode: 'files',
    entry: 'app.exe',
    publishedAt: NOW,
    changelog: '',
    totalSize: 1,
    fileCount: 1,
    filesUrl: `${version}/files.json`,
    downloadBaseUrl: `${version}/`,
    files: [{ path: 'app.exe', size: 1, md5: MD5 }],
    archive: null,
  };
}

function appMeta(appId: string, version: string) {
  return {
    schemaVersion: 1,
    kind: 'apphub-app-meta',
    appId,
    channelId: CHANNEL_ID,
    name: appId,
    displayName: 'CPU-Z',
    description: '',
    author: '',
    publishMode: 'files',
    entry: 'app.exe',
    platforms: ['windows'],
    latest: { windows: version },
    versions: [versionEntry(version)],
    updatedAt: NOW,
  };
}

function appRef(appId: string, version: string) {
  return {
    appId,
    name: appId,
    displayName: 'CPU-Z',
    description: '',
    author: '',
    entry: 'app.exe',
    platforms: ['windows'],
    publishMode: 'files',
    latest: { windows: version },
    metaUrl: `${appId}/app.meta.json`,
    updatedAt: NOW,
  };
}

function channelFile(apps: ReturnType<typeof appRef>[]) {
  return {
    schemaVersion: 1,
    kind: 'apphub-channel',
    id: CHANNEL_ID,
    name: '重复 App 频道',
    description: '',
    visibility: 'public',
    owner: { name: '' },
    apps,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

describe('repair:duplicate-app', () => {
  let root: string;

  beforeEach(async () => {
    root = await createTempDir('apphub-repair-test-');
    for (const appId of ['cpu_z', 'cpu-z']) {
      await fs.mkdir(path.join(root, appId), { recursive: true });
    }
    await fs.writeFile(
      path.join(root, 'channel.json'),
      JSON.stringify(channelFile([appRef('cpu_z', '1.0.0'), appRef('cpu-z', '1.0.1')]), null, 2),
    );
    await fs.writeFile(
      path.join(root, 'cpu_z', 'app.meta.json'),
      JSON.stringify(appMeta('cpu_z', '1.0.0'), null, 2),
    );
    await fs.writeFile(
      path.join(root, 'cpu-z', 'app.meta.json'),
      JSON.stringify(appMeta('cpu-z', '1.0.1'), null, 2),
    );
    await fs.mkdir(path.join(root, 'cpu_z', '1.0.0'), { recursive: true });
    await fs.mkdir(path.join(root, 'cpu-z', '1.0.1'), { recursive: true });
    await fs.writeFile(path.join(root, 'cpu_z', '1.0.0', 'files.json'), '{}');
    await fs.writeFile(path.join(root, 'cpu-z', '1.0.1', 'files.json'), '{}');
  });

  afterEach(async () => {
    await safeRemove(root);
  });

  it('把 merge App 的版本并入 keep App，删除重复的频道条目', async () => {
    const result = await repairDuplicateApp({
      root,
      keep: 'cpu_z',
      merge: 'cpu-z',
    });

    expect(result.movedVersions).toEqual(['1.0.1']);
    expect(result.appCount).toBe(1);
    expect(result.backupDir).not.toBeNull();

    const channel = parseChannelFile(await fs.readFile(path.join(root, 'channel.json'), 'utf8'));
    expect(channel.apps.map((item) => item.appId)).toEqual(['cpu_z']);
    expect(channel.apps[0]!.latest).toEqual({ windows: '1.0.1' });
    expect(channel.apps[0]!.metaUrl).toBe('cpu_z/app.meta.json');

    const meta = parseAppMetaFile(await fs.readFile(path.join(root, 'cpu_z', 'app.meta.json'), 'utf8'));
    expect(meta.versions.map((item) => item.version)).toEqual(['1.0.1', '1.0.0']);
    expect(meta.latest).toEqual({ windows: '1.0.1' });
    expect(await fs.readFile(path.join(root, 'cpu_z', '1.0.1', 'files.json'), 'utf8')).toBe('{}');
    await expect(fs.stat(path.join(root, 'cpu-z'))).rejects.toThrow();
    await expect(fs.stat(result.backupDir!)).resolves.toBeTruthy();
  });

  it('--dry-run 不修改文件，并拒绝同一版本冲突', async () => {
    const before = await fs.readFile(path.join(root, 'channel.json'), 'utf8');
    const dryRun = await repairDuplicateApp({
      root,
      keep: 'cpu_z',
      merge: 'cpu-z',
      dryRun: true,
    });
    expect(dryRun.dryRun).toBe(true);
    expect(await fs.readFile(path.join(root, 'channel.json'), 'utf8')).toBe(before);
    await expect(fs.stat(path.join(root, 'cpu-z', '1.0.1'))).resolves.toBeTruthy();

    // 两个 App 都声明 1.0.0 时，修复必须拒绝而不是覆盖已存在的版本目录。
    await fs.writeFile(
      path.join(root, 'cpu-z', 'app.meta.json'),
      JSON.stringify(appMeta('cpu-z', '1.0.0'), null, 2),
    );
    await fs.rm(path.join(root, 'cpu-z', '1.0.1'), { recursive: true, force: true });
    await fs.mkdir(path.join(root, 'cpu-z', '1.0.0'));
    await expect(
      repairDuplicateApp({ root, keep: 'cpu_z', merge: 'cpu-z' }),
    ).rejects.toThrow(/版本 1.0.0 同时存在/);
  });
});
