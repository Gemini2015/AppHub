import { expect, test } from './support/test-fixtures';
import { TESTID, TIMEOUTS, waitForShell, waitForText } from './support/ui';

/**
 * 创建频道向导 E2E（表单校验 + 存储 provider 切换）。
 *
 * 边界：不点击最终「创建」提交（会触发真实 storage probe 并写远端存储，
 * 属于手工/集成测试范围）；本用例只验证向导的必填拦截与 provider 字段切换。
 */
test.describe('创建频道向导', () => {
  test('空/纯空格名称被拦截，合法名称进入存储配置并可切换 provider', async ({ window }) => {
    await waitForShell(window);
    await expect(window.getByTestId(TESTID.navChannels)).toBeVisible();

    await window.getByTestId(TESTID.createChannelButton).click();
    await expect(window.getByTestId(TESTID.createChannelForm)).toBeVisible();

    const nameInput = window.getByTestId(TESTID.createChannelName);
    const nextButton = window.getByTestId(TESTID.createChannelNext);
    const providerSelect = window.getByTestId(TESTID.storageProviderSelect);
    await expect(nameInput).toBeVisible();
    await expect(nextButton).toBeVisible();

    // 1) 空名称：留在第 1 步 + 出现必填提示
    await nextButton.click();
    await waitForText(window, /请输入|必填|不能为空|请填写/);
    await expect(nameInput).toBeVisible();
    await expect(providerSelect).toBeHidden();

    // 2) 纯空格名称：trim 后仍为空，同样被拦截
    await nameInput.fill('   ');
    await nextButton.click();
    await waitForText(window, /请输入|必填|不能为空|请填写/);
    await expect(providerSelect).toBeHidden();

    // 3) 合法名称：进入存储配置步骤
    await nameInput.fill('E2E 创建频道');
    await nextButton.click();
    await expect(providerSelect).toBeVisible({ timeout: TIMEOUTS.op });

    // 4) provider 切换：字段联动（value 与 UI 同步）
    await providerSelect.selectOption('ftp-http');
    await expect(providerSelect).toHaveValue('ftp-http');
    await providerSelect.selectOption('s3');
    await expect(providerSelect).toHaveValue('s3');
    await providerSelect.selectOption('local');
    await expect(providerSelect).toHaveValue('local');

    // 表单仍可交互（没有因为切换 provider 崩溃/白屏）
    await expect(window.getByTestId(TESTID.createChannelForm)).toBeVisible();
    await expect(window.getByTestId(TESTID.appRoot)).toBeVisible();
  });
});
