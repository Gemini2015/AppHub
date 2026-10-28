import { AppError } from '@apphub/protocol';
import { createFakeLogger } from '@apphub/testkit';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** core 的 inspectZipArchive 在 core-dev 实现前用 mock 顶替。 */
const coreMock = vi.hoisted(() => ({ inspectZipArchive: vi.fn() }));

vi.mock('@apphub/core', () => ({ inspectZipArchive: coreMock.inspectZipArchive }));
vi.mock('electron', () => ({ dialog: { showOpenDialog: vi.fn() } }));

import type { OpenDialogOptions } from 'electron';
import type { SelectionRegistryOptions } from './selection-registry';
import {
  SELECTION_LIMITS,
  SelectionRegistry,
  createE2ESelectionDialog,
  normalizeZipInspection,
  suggestEntry,
} from './selection-registry';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'apphub-selection-'));
});

afterEach(async () => {
  vi.clearAllMocks();
  await rm(tempDir, { recursive: true, force: true });
});

function makeRegistry(overrides: Partial<SelectionRegistryOptions> = {}): SelectionRegistry {
  return new SelectionRegistry({
    logger: createFakeLogger(),
    dialog: { showOpenDialog: vi.fn() },
    ...overrides,
  });
}

function dialogReturning(filePaths: string[]): SelectionRegistryOptions['dialog'] {
  return { showOpenDialog: vi.fn(async () => ({ canceled: false, filePaths })) };
}

