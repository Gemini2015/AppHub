import { AppError } from '@apphub/protocol';
import { cp, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Logger } from './logger';

/**
 * 可配置的 AppHub 数据目录（Phase7）。
 *
 * 设计要点：
 *  - 默认 AppHub 数据目录 = `<Electron userData>/AppHubData`，与 Electron/Chromium 缓存隔离；
 *  - 旧版（Phase6 及更早）数据直接位于 userData 根，启动时做一次性 move 迁移（不迁移 tmp/logs/Chromium）；
 *  - 引导配置 `apphub-bootstrap.json` 永远存放在 **Electron 当前 userData 目录**里
 *    （不是可被用户修改的数据目录），保证下次启动能找回自定义数据目录；
 *  - 数据目录优先级：APPHUB_DATA_DIR（仅 AppHub 数据）> APPHUB_USER_DATA_DIR（整体覆盖 Electron
 *    userData 的旧语义）> bootstrap.dataDir > `<userData>/AppHubData`；
 *  - 修改数据目录 = 校验目标 → 关闭 core（会停止本机 Host）→ 只迁移 AppHub 管理的数据
 *    （channels.json/channels/secrets/library/apphub.json）→ 写引导配置 → 重启 App。
 *  - tmp/、logs/ 与 Chromium 缓存不迁移，避免把临时/机器相关状态带过去。
 */

export const BOOTSTRAP_FILE_NAME = 'apphub-bootstrap.json';
export const MANAGED_ENTRIES = ['channels.json', 'channels', 'secrets', 'library', 'apphub.json'] as const;
/** 默认 AppHub 数据目录名（位于 Electron userData 下，与 Chromium 缓存隔离）。 */
export const DEFAULT_DATA_DIR_NAME = 'AppHubData';
/** 判断“新默认目录是否已有数据”时使用的条目（apphub.json 不参与，避免仅设置文件阻止迁移）。 */
const LEGACY_TARGET_ENTRIES = ['channels.json', 'channels', 'secrets', 'library'] as const;

/** `<electronUserData>/AppHubData`。 */
export function defaultAppDataDir(electronUserDataDir: string): string {
  return path.join(path.resolve(electronUserDataDir), DEFAULT_DATA_DIR_NAME);
}

export type DataDirSource = 'default' | 'custom' | 'env';
export type DataDirEnvVar = 'APPHUB_DATA_DIR' | 'APPHUB_USER_DATA_DIR';

export interface DataDirInfo {
  dataDir: string;
  /** AppHub 默认数据目录 `<electron userData>/AppHubData`（用于展示与“恢复默认”说明）。 */
  defaultDataDir: string;
  source: DataDirSource;
  /** env 固定时为 false：设置中不允许修改。 */
  editable: boolean;
  /** source==='env' 时标记由哪个环境变量固定。 */
  envVar?: DataDirEnvVar;
  /** 检测到 userData 根目录存在旧版数据时返回，由 index.ts 在启动阶段执行迁移。 */
  legacyMigration?: { baseDataDir: string; defaultDataDir: string };
}

export interface BootstrapConfig {
  dataDir?: string;
}

export interface ResolveAppDataDirOptions {
  electronUserDataDir: string;
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
}

export interface ValidateTargetDataDirOptions {
  currentDataDir: string;
  targetPath: string;
  defaultDataDir: string;
  /** 测试注入：返回 null 表示不存在。 */
  statImpl?: (target: string) => Promise<{ isDirectory(): boolean } | null>;
  readdirImpl?: (target: string) => Promise<string[]>;
  mkdirImpl?: (target: string, options: { recursive: boolean }) => Promise<unknown>;
  platform?: NodeJS.Platform;
}

export interface ValidatedTargetDataDir {
  targetDataDir: string;
  /** target === defaultDataDir（“恢复默认”，允许目标非空）。 */
  isDefault: boolean;
  existed: boolean;
  empty: boolean;
}

export interface MigrateOptions {
  logger?: Logger;
}

