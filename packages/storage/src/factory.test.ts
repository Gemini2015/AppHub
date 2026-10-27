import { describe, expect, it } from 'vitest';
import { AppError, isAppError } from '@apphub/protocol';
import type {
  FtpHttpStorageConfig,
  LocalHostStorageConfig,
  LocalStorageConfig,
  S3StorageConfig,
  StorageConfig,
} from '@apphub/protocol';
import { FtpHttpStorageAdapter } from './adapters/ftp-http';
import { LocalHostStorageAdapter } from './adapters/local-host';
import { LocalStorageAdapter } from './adapters/local';
import { S3StorageAdapter } from './adapters/s3';
import { createStorageAdapter, createStorageFactory } from './factory';

const localConfig: LocalStorageConfig = {
  provider: 'local',
  rootDir: 'E:\\tmp\\apphub-test-repo',
  publicBaseUrl: 'http://127.0.0.1:8080/app_repo/',
};

const localHostConfig: LocalHostStorageConfig = {
  provider: 'local-host',
  rootDir: 'E:\\tmp\\apphub-host-repo',
  port: 8787,
  bindHost: '0.0.0.0',
};

const ftpHttpConfig: FtpHttpStorageConfig = {
  provider: 'ftp-http',
  ftp: {
    host: '127.0.0.1',
    port: 21,
    secure: false,
    user: 'apphub',
    password: 'secret-password',
    rootDir: 'app_repo/',
    passive: true,
    timeoutMs: 20_000,
  },
  http: { baseUrl: 'http://127.0.0.1:8080/app_repo/' },
};

const s3Config: S3StorageConfig = {
  provider: 's3',
  endpoint: 'http://127.0.0.1:9000',
  region: 'us-east-1',
  bucket: 'apphub',
  accessKey: 'access-key',
  secretKey: 'secret-key',
  pathStyle: true,
  secure: false,
  prefix: 'apphub/',
};

function expectAppErrorWithCode(operation: () => unknown, code: AppError['code']): void {
  try {
    operation();
  } catch (error) {
    expect(isAppError(error)).toBe(true);
    expect((error as AppError).code).toBe(code);
    return;
  }
  throw new Error(`期望抛出 ${code}，但操作成功`);
}

describe('storage factory', () => {
  it('按 provider 返回对应适配器实例（同步创建、惰性连接）', () => {
    const local = createStorageAdapter(localConfig);
    expect(local).toBeInstanceOf(LocalStorageAdapter);
    expect(local.provider).toBe('local');
    expect(local.config).toBe(localConfig);

    const localHost = createStorageAdapter(localHostConfig);
    expect(localHost).toBeInstanceOf(LocalHostStorageAdapter);
    expect(localHost.provider).toBe('local-host');
    expect(localHost.config).toBe(localHostConfig);

    const ftp = createStorageAdapter(ftpHttpConfig);
    expect(ftp).toBeInstanceOf(FtpHttpStorageAdapter);
    expect(ftp.provider).toBe('ftp-http');

    const s3 = createStorageAdapter(s3Config);
    expect(s3).toBeInstanceOf(S3StorageAdapter);
    expect(s3.provider).toBe('s3');
  });

  it('createStorageFactory().create 每次返回新的适配器实例', () => {
    const factory = createStorageFactory();
    const first = factory.create(s3Config);
    const second = factory.create(s3Config);
    expect(first).toBeInstanceOf(S3StorageAdapter);
    expect(second).toBeInstanceOf(S3StorageAdapter);
    expect(first).not.toBe(second);

    const hostFirst = factory.create(localHostConfig);
    const hostSecond = factory.create(localHostConfig);
    expect(hostFirst).toBeInstanceOf(LocalHostStorageAdapter);
    expect(hostSecond).toBeInstanceOf(LocalHostStorageAdapter);
    expect(hostFirst).not.toBe(hostSecond);
  });

  it('local-host 适配器由工厂创建：provider 正确、getDownloadUrl 使用推导出的本机地址', async () => {
    const adapter = createStorageAdapter(localHostConfig);
    try {
      // 真正的读写由 core/book 测试覆盖；这里只断言工厂产物具备 local-host 的 provider 与 URL 语义
      expect(adapter.provider).toBe('local-host');
      expect(adapter).toBeInstanceOf(LocalHostStorageAdapter);
      const url = await adapter.getDownloadUrl('channel.json');
      expect(url).toMatch(/^http:\/\/[^/]+:8787\/channel\.json$/);
    } finally {
      await adapter.close();
    }
  });

  it('未知 provider 抛 UNSUPPORTED（防御性分支）', () => {
    expectAppErrorWithCode(
      () => createStorageAdapter({ provider: 'webdav' } as unknown as StorageConfig),
      'UNSUPPORTED',
    );
    expectAppErrorWithCode(
      () => createStorageAdapter({ provider: undefined } as unknown as StorageConfig),
      'UNSUPPORTED',
    );
    expectAppErrorWithCode(() => createStorageAdapter(null as unknown as StorageConfig), 'UNSUPPORTED');
  });

  it('非法配置在创建阶段抛 VALIDATION（无需网络）', () => {
    const invalidConfigs: StorageConfig[] = [
      { ...localConfig, rootDir: '' },
      { ...localHostConfig, rootDir: '' },
      { ...localHostConfig, publicBaseUrl: 'ftp://not-http/' },
      { ...localHostConfig, port: 0 },
      { ...s3Config, bucket: '' },
      { ...s3Config, prefix: '../escape/' },
      { ...ftpHttpConfig, ftp: { ...ftpHttpConfig.ftp, rootDir: '../escape' } },
    ];
    for (const config of invalidConfigs) {
      expectAppErrorWithCode(() => createStorageAdapter(config), 'VALIDATION');
    }
  });

  it('协议解析后的存储配置可直接创建适配器', () => {
    // 与 core/desktop 的真实用法一致：channel_pri.json 经 zod 解析后交给工厂
    const parsed: StorageConfig = {
      provider: 's3',
      bucket: 'apphub',
      accessKey: 'key',
      secretKey: 'secret',
      region: 'us-east-1',
      pathStyle: true,
      secure: true,
      prefix: '',
    };
    expect(createStorageAdapter(parsed)).toBeInstanceOf(S3StorageAdapter);

    const parsedHost: StorageConfig = {
      provider: 'local-host',
      rootDir: 'E:\\tmp\\apphub-host-repo',
      port: 8787,
      bindHost: '0.0.0.0',
    };
    expect(createStorageAdapter(parsedHost)).toBeInstanceOf(LocalHostStorageAdapter);
  });
});
