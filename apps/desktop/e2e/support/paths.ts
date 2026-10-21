import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * E2E 运行时路径约定。
 *
 * 所有运行时产物都写在 `apps/desktop/e2e/.tmp/` 下（根 .gitignore 已忽略 `.tmp/`），
 * 每次 global-setup 开始时整体清空，避免脏状态影响测试结果。
 */

/** apps/desktop/e2e */
export const E2E_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** apps/desktop（Electron 应用根目录，package.json 的 main 指向 out/main/index.cjs） */
export const DESKTOP_DIR = path.dirname(E2E_DIR);

/** 运行时产物根目录（fixture、用户数据、报告）。 */
export const TMP_DIR = path.join(E2E_DIR, '.tmp');

/** global-setup 写入、各测试读取的 fixture 清单。 */
export const FIXTURE_FILE = path.join(TMP_DIR, 'fixture.json');

/** 预置频道仓库（静态服务器根目录，模拟 nginx 上的 app_repo）。 */
export const REPO_DIR = path.join(TMP_DIR, 'repo');

/** 每个测试独立 userData 目录的父目录（对应 APPHUB_USER_DATA_DIR）。 */
export const USER_DATA_ROOT = path.join(TMP_DIR, 'user-data');

/** Playwright 输出。 */
export const PLAYWRIGHT_REPORT_DIR = path.join(TMP_DIR, 'playwright-report');
export const TEST_RESULTS_DIR = path.join(TMP_DIR, 'test-results');

/** 应用构建产物（缺任何一个都说明没 build，E2E 无法启动）。 */
export const DESKTOP_MAIN_ENTRY = path.join(DESKTOP_DIR, 'out', 'main', 'index.cjs');
export const DESKTOP_RENDERER_ENTRY = path.join(DESKTOP_DIR, 'out', 'renderer', 'index.html');