const MAX_PATH_LENGTH = 4096;
/** Windows 上不允许出现在路径中的字符（盘符冒号除外，逐段检查时处理）。 */
const WINDOWS_INVALID_SEGMENT_CHARS = /[<>:"|?*\u0000-\u001f]/;

export function bootstrapFilePath(electronUserDataDir: string): string {
  return path.join(path.resolve(electronUserDataDir), BOOTSTRAP_FILE_NAME);
}

export function isSamePath(a: string, b: string): boolean {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/** child 是否严格位于 parent 内（相同路径不算）。 */
export function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  if (relative === '' || path.isAbsolute(relative)) return false;
  return relative.split(/[\\/]/)[0] !== '..';
}

function errorCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null ? (err as NodeJS.ErrnoException).code : undefined;
}

/**
 * 读取引导配置（同步，启动早期使用）。
 * 文件不存在/损坏/字段非法时静默回退为 {}，并（可选）记录 warn。
 */
export function readDataDirConfig(electronUserDataDir: string, logger?: Logger): BootstrapConfig {
  const file = bootstrapFilePath(electronUserDataDir);
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    if (errorCode(err) !== 'ENOENT') {
      logger?.warn('读取数据目录引导配置失败（忽略，回退默认目录）', {
        file,
        message: err instanceof Error ? err.message : String(err),
      });
    }
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    logger?.warn('数据目录引导配置不是合法 JSON（忽略，回退默认目录）', { file });
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    logger?.warn('数据目录引导配置结构非法（忽略，回退默认目录）', { file });
    return {};
  }
  const dataDir = (parsed as Record<string, unknown>)['dataDir'];
  if (typeof dataDir !== 'string' || dataDir.trim().length === 0) return {};
  if (!path.isAbsolute(dataDir)) {
    logger?.warn('数据目录引导配置中的路径不是绝对路径（忽略）', { file });
    return {};
  }
  return { dataDir: path.resolve(dataDir) };
}

/**
 * 写入/删除引导配置。
 * dataDir=null 表示“恢复默认”（删除配置文件）。
 * 采用“写临时文件 + rename”的原子写入，避免断电/崩溃留下半截 JSON。
 */
export function writeDataDirConfig(electronUserDataDir: string, dataDir: string | null): void {
  const userDataDir = path.resolve(electronUserDataDir);
  const file = path.join(userDataDir, BOOTSTRAP_FILE_NAME);
  if (dataDir === null) {
    try {
      rmSync(file, { force: true });
    } catch (err) {
      throw AppError.from(err, 'IO');
    }
    return;
  }
  const normalized = path.resolve(dataDir);
  const tmpFile = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    mkdirSync(userDataDir, { recursive: true });
    writeFileSync(tmpFile, `${JSON.stringify({ dataDir: normalized }, null, 2)}\n`, 'utf8');
    renameSync(tmpFile, file);
  } catch (err) {
    try {
      rmSync(tmpFile, { force: true });
    } catch {
      /* ignore */
    }
    throw AppError.from(err, 'IO');
  }
}

function existingEntries(dir: string, entries: readonly string[]): string[] {
  return entries.filter((entry) => existsSync(path.join(dir, entry)));
}

/**
 * 默认目录解析：同时检测 userData 根目录下的旧版数据，返回需要异步迁移的标记。
 *  - 旧版数据（根目录任一 managed 条目）存在，且新默认目录还没有数据 → legacyMigration；
 *  - 新默认目录已有数据 → 不覆盖，跳过迁移（记录 warn）。
 */
function resolveDefaultDataDir(baseDataDir: string, defaultDataDir: string, logger?: Logger): DataDirInfo {
  const baseLegacyEntries = existingEntries(baseDataDir, MANAGED_ENTRIES);
  if (baseLegacyEntries.length === 0) {
    return { dataDir: defaultDataDir, defaultDataDir, source: 'default', editable: true };
  }
  const targetHasData = existingEntries(defaultDataDir, LEGACY_TARGET_ENTRIES);
  if (targetHasData.length > 0) {
    logger?.warn('检测到 userData 根目录存在旧版 AppHub 数据，但新的默认数据目录已有数据，跳过旧版迁移', {
      baseDataDir,
      defaultDataDir,
      legacyEntries: baseLegacyEntries,
      existingTargetEntries: targetHasData,
    });
    return { dataDir: defaultDataDir, defaultDataDir, source: 'default', editable: true };
  }
  return {
    dataDir: defaultDataDir,
    defaultDataDir,
    source: 'default',
    editable: true,
    legacyMigration: { baseDataDir, defaultDataDir },
  };
}