async function writeFileAt(relative: string, content = 'x'): Promise<string> {
  const target = path.join(tempDir, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
  return target;
}

describe('selection-registry：pick files', () => {
  it('生成 selectionId 与文件 token，DTO 中不包含本地绝对路径', async () => {
    const first = await writeFileAt('tool.exe', 'binary');
    const second = await writeFileAt('readme.txt', 'hello');
    const registry = makeRegistry({ dialog: dialogReturning([first, second]) });

    const selection = await registry.pick('files');
    expect(selection).not.toBeNull();
    if (!selection) throw new Error('unreachable');
    expect(selection.kind).toBe('files');
    expect(selection.files.map((file) => file.relativePath).sort()).toEqual(['readme.txt', 'tool.exe']);
    expect(selection.files.every((file) => file.id.length > 0)).toBe(true);
    expect(new Set(selection.files.map((file) => file.id)).size).toBe(2);
    expect(selection.files.find((file) => file.relativePath === 'tool.exe')?.size).toBe(6);
    // 绝对路径绝不能进入 DTO
    const serialized = JSON.stringify(selection);
    expect(serialized).not.toContain(tempDir);
    expect(serialized).not.toContain(tempDir.replace(/\\/g, '\\\\'));
  });

  it('取消选择返回 null 且不登记记录', async () => {
    const registry = makeRegistry({
      dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) },
    });
    await expect(registry.pick('files')).resolves.toBeNull();
    expect(registry.size).toBe(0);
  });

  it('同名文件（不同目录）被拒绝，避免发布目标路径冲突', async () => {
    const a = await writeFileAt('a/tool.exe');
    const b = await writeFileAt('b/tool.exe');
    const registry = makeRegistry({ dialog: dialogReturning([a, b]) });
    await expect(registry.pick('files')).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});

describe('selection-registry：folder 递归', () => {
  it('递归列出文件（相对 POSIX 路径）并推荐 .exe 作为 entry', async () => {
    await writeFileAt('app/run.exe');
    await writeFileAt('app/data/notes.txt');
    await writeFileAt('app/data/nested/extra.bin');
    const registry = makeRegistry({ dialog: dialogReturning([path.join(tempDir, 'app')]) });

    const selection = await registry.pick('folder');
    if (!selection) throw new Error('unreachable');
    const inspected = await registry.inspect(selection.selectionId);
    expect(inspected.kind).toBe('folder');
    expect(inspected.files.map((file) => file.path)).toEqual([
      'data/nested/extra.bin',
      'data/notes.txt',
      'run.exe',
    ]);
    expect(inspected.suggestedEntry).toBe('run.exe');
  });

  it('跳过符号链接（避免把目录外文件带进发布）', async () => {
    const outside = path.join(tempDir, 'outside-secret.txt');
    await writeFile(outside, 'secret');
    const appDir = path.join(tempDir, 'app');
    await mkdir(appDir, { recursive: true });
    await writeFile(path.join(appDir, 'keep.txt'), 'ok');
    let linked = false;
    try {
      await symlink(outside, path.join(appDir, 'link.txt'));
      linked = true;
    } catch {
      // Windows 非管理员/未开启开发者模式时无法创建符号链接，跳过该断言
    }
    if (!linked) return;

    const registry = makeRegistry({ dialog: dialogReturning([appDir]) });
    const selection = await registry.pick('folder');
    if (!selection) throw new Error('unreachable');
    const inspected = await registry.inspect(selection.selectionId);
    expect(inspected.files.map((file) => file.path)).toEqual(['keep.txt']);
  });

  it('空文件夹被拒绝', async () => {
    const emptyDir = path.join(tempDir, 'empty');
    await mkdir(emptyDir, { recursive: true });
    const registry = makeRegistry({ dialog: dialogReturning([emptyDir]) });
    await expect(registry.pick('folder')).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('文件数 / 单文件大小 / 总大小上限生效', async () => {
    await writeFileAt('big/a.bin', '0123456789');
    const countRegistry = makeRegistry({
      dialog: dialogReturning([path.join(tempDir, 'big')]),
      maxFiles: 0,
    });
    await expect(countRegistry.pick('folder')).rejects.toMatchObject({ code: 'VALIDATION' });

    const sizeRegistry = makeRegistry({
      dialog: dialogReturning([path.join(tempDir, 'big')]),
      maxFileSize: 3,
    });
    await expect(sizeRegistry.pick('folder')).rejects.toMatchObject({ code: 'VALIDATION' });

    await writeFileAt('two/a.bin', '01234');
    await writeFileAt('two/b.bin', '01234');
    const totalRegistry = makeRegistry({
      dialog: dialogReturning([path.join(tempDir, 'two')]),
      maxTotalSize: 8,
    });
    await expect(totalRegistry.pick('folder')).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});

describe('selection-registry：过期与未知选择', () => {
  it('未知 selectionId 抛 NOT_FOUND', async () => {
    const registry = makeRegistry();
    await expect(registry.inspect('does-not-exist')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('超过 TTL 的记录按 NOT_FOUND 处理并被清理', async () => {
    const file = await writeFileAt('tool.exe');
    let now = 1_000;
    const registry = makeRegistry({
      dialog: dialogReturning([file]),
      ttlMs: 10,
      now: () => now,
    });
    const selection = await registry.pick('files');
    if (!selection) throw new Error('unreachable');
    now += 10;
    await expect(registry.inspect(selection.selectionId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(registry.size).toBe(0);
  });

  it('超出 maxSelections 时淘汰最旧记录', async () => {
    const first = await writeFileAt('first.exe');
    const second = await writeFileAt('second.exe');
    const dialog = { showOpenDialog: vi.fn() };
    const registry = new SelectionRegistry({
      logger: createFakeLogger(),
      dialog: dialog as unknown as SelectionRegistryOptions['dialog'],
      maxSelections: 1,
    });
    dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [first] });
    dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [second] });
    const selectionA = await registry.pick('files');
    const selectionB = await registry.pick('files');
    if (!selectionA || !selectionB) throw new Error('unreachable');
    expect(registry.size).toBe(1);
    expect(() => registry.get(selectionB.selectionId)).not.toThrow();
    expect(() => registry.get(selectionA.selectionId)).toThrow(AppError);
  });
});

describe('selection-registry：zip', () => {
  it('pick zip 后通过 core.inspectZipArchive 返回目录与建议入口', async () => {
    const zipPath = await writeFileAt('bundle.zip', 'PK-fake-zip-content');
    coreMock.inspectZipArchive.mockResolvedValue({
      files: [
        { path: 'docs/a.txt', size: 2 },
        { path: 'run.exe', size: 10 },
      ],
      suggestedEntry: 'run.exe',
    });

    const registry = makeRegistry({ dialog: dialogReturning([zipPath]) });
    const selection = await registry.pick('zip');
    if (!selection) throw new Error('unreachable');
    expect(selection.files).toEqual([]);

    const inspected = await registry.inspect(selection.selectionId);
    expect(inspected.kind).toBe('zip');
    expect(inspected.files).toEqual([
      { path: 'docs/a.txt', size: 2 },
      { path: 'run.exe', size: 10 },
    ]);
    expect(inspected.suggestedEntry).toBe('run.exe');
    expect(inspected.zip?.name).toBe('bundle.zip');
    expect(inspected.zip?.size).toBeGreaterThan(0);
    expect(coreMock.inspectZipArchive).toHaveBeenCalledTimes(1);
  });

  it('core 未给出建议入口时按 .exe 优先推荐', async () => {
    const zipPath = await writeFileAt('bundle.zip', 'PK');
    coreMock.inspectZipArchive.mockResolvedValue({
      files: [
        { path: 'readme.md', size: 1 },
        { path: 'app.exe', size: 1 },
      ],
      suggestedEntry: null,
    });
    const registry = makeRegistry({ dialog: dialogReturning([zipPath]) });
    const selection = await registry.pick('zip');
    if (!selection) throw new Error('unreachable');
    await expect(registry.inspect(selection.selectionId)).resolves.toMatchObject({ suggestedEntry: 'app.exe' });
  });

  it('压缩包内非法路径（zip-slip）被拒绝', async () => {
    const zipPath = await writeFileAt('evil.zip', 'PK');
    coreMock.inspectZipArchive.mockResolvedValue({
      files: [{ path: '../../etc/passwd', size: 1 }],
      suggestedEntry: null,
    });
    const registry = makeRegistry({ dialog: dialogReturning([zipPath]) });
    const selection = await registry.pick('zip');
    if (!selection) throw new Error('unreachable');
    await expect(registry.inspect(selection.selectionId)).rejects.toMatchObject({ code: 'SECURITY' });
  });

  it('zip 检查抛 AppError 时原样透传（例如压缩包损坏/超限）', async () => {
    const zipPath = await writeFileAt('bundle.zip', 'PK');
    coreMock.inspectZipArchive.mockRejectedValue(new AppError('UNSUPPORTED', 'not implemented'));
    const registry = makeRegistry({ dialog: dialogReturning([zipPath]) });
    const selection = await registry.pick('zip');
    if (!selection) throw new Error('unreachable');
    await expect(registry.inspect(selection.selectionId)).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  });

  it('非 .zip 扩展名被拒绝', async () => {
    const notZip = await writeFileAt('bundle.tar', 'xx');
    const registry = makeRegistry({ dialog: dialogReturning([notZip]) });
    await expect(registry.pick('zip')).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});

describe('selection-registry：建议入口与 zip 结构校验', () => {
  it('suggestEntry 优先 .exe > .cmd > .bat > 字典序', () => {
    expect(suggestEntry([])).toBeNull();
    expect(suggestEntry(['readme.md', 'setup.bat', 'install.cmd', 'game.exe'])).toBe('game.exe');
    expect(suggestEntry(['readme.md', 'setup.bat', 'install.cmd'])).toBe('install.cmd');
    expect(suggestEntry(['readme.md', 'setup.bat'])).toBe('setup.bat');
    expect(suggestEntry(['z.txt', 'a.txt'])).toBe('a.txt');
  });

  it('normalizeZipInspection 拒绝结构不兼容的返回', () => {
    expect(() => normalizeZipInspection(null)).toThrow(AppError);
    expect(() => normalizeZipInspection({})).toThrow(AppError);
    expect(() => normalizeZipInspection({ files: [{ size: 1 }] })).toThrow(AppError);
    expect(normalizeZipInspection({ files: [{ path: 'a/./b.txt', size: 3 }] })).toEqual({
      files: [{ path: 'a/b.txt', size: 3 }],
      suggestedEntry: null,
    });
  });

  it('SELECTION_LIMITS 与契约一致（2 万文件 / 2GiB 单文件）', () => {
    expect(SELECTION_LIMITS.maxFiles).toBe(20_000);
    expect(SELECTION_LIMITS.maxFileSize).toBe(2 * 1024 * 1024 * 1024);
  });
});

// ---------------------------------------------------------------------------
// E2E 文件选择注入（APPHUB_E2E=1）
// ---------------------------------------------------------------------------

describe('selection-registry：E2E 文件选择注入', () => {
  const folderOptions = { properties: ['openDirectory'] } as OpenDialogOptions;
  const zipOptions = {
    properties: ['openFile'],
    filters: [{ name: 'ZIP 压缩包', extensions: ['zip'] }],
  } as OpenDialogOptions;
  const filesOptions = { properties: ['openFile', 'multiSelections'] } as OpenDialogOptions;

  it('非 E2E 环境（未设置/不为 1）返回 null，生产行为不变', () => {
    expect(createE2ESelectionDialog({})).toBeNull();
    expect(createE2ESelectionDialog({ APPHUB_E2E: '0' })).toBeNull();
    expect(createE2ESelectionDialog({ APPHUB_E2E: 'true' })).toBeNull();
  });

  it('E2E + folder 选择使用 APPHUB_E2E_PICK_FOLDER', async () => {
    const dialog = createE2ESelectionDialog({
      APPHUB_E2E: '1',
      APPHUB_E2E_PICK_FOLDER: tempDir,
    });
    expect(dialog).not.toBeNull();
    await expect(dialog!.showOpenDialog(folderOptions)).resolves.toEqual({
      canceled: false,
      filePaths: [tempDir],
    });
  });

  it('E2E + zip 选择使用 APPHUB_E2E_PICK_ZIP（扩展名大小写不敏感）', async () => {
    const zipPath = path.join(tempDir, 'bundle.zip');
    const dialog = createE2ESelectionDialog({
      APPHUB_E2E: '1',
      APPHUB_E2E_PICK_ZIP: zipPath,
    });
    await expect(dialog!.showOpenDialog(zipOptions)).resolves.toEqual({
      canceled: false,
      filePaths: [zipPath],
    });
    await expect(
      dialog!.showOpenDialog({
        properties: ['openFile'],
        filters: [{ name: 'ZIP', extensions: ['ZIP'] }],
      } as OpenDialogOptions),
    ).resolves.toEqual({ canceled: false, filePaths: [zipPath] });
  });

  it('E2E + files 选择支持 JSON 数组与 path.delimiter 两种格式', async () => {
    const first = path.join(tempDir, 'app.exe');
    const second = path.join(tempDir, 'readme.txt');

    const jsonDialog = createE2ESelectionDialog({
      APPHUB_E2E: '1',
      APPHUB_E2E_PICK_FILES: JSON.stringify([first, second]),
    });
    await expect(jsonDialog!.showOpenDialog(filesOptions)).resolves.toEqual({
      canceled: false,
      filePaths: [first, second],
    });

    const delimitedDialog = createE2ESelectionDialog({
      APPHUB_E2E: '1',
      APPHUB_E2E_PICK_FILES: [first, second].join(path.delimiter),
    });
    await expect(delimitedDialog!.showOpenDialog(filesOptions)).resolves.toEqual({
      canceled: false,
      filePaths: [first, second],
    });
  });

  it('缺少匹配 env 时返回 canceled，绝不回退真实原生对话框', async () => {
    const dialog = createE2ESelectionDialog({ APPHUB_E2E: '1' });
    expect(dialog).not.toBeNull();
    await expect(dialog!.showOpenDialog(folderOptions)).resolves.toEqual({ canceled: true });
    await expect(dialog!.showOpenDialog(zipOptions)).resolves.toEqual({ canceled: true });
    await expect(dialog!.showOpenDialog(filesOptions)).resolves.toEqual({ canceled: true });

    // 空白值同样视为缺失
    const blankDialog = createE2ESelectionDialog({
      APPHUB_E2E: '1',
      APPHUB_E2E_PICK_FOLDER: '   ',
      APPHUB_E2E_PICK_ZIP: '',
      APPHUB_E2E_PICK_FILES: '[]',
    });
    await expect(blankDialog!.showOpenDialog(folderOptions)).resolves.toEqual({ canceled: true });
    await expect(blankDialog!.showOpenDialog(zipOptions)).resolves.toEqual({ canceled: true });
    await expect(blankDialog!.showOpenDialog(filesOptions)).resolves.toEqual({ canceled: true });
  });

  it('注入后 SelectionRegistry.pick 可正常走 folder 选择（后续真实校验不变）', async () => {
    const folder = path.join(tempDir, 'picked-folder');
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, 'app.exe'), 'MZ');
    const dialog = createE2ESelectionDialog({
      APPHUB_E2E: '1',
      APPHUB_E2E_PICK_FOLDER: folder,
    });
    const registry = makeRegistry({ dialog: dialog ?? undefined });
    const selection = await registry.pick('folder');
    expect(selection).not.toBeNull();
    expect(selection?.kind).toBe('folder');
    expect(selection?.files.map((file) => file.relativePath)).toEqual(['app.exe']);
  });
});
