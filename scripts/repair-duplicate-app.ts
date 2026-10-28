#!/usr/bin/env node
/**
 * 修复历史遗留的"发布新版本变成新 App"数据。
 *
 * 背景：v0.1.0 的发布向导在"发布新版本"时没有把原 App 的 appId 传给主进程，
 * 主进程按 displayName 重新 slugify；当 displayName 与 appId 不一致时
 * （例如 appId=cpu_z、displayName=CPU-Z），会生成 cpu-z 这个新 App。
 *
 * 本脚本把一个误生成 App（--merge）的版本合并回原 App（--keep），并更新
 * 频道 app 列表；channels 仓库需在本机文件系统中，运行前请先停止该频道的 Host。
 *
 * 用法：
 *   pnpm repair:duplicate-app -- --root "D:\AppHubData\channels\某频道仓库" --keep cpu_z --merge cpu-z
 *   加 --dry-run 只打印计划、不写文件。
 *
 * 安全措施：先备份 channel.json / 两个 app.meta.json，再移动版本目录，最后写元信息；
 * 任何一步失败会尽力回滚已移动的版本目录。
 */
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import {
  assertAppId,
  compareVersions,
  maxVersion,
  parseAppMetaFile,
  parseChannelFile,
} from '@apphub/protocol';
import type { AppMetaFile, ChannelFile, ChannelAppRef } from '@apphub/protocol';

export interface RepairOptions {
  root: string;
  keep: string;
  merge: string;
  dryRun?: boolean;
}