/**
 * 解析本次运行使用的数据目录。
 *
 * 优先级：
 *  1. `APPHUB_DATA_DIR`：只改 AppHub 数据目录（不动 Electron userData/缓存），只读，不读 bootstrap、不迁移旧版；
 *  2. `APPHUB_USER_DATA_DIR`：历史语义——index.ts 已在 ready 前 app.setPath 覆盖 Electron userData，
 *     因此 AppHub 数据直接位于该目录根（只读，不读 bootstrap）；
 *  3. bootstrap.dataDir（必须是绝对路径）→ custom；
 *  4. 默认 `<electronUserData>/AppHubData`，并检测旧版数据（位于 userData 根）供 index 启动时迁移。
 */
export function resolveAppDataDir(options: ResolveAppDataDirOptions): DataDirInfo {
  const baseDataDir = path.resolve(options.electronUserDataDir);
  const defaultDataDir = defaultAppDataDir(baseDataDir);

  const appDataDirEnv = options.env?.APPHUB_DATA_DIR?.trim();
  if (appDataDirEnv && appDataDirEnv.length > 0) {
    return {
      dataDir: path.resolve(appDataDirEnv),
      defaultDataDir,
      source: 'env',
      editable: false,
      envVar: 'APPHUB_DATA_DIR',
    };
  }

  const userDataDirEnv = options.env?.APPHUB_USER_DATA_DIR?.trim();
  if (userDataDirEnv && userDataDirEnv.length > 0) {
    return {
      dataDir: baseDataDir,
      defaultDataDir,
      source: 'env',
      editable: false,
      envVar: 'APPHUB_USER_DATA_DIR',
    };
  }

  const config = readDataDirConfig(baseDataDir, options.logger);
  if (config.dataDir) {
    // 引导配置指向默认 AppHubData 目录时按默认处理（例如手工编辑后的残留）
    if (isSamePath(config.dataDir, defaultDataDir)) {
      return resolveDefaultDataDir(baseDataDir, defaultDataDir, options.logger);
    }
    return {
      dataDir: path.resolve(config.dataDir),
      defaultDataDir,
      source: 'custom',
      editable: true,
    };
  }
  return resolveDefaultDataDir(baseDataDir, defaultDataDir, options.logger);
}

function assertValidTargetPath(targetPath: string, platform: NodeJS.Platform): string {
  if (typeof targetPath !== 'string') {
    throw new AppError('VALIDATION', '数据目录路径必须是字符串');
  }
  const raw = targetPath.trim();
  if (raw.length === 0) throw new AppError('VALIDATION', '数据目录路径不能为空');
  if (raw.length > MAX_PATH_LENGTH) throw new AppError('VALIDATION', '数据目录路径过长');
  if (raw.includes('\0')) throw new AppError('VALIDATION', '数据目录路径包含非法空字符');
  if (!path.isAbsolute(raw)) throw new AppError('VALIDATION', '数据目录必须是绝对路径');
  if (platform === 'win32') {
    // 去掉盘符后再检查各路径段中的 Windows 非法字符
    const withoutDrive = raw.replace(/^[A-Za-z]:/, '');
    for (const segment of withoutDrive.split(/[\\/]/)) {
      if (segment.length === 0) continue;
      if (WINDOWS_INVALID_SEGMENT_CHARS.test(segment)) {
        throw new AppError('VALIDATION', `数据目录路径包含非法字符：${segment}`);
      }
    }
  }
  return path.resolve(raw);
}

/**
 * 校验“修改数据目录”的目标：
 *  - 必须是绝对路径、不是当前目录、不与当前目录互相嵌套（避免递归复制）；
 *  - 不能是已有文件；
 *  - 已存在且非空时拒绝（CONFLICT），除非目标是 defaultDataDir（AppHub 默认子目录
 *    `<electron userData>/AppHubData`，即“恢复默认”，允许非空）；
 *  - 通过后确保目录存在（不存在则创建）。
 */
