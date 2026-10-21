import type { AppHubCore, LaunchDescriptor } from '@apphub/core';
import { AppError } from '@apphub/protocol';
import { createFakeLogger } from '@apphub/testkit';
import type { ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildSpawnPlan,
  launchInstalledApp,
  resolveInstalledAppRoot,
  validateLaunchDescriptor,
} from './app-launcher';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'apphub-launch-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

interface Fixture {
  appRoot: string;
  versionDir: string;
  entryPath: string;
  descriptor: LaunchDescriptor;
}

async function createFixture(): Promise<Fixture> {
  const appRoot = path.join(tempDir, 'library', 'ch_0123456789abcdef', 'demo');
  const versionDir = path.join(appRoot, 'versions', '1.0.0');
  await mkdir(versionDir, { recursive: true });
  const entryPath = path.join(versionDir, 'demo.exe');
  await writeFile(entryPath, 'MZ fake executable');
  return {
    appRoot,
    versionDir,
    entryPath,
    descriptor: { appRoot, versionDir, entryPath, cwd: versionDir, args: [] },
  };
}

function fakeCore(descriptor: LaunchDescriptor): AppHubCore {
  return {
    dataDir: tempDir,
    library: {
      getLaunchDescriptor: vi.fn(async () => descriptor),
    },
  } as unknown as AppHubCore;
}

