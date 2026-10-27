import { promises as fs } from 'node:fs';
import path from 'node:path';
import { getSystemInfo } from './support/app-api';
import { launchApp } from './support/electron-app';
import { TMP_DIR } from './support/paths';
import { expect, test } from './support/test-fixtures';
import { TESTID, TIMEOUTS, waitForShell } from './support/ui';

/**
 * Phase 6：设置页「数据目录」E2E。
 *
 * 覆盖三个"启动期即可确定"的分支（均不需要点击「更改数据目录」，因此不触发原生目录对话框，
 * 也不触发迁移/重启）：
 *  1. env 只读：APPHUB_USER_DATA_DIR 启动 ⇒ source='env'、editable=false、按钮 disabled；
 *  2. 默认可编辑：Chromium `--user-data-dir` 隔离 userData（不设 env）⇒ source='default'、editable=true；
 *  3. 自定义目录：在隔离 userData 里预置 `apphub-bootstrap.json` 指向另一临时目录 ⇒ source='custom'、
 *     dataDir=自定义目录、defaultDataDir=隔离 userData。
 *
 * 为什么不自动化"点击更改数据目录 + 迁移 + 重启"：
 *  - 入口会先弹 **原生目录选择框**（Playwright 无法驱动），确认后 App 会 **重启**；
 *  - 重启会中断 Playwright 与 Electron 的连接，破坏用例与报告的归属关系；
 *  - 迁移/重启决策与文件复制逻辑由 `apps/desktop/src/main/data-dir.test.ts` 单测覆盖，
 *    真实交互列入手工清单 M28–M31（见 docs/TESTING.md §8.9、§11.5）。
 */
test.describe('设置页：数据目录（Phase 6）', () => {
  test('env 模式：来源=环境变量固定、不可编辑、system.info 契约字段正确', async ({
    window,
    runningApp,
  }) => {
    await waitForShell(window);

    // 1) IPC 契约字段（真实主进程）
    const info = await getSystemInfo(window);
    expect(info.dataDirSource).toBe('env');
    expect(info.dataDirEditable).toBe(false);
    expect(typeof info.defaultDataDir).toBe('string');
    expect(path.isAbsolute(info.defaultDataDir)).toBe(true);
    // env 覆盖了 Electron userData：当前数据目录就是 APPHUB_USER_DATA_DIR 临时目录，
    // defaultDataDir 也随之等于该 userData 目录（主进程 resolveAppDataDir 的既定行为）。
    expect(path.resolve(info.dataDir).toLowerCase()).toBe(
      path.resolve(runningApp.userDataDir).toLowerCase(),
    );
    expect(path.resolve(info.defaultDataDir).toLowerCase()).toBe(
      path.resolve(runningApp.userDataDir).toLowerCase(),
    );

    // 2) 设置页 UI：来源展示 + 按钮禁用 + 固定说明
    await window.getByTestId(TESTID.navSettings).click();
    const source = window.getByTestId(TESTID.dataDirSource);
    await expect(source).toBeVisible({ timeout: TIMEOUTS.ui });
    await expect(source).toHaveText('环境变量固定');

    const changeButton = window.getByTestId(TESTID.changeDataDirButton);
    await expect(changeButton).toBeVisible();
    await expect(changeButton).toBeDisabled();

    await expect(window.getByText(/数据目录由环境变量固定/).first()).toBeVisible();
    await expect(window.getByText(/APPHUB_USER_DATA_DIR/).first()).toBeVisible();
    await expect(window.getByTestId(TESTID.dataDirDefaultHint)).toContainText(info.defaultDataDir);

    // 不点击「更改数据目录」：点击会先触发 system.pickDirectory 的原生目录对话框，
    // Playwright/Electron 均无法自动操作（见 docs/TESTING.md §8.7、§11.5 手工清单）。
    await expect(window.getByTestId(TESTID.dataDirChangeError)).toHaveCount(0);
  });

  test('默认可编辑模式（--user-data-dir）：source=default、editable=true、展示默认目录为当前使用', async () => {
    // 用 Chromium 开关隔离 userData，但不设 APPHUB_USER_DATA_DIR ⇒ 可编辑的 default 分支
    const runningApp = await launchApp({ useUserDataDirArg: true });
    try {
      await waitForShell(runningApp.window);
      const info = await getSystemInfo(runningApp.window);
      const expectedUserData = path.resolve(runningApp.userDataDir).toLowerCase();

      expect(info.dataDirSource).toBe('default');
      expect(info.dataDirEditable).toBe(true);
      expect(path.resolve(info.dataDir).toLowerCase()).toBe(expectedUserData);
      expect(path.resolve(info.defaultDataDir).toLowerCase()).toBe(expectedUserData);

      await runningApp.window.getByTestId(TESTID.navSettings).click();
      await expect(runningApp.window.getByTestId(TESTID.dataDirSource)).toHaveText('默认目录', {
        timeout: TIMEOUTS.ui,
      });
      await expect(runningApp.window.getByTestId(TESTID.changeDataDirButton)).toBeEnabled();
      await expect(runningApp.window.getByTestId(TESTID.dataDirDefaultHint)).toContainText('当前使用');
      // env 专属说明不应出现
      await expect(runningApp.window.getByText(/数据目录由环境变量固定/)).toHaveCount(0);
      // 数据目录就是 userData：core 初始化后应有 managed 数据（至少 channels.json 所在目录可用）
      expect((await fs.stat(runningApp.userDataDir)).isDirectory()).toBe(true);
    } finally {
      await runningApp.close();
    }
  });

  test('custom 模式（预置 bootstrap）：source=custom、dataDir=自定义目录、defaultDataDir=userData', async () => {
    await fs.mkdir(TMP_DIR, { recursive: true });
    const defaultUserData = await fs.mkdtemp(path.join(TMP_DIR, 'user-data-custom-'));
    const customDataDir = await fs.mkdtemp(path.join(TMP_DIR, 'custom-data-'));
    // 引导配置存放在 Electron userData 下（main/data-dir.ts 契约）
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
      expect(path.resolve(info.dataDir).toLowerCase()).toBe(path.resolve(customDataDir).toLowerCase());
      expect(path.resolve(info.defaultDataDir).toLowerCase()).toBe(
        path.resolve(defaultUserData).toLowerCase(),
      );

      await runningApp.window.getByTestId(TESTID.navSettings).click();
      await expect(runningApp.window.getByTestId(TESTID.dataDirSource)).toHaveText('自定义目录', {
        timeout: TIMEOUTS.ui,
      });
      await expect(runningApp.window.getByTestId(TESTID.changeDataDirButton)).toBeEnabled();
      await expect(runningApp.window.getByTestId(TESTID.dataDirDefaultHint)).toContainText(
        defaultUserData,
      );
      // core 实际使用的数据目录是 custom dir（ChannelService.list 等可用；这里直接检查目录存在）
      expect((await fs.stat(customDataDir)).isDirectory()).toBe(true);
    } finally {
      await runningApp.close();
      await fs.rm(customDataDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});