export async function validateTargetDataDir(
  options: ValidateTargetDataDirOptions,
): Promise<ValidatedTargetDataDir> {
  const platform = options.platform ?? process.platform;
  const targetDataDir = assertValidTargetPath(options.targetPath, platform);
  const currentDataDir = path.resolve(options.currentDataDir);
  const defaultDataDir = path.resolve(options.defaultDataDir);
  const isDefault = isSamePath(targetDataDir, defaultDataDir);

  if (isSamePath(targetDataDir, currentDataDir)) {
    throw new AppError('VALIDATION', '目标目录与当前数据目录相同，无需修改');
  }
  if (isPathInside(currentDataDir, targetDataDir)) {
    throw new AppError('VALIDATION', '目标目录不能位于当前数据目录内，请选择其他目录');
  }
  if (!isDefault && isPathInside(targetDataDir, currentDataDir)) {
    throw new AppError('VALIDATION', '当前数据目录位于目标目录内，请选择其他目录（避免递归迁移）');
  }

  const statImpl =
    options.statImpl ??
    (async (target: string) => {
      try {
        return await stat(target);
      } catch (err) {
        if (errorCode(err) === 'ENOENT') return null;
        throw err;
      }
    });
  const readdirImpl = options.readdirImpl ?? (async (target: string) => readdir(target));
  const mkdirImpl =
    options.mkdirImpl ?? (async (target: string, mkdirOptions: { recursive: boolean }) => mkdir(target, mkdirOptions));

  const info = await statImpl(targetDataDir).catch((err) => {
    throw AppError.from(err, 'IO');
  });
  const existed = info !== null;
  if (info && !info.isDirectory()) {
    throw new AppError('VALIDATION', '目标路径已存在且不是目录');
  }
  let empty = true;
  if (info) {
    const entries = await readdirImpl(targetDataDir).catch((err) => {
      throw AppError.from(err, 'IO');
    });
    empty = entries.length === 0;
    if (!empty && !isDefault) {
      throw new AppError('CONFLICT', '目标目录非空，请选择空目录或“恢复默认数据目录”', {
        targetDataDir,
        entryCount: entries.length,
        sample: entries.slice(0, 10),
      });
    }
  } else {
    await mkdirImpl(targetDataDir, { recursive: true }).catch((err) => {
      throw new AppError('IO', `无法创建目标数据目录：${AppError.from(err).message}`, { targetDataDir });
    });
  }

  return { targetDataDir, isDefault, existed, empty };
}

/**
 * 迁移 AppHub 管理的数据到目标目录：
 *  - 只复制 MANAGED_ENTRIES（存在才复制），不复制 tmp/logs/Chromium 缓存等；
 *  - 目标已存在同名条目时先删除再复制（force 覆盖，保证目标与源一致）；
 *  - 返回实际复制的顶层条目名。
 */
export async function migrateAppHubData(
  currentDataDir: string,
  targetDataDir: string,
  options: MigrateOptions = {},
): Promise<string[]> {
  const source = path.resolve(currentDataDir);
  const target = path.resolve(targetDataDir);
  if (isSamePath(source, target)) {
    throw new AppError('VALIDATION', '源目录与目标目录相同，无法迁移');
  }
  if (isPathInside(source, target)) {
    throw new AppError('VALIDATION', '目标目录不能位于当前数据目录内，无法迁移');
  }
  try {
    await mkdir(target, { recursive: true });
  } catch (err) {
    throw new AppError('IO', `无法创建目标数据目录：${AppError.from(err).message}`, { targetDataDir: target });
  }

  const copied: string[] = [];
  for (const entry of MANAGED_ENTRIES) {
    const from = path.join(source, entry);
    const to = path.join(target, entry);
    if (isSamePath(from, to)) {
      throw new AppError('VALIDATION', `迁移目标与源条目重叠：${entry}`);
    }
    if (isPathInside(from, to)) {
      throw new AppError('VALIDATION', `目标条目位于源条目内，已中止迁移：${entry}`);
    }
    const info = await stat(from).catch((err) => {
      if (errorCode(err) === 'ENOENT') return null;
      throw AppError.from(err, 'IO');
    });
    if (!info) {
      options.logger?.debug('迁移跳过不存在的条目', { entry });
      continue;
    }
    try {
      await rm(to, { recursive: true, force: true });
      await cp(from, to, { recursive: true, force: true, errorOnExist: false });
    } catch (err) {
      throw new AppError('IO', `迁移 ${entry} 失败：${AppError.from(err).message}`, { entry });
    }
    copied.push(entry);
  }
  return copied;
}

