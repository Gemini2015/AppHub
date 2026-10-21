import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * 手工构造一个**符合 docs/PROTOCOL.md** 的频道仓库，供 Electron E2E 使用。
 *
 * 设计取舍：
 *  - 不用 core/storage 生成 fixture：E2E 的职责是"客户端能否消费一个真实存在的频道仓库"，
 *    而不是回归发布端实现（发布端由 tests/integration 与 packages/core 单测覆盖）。
 *    手工构造让 E2E 在 core 尚未完成时也能独立推进，且仓库内容完全可断言。
 *  - 不使用 testkit：见 support/static-server.ts 顶部说明。
 *  - 文件清单（size + MD5）在构造时真实计算，客户端安装校验走的是真实数据。
 */

export type FixturePlatform = 'windows' | 'linux' | 'mac';

export interface FixtureFileEntry {
  path: string;
  size: number;
  md5: string;
  executable?: boolean;
}

/** buildFixtureRepo 的返回值（fixture.json 的基础部分）。 */
export interface FixtureRepoSkeleton {
  channelId: string;
  channelName: string;
  channelDescription: string;
  appId: string;
  appName: string;
  appDisplayName: string;
  appDescription: string;
  appVersion: string;
  platform: FixturePlatform;
  entry: string;
  /** 版本内全部文件（path/size/md5），安装后用于校验本地库。 */
  files: FixtureFileEntry[];
  /** 可用于「新建自有频道」的本地目录（位于静态服务器根目录内，可写）。 */
  ownedRepoDir: string;
}

/** 完整 fixture 清单：global-setup 写入 .tmp/fixture.json，测试通过 loadFixture() 读取。 */
export interface E2EFixtureManifest extends FixtureRepoSkeleton {
  generatedAt: string;
  /** 静态服务器根地址，例如 http://127.0.0.1:53211/ */
  baseUrl: string;
  /** 预置 public 频道的 channel.json 订阅地址。 */
  channelUrl: string;
  /** 自有频道可用的 publicBaseUrl（指向服务器根目录下的 _e2e_owned/）。 */
  ownedPublicBaseUrl: string;
  repoDir: string;
}

/** 固定频道 ID（形如 ch_ + 20 位小写十六进制，满足 CHANNEL_ID_PATTERN）。 */
export const FIXTURE_CHANNEL_ID = 'ch_0123456789abcdef0123';
export const FIXTURE_CHANNEL_NAME = 'E2E 预置频道';
export const FIXTURE_APP_ID = 'hello-app';
export const FIXTURE_APP_DISPLAY_NAME = 'Hello App';
export const FIXTURE_APP_VERSION = '1.0.0';
export const FIXTURE_CHANGELOG = 'E2E 预置版本：用于订阅 → 安装 → 校验 → 卸载链路';

const CREATED_AT = '2026-01-01T00:00:00.000Z';
const UPDATED_AT = '2026-01-02T00:00:00.000Z';
const PUBLISHED_AT = '2026-01-02T00:00:00.000Z';

export function detectFixturePlatform(): FixturePlatform {
  switch (process.platform) {
    case 'win32':
      return 'windows';
    case 'darwin':
      return 'mac';
    default:
      return 'linux';
  }
}

/** 当前平台对应的启动入口文件名（在 Windows 上不给 .sh，避免 UI 误判不可运行）。 */
export function fixtureEntryName(platform: FixturePlatform): string {
  return platform === 'windows' ? 'hello-app.cmd' : 'hello-app.sh';
}

function md5Hex(data: Buffer | string): string {
  return createHash('md5').update(data).digest('hex');
}

interface FixturePayloadFile {
  path: string;
  content: Buffer;
  executable: boolean;
}

function buildPayloadFiles(platform: FixturePlatform, entry: string): FixturePayloadFile[] {
  const entryContent =
    platform === 'windows'
      ? '@echo off\r\necho Hello from AppHub E2E fixture\r\n'
      : '#!/bin/sh\necho "Hello from AppHub E2E fixture"\n';
  return [
    { path: entry, content: Buffer.from(entryContent, 'utf8'), executable: platform !== 'windows' },
    { path: 'hello.txt', content: Buffer.from('Hello AppHub\n', 'utf8'), executable: false },
    {
      path: 'resources/config.ini',
      content: Buffer.from('[app]\nname=Hello App\nversion=1.0.0\nmode=e2e\n', 'utf8'),
      executable: false,
    },
    {
      // 嵌套目录 + Unicode 文件名：覆盖 URL 编码/路径规范化
      path: 'resources/数据/说明.txt',
      content: Buffer.from('E2E 预置数据文件：用于校验嵌套目录与 Unicode 路径。\n', 'utf8'),
      executable: false,
    },
  ];
}

