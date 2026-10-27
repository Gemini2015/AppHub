import { AppError } from '@apphub/protocol';
import { createFakeLogger } from '@apphub/testkit';
import { cp, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BOOTSTRAP_FILE_NAME,
  DEFAULT_DATA_DIR_NAME,
  MANAGED_ENTRIES,
  bootstrapFilePath,
  decideStartupDataDirRecovery,
  defaultAppDataDir,
  handleStartupDataDirFailure,
  isPathInside,
  isSamePath,
  migrateAppHubData,
  migrateLegacyAppHubData,
  readDataDirConfig,
  resolveAppDataDir,
  validateTargetDataDir,
  writeDataDirConfig,
} from './data-dir';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'apphub-data-dir-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function userDataDir(): string {
  return path.join(tempDir, 'userData');
}

async function createFile(relativePath: string, content: string): Promise<string> {
  const target = path.join(tempDir, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, 'utf8');
  return target;
}

// ---------------------------------------------------------------------------
// 引导配置读写
// ---------------------------------------------------------------------------

describe('data-dir：bootstrap 引导配置', () => {
  it('写入绝对路径、读取、删除（恢复默认）', async () => {
    const userData = userDataDir();
    await mkdir(userData, { recursive: true });
    const custom = path.join(tempDir, 'custom-data');

    writeDataDirConfig(userData, custom);
    expect(bootstrapFilePath(userData)).toBe(path.join(path.resolve(userData), BOOTSTRAP_FILE_NAME));
    expect(readDataDirConfig(userData)).toEqual({ dataDir: path.resolve(custom) });

    writeDataDirConfig(userData, null);
    expect(readDataDirConfig(userData)).toEqual({});
    await expect(stat(bootstrapFilePath(userData))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('userData 目录不存在时写入会自动创建', async () => {
    const userData = path.join(tempDir, 'not-exists-yet', 'userData');
    const custom = path.join(tempDir, 'custom2');
    writeDataDirConfig(userData, custom);
    expect(readDataDirConfig(userData)).toEqual({ dataDir: path.resolve(custom) });
  });

  it('文件不存在 / JSON 损坏 / 结构非法 / 相对路径时静默回退并 warn', async () => {
    const userData = userDataDir();
    await mkdir(userData, { recursive: true });
    const logger = createFakeLogger();
    // 不存在：静默回退，不 warn
    expect(readDataDirConfig(userData, logger)).toEqual({});
    expect(logger.entries).toHaveLength(0);

    // 损坏 JSON
    await writeFile(bootstrapFilePath(userData), '{ not json', 'utf8');
    expect(readDataDirConfig(userData, logger)).toEqual({});
    expect(logger.entries.some((entry) => entry.level === 'warn')).toBe(true);

    // 数组结构
    await writeFile(bootstrapFilePath(userData), '[]', 'utf8');
    expect(readDataDirConfig(userData, logger)).toEqual({});

    // 相对路径被忽略
    await writeFile(bootstrapFilePath(userData), JSON.stringify({ dataDir: 'relative/dir' }), 'utf8');
    expect(readDataDirConfig(userData, logger)).toEqual({});

    // dataDir 非字符串
    await writeFile(bootstrapFilePath(userData), JSON.stringify({ dataDir: 123 }), 'utf8');
    expect(readDataDirConfig(userData, logger)).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// 数据目录解析优先级
// ---------------------------------------------------------------------------

describe('data-dir：resolveAppDataDir 优先级（Phase7）', () => {
  function defaultDirOf(base: string): string {
    return path.join(path.resolve(base), DEFAULT_DATA_DIR_NAME);
  }

  it('无 env / 无 bootstrap / 无旧数据 → <userData>/AppHubData，source=default 且可编辑', () => {
    const base = userDataDir();
    expect(DEFAULT_DATA_DIR_NAME).toBe('AppHubData');
    expect(defaultAppDataDir(base)).toBe(path.resolve(base, 'AppHubData'));
    const resolved = resolveAppDataDir({ electronUserDataDir: base, env: {} });
    expect(resolved).toEqual({
      dataDir: defaultDirOf(base),
      defaultDataDir: defaultDirOf(base),
      source: 'default',
      editable: true,
    });
  });

  it('bootstrap 自定义目录 → source=custom，defaultDataDir 仍为 AppHubData 子目录', async () => {
    const base = userDataDir();
    await mkdir(base, { recursive: true });
    const custom = path.join(tempDir, 'd-drive-data');
    writeDataDirConfig(base, custom);
    const resolved = resolveAppDataDir({ electronUserDataDir: base, env: {} });
    expect(resolved).toMatchObject({ dataDir: path.resolve(custom), source: 'custom', editable: true });
    expect(resolved.defaultDataDir).toBe(defaultDirOf(base));
    expect(resolved.legacyMigration).toBeUndefined();
  });

  it('APPHUB_USER_DATA_DIR 保持旧语义：dataDir=base，只读、不读 bootstrap', async () => {
    const base = userDataDir();
    await mkdir(base, { recursive: true });
    writeDataDirConfig(base, path.join(tempDir, 'bootstrap-data'));
    const resolved = resolveAppDataDir({
      electronUserDataDir: base,
      env: { APPHUB_USER_DATA_DIR: base },
    });
    expect(resolved).toMatchObject({
      dataDir: path.resolve(base),
      defaultDataDir: defaultDirOf(base),
      source: 'env',
      editable: false,
      envVar: 'APPHUB_USER_DATA_DIR',
    });
    expect(resolved.legacyMigration).toBeUndefined();
  });

  it('APPHUB_DATA_DIR 优先级最高（仅 AppHub 数据、只读），不读 bootstrap、不做旧版迁移', async () => {
    const base = userDataDir();
    await mkdir(base, { recursive: true });
    writeDataDirConfig(base, path.join(tempDir, 'bootstrap-data'));
    // 旧版数据在根目录也不应触发迁移
    await createFile('userData/channels.json', '{"legacy":true}');
    const appDataEnv = path.join(tempDir, 'apphub-data-env');
    const resolved = resolveAppDataDir({
      electronUserDataDir: base,
      env: { APPHUB_DATA_DIR: appDataEnv, APPHUB_USER_DATA_DIR: path.join(tempDir, 'userdata-env') },
    });
    expect(resolved).toMatchObject({
      dataDir: path.resolve(appDataEnv),
      defaultDataDir: defaultDirOf(base),
      source: 'env',
      editable: false,
      envVar: 'APPHUB_DATA_DIR',
    });
    expect(resolved.legacyMigration).toBeUndefined();
  });

  it('空白 env 视为未设置；相对路径 bootstrap 被忽略 → 默认 AppHubData', async () => {
    const base = userDataDir();
    await mkdir(base, { recursive: true });
    await writeFile(bootstrapFilePath(base), JSON.stringify({ dataDir: './relative' }), 'utf8');
    const resolved = resolveAppDataDir({
      electronUserDataDir: base,
      env: { APPHUB_USER_DATA_DIR: '   ', APPHUB_DATA_DIR: '   ' },
      logger: createFakeLogger(),
    });
    expect(resolved).toMatchObject({
      dataDir: defaultDirOf(base),
      defaultDataDir: defaultDirOf(base),
      source: 'default',
      editable: true,
    });
  });

  it('bootstrap 指向 AppHubData 子目录时按 default 处理', async () => {
    const base = userDataDir();
    await mkdir(base, { recursive: true });
    writeDataDirConfig(base, defaultDirOf(base));
    const resolved = resolveAppDataDir({ electronUserDataDir: base, env: {} });
    expect(resolved).toMatchObject({
      dataDir: defaultDirOf(base),
      defaultDataDir: defaultDirOf(base),
      source: 'default',
      editable: true,
    });
  });

  it('检测旧版数据（userData 根）→ 返回 legacyMigration 标记', async () => {
    const base = userDataDir();
    await createFile('userData/channels.json', '{"channels":1}');
    await createFile('userData/channels/ch_1/channel.json', '{}');
    const resolved = resolveAppDataDir({ electronUserDataDir: base, env: {} });
    expect(resolved.dataDir).toBe(defaultDirOf(base));
    expect(resolved.source).toBe('default');
    expect(resolved.legacyMigration).toEqual({
      baseDataDir: path.resolve(base),
      defaultDataDir: defaultDirOf(base),
    });
  });

  it('旧版数据存在但 AppHubData 已有数据 → 不迁移并 warn', async () => {
    const base = userDataDir();
    await createFile('userData/channels.json', '{"legacy":true}');
    await createFile('userData/AppHubData/channels.json', '{"new":true}');
    const logger = createFakeLogger();
    const resolved = resolveAppDataDir({ electronUserDataDir: base, env: {}, logger });
    expect(resolved.legacyMigration).toBeUndefined();
    expect(resolved.dataDir).toBe(defaultDirOf(base));
    expect(logger.entries.some((entry) => entry.level === 'warn')).toBe(true);
  });

  it('仅 apphub.json 不算“新默认目录已有数据”（仍执行旧版迁移）', async () => {
    const base = userDataDir();
    await createFile('userData/channels.json', '{"legacy":true}');
    await createFile('userData/AppHubData/apphub.json', '{"settings":1}');
    const resolved = resolveAppDataDir({ electronUserDataDir: base, env: {} });
    expect(resolved.legacyMigration).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 目标目录校验
// ---------------------------------------------------------------------------

describe('data-dir：validateTargetDataDir', () => {
  async function setup(): Promise<{ current: string; defaultDir: string }> {
    const current = path.join(tempDir, 'current-data');
    const defaultDir = path.join(tempDir, 'electron-user-data');
    await mkdir(current, { recursive: true });
    await mkdir(defaultDir, { recursive: true });
    return { current, defaultDir };
  }

  function validate(
    current: string,
    defaultDir: string,
    targetPath: unknown,
    extra: Partial<Parameters<typeof validateTargetDataDir>[0]> = {},
  ) {
    return validateTargetDataDir({
      currentDataDir: current,
      defaultDataDir: defaultDir,
      targetPath: targetPath as string,
      ...extra,
    });
  }

  it('拒绝空路径 / 相对路径 / 非法字符', async () => {
    const { current, defaultDir } = await setup();
    await expect(validate(current, defaultDir, '')).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(validate(current, defaultDir, '   ')).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(validate(current, defaultDir, 'relative/data')).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(validate(current, defaultDir, null)).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(validate(current, defaultDir, `${path.join(tempDir, 'bad')}\u0000evil`)).rejects.toMatchObject({
      code: 'VALIDATION',
    });
    if (process.platform === 'win32') {
      await expect(validate(current, defaultDir, path.join(tempDir, 'bad<name>'))).rejects.toMatchObject({
        code: 'VALIDATION',
      });
    }
  });

  it('拒绝与当前目录相同 / 嵌套（双向）', async () => {
    const { current, defaultDir } = await setup();
    await expect(validate(current, defaultDir, current)).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(validate(current, defaultDir, path.join(current, 'nested'))).rejects.toMatchObject({
      code: 'VALIDATION',
    });
    await expect(validate(current, defaultDir, tempDir)).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('拒绝已存在的文件；非空目录返回 CONFLICT', async () => {
    const { current, defaultDir } = await setup();
    const filePath = await createFile('not-a-dir.bin', 'x');
    await expect(validate(current, defaultDir, filePath)).rejects.toMatchObject({ code: 'VALIDATION' });

    const nonEmpty = path.join(tempDir, 'non-empty');
    await mkdir(nonEmpty, { recursive: true });
    await writeFile(path.join(nonEmpty, 'some-file.txt'), 'x', 'utf8');
    const conflict = await validate(current, defaultDir, nonEmpty).catch((err: unknown) => err);
    expect(conflict).toBeInstanceOf(AppError);
    expect((conflict as AppError).code).toBe('CONFLICT');
    expect((conflict as AppError).details).toMatchObject({
      targetDataDir: path.resolve(nonEmpty),
      entryCount: 1,
    });
  });

  it('接受不存在的目录并创建；接受空目录', async () => {
    const { current, defaultDir } = await setup();
    const created = path.join(tempDir, 'new', 'deep', 'data');
    const validated = await validate(current, defaultDir, created);
    expect(validated).toMatchObject({ targetDataDir: path.resolve(created), isDefault: false, existed: false, empty: true });
    await expect(stat(created)).resolves.toMatchObject({});

    const emptyDir = path.join(tempDir, 'empty-dir');
    await mkdir(emptyDir, { recursive: true });
    await expect(validate(current, defaultDir, emptyDir)).resolves.toMatchObject({
      targetDataDir: path.resolve(emptyDir),
      existed: true,
      empty: true,
    });
  });

  it('允许恢复默认目录（即使非空），且当前目录嵌套在默认目录内也可恢复', async () => {
    const defaultDir = path.join(tempDir, 'electron-user-data');
    const current = path.join(defaultDir, 'custom-sub');
    await mkdir(current, { recursive: true });
    await writeFile(path.join(defaultDir, 'channels.json'), '{"old":true}', 'utf8');

    const validated = await validate(current, defaultDir, defaultDir);
    expect(validated).toMatchObject({ targetDataDir: path.resolve(defaultDir), isDefault: true, existed: true, empty: false });
  });

  it('可通过注入的 statImpl/readdirImpl/mkdirImpl 做纯逻辑校验', async () => {
    const current = path.join(tempDir, 'current2');
    const defaultDir = path.join(tempDir, 'default2');
    await mkdir(current, { recursive: true });
    const mkdirImpl = vi.fn(async () => undefined);
    const validated = await validateTargetDataDir({
      currentDataDir: current,
      targetPath: path.join(tempDir, 'virtual-target'),
      defaultDataDir: defaultDir,
      statImpl: async () => null,
      mkdirImpl,
    });
    expect(validated.existed).toBe(false);
    expect(mkdirImpl).toHaveBeenCalledWith(path.resolve(tempDir, 'virtual-target'), { recursive: true });
  });
});

// ---------------------------------------------------------------------------
// 数据迁移
// ---------------------------------------------------------------------------

describe('data-dir：migrateAppHubData', () => {
  async function createSource(): Promise<string> {
    const source = path.join(tempDir, 'old-data');
    await createFile('old-data/channels.json', '{"channels":1}');
    await createFile('old-data/apphub.json', '{"settings":1}');
    await createFile('old-data/channels/ch_1/channel.json', '{"id":"ch_1"}');
    await createFile('old-data/secrets/channel_pri/ch_1.enc', 'cipher');
    await createFile('old-data/library/index.json', '{"apps":[]}');
    await createFile('old-data/tmp/download.bin', 'temp');
    await createFile('old-data/logs/main.log', 'log');
    await createFile('old-data/extra-file.txt', 'extra');
    return source;
  }

  it('只复制 AppHub 管理的条目，不复制 tmp/logs/其它文件', async () => {
    const source = await createSource();
    const target = path.join(tempDir, 'new-data');
    const copied = await migrateAppHubData(source, target);

    expect(copied.sort()).toEqual([...MANAGED_ENTRIES].sort());
    await expect(readFile(path.join(target, 'channels.json'), 'utf8')).resolves.toBe('{"channels":1}');
    await expect(readFile(path.join(target, 'channels', 'ch_1', 'channel.json'), 'utf8')).resolves.toBe(
      '{"id":"ch_1"}',
    );
    await expect(readFile(path.join(target, 'secrets', 'channel_pri', 'ch_1.enc'), 'utf8')).resolves.toBe('cipher');
    await expect(readFile(path.join(target, 'library', 'index.json'), 'utf8')).resolves.toBe('{"apps":[]}');
    await expect(readFile(path.join(target, 'apphub.json'), 'utf8')).resolves.toBe('{"settings":1}');
    await expect(stat(path.join(target, 'tmp'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(path.join(target, 'logs'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(path.join(target, 'extra-file.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('目标已有同名条目时覆盖，并清理目标内的陈旧文件', async () => {
    const source = await createSource();
    const target = path.join(tempDir, 'existing-target');
    await createFile('existing-target/channels.json', '{"old":true}');
    await createFile('existing-target/channels/stale.txt', 'stale');

    const copied = await migrateAppHubData(source, target);
    expect(copied).toContain('channels.json');
    await expect(readFile(path.join(target, 'channels.json'), 'utf8')).resolves.toBe('{"channels":1}');
    // 覆盖语义是“先删后复制”，目标中的陈旧文件不应保留
    await expect(stat(path.join(target, 'channels', 'stale.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(path.join(target, 'channels', 'ch_1', 'channel.json'))).resolves.toBeTruthy();
  });

  it('源目录缺失的条目被跳过（只返回实际复制项）', async () => {
    const source = path.join(tempDir, 'minimal-source');
    await createFile('minimal-source/channels.json', '{}');
    const target = path.join(tempDir, 'minimal-target');
    const copied = await migrateAppHubData(source, target);
    expect(copied).toEqual(['channels.json']);
  });

  it('拒绝相同目录 / 目标位于源目录内', async () => {
    const source = await createSource();
    await expect(migrateAppHubData(source, source)).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(migrateAppHubData(source, path.join(source, 'nested'))).rejects.toMatchObject({
      code: 'VALIDATION',
    });
  });

  it('允许源目录位于目标目录内（恢复默认场景：子目录 → 父目录）', async () => {
    const parent = path.join(tempDir, 'restore-default');
    const source = path.join(parent, 'custom-sub');
    await createFile('restore-default/custom-sub/channels.json', '{"from":"custom"}');
    await createFile('restore-default/custom-sub/library/index.json', '{}');

    const copied = await migrateAppHubData(source, parent);
    expect(copied.sort()).toEqual(['channels.json', 'library']);
    await expect(readFile(path.join(parent, 'channels.json'), 'utf8')).resolves.toBe('{"from":"custom"}');
    // 源目录保持完整（复制而非移动）
    await expect(readFile(path.join(source, 'channels.json'), 'utf8')).resolves.toBe('{"from":"custom"}');
  });
});

// ---------------------------------------------------------------------------
// 路径工具
// ---------------------------------------------------------------------------

describe('data-dir：路径工具', () => {
  it('isPathInside / isSamePath', () => {
    const base = path.join(tempDir, 'a');
    expect(isPathInside(base, path.join(base, 'b'))).toBe(true);
    expect(isPathInside(base, path.join(base, 'b', '..foo'))).toBe(true);
    expect(isPathInside(base, base)).toBe(false);
    expect(isPathInside(base, path.join(tempDir, 'c'))).toBe(false);
    expect(isSamePath(base, base)).toBe(true);
    expect(isSamePath(base, path.join(tempDir, 'a'))).toBe(true);
    expect(isSamePath(base, path.join(tempDir, 'b'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 旧版数据迁移（userData 根 → AppHubData）
// ---------------------------------------------------------------------------

describe('data-dir：migrateLegacyAppHubData', () => {
  async function createLegacyLayout(): Promise<{ base: string; target: string }> {
    const base = path.join(tempDir, 'userData');
    const target = defaultAppDataDir(base);
    await createFile('userData/channels.json', '{"channels":1}');
    await createFile('userData/apphub.json', '{"settings":1}');
    await createFile('userData/channels/ch_1/channel.json', '{"id":"ch_1"}');
    await createFile('userData/secrets/channel_pri/ch_1.enc', 'cipher');
    await createFile('userData/library/index.json', '{"apps":[]}');
    await createFile('userData/tmp/download.bin', 'temp');
    await createFile('userData/logs/main.log', 'log');
    await createFile('userData/Cache/cache.bin', 'chromium');
    await createFile('userData/Preferences', '{}');
    return { base, target };
  }

  it('移动 managed 条目到 AppHubData，不迁移 tmp/logs/Chromium，源目录不再保留 managed', async () => {
    const { base, target } = await createLegacyLayout();
    const result = await migrateLegacyAppHubData(base, target);
    expect(result.migrated).toBe(true);
    if (!result.migrated) throw new Error('unreachable');
    expect([...result.entries].sort()).toEqual([...MANAGED_ENTRIES].sort());

    await expect(readFile(path.join(target, 'channels.json'), 'utf8')).resolves.toBe('{"channels":1}');
    await expect(readFile(path.join(target, 'channels', 'ch_1', 'channel.json'), 'utf8')).resolves.toBe(
      '{"id":"ch_1"}',
    );
    await expect(readFile(path.join(target, 'secrets', 'channel_pri', 'ch_1.enc'), 'utf8')).resolves.toBe('cipher');
    await expect(readFile(path.join(target, 'library', 'index.json'), 'utf8')).resolves.toBe('{"apps":[]}');
    await expect(readFile(path.join(target, 'apphub.json'), 'utf8')).resolves.toBe('{"settings":1}');

    // move 语义：源目录不再保留 managed 条目
    for (const entry of MANAGED_ENTRIES) {
      await expect(stat(path.join(base, entry))).rejects.toMatchObject({ code: 'ENOENT' });
    }
    // tmp/logs/Chromium 状态保留在 userData 根，不进入 AppHubData
    await expect(stat(path.join(base, 'tmp', 'download.bin'))).resolves.toBeTruthy();
    await expect(stat(path.join(base, 'logs', 'main.log'))).resolves.toBeTruthy();
    await expect(stat(path.join(base, 'Cache', 'cache.bin'))).resolves.toBeTruthy();
    await expect(stat(path.join(base, 'Preferences'))).resolves.toBeTruthy();
    await expect(stat(path.join(target, 'tmp'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(path.join(target, 'logs'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('目标已有任一 managed 条目 → migrated:false，不覆盖也不动源', async () => {
    const { base, target } = await createLegacyLayout();
    await createFile('userData/AppHubData/channels.json', '{"new":true}');
    const result = await migrateLegacyAppHubData(base, target);
    expect(result).toEqual({ migrated: false, reason: 'target-not-empty' });
    await expect(readFile(path.join(target, 'channels.json'), 'utf8')).resolves.toBe('{"new":true}');
    await expect(readFile(path.join(base, 'channels.json'), 'utf8')).resolves.toBe('{"channels":1}');
  });

  it('源目录无 managed 条目 → migrated:true entries=[]', async () => {
    const base = path.join(tempDir, 'empty-userData');
    await mkdir(base, { recursive: true });
    await expect(migrateLegacyAppHubData(base, defaultAppDataDir(base))).resolves.toEqual({
      migrated: true,
      entries: [],
    });
  });

  it('相同目录 → VALIDATION', async () => {
    const base = path.join(tempDir, 'same-dir');
    await mkdir(base, { recursive: true });
    await expect(migrateLegacyAppHubData(base, base)).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('rename 非 EXDEV 失败 → 回滚已移动条目并抛 AppError(IO)', async () => {
    const { base, target } = await createLegacyLayout();
    const renameImpl = vi.fn(async (from: string, to: string) => {
      if (from.includes(`${path.sep}secrets`)) {
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      }
      await rename(from, to);
    });
    await expect(migrateLegacyAppHubData(base, target, undefined, { renameImpl })).rejects.toMatchObject({
      code: 'IO',
    });
    // 回滚后旧版数据仍完整，便于下次启动重试
    await expect(readFile(path.join(base, 'channels.json'), 'utf8')).resolves.toBe('{"channels":1}');
    await expect(stat(path.join(base, 'channels', 'ch_1', 'channel.json'))).resolves.toBeTruthy();
    await expect(stat(path.join(base, 'secrets', 'channel_pri', 'ch_1.enc'))).resolves.toBeTruthy();
    for (const entry of MANAGED_ENTRIES) {
      await expect(stat(path.join(target, entry))).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  it('跨盘 EXDEV 时退化为 copy+rm（仍是移动语义，不留双份）', async () => {
    const { base, target } = await createLegacyLayout();
    const renameImpl = vi.fn(async () => {
      throw Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' });
    });
    const cpImpl = vi.fn(async (from: string, to: string) => {
      await cp(from, to, { recursive: true, force: true });
    });
    const rmImpl = vi.fn(async (from: string) => {
      await rm(from, { recursive: true, force: true });
    });
    const result = await migrateLegacyAppHubData(base, target, undefined, { renameImpl, cpImpl, rmImpl });
    expect(result.migrated).toBe(true);
    expect(cpImpl.mock.calls.length).toBe(MANAGED_ENTRIES.length);
    expect(rmImpl).toHaveBeenCalledTimes(MANAGED_ENTRIES.length);
    await expect(stat(path.join(base, 'channels.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(path.join(target, 'channels.json'), 'utf8')).resolves.toBe('{"channels":1}');
  });
});

// ---------------------------------------------------------------------------
// 启动期数据目录不可用：决策 + 恢复流程
// ---------------------------------------------------------------------------

describe('data-dir：decideStartupDataDirRecovery', () => {
  it('custom 失败 → 提示恢复默认并重启（detail 含路径/原因/说明）', () => {
    const customDir = path.resolve(tempDir, 'removed-usb', 'AppHubData');
    const decision = decideStartupDataDirRecovery({
      source: 'custom',
      dataDir: customDir,
      error: new AppError('IO', 'ENOENT: 目录不存在'),
    });
    expect(decision.action).toBe('prompt-recovery');
    if (decision.action !== 'prompt-recovery') throw new Error('unreachable');
    expect(decision.message).toBe('自定义数据目录无法访问');
    expect(decision.detail).toContain(customDir);
    expect(decision.detail).toContain('ENOENT: 目录不存在');
    expect(decision.detail).toContain('可以恢复为默认数据目录后重启，或退出并修复磁盘/权限后重试。');
  });

  it('default / env 失败 → 直接退出（保持原错误路径）', () => {
    const error = new Error('permission denied');
    expect(decideStartupDataDirRecovery({ source: 'default', dataDir: tempDir, error })).toEqual({
      action: 'exit',
    });
    expect(decideStartupDataDirRecovery({ source: 'env', dataDir: tempDir, error })).toEqual({
      action: 'exit',
    });
  });

  it('非 Error 抛出值也能生成可读原因', () => {
    const decision = decideStartupDataDirRecovery({
      source: 'custom',
      dataDir: tempDir,
      error: '字符串错误',
    });
    if (decision.action !== 'prompt-recovery') throw new Error('unreachable');
    expect(decision.detail).toContain('字符串错误');
    const unknown = decideStartupDataDirRecovery({ source: 'custom', dataDir: tempDir, error: undefined });
    if (unknown.action !== 'prompt-recovery') throw new Error('unreachable');
    expect(unknown.detail).toContain('未知错误');
  });
});

describe('data-dir：handleStartupDataDirFailure', () => {
  interface Handlers {
    showRecoveryDialog: ReturnType<typeof vi.fn>;
    writeDefaultConfig: ReturnType<typeof vi.fn>;
    relaunch: ReturnType<typeof vi.fn>;
    exit: ReturnType<typeof vi.fn>;
  }

  function makeHandlers(overrides: Partial<Handlers> = {}): Handlers {
    return {
      showRecoveryDialog: vi.fn(() => 1),
      writeDefaultConfig: vi.fn(),
      relaunch: vi.fn(),
      exit: vi.fn(),
      ...overrides,
    };
  }

  function baseOptions(handlers: Handlers, overrides: Record<string, unknown> = {}) {
    return {
      source: 'custom' as const,
      dataDir: path.resolve(tempDir, 'missing-custom-data'),
      electronUserDataDir: path.resolve(tempDir, 'userData'),
      error: new AppError('IO', '自定义目录不可写'),
      handlers,
      logger: createFakeLogger(),
      ...overrides,
    };
  }

  it('custom + 选择“恢复默认” → 删除引导配置 → relaunch → exit(0)', () => {
    const handlers = makeHandlers({ showRecoveryDialog: vi.fn(() => 0) });
    const logger = createFakeLogger();
    const options = baseOptions(handlers, { logger });
    const outcome = handleStartupDataDirFailure(options);

    expect(outcome).toBe('recovery-scheduled');
    expect(handlers.showRecoveryDialog).toHaveBeenCalledWith(
      '自定义数据目录无法访问',
      expect.stringContaining('可以恢复为默认数据目录后重启'),
    );
    expect(handlers.writeDefaultConfig).toHaveBeenCalledWith(options.electronUserDataDir);
    expect(handlers.relaunch).toHaveBeenCalledTimes(1);
    expect(handlers.exit).toHaveBeenCalledWith(0);
    const errorLog = logger.entries.find((entry) => entry.level === 'error');
    expect(errorLog?.meta).toMatchObject({
      source: 'custom',
      dataDir: options.dataDir,
      reason: '自定义目录不可写',
    });
  });

  it('custom + 选择“退出” → 不写配置/不重启，exit(1)', () => {
    const handlers = makeHandlers({ showRecoveryDialog: vi.fn(() => 1) });
    const outcome = handleStartupDataDirFailure(baseOptions(handlers));
    expect(outcome).toBe('exited');
    expect(handlers.writeDefaultConfig).not.toHaveBeenCalled();
    expect(handlers.relaunch).not.toHaveBeenCalled();
    expect(handlers.exit).toHaveBeenCalledWith(1);
  });

  it('弹窗本身抛错 → 按退出处理（exit(1) 且记录 warn）', () => {
    const handlers = makeHandlers({
      showRecoveryDialog: vi.fn(() => {
        throw new Error('dialog unavailable');
      }),
    });
    const logger = createFakeLogger();
    const outcome = handleStartupDataDirFailure(baseOptions(handlers, { logger }));
    expect(outcome).toBe('exited-dialog-error');
    expect(handlers.exit).toHaveBeenCalledWith(1);
    expect(logger.entries.some((entry) => entry.level === 'warn')).toBe(true);
  });

  it('写引导配置失败也尽力重启（exit(0) + 记录 error）', () => {
    const handlers = makeHandlers({
      showRecoveryDialog: vi.fn(() => 0),
      writeDefaultConfig: vi.fn(() => {
        throw new Error('EACCES');
      }),
    });
    const logger = createFakeLogger();
    const outcome = handleStartupDataDirFailure(baseOptions(handlers, { logger }));
    expect(outcome).toBe('recovery-scheduled');
    expect(handlers.relaunch).toHaveBeenCalledTimes(1);
    expect(handlers.exit).toHaveBeenCalledWith(0);
    expect(logger.entries.filter((entry) => entry.level === 'error').length).toBeGreaterThanOrEqual(2);
  });

  it('default / env 失败 → 不弹窗，直接 exit(1)', () => {
    for (const source of ['default', 'env'] as const) {
      const handlers = makeHandlers();
      const outcome = handleStartupDataDirFailure(
        baseOptions(handlers, { source, dataDir: path.resolve(tempDir, source) }),
      );
      expect(outcome).toBe('exited');
      expect(handlers.showRecoveryDialog).not.toHaveBeenCalled();
      expect(handlers.exit).toHaveBeenCalledWith(1);
    }
  });

  it('“恢复默认”真实调用 writeDataDirConfig(null) 时引导配置被删除', async () => {
    const userData = path.join(tempDir, 'userData');
    await mkdir(userData, { recursive: true });
    writeDataDirConfig(userData, path.join(tempDir, 'broken-custom'));
    expect(readDataDirConfig(userData)).toMatchObject({ dataDir: path.resolve(tempDir, 'broken-custom') });

    const handlers = makeHandlers({
      showRecoveryDialog: vi.fn(() => 0),
      writeDefaultConfig: vi.fn((dir: string) => writeDataDirConfig(dir, null)),
    });
    const outcome = handleStartupDataDirFailure(baseOptions(handlers, { electronUserDataDir: userData }));
    expect(outcome).toBe('recovery-scheduled');
    expect(readDataDirConfig(userData)).toEqual({});
    expect(handlers.relaunch).toHaveBeenCalledTimes(1);
    expect(handlers.exit).toHaveBeenCalledWith(0);
  });
});
