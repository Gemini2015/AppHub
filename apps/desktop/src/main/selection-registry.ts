import { AppError, normalizeRelativePath } from '@apphub/protocol';
import { inspectZipArchive } from '@apphub/core';
import { dialog } from 'electron';
import type { OpenDialogOptions } from 'electron';
import { randomUUID } from 'node:crypto';
import { lstat, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from './logger';
import type { InspectSelectionResultDTO, PickKind, PublishSelectionDTO } from '../../shared/ipc';

/**
 * 文件选择注册表（selection registry）。
 *
 * 设计目标（docs/ARCHITECTURE.md §4.3/§6）：
 *  - 文件系统绝对路径只存在于主进程内存，渲染进程只拿到 selectionId / 文件 token；
 *  - 文件选择后立即做数量/大小/符号链接校验，避免发布阶段才发现不可用；
 *  - 记录带 TTL（默认 30 分钟），过期后按 NOT_FOUND 处理；
 *  - zip 内容检查委托 @apphub/core 的 inspectZipArchive（core 尚未导出时给可读 UNSUPPORTED）。
 */

export const SELECTION_LIMITS = {
  /** 文件夹递归文件数上限。 */
  maxFiles: 20_000,
  /** 单文件大小上限（2 GiB）。 */
  maxFileSize: 2 * 1024 * 1024 * 1024,
  /** 单次选择总大小上限（32 GiB）。 */
  maxTotalSize: 32 * 1024 * 1024 * 1024,
  /** 选择记录有效期。 */
  ttlMs: 30 * 60 * 1000,
  /** 内存中同时保留的选择记录上限（超出后淘汰最旧记录）。 */
  maxSelections: 64,
} as const;

export interface SelectionFileRecord {
  /** 本地绝对路径：只允许在主进程内使用，不得进入 DTO。 */
  absPath: string;
  /** 相对路径（POSIX 分隔符），作为发布后的 targetPath。 */
  relativePath: string;
  size: number;
}

export interface SelectionRecord {
  id: string;
  kind: PickKind;
  createdAt: number;
  expiresAt: number;
  files: SelectionFileRecord[];
  /** folder 选择时的根目录（zip 发布模式下作为 zipFromDir）。 */
  rootDir?: string;
  /** zip 选择时的压缩包路径/名称/大小。 */
  zipPath?: string;
  zipName?: string;
  zipSize?: number;
}

export interface ZipInspectionResult {
  files: { path: string; size: number }[];
  suggestedEntry?: string | null;
}

export type ZipInspector = (zipPath: string) => Promise<ZipInspectionResult>;

export interface SelectionDialogResult {
  canceled: boolean;
  filePaths?: string[];
}

export interface SelectionDialogLike {
  showOpenDialog(options: OpenDialogOptions): Promise<SelectionDialogResult>;
}

export interface SelectionRegistryOptions {
  logger: Logger;
  dialog?: SelectionDialogLike;
  /** 覆盖 zip 检查实现（测试注入）；缺省使用 @apphub/core 的 inspectZipArchive。 */
  inspectZipArchive?: ZipInspector | null;
  maxFiles?: number;
  maxFileSize?: number;
  maxTotalSize?: number;
  ttlMs?: number;
  maxSelections?: number;
  now?: () => number;
  newId?: () => string;
}

interface ResolvedLimits {
  maxFiles: number;
  maxFileSize: number;
  maxTotalSize: number;
  ttlMs: number;
  maxSelections: number;
}

/** 从候选路径中推荐启动入口：优先 .exe，再 .cmd、.bat，最后字典序第一个文件。 */
export function suggestEntry(paths: readonly string[]): string | null {
  if (paths.length === 0) return null;
  const groups = [/\.exe$/i, /\.cmd$/i, /\.bat$/i];
  for (const pattern of groups) {
    const matches = paths.filter((candidate) => pattern.test(candidate)).sort(comparePath);
    if (matches.length > 0) return matches[0] ?? null;
  }
  return [...paths].sort(comparePath)[0] ?? null;
}

function comparePath(a: string, b: string): number {
  return a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' });
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${bytes} B`;
}

function dialogOptionsFor(kind: PickKind): OpenDialogOptions {
  switch (kind) {
    case 'files':
      return { title: '选择要发布的文件', properties: ['openFile', 'multiSelections'] };
    case 'folder':
      return { title: '选择要发布的文件夹', properties: ['openDirectory'] };
    case 'zip':
      return {
        title: '选择要发布的 zip 压缩包',
        properties: ['openFile'],
        filters: [{ name: 'ZIP 压缩包', extensions: ['zip'] }],
      };
  }
}

// ---------------------------------------------------------------------------
// E2E 文件选择注入（测试专用；生产环境返回 null，行为完全不变）
// ---------------------------------------------------------------------------

const E2E_PICK_ENV = {
  folder: 'APPHUB_E2E_PICK_FOLDER',
  zip: 'APPHUB_E2E_PICK_ZIP',
  files: 'APPHUB_E2E_PICK_FILES',
} as const;

function hasZipFilter(options: OpenDialogOptions): boolean {
  return (options.filters ?? []).some((filter) =>
    (filter.extensions ?? []).some((extension) => extension.replace(/^\./, '').toLowerCase() === 'zip'),
  );
}

function readSinglePathEnv(env: NodeJS.ProcessEnv, key: string): string | null {
  const raw = env[key]?.trim();
  return raw && raw.length > 0 ? raw : null;
}

/** 解析 APPHUB_E2E_PICK_FILES：优先 JSON 字符串数组，其次 path.delimiter 分隔。 */
function readFilesEnv(env: NodeJS.ProcessEnv): string[] | null {
  const raw = env[E2E_PICK_ENV.files]?.trim();
  if (!raw) return null;
  let candidates: string[];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    candidates = parsed.filter((value): value is string => typeof value === 'string');
  } catch {
    candidates = raw.split(path.delimiter);
  }
  const filePaths = candidates.map((value) => value.trim()).filter((value) => value.length > 0);
  return filePaths.length > 0 ? filePaths : null;
}

/**
 * E2E 测试钩子：当 `APPHUB_E2E === '1'` 时返回伪造的文件选择对话框，让 Playwright
 * 能驱动“发布/选择文件/文件夹/zip”流程（原生对话框无法自动化）。
 *
 * 约定（对应 env 缺失即返回 canceled，**绝不回退真实 native dialog**，避免 E2E 卡死）：
 *  - `properties` 含 `openDirectory` → APPHUB_E2E_PICK_FOLDER（绝对目录）
 *  - `filters` 含 zip 扩展名 → APPHUB_E2E_PICK_ZIP（zip 路径）
 *  - 其余（files）→ APPHUB_E2E_PICK_FILES（JSON 数组字符串；也兼容 path.delimiter 分隔）
 *
 * 非 E2E 环境返回 null；index.ts 只在非 null 时注入，生产路径完全不变。
 */
export function createE2ESelectionDialog(
  env: NodeJS.ProcessEnv = process.env,
): SelectionDialogLike | null {
  if (env.APPHUB_E2E !== '1') return null;
  return {
    async showOpenDialog(options: OpenDialogOptions): Promise<SelectionDialogResult> {
      if ((options.properties ?? []).includes('openDirectory')) {
        const folder = readSinglePathEnv(env, E2E_PICK_ENV.folder);
        return folder ? { canceled: false, filePaths: [folder] } : { canceled: true };
      }
      if (hasZipFilter(options)) {
        const zip = readSinglePathEnv(env, E2E_PICK_ENV.zip);
        return zip ? { canceled: false, filePaths: [zip] } : { canceled: true };
      }
      const files = readFilesEnv(env);
      return files ? { canceled: false, filePaths: files } : { canceled: true };
    },
  };
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * 递归收集目录下的普通文件（跳过符号链接/特殊文件），并执行限额校验。
 * 返回文件按相对路径排序，保证建议入口与 UI 展示稳定。
 */
export async function collectFolderFiles(
  rootDir: string,
  limits: { maxFiles: number; maxFileSize: number; maxTotalSize: number },
  logger?: Logger,
): Promise<SelectionFileRecord[]> {
  const root = path.resolve(rootDir);
  const files: SelectionFileRecord[] = [];
  let totalSize = 0;

  async function walk(dir: string, relativeDir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => comparePath(a.name, b.name));
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      const relative = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        logger?.debug('跳过符号链接', { relativePath: relative });
        continue;
      }
      if (entry.isDirectory()) {
        await walk(absolute, relative);
        continue;
      }
      if (!entry.isFile()) {
        logger?.debug('跳过非普通文件', { relativePath: relative });
        continue;
      }
      if (!isInside(root, absolute)) {
        throw new AppError('SECURITY', `目录内容越界：${relative}`);
      }
      const info = await lstat(absolute);
      const safeRelative = normalizeRelativePath(relative, '文件相对路径');
      if (info.size > limits.maxFileSize) {
        throw new AppError(
          'VALIDATION',
          `文件过大：${relative}（${formatBytes(info.size)}，单文件上限 ${formatBytes(limits.maxFileSize)}）`,
        );
      }
      files.push({ absPath: absolute, relativePath: safeRelative, size: info.size });
      totalSize += info.size;
      if (files.length > limits.maxFiles) {
        throw new AppError('VALIDATION', `文件数量超过上限（${limits.maxFiles}），请改用 zip 方式发布`);
      }
      if (totalSize > limits.maxTotalSize) {
        throw new AppError(
          'VALIDATION',
          `所选内容总大小超过上限（${formatBytes(limits.maxTotalSize)}），请改用 zip 或拆分发布`,
        );
      }
    }
  }

  await walk(root, '');
  files.sort((a, b) => comparePath(a.relativePath, b.relativePath));
  return files;
}

export class SelectionRegistry {
  private readonly logger: Logger;
  private readonly dialog: SelectionDialogLike;
  private readonly limits: ResolvedLimits;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly injectedZipInspector: ZipInspector | null | undefined;
  private cachedCoreInspector: ZipInspector | undefined;

  private readonly selections = new Map<string, SelectionRecord>();
  /** 文件 token -> selectionId（token 不下发真实路径）。 */
  private readonly fileTokens = new Map<string, string>();

  constructor(options: SelectionRegistryOptions) {
    this.logger = options.logger;
    this.dialog = options.dialog ?? {
      showOpenDialog: (dialogOptions) => dialog.showOpenDialog(dialogOptions),
    };
    this.limits = {
      maxFiles: options.maxFiles ?? SELECTION_LIMITS.maxFiles,
      maxFileSize: options.maxFileSize ?? SELECTION_LIMITS.maxFileSize,
      maxTotalSize: options.maxTotalSize ?? SELECTION_LIMITS.maxTotalSize,
      ttlMs: options.ttlMs ?? SELECTION_LIMITS.ttlMs,
      maxSelections: options.maxSelections ?? SELECTION_LIMITS.maxSelections,
    };
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? (() => randomUUID());
    this.injectedZipInspector = options.inspectZipArchive;
  }

  /** 当前保留的选择记录数（测试/诊断用）。 */
  get size(): number {
    this.sweep();
    return this.selections.size;
  }

  /**
   * 弹出系统文件选择框并登记选择。
   * 取消时返回 null（不创建记录）。
   */
  async pick(kind: PickKind): Promise<PublishSelectionDTO | null> {
    this.sweep();
    const result = await this.dialog.showOpenDialog(dialogOptionsFor(kind));
    if (!result || result.canceled) return null;
    const selectedPaths = (result.filePaths ?? []).filter(
      (candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0,
    );
    if (selectedPaths.length === 0) return null;

    const record = await this.buildRecord(kind, selectedPaths);
    this.evictIfNeeded();
    this.selections.set(record.id, record);
    this.logger.info('登记文件选择', {
      kind,
      fileCount: record.files.length,
      totalSize: record.files.reduce((sum, file) => sum + file.size, 0),
    });
    return {
      selectionId: record.id,
      kind: record.kind,
      files:
        record.kind === 'zip'
          ? []
          : record.files.map((file) => ({
              id: this.issueFileToken(record.id),
              name: path.posix.basename(file.relativePath),
              relativePath: file.relativePath,
              size: file.size,
            })),
    };
  }

  /** 取选择记录（同时处理过期），未知/过期一律 NOT_FOUND。 */
  get(selectionId: string): SelectionRecord {
    this.sweep();
    if (typeof selectionId !== 'string' || selectionId.length === 0) {
      throw new AppError('NOT_FOUND', '选择记录不存在，请重新选择文件');
    }
    const record = this.selections.get(selectionId);
    if (!record) throw new AppError('NOT_FOUND', '选择记录不存在或已过期，请重新选择文件');
    if (record.expiresAt <= this.now()) {
      this.delete(selectionId);
      throw new AppError('NOT_FOUND', '选择记录已过期，请重新选择文件');
    }
    return record;
  }

  /** 检查选择内容（files/folder 直接返回列表；zip 读取压缩包目录）。 */
  async inspect(selectionId: string): Promise<InspectSelectionResultDTO> {
    const record = this.get(selectionId);
    if (record.kind === 'zip') {
      const inspector = this.resolveZipInspector();
      const zipPath = record.zipPath;
      if (!zipPath) {
        throw new AppError('STATE', 'zip 选择记录损坏（缺少压缩包路径），请重新选择');
      }
      const raw = await inspector(zipPath);
      const normalized = normalizeZipInspection(raw);
      const files = normalized.files;
      const suggested = pickSuggestedEntry(normalized.suggestedEntry, files.map((file) => file.path));
      return {
        kind: 'zip',
        files,
        suggestedEntry: suggested,
        zip: { name: record.zipName ?? path.basename(zipPath), size: record.zipSize ?? 0 },
      };
    }
    const files = record.files.map((file) => ({ path: file.relativePath, size: file.size }));
    return {
      kind: record.kind,
      files,
      suggestedEntry: suggestEntry(files.map((file) => file.path)),
    };
  }

  /** 清空所有选择记录（退出时调用）。 */
  clear(): void {
    this.selections.clear();
    this.fileTokens.clear();
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  private async buildRecord(kind: PickKind, selectedPaths: readonly string[]): Promise<SelectionRecord> {
    const id = this.newId();
    const createdAt = this.now();
    const expiresAt = createdAt + this.limits.ttlMs;
    switch (kind) {
      case 'files': {
        const files: SelectionFileRecord[] = [];
        const seen = new Set<string>();
        let totalSize = 0;
        for (const selectedPath of selectedPaths) {
          let info;
          try {
            info = await stat(selectedPath);
          } catch {
            throw new AppError('NOT_FOUND', `所选文件不存在：${path.basename(selectedPath)}`);
          }
          if (!info.isFile()) {
            throw new AppError('VALIDATION', `所选路径不是文件：${path.basename(selectedPath)}`);
          }
          const relativePath = normalizeRelativePath(path.basename(selectedPath), '文件名');
          if (seen.has(relativePath.toLowerCase())) {
            throw new AppError('VALIDATION', `所选文件存在重名：${relativePath}，请改用文件夹或 zip 方式发布`);
          }
          seen.add(relativePath.toLowerCase());
          if (info.size > this.limits.maxFileSize) {
            throw new AppError(
              'VALIDATION',
              `文件过大：${relativePath}（单文件上限 ${formatBytes(this.limits.maxFileSize)}）`,
            );
          }
          totalSize += info.size;
          if (files.length + 1 > this.limits.maxFiles) {
            throw new AppError('VALIDATION', `文件数量超过上限（${this.limits.maxFiles}）`);
          }
          if (totalSize > this.limits.maxTotalSize) {
            throw new AppError('VALIDATION', `所选文件总大小超过上限（${formatBytes(this.limits.maxTotalSize)}）`);
          }
          files.push({ absPath: path.resolve(selectedPath), relativePath, size: info.size });
        }
        files.sort((a, b) => comparePath(a.relativePath, b.relativePath));
        return { id, kind, createdAt, expiresAt, files };
      }
      case 'folder': {
        const root = selectedPaths[0];
        if (!root) throw new AppError('VALIDATION', '未选择文件夹');
        let info;
        try {
          info = await stat(root);
        } catch {
          throw new AppError('NOT_FOUND', '所选文件夹不存在');
        }
        if (!info.isDirectory()) throw new AppError('VALIDATION', '所选路径不是文件夹');
        const files = await collectFolderFiles(root, this.limits, this.logger);
        if (files.length === 0) throw new AppError('VALIDATION', '所选文件夹中没有可发布的文件');
        return { id, kind, createdAt, expiresAt, files, rootDir: path.resolve(root) };
      }
      case 'zip': {
        const zipPath = selectedPaths[0];
        if (!zipPath) throw new AppError('VALIDATION', '未选择 zip 文件');
        let info;
        try {
          info = await stat(zipPath);
        } catch {
          throw new AppError('NOT_FOUND', '所选 zip 文件不存在');
        }
        if (!info.isFile()) throw new AppError('VALIDATION', '所选路径不是文件');
        if (!/\.zip$/i.test(zipPath)) throw new AppError('VALIDATION', 'zip 发布模式必须选择 .zip 文件');
        if (info.size > this.limits.maxTotalSize) {
          throw new AppError('VALIDATION', `压缩包过大（上限 ${formatBytes(this.limits.maxTotalSize)}）`);
        }
        return {
          id,
          kind,
          createdAt,
          expiresAt,
          files: [],
          zipPath: path.resolve(zipPath),
          zipName: path.basename(zipPath),
          zipSize: info.size,
        };
      }
      default: {
        throw new AppError('VALIDATION', `未知的选择类型：${String(kind)}`);
      }
    }
  }

  private issueFileToken(selectionId: string): string {
    const token = this.newId();
    this.fileTokens.set(token, selectionId);
    return token;
  }

  private delete(selectionId: string): void {
    this.selections.delete(selectionId);
    for (const [token, owner] of this.fileTokens) {
      if (owner === selectionId) this.fileTokens.delete(token);
    }
  }

  private sweep(): void {
    const now = this.now();
    for (const [id, record] of this.selections) {
      if (record.expiresAt <= now) this.delete(id);
    }
  }

  private evictIfNeeded(): void {
    this.sweep();
    while (this.selections.size >= this.limits.maxSelections) {
      const oldest = [...this.selections.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
      if (!oldest) break;
      this.delete(oldest.id);
    }
  }

  private resolveZipInspector(): ZipInspector {
    if (this.injectedZipInspector !== undefined) {
      if (this.injectedZipInspector === null) {
        throw new AppError('UNSUPPORTED', '当前版本不支持 zip 内容检查');
      }
      return this.injectedZipInspector;
    }
    if (this.cachedCoreInspector === undefined) {
      this.cachedCoreInspector = defaultZipInspector;
    }
    return this.cachedCoreInspector;
  }
}

/** 默认的 zip 检查实现：委托 @apphub/core 的纯函数（含 zip-slip/大小/符号链接校验）。 */
async function defaultZipInspector(zipPath: string): Promise<ZipInspectionResult> {
  const inspection = await inspectZipArchive(zipPath);
  return { files: inspection.files, suggestedEntry: inspection.suggestedEntry };
}

/** 校验 core 返回的 zip 目录结构，并统一为安全的相对路径。 */
export function normalizeZipInspection(raw: unknown): ZipInspectionResult {
  if (typeof raw !== 'object' || raw === null || !Array.isArray((raw as { files?: unknown }).files)) {
    throw new AppError('UNSUPPORTED', 'zip 检查返回结构不兼容（缺少 files 数组）');
  }
  const rawFiles = (raw as { files: unknown[] }).files;
  const files = rawFiles.map((entry) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new AppError('UNSUPPORTED', 'zip 检查返回了非法的文件条目');
    }
    const record = entry as { path?: unknown; name?: unknown; size?: unknown };
    const rawPath = typeof record.path === 'string' ? record.path : record.name;
    if (typeof rawPath !== 'string' || rawPath.length === 0) {
      throw new AppError('UNSUPPORTED', 'zip 检查返回了缺少路径的文件条目');
    }
    // 压缩包内路径也要走协议路径校验（拒绝 ../、绝对路径、Windows 保留名等）
    const safePath = normalizeRelativePath(rawPath, '压缩包内文件路径');
    const size = typeof record.size === 'number' && Number.isFinite(record.size) ? Math.max(0, Math.trunc(record.size)) : 0;
    return { path: safePath, size };
  });
  const rawSuggested = (raw as { suggestedEntry?: unknown }).suggestedEntry;
  let suggestedEntry: string | null = null;
  if (typeof rawSuggested === 'string' && rawSuggested.length > 0) {
    try {
      suggestedEntry = normalizeRelativePath(rawSuggested, '压缩包内启动入口');
    } catch {
      suggestedEntry = null;
    }
  }
  return { files, suggestedEntry };
}

function pickSuggestedEntry(rawSuggested: string | null | undefined, paths: readonly string[]): string | null {
  if (rawSuggested && paths.includes(rawSuggested)) return rawSuggested;
  return suggestEntry(paths);
}