async function writeJson(targetPath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function writeBuffer(targetPath: string, data: Buffer): Promise<void> {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, data);
}

/**
 * 在 repoDir 下构造频道仓库：
 *
 * ```
 * repo/
 *   channel.json
 *   hello-app/app.meta.json
 *   hello-app/1.0.0/files.json
 *   hello-app/1.0.0/<entry> hello.txt resources/...
 *   _e2e_owned/            # 供 E2E 创建「自有频道」时写本地目录
 * ```
 */
export async function buildFixtureRepo(repoDir: string): Promise<FixtureRepoSkeleton> {
  const platform = detectFixturePlatform();
  const entry = fixtureEntryName(platform);
  const payload = buildPayloadFiles(platform, entry);

  const versionDir = path.join(repoDir, FIXTURE_APP_ID, FIXTURE_APP_VERSION);
  const files: FixtureFileEntry[] = [];
  for (const file of payload) {
    await writeBuffer(path.join(versionDir, ...file.path.split('/')), file.content);
    files.push({
      path: file.path,
      size: file.content.length,
      md5: md5Hex(file.content),
      ...(file.executable ? { executable: true } : {}),
    });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));

  const totalSize = files.reduce((sum, file) => sum + file.size, 0);

  const filesJson = {
    schemaVersion: 1,
    kind: 'apphub-files',
    appId: FIXTURE_APP_ID,
    channelId: FIXTURE_CHANNEL_ID,
    version: FIXTURE_APP_VERSION,
    platform,
    publishMode: 'files',
    entry,
    totalSize,
    fileCount: files.length,
    files,
    archive: null,
    generatedAt: PUBLISHED_AT,
  };
  await writeJson(path.join(versionDir, 'files.json'), filesJson);

  const appMeta = {
    schemaVersion: 1,
    kind: 'apphub-app-meta',
    appId: FIXTURE_APP_ID,
    channelId: FIXTURE_CHANNEL_ID,
    name: FIXTURE_APP_ID,
    displayName: FIXTURE_APP_DISPLAY_NAME,
    description: 'E2E 预置示例 App（由 apps/desktop/e2e/global-setup.ts 生成）',
    author: 'AppHub QA',
    publishMode: 'files',
    entry,
    platforms: [platform],
    latest: { [platform]: FIXTURE_APP_VERSION },
    versions: [
      {
        version: FIXTURE_APP_VERSION,
        platform,
        publishMode: 'files',
        entry,
        publishedAt: PUBLISHED_AT,
        changelog: FIXTURE_CHANGELOG,
        totalSize,
        fileCount: files.length,
        filesUrl: `${FIXTURE_APP_VERSION}/files.json`,
        downloadBaseUrl: `${FIXTURE_APP_VERSION}/`,
        files,
        archive: null,
      },
    ],
    updatedAt: UPDATED_AT,
  };
  await writeJson(path.join(repoDir, FIXTURE_APP_ID, 'app.meta.json'), appMeta);

  const channelJson = {
    schemaVersion: 1,
    kind: 'apphub-channel',
    id: FIXTURE_CHANNEL_ID,
    name: FIXTURE_CHANNEL_NAME,
    description: 'Playwright E2E 预置频道（离线静态服务器提供，模拟 nginx 上的 app_repo）',
    visibility: 'public',
    owner: { name: 'AppHub QA', contact: 'qa@example.com' },
    apps: [
      {
        appId: FIXTURE_APP_ID,
        name: FIXTURE_APP_ID,
        displayName: FIXTURE_APP_DISPLAY_NAME,
        description: 'E2E 预置示例 App',
        author: 'AppHub QA',
        entry,
        platforms: [platform],
        publishMode: 'files',
        latest: { [platform]: FIXTURE_APP_VERSION },
        metaUrl: `${FIXTURE_APP_ID}/app.meta.json`,
        updatedAt: UPDATED_AT,
      },
    ],
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
  };
  await writeJson(path.join(repoDir, 'channel.json'), channelJson);

  const ownedRepoDir = path.join(repoDir, '_e2e_owned');
  await fs.mkdir(ownedRepoDir, { recursive: true });

  return {
    channelId: FIXTURE_CHANNEL_ID,
    channelName: FIXTURE_CHANNEL_NAME,
    channelDescription: channelJson.description,
    appId: FIXTURE_APP_ID,
    appName: FIXTURE_APP_ID,
    appDisplayName: FIXTURE_APP_DISPLAY_NAME,
    appDescription: appMeta.description,
    appVersion: FIXTURE_APP_VERSION,
    platform,
    entry,
    files,
    ownedRepoDir,
  };
}
