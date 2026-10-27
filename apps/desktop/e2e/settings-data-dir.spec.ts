import { promises as fs } from 'node:fs';
import path from 'node:path';
import { getSystemInfo, listChannels } from './support/app-api';
import { launchApp } from './support/electron-app';
import { TMP_DIR } from './support/paths';
import { expect, test } from './support/test-fixtures';
import { TESTID, TIMEOUTS, waitForShell } from './support/ui';

/**
 * Phase 6/7：设置页「数据目录」E2E。
 *
 * Phase 7 语义：
 *  - 默认 AppHub 数据目录 = `<Electron userData>/AppHubData`（与 Chromium 缓存隔离）；
 *  - `APPHUB_DATA_DIR`：只改 AppHub 数据目录，不改 Electron userData；source=env、editable=false；
 *  - `APPHUB_USER_DATA_DIR`：历史语义，整体覆盖 Electron userData，AppHub 数据直接位于该目录根；
 *  - 旧版数据（直接位于 userData 根）启动时自动 move 到 `AppHubData`。
 *
 * 覆盖方式（均只验证启动期行为，不点击「更改数据目录」）：
 *  1. env（APPHUB_USER_DATA_DIR，E2E 默认隔离）；
 *  2. env（APPHUB_DATA_DIR；用 `--user-data-dir` 隔离 Electron userData、不设 APPHUB_USER_DATA_DIR）；
 *  3. default（--user-data-dir 隔离、无 env）；
 *  4. custom（隔离 userData 下预置 `apphub-bootstrap.json`）；
 *  5. 旧版迁移（隔离 userData 根预置 Phase6 数据结构，启动后应移动到 AppHubData）。
 *
 * 为什么"点击更改数据目录 → 迁移 → 重启"仍不自动化：
 *  - 入口先弹原生目录选择框（Playwright 无法驱动），确认后 App 重启并断开会话；
 *  - 迁移/校验/重启决策由 `apps/desktop/src/main/data-dir.test.ts` 单测 + 手工 M28–M34 覆盖。
 */

async function createTempDir(prefix: string): Promise<string> {
  await fs.mkdir(TMP_DIR, { recursive: true });
  return fs.mkdtemp(path.join(TMP_DIR, prefix));
}

