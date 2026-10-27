import { AppError } from '@apphub/protocol';
import { spawn } from 'node:child_process';
import type { SpawnOptions } from 'node:child_process';
import { chmod, lstat, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { AppHubCore, LaunchDescriptor } from '@apphub/core';
import type { LaunchResultDTO } from '../../shared/ipc';
import type { Logger } from './logger';

/**
 * 启动已安装 App / 定位安装目录。
 *
 * 安全要求（docs/ARCHITECTURE.md §3.5）：
 *  - 启动入口必须位于当前版本目录 / App 根目录内（path.relative 不含 `..`）；
 *  - 真实路径（realpath）也要在根目录内，防止符号链接逃逸；
 *  - 入口必须是普通文件；POSIX 下必要时补可执行位；
 *  - Windows 下 .cmd/.bat 需要 shell（Node 22 起不允许直接 spawn 脚本）；
 *  - spawn 使用 detached + stdio: 'ignore' + unref()，不阻塞主进程。
 */

export interface LaunchDependencies {
  platform?: NodeJS.Platform;
  spawnImpl?: typeof spawn;
  chmodImpl?: (file: string, mode: number) => Promise<void>;
  realpathImpl?: (file: string) => Promise<string>;
  lstatImpl?: typeof lstat;
  statImpl?: typeof stat;
  logger?: Logger;
}

export interface ValidatedLaunch {
  appRoot: string;
  versionDir: string;
  entryPath: string;
  cwd: string;
  args: string[];
}

export interface SpawnPlan {
  command: string;
  args: string[];
  shell: boolean;
  options: SpawnOptions;
}

function isContained(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 校验 core.library.getLaunchDescriptor 返回的启动信息。
 * 失败抛 AppError('SECURITY' | 'NOT_FOUND' | 'VALIDATION' | 'STATE' | 'IO')。
 */
export async function validateLaunchDescriptor(
  descriptor: LaunchDescriptor,
  deps: LaunchDependencies = {},
): Promise<ValidatedLaunch> {
  const platform = deps.platform ?? process.platform;
  const realpathImpl = deps.realpathImpl ?? realpath;
  const lstatImpl = deps.lstatImpl ?? lstat;

  const required: (keyof LaunchDescriptor)[] = ['appRoot', 'versionDir', 'entryPath'];
  for (const key of required) {
    const value = descriptor?.[key];
    if (typeof value !== 'string' || value.length === 0 || !path.isAbsolute(value)) {
      throw new AppError('STATE', `安装信息损坏：${String(key)} 不是绝对路径`);
    }
  }

  const appRoot = path.resolve(descriptor.appRoot);
  const versionDir = path.resolve(descriptor.versionDir);
  const entryPath = path.resolve(descriptor.entryPath);
  const rawCwd = typeof descriptor.cwd === 'string' && descriptor.cwd.length > 0 ? descriptor.cwd : versionDir;
  const cwd = path.resolve(rawCwd);

  if (!isContained(appRoot, versionDir)) {
    throw new AppError('SECURITY', '安装目录结构异常：版本目录不在 App 根目录内');
  }
  if (!isContained(versionDir, entryPath)) {
    throw new AppError('SECURITY', '启动入口不在当前版本目录内，已拒绝启动');
  }
  if (!isContained(appRoot, cwd)) {
    throw new AppError('SECURITY', '启动工作目录不在 App 根目录内，已拒绝启动');
  }

  let realRoot: string;
  let realEntry: string;
  let realCwd: string;
  try {
    realRoot = await realpathImpl(appRoot);
  } catch {
    throw new AppError('NOT_FOUND', 'App 安装目录不存在，请重新安装');
  }
  try {
    realEntry = await realpathImpl(entryPath);
  } catch {
    throw new AppError('NOT_FOUND', `启动入口文件不存在：${path.basename(entryPath)}`);
  }
  try {
    realCwd = await realpathImpl(cwd);
  } catch {
    throw new AppError('NOT_FOUND', 'App 安装目录不存在，请重新安装');
  }
  if (!isContained(realRoot, realEntry)) {
    throw new AppError('SECURITY', '启动入口通过符号链接逃逸出 App 目录，已拒绝启动');
  }
  if (!isContained(realRoot, realCwd)) {
    throw new AppError('SECURITY', '启动工作目录通过符号链接逃逸出 App 目录，已拒绝启动');
  }

  const info = await lstatImpl(entryPath).catch(() => null);
  if (!info) throw new AppError('NOT_FOUND', '启动入口文件不存在，请重新安装');
  if (!info.isFile()) throw new AppError('VALIDATION', '启动入口不是普通文件，已拒绝启动');

  if (platform !== 'win32') {
    const mode = info.mode & 0o777;
    if ((mode & 0o111) === 0) {
      try {
        await (deps.chmodImpl ?? chmod)(entryPath, mode | 0o111);
      } catch (err) {
        throw new AppError('IO', `无法设置启动入口的可执行权限：${errorMessage(err)}`);
      }
    }
  }

  // 返回构造出的原始路径（realpath 仅用于逃逸校验）：
  // Windows 上 realpath 可能返回 8.3 短路径（C:\Users\RUNNER~1\...），
  // 直接返回会让启动命令/日志路径不稳定，也会破坏路径断言。
  return { appRoot, versionDir, entryPath, cwd, args: [] };
}

/** 构造 spawn 参数（单独抽出便于单测 Windows 脚本分支）。 */
export function buildSpawnPlan(entryPath: string, cwd: string): SpawnPlan {
  const windowsScript = process.platform === 'win32' && /\.(cmd|bat)$/i.test(entryPath);
  const options: SpawnOptions = {
    cwd,
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  };
  if (windowsScript) {
    // cmd.exe /d /s /c "<path>"：路径含空格时必须整体加引号（Windows 路径不允许引号字符）
    const command = /\s/.test(entryPath) ? `"${entryPath}"` : entryPath;
    return { command, args: [], shell: true, options };
  }
  return { command: entryPath, args: [], shell: false, options };
}

/**
 * 校验并启动已安装 App，返回子进程 pid（无法取得时为 null）。
 * 注意：这里只负责拉起进程，不等待其退出。
 */
export async function launchInstalledApp(
  core: AppHubCore,
  channelId: string,
  appId: string,
  deps: LaunchDependencies = {},
): Promise<LaunchResultDTO> {
  const descriptor = await core.library.getLaunchDescriptor(channelId, appId);
  const validated = await validateLaunchDescriptor(descriptor, deps);
  const plan = buildSpawnPlan(validated.entryPath, validated.cwd);
  const spawnImpl = deps.spawnImpl ?? spawn;

  let child;
  try {
    child = spawnImpl(plan.command, plan.args, { ...plan.options, shell: plan.shell });
  } catch (err) {
    throw new AppError('IO', `启动失败：${errorMessage(err)}`);
  }

  child.once?.('error', (err: Error) => {
    deps.logger?.error('已安装 App 启动失败', { message: err.message });
  });
  try {
    child.unref?.();
  } catch {
    /* unref 失败不影响启动 */
  }
  deps.logger?.info('已启动 App', { channelId, appId, pid: child.pid ?? null });
  return { pid: typeof child.pid === 'number' ? child.pid : null };
}

/**
 * 解析已安装 App 的根目录（用于"打开所在目录"）。
 * 只接受 core 返回且位于 dataDir 内的路径，避免被异常 descriptor 带偏。
 */
export async function resolveInstalledAppRoot(
  core: AppHubCore,
  channelId: string,
  appId: string,
  deps: Pick<LaunchDependencies, 'statImpl'> = {},
): Promise<string> {
  const apps = await core.library.list();
  const installed = apps.find((item) => item.channelId === channelId && item.appId === appId);
  if (!installed) {
    throw new AppError('NOT_FOUND', '该 App 尚未安装，无法定位安装目录');
  }
  const appRoot = path.resolve(installed.appRoot);
  if (!path.isAbsolute(installed.appRoot)) {
    throw new AppError('STATE', '安装信息损坏：appRoot 不是绝对路径');
  }
  if (!isContained(core.dataDir, appRoot)) {
    throw new AppError('SECURITY', '安装目录不在 AppHub 数据目录内，已拒绝打开');
  }
  const statImpl = deps.statImpl ?? stat;
  const info = await statImpl(appRoot).catch(() => null);
  if (!info || !info.isDirectory()) {
    throw new AppError('NOT_FOUND', '安装目录不存在，请重新安装');
  }
  return appRoot;
}
