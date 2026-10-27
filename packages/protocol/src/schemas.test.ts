import { describe, expect, it } from 'vitest';
import {
  AppError,
  ChannelFileSchemaStrict,
  ChannelPrivateFileSchemaStrict,
  FilesFileSchemaStrict,
  AppMetaFileSchemaStrict,
  parseAppMetaFile,
  parseChannelFile,
  parseChannelPrivateFile,
  parseFilesFile,
  serializeAppMetaFile,
  serializeChannelFile,
  serializeChannelPrivateFile,
  serializeFilesFile,
  StorageConfigSchema,
  stringifyJson,
} from './index';
import type {
  AppMetaFile,
  ChannelFile,
  ChannelPrivateFile,
  FilesFile,
  FtpHttpStorageConfig,
  LocalHostStorageConfig,
} from './index';

const CHANNEL_ID = 'ch_0123456789abcdef0123';

/** 测试 fixture 的深部分类型：允许外层字段与嵌套对象字段只写一部分（用于测试默认值填充）。 */
type DeepPartial<T> = T extends readonly (infer U)[]
  ? U[]
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

export function makeFilesFile(overrides: DeepPartial<FilesFile> = {}): FilesFile {
  const files = [
    { path: 'foobar.exe', size: 11, md5: '0123456789abcdef0123456789abcdef' },
    { path: 'resources/data.txt', size: 5, md5: '0123456789abcdef0123456789abcdef' },
  ];
  return {
    schemaVersion: 1,
    kind: 'apphub-files',
    appId: 'foobar',
    channelId: CHANNEL_ID,
    version: '1.0.0',
    platform: 'windows',
    publishMode: 'files',
    entry: 'foobar.exe',
    totalSize: 16,
    fileCount: 2,
    files,
    generatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as FilesFile;
}

export function makeAppMeta(overrides: DeepPartial<AppMetaFile> = {}): AppMetaFile {
  const files = makeFilesFile().files;
  return {
    schemaVersion: 1,
    kind: 'apphub-app-meta',
    appId: 'foobar',
    channelId: CHANNEL_ID,
    name: 'foobar',
    displayName: 'FooBar',
    description: '示例 App',
    author: 'AppHub',
    publishMode: 'files',
    entry: 'foobar.exe',
    platforms: ['windows'],
    latest: { windows: '1.0.0' },
    versions: [
      {
        version: '1.0.0',
        platform: 'windows',
        publishMode: 'files',
        entry: 'foobar.exe',
        publishedAt: '2026-01-01T00:00:00.000Z',
        changelog: 'first release',
        totalSize: 16,
        fileCount: 2,
        filesUrl: '1.0.0/files.json',
        downloadBaseUrl: '1.0.0/',
        files,
      },
    ],
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as AppMetaFile;
}

export function makeChannel(overrides: DeepPartial<ChannelFile> = {}): ChannelFile {
  const meta = makeAppMeta();
  return {
    schemaVersion: 1,
    kind: 'apphub-channel',
    id: CHANNEL_ID,
    name: 'example',
    description: '示例频道',
    visibility: 'public',
    owner: { name: 'Owner' },
    apps: [
      {
        appId: 'foobar',
        name: 'FooBar',
        displayName: 'FooBar',
        description: meta.description,
        author: meta.author,
        entry: 'foobar.exe',
        platforms: ['windows'],
        publishMode: 'files',
        latest: { windows: '1.0.0' },
        metaUrl: 'foobar/app.meta.json',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as ChannelFile;
}

export const ftpStorage: FtpHttpStorageConfig = {
  provider: 'ftp-http',
  ftp: {
    host: '127.0.0.1',
    port: 2121,
    secure: false,
    user: 'apphub',
    password: 'secret',
    rootDir: 'app_repo/',
    passive: true,
    timeoutMs: 20000,
  },
  http: { baseUrl: 'http://127.0.0.1:8080/app_repo/' },
};

export function makeChannelPrivate(overrides: DeepPartial<ChannelPrivateFile> = {}): ChannelPrivateFile {
  return {
    schemaVersion: 1,
    kind: 'apphub-channel-private',
    channelId: CHANNEL_ID,
    channelName: 'example',
    visibility: 'public',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    storage: ftpStorage,
    owner: { name: 'Owner' },
    admins: [],
    ...overrides,
  } as ChannelPrivateFile;
}

describe('channel.json', () => {
  it('解析合法文件并填充默认值', () => {
    const parsed = parseChannelFile(JSON.stringify(makeChannel({ description: '', owner: {} })));
    expect(parsed.description).toBe('');
    expect(parsed.owner.name).toBe('');
    expect(parsed.visibility).toBe('public');
  });

  it('拒绝重复 App / 私密频道缺 access / 公开频道带 access', () => {
    const channel = makeChannel();
    const duplicated = { ...channel, apps: [channel.apps[0], channel.apps[0]] };
    expect(() => parseChannelFile(JSON.stringify(duplicated))).toThrow(AppError);

    const privateNoAccess = { ...makeChannel(), visibility: 'private' };
    expect(() => parseChannelFile(JSON.stringify(privateNoAccess))).toThrow(AppError);

    const publicWithAccess = {
      ...makeChannel(),
      access: { type: 'secret-url' },
    };
    expect(() => parseChannelFile(JSON.stringify(publicWithAccess))).toThrow(AppError);

    const okPrivate = {
      ...makeChannel(),
      visibility: 'private',
      access: { type: 'secret-url' },
    };
    expect(ChannelFileSchemaStrict.parse(okPrivate).visibility).toBe('private');
  });

  it('拒绝非法 metaUrl 与 appId', () => {
    const channel = makeChannel();
    const badMeta = {
      ...channel,
      apps: [{ ...channel.apps[0], metaUrl: '../escape/app.meta.json' }],
    };
    expect(() => parseChannelFile(JSON.stringify(badMeta))).toThrow(AppError);
    const badAppId = {
      ...channel,
      apps: [{ ...channel.apps[0], appId: 'Bad Name' }],
    };
    expect(() => parseChannelFile(JSON.stringify(badAppId))).toThrow(AppError);
  });
});

describe('app.meta.json', () => {
  it('解析合法文件并序列化可回环', () => {
    const text = serializeAppMetaFile(makeAppMeta());
    const parsed = parseAppMetaFile(text);
    expect(parsed.versions).toHaveLength(1);
    expect(parsed.latest.windows).toBe('1.0.0');
    expect(parseAppMetaFile(serializeAppMetaFile(parsed))).toEqual(parsed);
  });

  it('拒绝重复版本、入口不在文件列表、latest 悬空、zip 缺 archive', () => {
    const meta = makeAppMeta();
    const duplicated = { ...meta, versions: [meta.versions[0], meta.versions[0]] };
    expect(() => parseAppMetaFile(JSON.stringify(duplicated))).toThrow(AppError);

    const badEntry = {
      ...meta,
      versions: [{ ...meta.versions[0], entry: 'missing.exe' }],
    };
    expect(() => parseAppMetaFile(JSON.stringify(badEntry))).toThrow(AppError);

    const danglingLatest = { ...meta, latest: { windows: '9.9.9' } };
    expect(() => parseAppMetaFile(JSON.stringify(danglingLatest))).toThrow(AppError);

    const zipWithoutArchive = {
      ...meta,
      publishMode: 'zip' as const,
      versions: [{ ...meta.versions[0], publishMode: 'zip' as const }],
    };
    expect(() => parseAppMetaFile(JSON.stringify(zipWithoutArchive))).toThrow(AppError);
  });
});

describe('files.json', () => {
  it('校验 fileCount/totalSize/entry 一致性', () => {
    expect(parseFilesFile(serializeFilesFile(makeFilesFile())).fileCount).toBe(2);
    expect(() => parseFilesFile(JSON.stringify(makeFilesFile({ totalSize: 1 })))).toThrow(AppError);
    expect(() => parseFilesFile(JSON.stringify(makeFilesFile({ fileCount: 3 })))).toThrow(AppError);
    expect(() => parseFilesFile(JSON.stringify(makeFilesFile({ entry: 'nope.exe' })))).toThrow(AppError);
  });

  it('拒绝非法 MD5', () => {
    const bad = makeFilesFile();
    bad.files = [{ path: 'a.exe', size: 1, md5: 'not-md5' }];
    expect(() => FilesFileSchemaStrict.parse(bad)).toThrow();
  });
});

describe('channel_pri.json', () => {
  it('解析公/私频道配置', () => {
    const publicPri = parseChannelPrivateFile(serializeChannelPrivateFile(makeChannelPrivate()));
    expect(publicPri.storage.provider).toBe('ftp-http');

    const privatePri = makeChannelPrivate({
      visibility: 'private',
      accessKey: 'abcdef0123456789abcdef0123456789',
    });
    expect(parseChannelPrivateFile(serializeChannelPrivateFile(privatePri)).accessKey).toBe(
      privatePri.accessKey,
    );
  });

  it('私密频道必须有 accessKey，公开频道不能有', () => {
    expect(() =>
      ChannelPrivateFileSchemaStrict.parse(makeChannelPrivate({ visibility: 'private' })),
    ).toThrow(/accessKey/);
    expect(() =>
      ChannelPrivateFileSchemaStrict.parse(
        makeChannelPrivate({ visibility: 'public', accessKey: 'abcdef0123456789abcdef0123456789' }),
      ),
    ).toThrow(/accessKey/);
  });

  it('存储地址必须是 http(s)', () => {
    const bad = makeChannelPrivate();
    bad.storage = {
      provider: 'local',
      rootDir: 'C:/repo',
      publicBaseUrl: 'file:///C:/repo',
    };
    expect(() => ChannelPrivateFileSchemaStrict.parse(bad)).toThrow(/http\(s\)/);
  });
});

describe('local-host 存储配置（本机 Host）', () => {
  it('默认监听 0.0.0.0:8787，并可通过 channel_pri 序列化往返', () => {
    const pri = makeChannelPrivate({
      storage: { provider: 'local-host', rootDir: 'D:/AppHubRepo' },
    });
    const parsed = parseChannelPrivateFile(serializeChannelPrivateFile(pri));
    const storage = parsed.storage as LocalHostStorageConfig;
    expect(storage).toEqual({
      provider: 'local-host',
      rootDir: 'D:/AppHubRepo',
      port: 8787,
      bindHost: '0.0.0.0',
    });
    expect(StorageConfigSchema.parse({ provider: 'local-host', rootDir: '/repo' })).toMatchObject({
      port: 8787,
      bindHost: '0.0.0.0',
    });
  });

  it('支持 advertiseHost / publicBaseUrl / 仅本机绑定', () => {
    const storage = StorageConfigSchema.parse({
      provider: 'local-host',
      rootDir: '/repo',
      port: 18888,
      bindHost: '127.0.0.1',
      advertiseHost: 'apphub.lan',
      publicBaseUrl: 'https://apps.example.com/repo/',
    }) as LocalHostStorageConfig;
    expect(storage.port).toBe(18888);
    expect(storage.bindHost).toBe('127.0.0.1');
    expect(storage.advertiseHost).toBe('apphub.lan');
    expect(storage.publicBaseUrl).toBe('https://apps.example.com/repo/');
  });

  it('拒绝非法端口 / bindHost / advertiseHost / publicBaseUrl', () => {
    const bads: unknown[] = [
      { provider: 'local-host', rootDir: '/repo', port: 0 },
      { provider: 'local-host', rootDir: '/repo', port: 70000 },
      { provider: 'local-host', rootDir: '/repo', bindHost: '192.168.1.2' },
      { provider: 'local-host', rootDir: '/repo', advertiseHost: 'http://x' },
      { provider: 'local-host', rootDir: '/repo', advertiseHost: 'host:8080' },
      { provider: 'local-host', rootDir: '/repo', publicBaseUrl: 'ftp://x/' },
      { provider: 'local-host', rootDir: '' },
    ];
    for (const bad of bads) {
      expect(StorageConfigSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('serialize helpers', () => {
  it('stringifyJson 带结尾换行且拒绝循环引用', () => {
    expect(stringifyJson({ a: 1 })).toBe('{\n  "a": 1\n}\n');
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => stringifyJson(cyclic)).toThrow(AppError);
  });

  it('顶层不是对象时报 VALIDATION', () => {
    expect(() => parseChannelFile('[]')).toThrow(/顶层必须是对象/);
    expect(() => parseChannelFile('not json')).toThrow(/不是合法 JSON/);
  });

  it('schema 输出类型与默认值一致', () => {
    const parsed = AppMetaFileSchemaStrict.parse(makeAppMeta());
    expect(parsed.versions[0].changelog).toBe('first release');
    const files = FilesFileSchemaStrict.parse(makeFilesFile());
    expect(files.publishMode).toBe('files');
  });
});