function normalize(target: string): string {
  return path.resolve(target).toLowerCase();
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

/** 构造一个合法的旧版 `channels.json`（subscriber 记录，无需 channel_pri）。 */
function legacyChannelsJson(channelId: string): string {
  return `${JSON.stringify(
    {
      schemaVersion: 1,
      kind: 'apphub-channels',
      channels: [
        {
          channelId,
          url: 'http://127.0.0.1:1/channel.json',
          visibility: 'public',
          role: 'subscriber',
          source: 'subscribed',
          channelName: 'Legacy Channel',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-02T00:00:00.000Z',
          lastFetchedAt: '2026-01-02T00:00:00.000Z',
        },
      ],
    },
    null,
    2,
  )}\n`;
}

/** 构造合法的 channel.json 缓存（与 channels.json 中的记录对应）。 */
function legacyChannelCacheJson(channelId: string): string {
  return `${JSON.stringify(
    {
      schemaVersion: 1,
      kind: 'apphub-channel',
      id: channelId,
      name: 'Legacy Channel',
      description: 'Phase6 旧版数据（位于 userData 根）',
      visibility: 'public',
      owner: { name: 'Legacy Owner' },
      apps: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    },
    null,
    2,
  )}\n`;
}

test.describe('设置页：数据目录（Phase 6/7）', () => {
  test('env（APPHUB_USER_DATA_DIR）：source=env、editable=false、AppHub 数据位于该目录根、默认目录=<userData>/AppHubData', async ({
    window,
    runningApp,
  }) => {
    await waitForShell(window);
    const info = await getSystemInfo(window);
    const expectedDefault = path.join(runningApp.userDataDir, 'AppHubData');

    expect(info.dataDirSource).toBe('env');
    expect(info.dataDirEditable).toBe(false);
    expect(path.isAbsolute(info.defaultDataDir)).toBe(true);
    // 历史语义：APPHUB_USER_DATA_DIR 覆盖 Electron userData，AppHub 数据直接位于该目录根
    expect(normalize(info.dataDir)).toBe(normalize(runningApp.userDataDir));
    expect(normalize(info.defaultDataDir)).toBe(normalize(expectedDefault));

    await window.getByTestId(TESTID.navSettings).click();
    const source = window.getByTestId(TESTID.dataDirSource);
    await expect(source).toBeVisible({ timeout: TIMEOUTS.ui });
    await expect(source).toHaveText('环境变量固定');
    const changeButton = window.getByTestId(TESTID.changeDataDirButton);
    await expect(changeButton).toBeVisible();
    await expect(changeButton).toBeDisabled();

    // Phase 7 文案：env 专属说明同时解释 APPHUB_DATA_DIR / APPHUB_USER_DATA_DIR
    const envHint = window.getByTestId(TESTID.dataDirEnvHint);
    await expect(envHint).toBeVisible();
    await expect(envHint).toContainText('APPHUB_DATA_DIR');
    await expect(envHint).toContainText('APPHUB_USER_DATA_DIR');
    await expect(envHint).toContainText(/不影响 Electron 自身的缓存\/配置路径/);
    await expect(envHint).toContainText(/移除环境变量并重启 App/);

    // 默认目录 hint 在 Phase 7 也会展示 AppHubData 隔离说明
    await expect(window.getByTestId(TESTID.dataDirDefaultHint)).toContainText(info.defaultDataDir);
    await expect(window.getByTestId(TESTID.dataDirDefaultHint)).toContainText('AppHubData');
    await expect(window.getByTestId(TESTID.dataDirChangeError)).toHaveCount(0);
  });

  test('env（APPHUB_DATA_DIR）：只改 AppHub 数据目录，默认目录仍为 <userData>/AppHubData', async () => {
    const appDataDir = await createTempDir('apphub-data-dir-');
    const runningApp = await launchApp({
      useUserDataDirArg: true,
      extraEnv: { APPHUB_DATA_DIR: appDataDir },
    });
    try {
      await waitForShell(runningApp.window);
      const info = await getSystemInfo(runningApp.window);
      const expectedDefault = path.join(runningApp.userDataDir, 'AppHubData');

      expect(info.dataDirSource).toBe('env');
      expect(info.dataDirEditable).toBe(false);
      expect(normalize(info.dataDir)).toBe(normalize(appDataDir));
      expect(normalize(info.defaultDataDir)).toBe(normalize(expectedDefault));
      // APPHUB_DATA_DIR 不改变 Electron userData：AppHub 数据目录与 userData 不同
      expect(normalize(info.dataDir)).not.toBe(normalize(runningApp.userDataDir));
      expect((await fs.stat(appDataDir)).isDirectory()).toBe(true);

      await runningApp.window.getByTestId(TESTID.navSettings).click();
      await expect(runningApp.window.getByTestId(TESTID.dataDirSource)).toHaveText(
        '环境变量固定',
        { timeout: TIMEOUTS.ui },
      );
      await expect(runningApp.window.getByTestId(TESTID.changeDataDirButton)).toBeDisabled();
      await expect(runningApp.window.getByTestId(TESTID.dataDirEnvHint)).toContainText(
        'APPHUB_DATA_DIR',
      );
    } finally {
      await runningApp.close();
      await fs.rm(appDataDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  test('default（--user-data-dir）：dataDir=defaultDataDir=<userData>/AppHubData、editable=true', async () => {
    const runningApp = await launchApp({ useUserDataDirArg: true });
    try {
      await waitForShell(runningApp.window);
      const info = await getSystemInfo(runningApp.window);
      const expectedAppHubData = path.join(runningApp.userDataDir, 'AppHubData');

      expect(info.dataDirSource).toBe('default');
      expect(info.dataDirEditable).toBe(true);
      expect(normalize(info.dataDir)).toBe(normalize(expectedAppHubData));
      expect(normalize(info.defaultDataDir)).toBe(normalize(expectedAppHubData));
      // 默认数据目录位于 userData 下的独立子目录（Phase 7 与 Chromium 缓存隔离）
      expect(normalize(info.dataDir)).not.toBe(normalize(runningApp.userDataDir));
      expect((await fs.stat(expectedAppHubData)).isDirectory()).toBe(true);

      await runningApp.window.getByTestId(TESTID.navSettings).click();
      await expect(runningApp.window.getByTestId(TESTID.dataDirSource)).toHaveText('默认目录', {
        timeout: TIMEOUTS.ui,
      });
      await expect(runningApp.window.getByTestId(TESTID.changeDataDirButton)).toBeEnabled();
      const defaultHint = runningApp.window.getByTestId(TESTID.dataDirDefaultHint);
      await expect(defaultHint).toContainText(info.defaultDataDir);
      await expect(defaultHint).toContainText('AppHubData');
      await expect(defaultHint).toContainText(/不会改变 Electron 自身的缓存\/配置路径/);
      await expect(defaultHint).toContainText(/当前使用/);
      // 非 env 模式不渲染 env 专属说明
      await expect(runningApp.window.getByTestId(TESTID.dataDirEnvHint)).toHaveCount(0);
    } finally {
      await runningApp.close();
    }
  });

  test('custom（预置 bootstrap）：dataDir=自定义目录、defaultDataDir=<userData>/AppHubData', async () => {
    const defaultUserData = await createTempDir('user-data-custom-');
    const customDataDir = await createTempDir('custom-data-');
    await fs.writeFile(
      path.join(defaultUserData, 'apphub-bootstrap.json'),
      `${JSON.stringify({ dataDir: customDataDir }, null, 2)}\n`,
      'utf8',
    );

    const runningApp = await launchApp({ userDataDir: defaultUserData, useUserDataDirArg: true });
    try {
      await waitForShell(runningApp.window);
      const info = await getSystemInfo(runningApp.window);
      expect(info.dataDirSource).toBe('custom');
      expect(info.dataDirEditable).toBe(true);
      expect(normalize(info.dataDir)).toBe(normalize(customDataDir));
      expect(normalize(info.defaultDataDir)).toBe(
        normalize(path.join(defaultUserData, 'AppHubData')),
      );

      await runningApp.window.getByTestId(TESTID.navSettings).click();
      await expect(runningApp.window.getByTestId(TESTID.dataDirSource)).toHaveText('自定义目录', {
        timeout: TIMEOUTS.ui,
      });
      await expect(runningApp.window.getByTestId(TESTID.changeDataDirButton)).toBeEnabled();
      await expect(runningApp.window.getByTestId(TESTID.dataDirDefaultHint)).toContainText(
        info.defaultDataDir,
      );
      expect((await fs.stat(customDataDir)).isDirectory()).toBe(true);
    } finally {
      await runningApp.close();
      await fs.rm(customDataDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  test('旧版数据自动迁移：userData 根 → <userData>/AppHubData，频道可用且非 managed 文件保留', async () => {
    const legacyUserData = await createTempDir('user-data-legacy-');
    const channelId = 'ch_0123456789abcdef0123';

    // Phase 6 及更早：数据直接位于 Electron userData 根
    await fs.writeFile(
      path.join(legacyUserData, 'channels.json'),
      legacyChannelsJson(channelId),
      'utf8',
    );
    await fs.mkdir(path.join(legacyUserData, 'channels', channelId), { recursive: true });
    await fs.writeFile(
      path.join(legacyUserData, 'channels', channelId, 'channel.json'),
      legacyChannelCacheJson(channelId),
      'utf8',
    );
    // 非 managed 文件（模拟 Chromium/用户文件）：迁移不应动它
    await fs.writeFile(path.join(legacyUserData, 'keep-me.txt'), 'not-managed\n', 'utf8');

    const runningApp = await launchApp({ userDataDir: legacyUserData, useUserDataDirArg: true });
    try {
      await waitForShell(runningApp.window);
      const info = await getSystemInfo(runningApp.window);
      const appHubData = path.join(legacyUserData, 'AppHubData');

      // 1) 启动后数据目录指向 AppHubData（source 仍为 default）
      expect(info.dataDirSource).toBe('default');
      expect(normalize(info.dataDir)).toBe(normalize(appHubData));
      expect(normalize(info.defaultDataDir)).toBe(normalize(appHubData));

      // 2) 旧 managed 条目已 move 到 AppHubData；根目录不再有 channels.json/channels
      expect(await pathExists(path.join(appHubData, 'channels.json'))).toBe(true);
      expect(await pathExists(path.join(appHubData, 'channels', channelId, 'channel.json'))).toBe(
        true,
      );
      expect(await pathExists(path.join(legacyUserData, 'channels.json'))).toBe(false);
      expect(await pathExists(path.join(legacyUserData, 'channels'))).toBe(false);
      // 非 managed 文件保留原位
      expect(await pathExists(path.join(legacyUserData, 'keep-me.txt'))).toBe(true);

      // 3) 迁移后的频道对 core 可用（channels.list 能读到旧记录 + 缓存）
      const channels = await listChannels(runningApp.window);
      expect(channels).toHaveLength(1);
      expect(channels[0]?.id).toBe(channelId);
      expect(channels[0]?.name).toBe('Legacy Channel');

      // 4) 设置页展示默认目录（AppHubData）且可编辑
      await runningApp.window.getByTestId(TESTID.navSettings).click();
      await expect(runningApp.window.getByTestId(TESTID.dataDirSource)).toHaveText('默认目录', {
        timeout: TIMEOUTS.ui,
      });
      await expect(runningApp.window.getByTestId(TESTID.dataDirDefaultHint)).toContainText(
        'AppHubData',
      );
      await expect(runningApp.window.getByTestId(TESTID.dataDirEnvHint)).toHaveCount(0);
    } finally {
      await runningApp.close();
    }
  });
});
