import { promises as fs } from 'node:fs';
import path from 'node:path';
import { expect } from 'vitest';
import { isAppError, type AppError, type ErrorCode } from '@apphub/protocol';

/**
 * 断言工具：错误码断言 / 临时目录文件查询。
 */

/** 断言 action 抛出 AppError 且错误码在 allowedCodes 内；返回该错误对象。 */
export async function expectAppError(
  action: () => Promise<unknown>,
  allowedCodes: readonly ErrorCode[],
): Promise<AppError> {
  let caught: unknown;
  try {
    await action();
  } catch (error) {
    caught = error;
  }
  if (caught === undefined) {
    throw new Error(`期望抛出 AppError（允许的错误码：${allowedCodes.join('/')}），但调用成功返回`);
  }
  if (!isAppError(caught)) {
    throw caught instanceof Error ? caught : new Error(String(caught));
  }
  expect(
    allowedCodes,
    `收到未预期的错误码 ${caught.code}：${caught.message}`,
  ).toContain(caught.code);
  return caught;
}

/** 递归列出目录下所有文件相对路径（POSIX，排序）；目录不存在返回 []。 */
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

/** 找到以指定 POSIX 后缀结尾的文件（绝对路径）。 */
export async function findFilesBySuffix(rootDir: string, suffix: string): Promise<string[]> {
  const normalized = suffix.replace(/\\/g, '/').replace(/^\/+/, '');
  return (await listFilesRecursive(rootDir))
    .filter((rel) => rel.endsWith(normalized))
    .map((rel) => path.join(rootDir, ...rel.split('/')));
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

/** 读取文件并返回 Buffer（不存在时抛错，便于断言"应该存在"）。 */
export async function readFileBuffer(filePath: string): Promise<Buffer> {
  return fs.readFile(filePath);
}
