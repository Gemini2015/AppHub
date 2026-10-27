/**
 * AppHub 全链路演示（无需 GUI、无需真实 FTP/nginx 服务器）。
 *
 * 运行：pnpm demo        （保留临时目录：pnpm demo -- --keep）
 *
 * 演示内容：
 *  1. 在进程内启动 FTP 服务器（模拟 vsftpd）+ 静态 HTTP 服务器（模拟 nginx）；
 *  2. 创建公开频道（存储 = ftp-http）；
 *  3. 发布 App（散文件模式）v1.0.0 / v1.0.1 / v1.0.2；
 *  4. 发布 App（zip 模式）；
 *  5. 以"另一台机器"的身份（独立 dataDir）通过 HTTP 订阅频道；
 *  6. 安装、更新（验证只下载变化文件）、校验、启动描述、卸载；
 *  7. 本机 Host（local-host）：内置 Host 托管本地目录 → 订阅 → 安装 → 启停验证；
 *  8. 结束时清理环境（--keep 保留临时目录便于查看产物）。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createAppHubCore, type AppHubCore, type CoreContext } from '@apphub/core';
import type { ChannelDetail } from '@apphub/core';
import { createStorageFactory } from '@apphub/storage';
import type { FtpHttpStorageConfig } from '@apphub/protocol';
import {
  createFakeSecretBox,
  createTempDir,
  getFreePort,
  safeRemove,
  startFtpTestServer,
  startStaticServer,
  writeFileTree,
  writeZip,
  fileMd5Hex,
  listFilesRecursive,
} from '@apphub/testkit';

const { values: args } = parseArgs({ options: { keep: { type: 'boolean', default: false } } });

function heading(title: string): void {
  console.log(`\n\x1b[36m━━ ${title} ━━\x1b[0m`);
}

function ok(message: string): void {
  console.log(`  \x1b[32m✔\x1b[0m ${message}`);
}

function info(message: string): void {
  console.log(`  \x1b[90m·\x1b[0m ${message}`);
}

function makeContext(dataDir: string): { core: AppHubCore } {
  const context: CoreContext = {
    dataDir,
    storageFactory: createStorageFactory(),
    secretBox: createFakeSecretBox(),
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: (message, meta) => console.warn(`  [warn] ${message}`, meta ?? ''),
      error: (message, meta) => console.error(`  [error] ${message}`, meta ?? ''),
    },
  };
  const core = createAppHubCore(context);
  return { core };
}

async function main(): Promise<void> {
  const root = await createTempDir('apphub-demo-');
  const repoDir = path.join(root, 'app_repo');
  await fs.mkdir(repoDir, { recursive: true });

  const staticServer = await startStaticServer(repoDir);
  const ftpServer = await startFtpTestServer({
    rootDir: repoDir,
    user: 'apphub',
    password: 'apphub-demo-password',
  });

  const storage: FtpHttpStorageConfig = {
    provider: 'ftp-http',
    ftp: {
      host: '127.0.0.1',
      port: ftpServer.port,
      secure: false,
      user: 'apphub',
      password: 'apphub-demo-password',
      rootDir: '',
      passive: true,
      timeoutMs: 20_000,
    },
    http: { baseUrl: staticServer.baseUrl },
  };

  let owner: AppHubCore | undefined;
  let subscriber: AppHubCore | undefined;

  try {
    heading('0. 环境已就绪（进程内 FTP + nginx 模拟）');
    info(`FTP:  ftp://127.0.0.1:${ftpServer.port}  root=${repoDir}`);
    info(`HTTP: ${staticServer.baseUrl}  root=${repoDir}`);
    info(`临时目录: ${root}`);

    const ownerCtx = makeContext(path.join(root, 'owner-data'));
    owner = ownerCtx.core;
    const subCtx = makeContext(path.join(root, 'subscriber-data'));
    subscriber = subCtx.core;

    // ---------------------------------------------------------------- 创建频道
    heading('1. 创建公开频道 example（FTP + nginx 存储）');
    const created: ChannelDetail = await owner.channels.create({
      name: 'example',
      description: 'AppHub 演示频道',
      visibility: 'public',
      owner: { name: 'Demo Owner' },
      storage,
    });
    ok(`频道已创建：${created.name} (${created.id})`);
    info(`订阅链接：${created.subscribeUrl}`);

    // ---------------------------------------------------------------- 发布 v1
    heading('2. 发布 foobar v1.0.0（散文件）');
    const srcDir = path.join(root, 'sources');
    const foobarV1 = path.join(srcDir, 'v1');
    await writeFileTree(foobarV1, [
      { path: 'foobar.exe', content: 'foobar v1.0.0 binary\n' },
      { path: 'resources/config.ini', content: 'version=1.0.0\n' },
    ]);
    const publishV1 = await owner.publishing.publish({
      channelId: created.id,
      app: { appId: 'foobar', displayName: 'FooBar', description: '演示 App', author: 'Demo' },
      version: '1.0.0',
      platform: 'windows',
      publishMode: 'files',
      entry: 'foobar.exe',
      changelog: '首个版本',
      files: [
        { sourcePath: path.join(foobarV1, 'foobar.exe'), targetPath: 'foobar.exe', executable: true },
        { sourcePath: path.join(foobarV1, 'resources', 'config.ini'), targetPath: 'resources/config.ini' },
      ],
      onProgress: (event) => {
        if (event.phase === 'commit') info(`发布进度：${event.message ?? ''}`);
      },
    });
    ok(`发布成功：${publishV1.appId}@${publishV1.version}，${publishV1.fileCount} 个文件 / ${publishV1.totalSize} 字节`);
    info(`app.meta.json → ${publishV1.metaUrl}`);

    // ---------------------------------------------------------------- 订阅 + 安装
    heading('3. 以订阅者身份（独立数据目录）通过 HTTP 订阅频道');
    const subscribed = await subscriber.channels.subscribe({ url: created.subscribeUrl });
    ok(`订阅成功：${subscribed.name}，App 数量 ${subscribed.apps.length}`);
    const appSummary = subscribed.apps.find((app) => app.appId === 'foobar');
    if (!appSummary) throw new Error('订阅后未找到 foobar');
    info(`发现 App：${appSummary.displayName}，latest=${JSON.stringify(appSummary.latest)}`);

    heading('4. 安装 foobar v1.0.0 并校验');
    const installV1 = await subscriber.library.install({ channelId: created.id, appId: 'foobar' });
    ok(`安装完成：${installV1.app.displayName}@${installV1.app.version} → ${installV1.app.installPath}`);
    const verifyV1 = await subscriber.library.verify(created.id, 'foobar');
    if (!verifyV1.ok) throw new Error(`安装校验失败：${JSON.stringify(verifyV1.mismatches)}`);
    ok(`校验通过（${verifyV1.checkedFiles} 个文件 size+MD5 一致）`);

    // ---------------------------------------------------------------- 发布 v2（更新）
    heading('5. 发布 foobar v1.0.1 / v1.0.2（散文件增量更新）');
    const foobarV2 = path.join(srcDir, 'v2');
    await writeFileTree(foobarV2, [
      { path: 'foobar.exe', content: 'foobar v1.0.2 binary with fixes\n' },
      { path: 'resources/config.ini', content: 'version=1.0.0\n' },
    ]);
    // 先发布 1.0.1（仅 exe 变化），再发布 1.0.2（新增文件），演示差量下载
    await owner.publishing.publish({
      channelId: created.id,
      app: { appId: 'foobar', displayName: 'FooBar', description: '演示 App', author: 'Demo' },
      version: '1.0.1',
      platform: 'windows',
      publishMode: 'files',
      entry: 'foobar.exe',
      changelog: '修复问题',
      files: [
        { sourcePath: path.join(foobarV2, 'foobar.exe'), targetPath: 'foobar.exe', executable: true },
        { sourcePath: path.join(foobarV2, 'resources', 'config.ini'), targetPath: 'resources/config.ini' },
      ],
    });
    await writeFileTree(path.join(srcDir, 'v3'), [
      { path: 'foobar.exe', content: 'foobar v1.0.2 binary with fixes\n' },
      { path: 'resources/config.ini', content: 'version=1.0.0\n' },
      { path: 'resources/new.dat', content: 'new file in 1.0.2\n' },
    ]);
    await owner.publishing.publish({
      channelId: created.id,
      app: { appId: 'foobar', displayName: 'FooBar', description: '演示 App', author: 'Demo' },
      version: '1.0.2',
      platform: 'windows',
      publishMode: 'files',
      entry: 'foobar.exe',
      changelog: '新增资源文件',
      files: [
        { sourcePath: path.join(srcDir, 'v3', 'foobar.exe'), targetPath: 'foobar.exe', executable: true },
        { sourcePath: path.join(srcDir, 'v3', 'resources', 'config.ini'), targetPath: 'resources/config.ini' },
        { sourcePath: path.join(srcDir, 'v3', 'resources', 'new.dat'), targetPath: 'resources/new.dat' },
      ],
    });
    ok('已发布 1.0.1 / 1.0.2');

    const updates = await subscriber.library.checkUpdates();
    const foobarUpdate = updates.find((item) => item.appId === 'foobar');
    if (!foobarUpdate?.updateAvailable) throw new Error('未检测到 foobar 更新');
    ok(`检测到更新：${foobarUpdate.currentVersion} → ${foobarUpdate.latestVersion}`);

    const downloaded: number[] = [];
    const updateResult = await subscriber.library.update({
      channelId: created.id,
      appId: 'foobar',
      onProgress: (event) => {
        if (event.phase === 'transfer' && event.transferredBytes !== undefined) {
          downloaded.push(event.transferredBytes);
        }
      },
    });
    ok(
      `更新完成：${updateResult.updatedFrom} → ${updateResult.app.version}；` +
        `下载 ${updateResult.downloadedBytes} 字节，复用 ${updateResult.reusedBytes} 字节`,
    );
    const verifyV2 = await subscriber.library.verify(created.id, 'foobar');
    if (!verifyV2.ok) throw new Error('更新后校验失败');
    ok('更新后校验通过');
    const launch = await subscriber.library.getLaunchDescriptor(created.id, 'foobar');
    ok(`启动入口：${launch.entryPath}`);

    // ---------------------------------------------------------------- zip App
    heading('6. 发布 zip 模式 App（packtool v1.0.0）并安装');
    const zipPath = path.join(srcDir, 'packtool-1.0.0.zip');
    await writeZip(zipPath, {
      'packtool.exe': 'packtool v1.0.0 binary\n',
      'data/tool.dat': 'zip packaged data\n',
    });
    const publishZip = await owner.publishing.publish({
      channelId: created.id,
      app: { appId: 'packtool', displayName: 'PackTool', description: 'zip 发布的演示 App', author: 'Demo' },
      version: '1.0.0',
      platform: 'windows',
      publishMode: 'zip',
      entry: 'packtool.exe',
      changelog: 'zip 首个版本',
      zipPath,
    });
    ok(`zip 发布成功：${publishZip.fileCount} 个内部文件，压缩包 ${publishZip.archive?.size ?? 0} 字节`);

    await subscriber.channels.refresh(created.id);
    const zipInstall = await subscriber.library.install({ channelId: created.id, appId: 'packtool' });
    ok(`安装成功：${zipInstall.app.displayName}@${zipInstall.app.version}`);
    const zipVerify = await subscriber.library.verify(created.id, 'packtool');
    if (!zipVerify.ok) throw new Error('zip App 校验失败');
    const installedFiles = await listFilesRecursive(zipInstall.app.installPath);
    ok(`zip 解压文件：${installedFiles.join(', ')}`);

    // ---------------------------------------------------------------- 本机 Host
    heading('7. 本机 Host（local-host）：无需外部服务器的频道分享');
    const hostRepoDir = path.join(root, 'host_repo');
    await fs.mkdir(hostRepoDir, { recursive: true });
    const hostPort = await getFreePort();
    const hostChannel: ChannelDetail = await owner.channels.create({
      name: 'local-host-demo',
      description: 'AppHub 内置 Host 演示频道',
      visibility: 'public',
      owner: { name: 'Demo Owner' },
      storage: {
        provider: 'local-host',
        rootDir: hostRepoDir,
        port: hostPort,
        bindHost: '0.0.0.0',
        advertiseHost: '127.0.0.1',
      },
    });
    const hostStarted = await owner.host.start(hostChannel.id);
    ok(`Host 已启动：${hostStarted.urls.channelUrl}`);
    info(`监听范围：${hostStarted.bindHost}:${hostStarted.port}（默认局域网可访问，演示固定 127.0.0.1 便于验证）`);

    const hostAppDir = path.join(srcDir, 'hostapp');
    await writeFileTree(hostAppDir, [
      { path: 'hostapp.exe', content: 'hostapp v1.0.0 binary\n' },
      { path: 'readme.txt', content: 'served by AppHub built-in host\n' },
    ]);
    await owner.publishing.publish({
      channelId: hostChannel.id,
      app: { appId: 'hostapp', displayName: 'HostApp', description: '由本机 Host 提供下载', author: 'Demo' },
      version: '1.0.0',
      platform: 'windows',
      publishMode: 'files',
      entry: 'hostapp.exe',
      changelog: '本机 Host 首个版本',
      files: [
        { sourcePath: path.join(hostAppDir, 'hostapp.exe'), targetPath: 'hostapp.exe', executable: true },
        { sourcePath: path.join(hostAppDir, 'readme.txt'), targetPath: 'readme.txt' },
      ],
    });
    await subscriber.channels.subscribe({ url: hostStarted.urls.channelUrl });
    const hostInstall = await subscriber.library.install({ channelId: hostChannel.id, appId: 'hostapp' });
    ok(`订阅者经内置 Host 安装成功：${hostInstall.app.displayName}@${hostInstall.app.version}`);
    const hostVerify = await subscriber.library.verify(hostChannel.id, 'hostapp');
    if (!hostVerify.ok) throw new Error('本机 Host App 校验失败');

    const stopped = await owner.host.stop(hostChannel.id);
    let reachableAfterStop = true;
    try {
      const response = await fetch(stopped.urls.channelUrl, { signal: AbortSignal.timeout(3000) });
      reachableAfterStop = response.ok;
    } catch {
      reachableAfterStop = false;
    }
    if (reachableAfterStop) throw new Error('停止 Host 后订阅链接仍可访问（端口可能未释放）');
    ok('停止 Host 后端口已释放，订阅链接不可访问（符合预期）');

    const restarted = await owner.host.start(hostChannel.id);
    const restartedResponse = await fetch(restarted.urls.channelUrl, { signal: AbortSignal.timeout(3000) });
    if (!restartedResponse.ok) {
      throw new Error(`重新启动 Host 后订阅链接不可用：HTTP ${restartedResponse.status}`);
    }
    ok('重新启动 Host 后订阅链接恢复可访问');
    await owner.host.stop(hostChannel.id);

    // ---------------------------------------------------------------- 汇总
    heading('8. 本地库与卸载');
    const library = await subscriber.library.list();
    info(`已安装 ${library.length} 个 App：${library.map((app) => `${app.displayName}@${app.version}`).join(', ')}`);
    await subscriber.library.uninstall(created.id, 'packtool');
    const afterUninstall = await subscriber.library.list();
    ok(`卸载 packtool 成功，剩余 ${afterUninstall.length} 个 App`);

    const metaStat = await fileMd5Hex(path.join(repoDir, 'foobar', 'app.meta.json'));
    info(`远端 app.meta.json MD5=${metaStat.md5}`);
    info(`远端目录：${repoDir}`);

    heading('演示完成 ✅');
    console.log(`
  结果概览：
    · 频道: example (${created.id})（ftp-http）
    · 频道: local-host-demo (${hostChannel.id})（AppHub 内置 Host）
    · App: foobar（散文件，1.0.0→1.0.1→1.0.2，差量更新）
    · App: packtool（zip 发布、安装、卸载）
    · App: hostapp（本机 Host 托管、订阅安装、启停验证）
    · 订阅者本地库: ${afterUninstall.length} 个 App
    · 产物目录: ${repoDir}
`);
  } finally {
    await owner?.close().catch(() => undefined);
    await subscriber?.close().catch(() => undefined);
    await ftpServer.close().catch(() => undefined);
    await staticServer.close().catch(() => undefined);
    if (args.keep) {
      console.log(`\n已保留临时目录：${root}`);
    } else {
      await safeRemove(root);
    }
  }
}

main().catch((error) => {
  console.error('\n\x1b[31m演示失败：\x1b[0m', error);
  process.exitCode = 1;
});
