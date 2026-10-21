import { AppError } from '@apphub/protocol';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * IPC sender frame 校验策略。
 *
 * 规则（docs/ARCHITECTURE.md §4.3/§6）：
 *  - 生产（无 dev server）：只接受加载 `<out>/renderer/index.html` 的 file:// frame；
 *  - 开发（APPHUB_DEV_SERVER_URL）：只接受该 dev server origin（含 localhost/127.0.0.1 回环等价）；
 *  - 其他来源（data:、远程 http、其他页面、空 url）一律拒绝。
 *
 * 本文件保持纯函数（只依赖 node:path/node:url），便于单元测试。
 */

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export interface SenderPolicyOptions {
  /** 开发模式 dev server 地址；生产模式必须为空。 */
  devServerUrl?: string;
  /** 生产模式渲染进程 index.html 的绝对路径。 */
  appIndexFile: string;
}

export interface SenderPolicy {
  readonly appIndexFile: string;
  readonly devServerUrl?: string;
  isAllowed(url: string | null | undefined): boolean;
}

function normalizePathForCompare(target: string): string {
  const resolved = path.resolve(target);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isLoopbackEquivalent(candidate: URL, devOrigin: URL): boolean {
  if (candidate.protocol !== devOrigin.protocol) return false;
  if (candidate.port !== devOrigin.port) return false;
  return LOOPBACK_HOSTS.has(candidate.hostname) && LOOPBACK_HOSTS.has(devOrigin.hostname);
}

/** 尝试把 URL 解析为本地文件绝对路径；非 file: 或非法 URL 返回 null。 */
export function fileUrlToLocalPath(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'file:') return null;
  const clean = new URL(url.href);
  clean.search = '';
  clean.hash = '';
  try {
    return fileURLToPath(clean);
  } catch {
    return null;
  }
}

export function createSenderPolicy(options: SenderPolicyOptions): SenderPolicy {
  const appIndexFile = path.resolve(options.appIndexFile);
  const appIndexComparable = normalizePathForCompare(appIndexFile);
  const devServerUrl = options.devServerUrl?.trim() || undefined;

  let devOrigin: URL | null = null;
  if (devServerUrl) {
    try {
      devOrigin = new URL(devServerUrl);
    } catch {
      throw new AppError('VALIDATION', `APPHUB_DEV_SERVER_URL 不是合法 URL：${devServerUrl}`);
    }
    if (devOrigin.protocol !== 'http:' && devOrigin.protocol !== 'https:') {
      throw new AppError('VALIDATION', 'APPHUB_DEV_SERVER_URL 必须是 http(s) 地址');
    }
  }

  function isAllowed(rawUrl: string | null | undefined): boolean {
    if (typeof rawUrl !== 'string' || rawUrl.length === 0) return false;
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return false;
    }
    if (devOrigin) {
      if (url.origin === devOrigin.origin) return true;
      return isLoopbackEquivalent(url, devOrigin);
    }
    if (url.protocol !== 'file:') return false;
    const filePath = fileUrlToLocalPath(rawUrl);
    if (filePath === null) return false;
    return normalizePathForCompare(filePath) === appIndexComparable;
  }

  return { appIndexFile, devServerUrl, isAllowed };
}

/** 校验 sender frame 来源，不受信任时抛 AppError('SECURITY')。 */
export function assertTrustedSender(policy: SenderPolicy, frameUrl: string | null | undefined): void {
  if (!policy.isAllowed(frameUrl)) {
    throw new AppError('SECURITY', 'IPC 调用来源不受信任，已拒绝');
  }
}
