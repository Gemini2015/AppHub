import { describe, expect, it } from 'vitest';
import {
  AppError,
  assertAppId,
  assertSafeRelativePath,
  compareVersions,
  encodeUrlPath,
  isSafeRelativePath,
  isValidVersion,
  maxVersion,
  newAccessKey,
  newChannelId,
  normalizeRelativePath,
  parseVersion,
  resolveAppMetaUrl,
  resolveFileDownloadUrl,
  resolveUrl,
  serializeError,
  slugifyAppName,
  sortVersionsDesc,
} from './index';
import { appendUrl, channelDescriptorKey, versionFilePathKey } from './paths';
import { isChannelId, isAccessKey } from './ids';

describe('errors', () => {
  it('序列化为可跨进程传递的结构', () => {
    const error = new AppError('NETWORK', '连接失败', { host: 'x' });
    expect(error.toJSON()).toEqual({ code: 'NETWORK', message: '连接失败', details: { host: 'x' } });
    expect(serializeError(new Error('boom'))).toMatchObject({ code: 'INTERNAL', message: 'boom' });
    expect(serializeError(error)).toEqual(error.toJSON());
  });

  it('从 errno 映射常见错误码', () => {
    const errno = Object.assign(new Error('no file'), { code: 'ENOENT' });
    expect(serializeError(errno).code).toBe('NOT_FOUND');
    const auth = Object.assign(new Error('denied'), { code: 'EACCES' });
    expect(serializeError(auth).code).toBe('AUTH');
  });
});

describe('version', () => {
  it('校验 semver', () => {
    expect(isValidVersion('1.0.0')).toBe(true);
    expect(isValidVersion('0.0.1')).toBe(true);
    expect(isValidVersion('1.2.3-beta.1')).toBe(true);
    expect(isValidVersion('1.2.3+build.5')).toBe(true);
    for (const bad of ['1.0', 'v1.0.0', '01.0.0', '1.0.0.0', '1.0.0-', '..', '1.0.0/..', '']) {
      expect(isValidVersion(bad), bad).toBe(false);
    }
  });

  it('按 semver 优先级比较', () => {
    expect(compareVersions('1.0.0', '1.0.1')).toBeLessThan(0);
    expect(compareVersions('1.10.0', '1.9.9')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0-alpha', '1.0.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0-alpha.1', '1.0.0-alpha.beta')).toBeLessThan(0);
    expect(compareVersions('1.0.0-beta.2', '1.0.0-beta.11')).toBeLessThan(0);
    expect(compareVersions('1.0.0+build.1', '1.0.0+build.2')).toBe(0);
    expect(parseVersion('1.2.3-rc.1+sha.5')).toMatchObject({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: ['rc', '1'],
      build: ['sha', '5'],
    });
  });

  it('maxVersion 与降序排序', () => {
    expect(maxVersion(['1.0.0', '2.0.0-beta', '1.9.9', 'not-a-version'])).toBe('2.0.0-beta');
    expect(sortVersionsDesc(['1.0.0', '2.1.0', '0.9.0', 'bad'])).toEqual(['2.1.0', '1.0.0', '0.9.0', 'bad']);
  });
});

describe('paths', () => {
  it('归一化相对路径', () => {
    expect(normalizeRelativePath('a\\b\\c.txt')).toBe('a/b/c.txt');
    expect(normalizeRelativePath('./a//b/./c')).toBe('a/b/c');
  });

  it('拒绝越权/危险路径', () => {
    for (const bad of ['../secret', 'a/../../b', '/etc/passwd', 'C:\\Windows\\system32', '\\\\server\\share', 'a\0b', 'con.txt', 'a/b.']) {
      expect(isSafeRelativePath(bad), bad).toBe(false);
      expect(() => assertSafeRelativePath(bad)).toThrow(AppError);
    }
  });

  it('URL 拼接与解析', () => {
    expect(appendUrl('http://example.com/app_repo/', 'foobar/1.0.0/my file.exe')).toBe(
      'http://example.com/app_repo/foobar/1.0.0/my%20file.exe',
    );
    expect(encodeUrlPath('a/中文 b.txt')).toContain('%E4%B8%AD');
    expect(resolveAppMetaUrl('http://example.com/app_repo/channel.json', 'foobar/app.meta.json')).toBe(
      'http://example.com/app_repo/foobar/app.meta.json',
    );
    expect(
      resolveAppMetaUrl(
        'http://example.com/app_repo/_private/ch_1/key/channel.json',
        'foobar/app.meta.json',
      ),
    ).toBe('http://example.com/app_repo/_private/ch_1/key/foobar/app.meta.json');
    expect(resolveFileDownloadUrl('http://example.com/app_repo/foobar/1.0.0/', 'bin/本工具.exe')).toBe(
      'http://example.com/app_repo/foobar/1.0.0/bin/%E6%9C%AC%E5%B7%A5%E5%85%B7.exe',
    );
    expect(resolveUrl('http://a/b/channel.json', 'https://cdn.example.com/x.json')).toBe(
      'https://cdn.example.com/x.json',
    );
    expect(() => resolveUrl('http://a/b', 'javascript:alert(1)')).toThrow(AppError);
  });

  it('存储对象 key 规则', () => {
    expect(channelDescriptorKey('public', 'ch_1234567890abcdefghij')).toBe('channel.json');
    const privateKey = channelDescriptorKey('private', 'ch_1234567890abcdefghij', 'abc123');
    expect(privateKey).toBe('_private/ch_1234567890abcdefghij/abc123/channel.json');
    expect(versionFilePathKey('foobar', '1.0.0', 'bin/foobar.exe')).toBe(
      'foobar/1.0.0/bin/foobar.exe',
    );
  });
});

describe('ids', () => {
  it('生成合法频道 ID 与访问密钥', () => {
    for (let i = 0; i < 20; i += 1) {
      const channelId = newChannelId();
      expect(isChannelId(channelId)).toBe(true);
      const key = newAccessKey();
      expect(isAccessKey(key)).toBe(true);
    }
  });

  it('slugify App 名称', () => {
    expect(slugifyAppName('Foo Bar 工具')).toBe('foo-bar');
    expect(slugifyAppName('  Hello__World  ')).toBe('hello_world');
    expect(slugifyAppName('中文名')).toMatch(/^app-[0-9a-f]+$/);
    expect(() => assertAppId(slugifyAppName('中文名'))).not.toThrow();
    expect(() => assertAppId('Bad Name')).toThrow(AppError);
  });
});
