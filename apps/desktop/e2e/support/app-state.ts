import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * 直接读取磁盘上的"本地数据目录"来做断言。
 *
 * 目录约定来自 docs/ARCHITECTURE.md §4.2（属于稳定产品契约）：
 *   <userData>/library/<channelId>/<appId>/versions/<version>/<entry>
 *
 * 这里刻意**不**假设 install.json 的具体字段结构（该文件由 core 内部定义，
 * 单元测试覆盖即可）；E2E 只校验"磁盘上确实存在可运行版本且 size/MD5 与频道清单一致"，
 * 这样不会因为 core 内部字段微调而误报 E2E 失败。
 */

export function md5Hex(data: Buffer): string {
  return createHash('md5').update(data).digest('hex');
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

/** 递归列出目录下所有文件（POSIX 相对路径，排序）。目录不存在时返回 []。 */
export async function listFilesRecursive(rootDir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string, prefix: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), rel);
      else if (entry.isFile()) out.push(rel);
    }
  }
  await walk(rootDir, '');
  return out.sort();
}

/** 找到所有以给定 POSIX 路径后缀结尾的文件，返回绝对路径。 */
export async function findFilesBySuffix(rootDir: string, suffix: string): Promise<string[]> {
  const normalizedSuffix = suffix.replace(/\\/g, '/').replace(/^\/+/, '');
  const files = await listFilesRecursive(rootDir);
  return files
    .filter((rel) => rel.endsWith(normalizedSuffix))
    .map((rel) => path.join(rootDir, ...rel.split('/')));
}

export async function waitForCondition(
  condition: () => boolean | Promise<boolean>,
  message: string,
  timeoutMs = 60_000,
  intervalMs = 100,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return;
    if (Date.now() > deadline) {
      throw new Error(`等待超时（${timeoutMs}ms）：${message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export async function waitForPathMissing(target: string, timeoutMs = 60_000): Promise<void> {
  await waitForCondition(async () => !(await pathExists(target)), `路径应被删除但仍然存在：${target}`, timeoutMs);
}

export interface ExpectedInstalledVersion {
  channelId: string;
  appId: string;
  version: string;
  entry: string;
  files: { path: string; size: number; md5: string }[];
}

export interface InstalledLocation {
  /** .../library/<channelId>/<appId>/versions/<version> */
  versionDir: string;
  /** .../library/<channelId>/<appId> */
  appRoot: string;
  entryPath: string;
}

/**
 * 等待"本地库中出现完整可用版本"，并逐文件校验 size + MD5。
 * 返回版本目录绝对路径，供后续断言/清理校验使用。
 */
export async function waitForInstalledVersion(
  userDataDir: string,
  expected: ExpectedInstalledVersion,
  timeoutMs = 120_000,
): Promise<InstalledLocation> {
  const entrySuffix = `library/${expected.channelId}/${expected.appId}/versions/${expected.version}/${expected.entry}`;
  let location: InstalledLocation | undefined;

  await waitForCondition(
    async () => {
      const matches = await findFilesBySuffix(userDataDir, entrySuffix);
      const candidate = matches[0];
      if (!candidate) return false;
      const versionDir = path.dirname(candidate);
      const appRoot = path.dirname(path.dirname(versionDir));
      try {
        for (const file of expected.files) {
          const abs = path.join(versionDir, ...file.path.split('/'));
          const data = await fs.readFile(abs);
          if (data.length !== file.size) return false;
          if (md5Hex(data) !== file.md5) return false;
        }
      } catch {
        return false;
      }
      location = { versionDir, appRoot, entryPath: candidate };
      return true;
    },
    `本地库未出现预期版本 ${expected.version}（channelId=${expected.channelId}, appId=${expected.appId}）或内容校验失败`,
    timeoutMs,
  );

  return location as InstalledLocation;
}

/** 读取 v 目录下的 JSON 文件（容忍暂不存在 + 解析失败，返回 undefined）。 */
export async function tryReadJson<T = unknown>(filePath: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8')) as T;
  } catch {
    return undefined;
  }
}
