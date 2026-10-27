import { AppError } from '@apphub/protocol';
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileUrlToLocalPath, createSenderPolicy, assertTrustedSender } from './sender';

// 使用平台无关的绝对路径构造 fixture：Windows 的 `C:\...` 在 Linux 上不是绝对路径，
// 直接写死会导致 CI（Linux）上的断言失败。
const APP_INDEX = path.resolve('apphub-test-out', 'renderer', 'index.html');

function prodPolicy() {
  return createSenderPolicy({ appIndexFile: APP_INDEX });
}

function fileUrl(filePath: string): string {
  return pathToFileURL(path.resolve(filePath)).href;
}

describe('sender：生产模式（file://）', () => {
  it('只允许加载渲染入口 index.html 的 frame', () => {
    const policy = prodPolicy();
    expect(policy.isAllowed(fileUrl(APP_INDEX))).toBe(true);
    // 带 query/hash 的等价地址也允许
    expect(policy.isAllowed(`${fileUrl(APP_INDEX)}#/channels`)).toBe(true);
    expect(policy.isAllowed(`${fileUrl(APP_INDEX)}?x=1`)).toBe(true);
  });

  it('拒绝其他 file:// 页面（例如被替换的恶意页面）', () => {
    const policy = prodPolicy();
    expect(policy.isAllowed(fileUrl(path.resolve('apphub-test-out', 'renderer', 'evil.html')))).toBe(false);
    expect(policy.isAllowed(fileUrl(path.resolve('evil.exe')))).toBe(false);
    expect(policy.isAllowed(`${fileUrl(APP_INDEX)}.bak`)).toBe(false);
  });

  it('拒绝非 file 协议与空/非法 URL', () => {
    const policy = prodPolicy();
    expect(policy.isAllowed('http://127.0.0.1:5173/')).toBe(false);
    expect(policy.isAllowed('https://evil.example/index.html')).toBe(false);
    expect(policy.isAllowed('data:text/html,<script>alert(1)</script>')).toBe(false);
    expect(policy.isAllowed('')).toBe(false);
    expect(policy.isAllowed(null)).toBe(false);
    expect(policy.isAllowed(undefined)).toBe(false);
    expect(policy.isAllowed('not a url')).toBe(false);
  });

  it('fileUrlToLocalPath 只接受 file: 协议', () => {
    const local = fileUrlToLocalPath(fileUrl(APP_INDEX));
    expect(local).not.toBeNull();
    expect(path.resolve(local as string)).toBe(path.resolve(APP_INDEX));
    expect(fileUrlToLocalPath('https://example.com/a')).toBeNull();
    expect(fileUrlToLocalPath('::::')).toBeNull();
  });
});

describe('sender：开发模式（dev server origin）', () => {
  const devPolicy = () =>
    createSenderPolicy({ devServerUrl: 'http://127.0.0.1:5173/', appIndexFile: APP_INDEX });

  it('允许 dev server origin 下任意路径（含 HMR 页面）', () => {
    const policy = devPolicy();
    expect(policy.isAllowed('http://127.0.0.1:5173/')).toBe(true);
    expect(policy.isAllowed('http://127.0.0.1:5173/src/main.tsx')).toBe(true);
  });

  it('localhost 与 127.0.0.1 回环等价（同一端口/协议）', () => {
    const policy = devPolicy();
    expect(policy.isAllowed('http://localhost:5173/index.html')).toBe(true);
  });

  it('拒绝不同端口 / 其他 origin / file 页面', () => {
    const policy = devPolicy();
    expect(policy.isAllowed('http://127.0.0.1:5174/')).toBe(false);
    expect(policy.isAllowed('http://localhost:9999/')).toBe(false);
    expect(policy.isAllowed('https://127.0.0.1:5173/')).toBe(false);
    expect(policy.isAllowed('http://evil.example:5173/')).toBe(false);
    expect(policy.isAllowed(fileUrl(APP_INDEX))).toBe(false);
  });

  it('非法 APPHUB_DEV_SERVER_URL 直接抛 VALIDATION', () => {
    expect(() => createSenderPolicy({ devServerUrl: 'ftp://example.com', appIndexFile: APP_INDEX })).toThrow(
      AppError,
    );
  });
});

describe('sender：assertTrustedSender', () => {
  it('受信任来源不抛错', () => {
    expect(() => assertTrustedSender(prodPolicy(), fileUrl(APP_INDEX))).not.toThrow();
  });

  it('不受信任来源抛 AppError(SECURITY)', () => {
    try {
      assertTrustedSender(prodPolicy(), 'https://evil.example/');
      throw new Error('应当抛错');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe('SECURITY');
    }
  });
});
