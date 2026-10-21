import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** 创建临时目录；调用方负责清理（或用 withTempDir）。 */
export async function createTempDir(prefix = 'apphub-test-'): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

/** 创建临时目录并在回调结束后自动删除。 */
export async function withTempDir<T>(fn: (dir: string) => Promise<T>, prefix?: string): Promise<T> {
  const dir = await createTempDir(prefix);
  try {
    return await fn(dir);
  } finally {
    await safeRemove(dir);
  }
}

/** 删除目录，忽略不存在错误。 */
export async function safeRemove(target: string): Promise<void> {
  await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
}
