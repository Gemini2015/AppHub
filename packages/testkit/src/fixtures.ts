import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { zipSync, type Zippable } from 'fflate';

export interface FixtureFile {
  path: string;
  content: string | Buffer;
  mode?: number;
}

/** 递归写入文件树（自动创建目录）。 */
export async function writeFileTree(rootDir: string, files: readonly FixtureFile[]): Promise<void> {
  for (const file of files) {
    const target = path.join(rootDir, ...file.path.split('/'));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, file.content);
  }
}

/** 生成 ZIP Buffer（key 为压缩包内相对路径）。 */
export function makeZipBuffer(files: Record<string, string | Buffer>): Buffer {
  const zippable: Zippable = {};
  for (const [name, content] of Object.entries(files)) {
    zippable[name] = typeof content === 'string' ? new TextEncoder().encode(content) : new Uint8Array(content);
  }
  return Buffer.from(zipSync(zippable));
}

/** 生成 ZIP 文件。 */
export async function writeZip(
  targetPath: string,
  files: Record<string, string | Buffer>,
): Promise<void> {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, makeZipBuffer(files));
}

/** 计算 Buffer 的 MD5（hex）。 */
export function md5Hex(data: Buffer | string): string {
  return createHash('md5').update(data).digest('hex');
}

/** 计算文件的 MD5（hex）与大小。 */
export async function fileMd5Hex(filePath: string): Promise<{ md5: string; size: number }> {
  const data = await fs.readFile(filePath);
  return { md5: md5Hex(data), size: data.length };
}

/** 读取 JSON 文件（测试断言辅助）。 */
export async function readJsonFile<T = unknown>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, 'utf8')) as T;
}

/** 判断路径是否存在。 */
export async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

/** 递归列出目录下所有文件（POSIX 相对路径，排序）。 */
export async function listFilesRecursive(rootDir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string, prefix: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), rel);
      else if (entry.isFile()) out.push(rel);
    }
  }
  await walk(rootDir, '');
  return out.sort();
}