// ---------------------------------------------------------------------------
// 旧版数据迁移（userData 根 → <userData>/AppHubData）
// ---------------------------------------------------------------------------

export type LegacyMigrationResult =
  | { migrated: true; entries: string[] }
  | { migrated: false; reason: 'target-not-empty' };

export interface LegacyMigrationDeps {
  renameImpl?: (from: string, to: string) => Promise<void>;
  cpImpl?: (from: string, to: string) => Promise<void>;
  rmImpl?: (target: string) => Promise<void>;
  mkdirImpl?: (target: string, options: { recursive: boolean }) => Promise<unknown>;
  existsImpl?: (target: string) => boolean;
}

async function moveEntry(
  from: string,
  to: string,
  deps: LegacyMigrationDeps,
): Promise<void> {
  const renameImpl = deps.renameImpl ?? rename;
  try {
    await renameImpl(from, to);
    return;
  } catch (err) {
    // 跨盘（移动盘/不同分区）时 rename 报 EXDEV，退化为 copy + rm（语义仍是 move，不保留双份）
    if (errorCode(err) !== 'EXDEV') throw err;
  }
  await (deps.cpImpl?.(from, to) ?? cp(from, to, { recursive: true, force: true, errorOnExist: false }));
  await (deps.rmImpl?.(from) ?? rm(from, { recursive: true, force: true }));
}

/**
 * 把旧版（直接位于 Electron userData 根）的 AppHub 数据迁移到默认子目录。
 *
 *  - 只迁移 MANAGED_ENTRIES（存在才迁移），不迁移 tmp/logs/Chromium 缓存；
 *  - 目标已有任一 managed 条目时视为“已迁移/新数据”，返回 migrated:false，不覆盖；
 *  - 采用 move（rename，EXDEV 时 copy+rm），避免旧版 library 等大数据出现双份；
 *  - 迁移中途失败会尽力回滚已移动条目再抛 AppError('IO')，让 index.ts 本次回退旧目录、下次启动重试。
 */
export async function migrateLegacyAppHubData(
  baseDataDir: string,
  defaultDataDir: string,
  logger?: Logger,
  deps: LegacyMigrationDeps = {},
): Promise<LegacyMigrationResult> {
  const base = path.resolve(baseDataDir);
  const target = path.resolve(defaultDataDir);
  if (isSamePath(base, target)) {
    throw new AppError('VALIDATION', '旧版数据目录与默认数据目录相同，无需迁移');
  }
  const exists = deps.existsImpl ?? existsSync;
  const legacyEntries = MANAGED_ENTRIES.filter((entry) => exists(path.join(base, entry)));
  if (legacyEntries.length === 0) {
    return { migrated: true, entries: [] };
  }
  const targetHasManaged = MANAGED_ENTRIES.some((entry) => exists(path.join(target, entry)));
  if (targetHasManaged) {
    logger?.warn('默认数据目录已有 AppHub 数据，跳过旧版迁移（不覆盖新数据）', {
      baseDataDir: base,
      defaultDataDir: target,
    });
    return { migrated: false, reason: 'target-not-empty' };
  }

  const mkdirImpl = deps.mkdirImpl ?? ((dir: string) => mkdir(dir, { recursive: true }));
  try {
    await mkdirImpl(target, { recursive: true });
  } catch (err) {
    throw new AppError('IO', `无法创建默认数据目录：${AppError.from(err).message}`, {
      defaultDataDir: target,
    });
  }

  const moved: string[] = [];
  try {
    for (const entry of legacyEntries) {
      await moveEntry(path.join(base, entry), path.join(target, entry), deps);
      moved.push(entry);
    }
  } catch (err) {
    // 回滚已移动条目，避免数据被拆散导致下次启动误判“新目录已有数据”
    for (const entry of [...moved].reverse()) {
      try {
        await moveEntry(path.join(target, entry), path.join(base, entry), deps);
      } catch {
        /* 回滚失败：保留现状并交由上层记录错误 */
      }
    }
    throw new AppError('IO', `迁移旧版 AppHub 数据失败：${AppError.from(err).message}`, {
      baseDataDir: base,
      defaultDataDir: target,
      movedEntries: moved,
    });
  }

  logger?.info('已将旧版 AppHub 数据迁移到默认子目录', {
    entries: moved,
    baseDataDir: base,
    defaultDataDir: target,
  });
  return { migrated: true, entries: moved };
}

