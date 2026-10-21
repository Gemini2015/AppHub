import { readFileSync } from 'node:fs';
import type { E2EFixtureManifest } from './fixture-repo';
import { FIXTURE_FILE } from './paths';

/**
 * 读取 global-setup 生成的 fixture 清单。
 *
 * 为什么通过文件而不是环境变量传递：Playwright 的 globalSetup 与 test worker
 * 之间没有共享的 process.env 契约（globalSetup 里改 env 的行为未文档化），
 * 落盘 JSON 是最稳的跨进程传递方式。
 */

let cached: E2EFixtureManifest | undefined;

export function loadFixture(): E2EFixtureManifest {
  if (cached) return cached;
  try {
    cached = JSON.parse(readFileSync(FIXTURE_FILE, 'utf8')) as E2EFixtureManifest;
  } catch (error) {
    throw new Error(
      [
        `未找到 E2E fixture 清单：${FIXTURE_FILE}`,
        'E2E 必须通过 global-setup 启动（它会生成仓库 + 静态服务器 + fixture.json）。',
        '推荐命令：pnpm --filter @apphub/desktop test:e2e',
        `原始错误：${error instanceof Error ? error.message : String(error)}`,
      ].join('\n'),
    );
  }
  return cached;
}
