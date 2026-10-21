import { promises as fs } from 'node:fs';
import { buildFixtureRepo, type E2EFixtureManifest } from './support/fixture-repo';
import { FIXTURE_FILE, REPO_DIR, TMP_DIR, USER_DATA_ROOT } from './support/paths';
import { startStaticServer } from './support/static-server';

/**
 * Playwright globalSetup：准备一次 E2E 运行所需的全部前置资源。
 *
 *  1. 清空 e2e/.tmp（幂等：重复运行不会残留上一次的频道/用户数据）；
 *  2. 手工构造符合 docs/PROTOCOL.md 的频道仓库（channel.json / app.meta.json /
 *     files.json / 版本文件；size+MD5 真实计算），并附一个可写的 `_e2e_owned/`
 *     目录供"创建自有频道"场景使用；
 *  3. 启动进程内静态服务器（模拟 nginx）暴露该仓库；
 *  4. 把 { channelUrl, baseUrl, repoDir, ... } 写入 .tmp/fixture.json 供测试读取。
 *
 * 注意：globalSetup 与 test worker 是不同进程，但都在本次 Playwright 运行的生命周期内；
 * 静态服务器运行在 globalSetup 所属进程（runner 主进程）里，测试通过 127.0.0.1 访问，
 * globalTeardown 负责关闭（已验证可行）。
 */
export default async function globalSetup(): Promise<void> {
  const startedAt = Date.now();
  await fs.rm(TMP_DIR, { recursive: true, force: true, maxRetries: 3 });
  await fs.mkdir(TMP_DIR, { recursive: true });
  await fs.mkdir(USER_DATA_ROOT, { recursive: true });

  const skeleton = await buildFixtureRepo(REPO_DIR);

  const server = await startStaticServer(REPO_DIR);
  globalThis.__APPHUB_E2E_STATIC_SERVER__ = server;

  const channelUrl = new URL('channel.json', server.baseUrl).toString();
  const ownedPublicBaseUrl = new URL('_e2e_owned/', server.baseUrl).toString();

  // 自检：确保静态服务器确实能提供协议文件（失败则立即给出可读错误，避免 30 个用例全超时）
  const probe = await fetch(channelUrl);
  if (!probe.ok) {
    throw new Error(
      `E2E global-setup 自检失败：GET ${channelUrl} 返回 ${probe.status}。静态服务器根目录：${server.rootDir}`,
    );
  }
  const metaUrl = new URL(`${skeleton.appId}/app.meta.json`, server.baseUrl).toString();
  const metaProbe = await fetch(metaUrl);
  if (!metaProbe.ok) {
    throw new Error(`E2E global-setup 自检失败：GET ${metaUrl} 返回 ${metaProbe.status}`);
  }

  const manifest: E2EFixtureManifest = {
    ...skeleton,
    generatedAt: new Date().toISOString(),
    baseUrl: server.baseUrl,
    channelUrl,
    ownedPublicBaseUrl,
    repoDir: REPO_DIR,
  };
  await fs.writeFile(FIXTURE_FILE, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const elapsed = Date.now() - startedAt;
  console.log(
    [
      `[E2E global-setup] 频道仓库已就绪（${elapsed}ms）`,
      `[E2E global-setup] 静态服务器：${server.baseUrl}（根目录 ${REPO_DIR}）`,
      `[E2E global-setup] 订阅地址：${channelUrl}`,
      `[E2E global-setup] 预置 App：${skeleton.appId}@${skeleton.appVersion}（${skeleton.platform}，入口 ${skeleton.entry}，${skeleton.files.length} 个文件）`,
      `[E2E global-setup] fixture 清单：${FIXTURE_FILE}`,
    ].join('\n'),
  );
}