// ---------------------------------------------------------------------------
// 启动期数据目录不可用：决策 + 恢复流程（可注入依赖，便于单测）
// ---------------------------------------------------------------------------

export type StartupDataDirDecision =
  | { action: 'prompt-recovery'; message: string; detail: string }
  | { action: 'exit' };

export interface StartupDataDirFailureInput {
  source: DataDirSource;
  dataDir: string;
  error: unknown;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return '未知错误';
}

/**
 * 启动期数据目录准备失败时的决策：
 *  - source==='custom'：弹窗让用户选择“恢复默认并重启 / 退出”（否则用户永远进不了 UI 改回）；
 *  - default/env：沿用原错误路径（直接退出，交还上游/环境变量负责）。
 */
export function decideStartupDataDirRecovery(input: StartupDataDirFailureInput): StartupDataDirDecision {
  if (input.source !== 'custom') return { action: 'exit' };
  return {
    action: 'prompt-recovery',
    message: '自定义数据目录无法访问',
    detail: `${path.resolve(input.dataDir)}\n${describeError(input.error)}\n\n可以恢复为默认数据目录后重启，或退出并修复磁盘/权限后重试。`,
  };
}

export interface StartupDataDirRecoveryHandlers {
  /** 显示“恢复默认 / 退出”对话框，返回按钮索引（0=恢复默认，其它=退出）。 */
  showRecoveryDialog: (message: string, detail: string) => number;
  /** 删除引导配置（dataDir=null）。 */
  writeDefaultConfig: (electronUserDataDir: string) => void;
  relaunch: () => void;
  exit: (code: number) => void;
}

export interface HandleStartupDataDirFailureOptions extends StartupDataDirFailureInput {
  electronUserDataDir: string;
  handlers: StartupDataDirRecoveryHandlers;
  logger?: Logger;
}

export type StartupDataDirFailureOutcome = 'recovery-scheduled' | 'exited' | 'exited-dialog-error';

/**
 * 处理启动期数据目录不可用：记录日志 →（仅 custom）弹窗 → 恢复默认并重启 / 退出。
 * 所有副作用通过 handlers 注入，index.ts 负责接 Electron 的 dialog/app。
 */
export function handleStartupDataDirFailure(
  options: HandleStartupDataDirFailureOptions,
): StartupDataDirFailureOutcome {
  const decision = decideStartupDataDirRecovery(options);
  const reason = describeError(options.error);
  options.logger?.error('数据目录不可用，App 无法继续启动', {
    source: options.source,
    dataDir: path.resolve(options.dataDir),
    reason,
    code: options.error instanceof AppError ? options.error.code : undefined,
  });

  if (decision.action === 'exit') {
    options.handlers.exit(1);
    return 'exited';
  }

  let choice: number;
  try {
    choice = options.handlers.showRecoveryDialog(decision.message, decision.detail);
  } catch (err) {
    options.logger?.warn('弹出数据目录恢复对话框失败，按退出处理', { message: describeError(err) });
    options.handlers.exit(1);
    return 'exited-dialog-error';
  }

  if (choice !== 0) {
    options.handlers.exit(1);
    return 'exited';
  }

  // 用户选择“恢复默认”：尽力删除引导配置；即使失败也重启（下次启动可能再次提示，但不会永久卡死）。
  try {
    options.handlers.writeDefaultConfig(options.electronUserDataDir);
    options.logger?.info('已清除自定义数据目录引导配置，准备以默认数据目录重启', {
      failedDataDir: path.resolve(options.dataDir),
      electronUserDataDir: path.resolve(options.electronUserDataDir),
    });
  } catch (err) {
    options.logger?.error('清除自定义数据目录引导配置失败（仍尝试重启）', { message: describeError(err) });
  }
  options.handlers.relaunch();
  options.handlers.exit(0);
  return 'recovery-scheduled';
}
