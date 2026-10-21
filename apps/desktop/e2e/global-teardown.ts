import { promises as fs } from 'node:fs';
import { TMP_DIR } from './support/paths';

/**
 * Playwright globalTeardown：关闭 globalSetup 启动的静态服务器。
 *
 * 默认保留 `.tmp/` 下的产物（fixture 仓库、userData、Playwright 报告）便于排查；
 * 每次 globalSetup 开始时会整体清空，所以不会无限增长。
 * 设置 APPHUB_E2E_KEEP_USER_DATA=0 之外无需关心；如需立即清理可手动删除 apps/desktop/e2e/.tmp。
 */
export default async function globalTeardown(): Promise<void> {
  const server = globalThis.__APPHUB_E2E_STATIC_SERVER__;
  if (server) {
    await server.close().catch(() => undefined);
    globalThis.__APPHUB_E2E_STATIC_SERVER__ = undefined;
    console.log('[E2E global-teardown] 静态服务器已关闭');
  } else {
    console.log('[E2E global-teardown] 未找到静态服务器实例（globalSetup 可能失败或未运行）');
  }

  if (process.env.APPHUB_E2E_KEEP_TMP !== '0') {
    console.log(`[E2E global-teardown] 运行产物保留在：${TMP_DIR}（下次 setup 会清空）`);
  } else {
    await fs.rm(TMP_DIR, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
    console.log('[E2E global-teardown] 已按 APPHUB_E2E_KEEP_TMP=0 清理 .tmp');
  }
}