describe('app-launcher：descriptor 逃逸校验', () => {
  it('合法的 descriptor 通过校验并使用 realpath', async () => {
    const fixture = await createFixture();
    const validated = await validateLaunchDescriptor(fixture.descriptor);
    expect(validated.entryPath).toBe(fixture.entryPath);
    expect(validated.cwd).toBe(fixture.versionDir);
  });

  it('入口不在版本目录内 -> SECURITY', async () => {
    const fixture = await createFixture();
    const outside = path.join(tempDir, 'outside.exe');
    await writeFile(outside, 'evil');
    await expect(
      validateLaunchDescriptor({ ...fixture.descriptor, entryPath: outside }),
    ).rejects.toMatchObject({ code: 'SECURITY' });
  });

  it('入口通过 ../ 逃逸出 App 根目录 -> SECURITY', async () => {
    const fixture = await createFixture();
    const traversal = path.join(fixture.versionDir, '..', '..', '..', '..', 'evil.exe');
    await expect(
      validateLaunchDescriptor({ ...fixture.descriptor, entryPath: traversal }),
    ).rejects.toMatchObject({ code: 'SECURITY' });
  });

  it('cwd 不在 App 根目录内 -> SECURITY', async () => {
    const fixture = await createFixture();
    await expect(
      validateLaunchDescriptor({ ...fixture.descriptor, cwd: tmpdir() }),
    ).rejects.toMatchObject({ code: 'SECURITY' });
  });

  it('非绝对路径 descriptor -> STATE（安装信息损坏）', async () => {
    const fixture = await createFixture();
    await expect(
      validateLaunchDescriptor({ ...fixture.descriptor, entryPath: 'demo.exe' }),
    ).rejects.toMatchObject({ code: 'STATE' });
  });

  it('入口文件不存在 -> NOT_FOUND', async () => {
    const fixture = await createFixture();
    await rm(fixture.entryPath);
    await expect(validateLaunchDescriptor(fixture.descriptor)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('入口是目录而不是文件 -> VALIDATION', async () => {
    const fixture = await createFixture();
    const dirEntry = path.join(fixture.versionDir, 'fake.exe');
    await mkdir(dirEntry);
    await expect(
      validateLaunchDescriptor({ ...fixture.descriptor, entryPath: dirEntry }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('符号链接逃逸出 App 根目录 -> SECURITY（无法创建链接时跳过）', async () => {
    const fixture = await createFixture();
    const outside = path.join(tempDir, 'outside-target.exe');
    await writeFile(outside, 'evil');
    const linkPath = path.join(fixture.versionDir, 'link.exe');
    try {
      await symlink(outside, linkPath);
    } catch {
      return; // Windows 无权限创建符号链接
    }
    await expect(
      validateLaunchDescriptor({ ...fixture.descriptor, entryPath: linkPath }),
    ).rejects.toMatchObject({ code: 'SECURITY' });
  });

  it('POSIX 下缺少可执行位时补 chmod', async () => {
    const fixture = await createFixture();
    const chmodImpl = vi.fn(async () => undefined);
    await validateLaunchDescriptor(fixture.descriptor, { platform: 'linux', chmodImpl });
    expect(chmodImpl).toHaveBeenCalledTimes(1);
    const [target, mode] = chmodImpl.mock.calls[0] as unknown as [string, number];
    expect(target).toBe(fixture.entryPath);
    expect(mode & 0o111).toBeGreaterThan(0);
  });
});

describe('app-launcher：spawn 启动', () => {
  it('spawn 使用 detached + stdio ignore + unref，并返回 pid', async () => {
    const fixture = await createFixture();
    const unref = vi.fn();
    const once = vi.fn();
    const spawnImpl = vi.fn(() => ({ pid: 4321, unref, once }) as unknown as ChildProcess);
    const logger = createFakeLogger();

    const result = await launchInstalledApp(
      fakeCore(fixture.descriptor),
      'ch_0123456789abcdef',
      'demo',
      { spawnImpl: spawnImpl as unknown as typeof import('node:child_process').spawn, logger },
    );

    expect(result).toEqual({ pid: 4321 });
    expect(unref).toHaveBeenCalledTimes(1);
    const [command, args, options] = spawnImpl.mock.calls[0] as unknown as [
      string,
      string[],
      { cwd: string; detached: boolean; stdio: string; shell: boolean },
    ];
    expect(command).toBe(fixture.entryPath);
    expect(args).toEqual([]);
    expect(options.detached).toBe(true);
    expect(options.stdio).toBe('ignore');
    expect(options.cwd).toBe(fixture.versionDir);
    expect(options.shell).toBe(false);
    expect(logger.entries.some((entry) => entry.message.includes('已启动 App'))).toBe(true);
  });

  it('descriptor 逃逸时不会 spawn', async () => {
    const fixture = await createFixture();
    const spawnImpl = vi.fn();
    const descriptor = { ...fixture.descriptor, entryPath: path.join(tempDir, 'evil.exe') };
    await expect(
      launchInstalledApp(fakeCore(descriptor), 'ch_0123456789abcdef', 'demo', {
        spawnImpl: spawnImpl as unknown as typeof import('node:child_process').spawn,
      }),
    ).rejects.toBeInstanceOf(AppError);
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it('Windows 脚本需要 shell，普通 exe 不需要', () => {
    if (process.platform === 'win32') {
      const cmd = buildSpawnPlan('C:\\apps\\run.cmd', 'C:\\apps');
      expect(cmd.shell).toBe(true);
      expect(cmd.command).toBe('C:\\apps\\run.cmd');
      const batWithSpace = buildSpawnPlan('C:\\my apps\\run.bat', 'C:\\my apps');
      expect(batWithSpace.shell).toBe(true);
      expect(batWithSpace.command).toBe('"C:\\my apps\\run.bat"');
    }
    const exe = buildSpawnPlan('/opt/app/run.sh', '/opt/app');
    expect(exe.shell).toBe(false);
    expect(exe.command).toBe('/opt/app/run.sh');
  });
});

describe('app-launcher：reveal 目录解析', () => {
  it('返回数据目录内的安装根目录', async () => {
    const fixture = await createFixture();
    const core = {
      dataDir: tempDir,
      library: {
        list: vi.fn(async () => [
          { channelId: 'ch_0123456789abcdef', appId: 'demo', appRoot: fixture.appRoot },
        ]),
      },
    } as unknown as AppHubCore;
    await expect(resolveInstalledAppRoot(core, 'ch_0123456789abcdef', 'demo')).resolves.toBe(fixture.appRoot);
  });

  it('App 未安装 -> NOT_FOUND', async () => {
    const core = {
      dataDir: tempDir,
      library: { list: vi.fn(async () => []) },
    } as unknown as AppHubCore;
    await expect(resolveInstalledAppRoot(core, 'ch_0123456789abcdef', 'demo')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('appRoot 不在数据目录内 -> SECURITY', async () => {
    const outsideRoot = path.join(tmpdir(), 'apphub-outside-app-root');
    const core = {
      dataDir: tempDir,
      library: {
        list: vi.fn(async () => [
          { channelId: 'ch_0123456789abcdef', appId: 'demo', appRoot: outsideRoot },
        ]),
      },
    } as unknown as AppHubCore;
    await expect(resolveInstalledAppRoot(core, 'ch_0123456789abcdef', 'demo')).rejects.toMatchObject({
      code: 'SECURITY',
    });
  });
});