export interface RepairResult {
  channelFile: string;
  backupDir: string | null;
  movedVersions: string[];
  keepAppId: string;
  mergedAppId: string;
  appCount: number;
  dryRun: boolean;
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await fs.readFile(file, 'utf8')) as T;
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const tmp = `${file}.repair-${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  try {
    await fs.rename(tmp, file);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EPERM' && code !== 'EEXIST') throw error;
    // Windows 上目标存在时 rename 可能失败：先删目标再 rename（已提前备份）。
    await fs.rm(file, { force: true });
    await fs.rename(tmp, file);
  }
}

function mergeLatest(keep: AppMetaFile, merge: AppMetaFile, versions: AppMetaFile['versions']): Record<string, string> {
  const latest: Record<string, string> = { ...keep.latest, ...merge.latest };
  for (const platform of new Set(versions.map((item) => item.platform))) {
    const candidates = versions.filter((item) => item.platform === platform).map((item) => item.version);
    const max = maxVersion(candidates);
    if (max) latest[platform] = max;
  }
  return latest;
}

function toChannelRef(meta: AppMetaFile, metaUrl: string): ChannelAppRef {
  return {
    appId: meta.appId,
    name: meta.name,
    displayName: meta.displayName,
    description: meta.description,
    author: meta.author,
    entry: meta.entry,
    platforms: meta.platforms,
    publishMode: meta.publishMode,
    latest: meta.latest,
    metaUrl,
    ...(meta.iconUrl ? { iconUrl: meta.iconUrl } : {}),
    updatedAt: meta.updatedAt,
  };
}

/** 合并两个 appId（把 merge 的版本并入 keep），成功后返回摘要。 */
export async function repairDuplicateApp(options: RepairOptions): Promise<RepairResult> {
  const root = path.resolve(options.root);
  const keepAppId = assertAppId(options.keep);
  const mergeAppId = assertAppId(options.merge);
  if (keepAppId === mergeAppId) throw new Error('--keep 与 --merge 不能相同');

  const channelFile = path.join(root, 'channel.json');
  if (!existsSync(channelFile)) throw new Error(`未找到频道文件：${channelFile}`);

  const keepMetaFile = path.join(root, keepAppId, 'app.meta.json');
  const mergeMetaFile = path.join(root, mergeAppId, 'app.meta.json');
  const keepDir = path.join(root, keepAppId);
  const mergeDir = path.join(root, mergeAppId);
  const channel = parseChannelFile(await fs.readFile(channelFile, 'utf8'));
  const keepMeta = parseAppMetaFile(await fs.readFile(keepMetaFile, 'utf8'));
  const mergeMeta = parseAppMetaFile(await fs.readFile(mergeMetaFile, 'utf8'));
  if (keepMeta.appId !== keepAppId) throw new Error(`keep app.meta.json 的 appId 不是 ${keepAppId}`);
  if (mergeMeta.appId !== mergeAppId) throw new Error(`merge app.meta.json 的 appId 不是 ${mergeAppId}`);
  if (!channel.apps.some((item) => item.appId === keepAppId)) {
    throw new Error(`channel.json 中没有 App：${keepAppId}`);
  }
  if (!channel.apps.some((item) => item.appId === mergeAppId)) {
    throw new Error(`channel.json 中没有 App：${mergeAppId}`);
  }

  const existingVersions = new Set(keepMeta.versions.map((item) => item.version));
  const movedVersions: string[] = [];
  for (const version of mergeMeta.versions) {
    if (existingVersions.has(version.version)) {
      throw new Error(`版本 ${version.version} 同时存在于两个 App，请先人工处理冲突后再运行`);
    }
    const sourceDir = path.join(mergeDir, version.version);
    const targetDir = path.join(keepDir, version.version);
    if (!existsSync(sourceDir)) throw new Error(`merge App 缺少版本目录：${sourceDir}`);
    if (existsSync(targetDir)) throw new Error(`keep App 已存在版本目录：${targetDir}`);
  }

  const allVersions = [...keepMeta.versions, ...mergeMeta.versions].sort((a, b) =>
    compareVersions(b.version, a.version),
  );
  const mergedMeta: AppMetaFile = {
    ...keepMeta,
    versions: allVersions,
    latest: mergeLatest(keepMeta, mergeMeta, allVersions),
    platforms: [...new Set([...keepMeta.platforms, ...mergeMeta.platforms])],
    updatedAt: new Date().toISOString(),
  };
  const nextApps = channel.apps
    .filter((item) => item.appId !== mergeAppId)
    .map((item) =>
      // 替换 keep 的引用（filter 后索引可能变化，用 appId 判断更稳）
      item.appId === keepAppId ? toChannelRef(mergedMeta, `${keepAppId}/app.meta.json`) : item,
    );
  const nextChannel: ChannelFile = {
    ...channel,
    apps: nextApps,
    updatedAt: new Date().toISOString(),
  };

  if (options.dryRun) {
    return {
      channelFile,
      backupDir: null,
      movedVersions: mergeMeta.versions.map((item) => item.version),
      keepAppId,
      mergedAppId: mergeAppId,
      appCount: nextChannel.apps.length,
      dryRun: true,
    };
  }

  const backupDir = path.join(root, `.repair-backup-${timestamp()}`);
  await fs.mkdir(backupDir, { recursive: true });
  await fs.copyFile(channelFile, path.join(backupDir, 'channel.json'));
  await fs.copyFile(keepMetaFile, path.join(backupDir, `${keepAppId}-app.meta.json`));
  await fs.copyFile(mergeMetaFile, path.join(backupDir, `${mergeAppId}-app.meta.json`));

  try {
    for (const version of mergeMeta.versions) {
      const sourceDir = path.join(mergeDir, version.version);
      const targetDir = path.join(keepDir, version.version);
      await fs.rename(sourceDir, targetDir);
      movedVersions.push(version.version);
    }
    await writeJsonAtomic(keepMetaFile, mergedMeta);
    await writeJsonAtomic(channelFile, nextChannel);
  } catch (error) {
    for (const version of movedVersions.reverse()) {
      const from = path.join(keepDir, version);
      const to = path.join(mergeDir, version);
      await fs.rename(from, to).catch(() => undefined);
    }
    throw error;
  }

  // 保留 merge App 的元信息备份，移除剩余空壳目录（版本文件已移走）。
  await fs.rm(mergeDir, { recursive: true, force: true }).catch(() => undefined);

  return {
    channelFile,
    backupDir,
    movedVersions,
    keepAppId,
    mergedAppId: mergeAppId,
    appCount: nextChannel.apps.length,
    dryRun: false,
  };
}

function printUsage(): void {
  console.log(
    '用法: pnpm repair:duplicate-app -- --root <频道仓库目录> --keep <保留的 appId> --merge <误生成的 appId> [--dry-run]',
  );
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      root: { type: 'string' },
      keep: { type: 'string' },
      merge: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
    },
  });
  if (!values.root || !values.keep || !values.merge) {
    printUsage();
    process.exitCode = 1;
    return;
  }
  const result = await repairDuplicateApp({
    root: values.root,
    keep: values.keep,
    merge: values.merge,
    dryRun: values['dry-run'],
  });
  console.log(
    `${result.dryRun ? '[dry-run] ' : ''}已合并 ${result.mergedAppId} → ${result.keepAppId}，移动版本：${result.movedVersions.join(', ') || '无'}`,
  );
  console.log(`频道 App 数量：${result.appCount}`);
  if (result.backupDir) console.log(`备份目录：${result.backupDir}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`[repair] 失败：${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
