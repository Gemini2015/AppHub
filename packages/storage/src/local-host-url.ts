import { networkInterfaces as readNetworkInterfaces } from 'node:os';
import type { NetworkInterfaceInfo } from 'node:os';
import { AppError, isHttpUrl } from '@apphub/protocol';
import type { LocalHostStorageConfig } from '@apphub/protocol';

/**
 * 本机 Host（provider `local-host`）的公开 HTTP 基础地址解析。
 *
 * 背景：`local-host` 频道由 AppHub 主进程在本机启动静态 HTTP 服务提供频道仓库。
 * 默认监听 `0.0.0.0`（局域网可访问），因此订阅地址需要从本机网卡推导出局域网 IP；
 * 同一台机器可能有多块网卡，所以返回首选地址 + 全部候选地址。
 *
 * 纯函数、不监听端口、不读写文件，便于单测与 core 的 HostService 复用。
 */
export interface LocalHostBaseUrls {
  /** 首选订阅地址（带尾部 `/`）。优先级见 resolveLocalHostBaseUrls 文档。 */
  preferredBaseUrl: string;
  /** 本机回环地址（带尾部 `/`），恒为 `http://127.0.0.1:<port>/`。 */
  localBaseUrl: string;
  /** 全部局域网候选地址（带尾部 `/`）；bindHost 非 0.0.0.0 时为空数组。 */
  lanBaseUrls: string[];
}

export interface ResolveLocalHostBaseUrlsOptions {
  /** 覆盖 config.port（实际监听端口/测试注入；须为 1-65535 的整数）。 */
  port?: number;
  /** 注入网卡表（默认 node:os.networkInterfaces），便于单测多网卡/无网卡场景。 */
  networkInterfaces?: () => NodeJS.Dict<NetworkInterfaceInfo[]>;
}

const LOOPBACK_HOST = '127.0.0.1';
const ALL_INTERFACES_HOST = '0.0.0.0';
const DEFAULT_PORT = 8787;
const HTTP_PROTOCOL = 'http';
const MAX_PORT = 65_535;

/** host 中不允许出现的字符（防止拼出带路径/查询/凭据的畸形 URL）。 */
const INVALID_HOST_CHARS = /[/\\?#@\s]/;

function ensureTrailingSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`;
}

function resolvePort(candidate: number | undefined): number {
  const port = candidate ?? DEFAULT_PORT;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > MAX_PORT) {
    throw new AppError(
      'VALIDATION',
      `local-host 端口非法：${String(candidate)}（须为 1-${MAX_PORT} 的整数）`,
    );
  }
  return port;
}

/**
 * 归一化 host：
 *  - 去空白；空串返回 null（调用方回退）；
 *  - 已带方括号的 IPv6 原样返回，裸 IPv6 字面量补 `[]`；
 *  - 含路径/查询/凭据/空白的值视为非法，抛 AppError('VALIDATION')。
 */
function normalizeHost(host: string): string | null {
  const trimmed = host.trim();
  if (trimmed.length === 0) return null;
  if (INVALID_HOST_CHARS.test(trimmed)) {
    throw new AppError(
      'VALIDATION',
      `local-host 的 host 非法：${host}（只能是主机名或 IP，不含协议/端口/路径）`,
    );
  }
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) return trimmed;
  if (trimmed.includes(':')) return `[${trimmed}]`;
  return trimmed;
}

function normalizePublicBaseUrl(publicBaseUrl: string): string {
  if (typeof publicBaseUrl !== 'string' || !isHttpUrl(publicBaseUrl.trim())) {
    throw new AppError(
      'VALIDATION',
      `local-host 的 publicBaseUrl 非法：${String(publicBaseUrl)}（须为 http(s) 绝对地址）`,
    );
  }
  return ensureTrailingSlash(publicBaseUrl.trim());
}

/** 收集本机全部非 internal IPv4（去重，保持网卡枚举顺序），并格式化为 host 片段。 */
function collectLanHosts(
  networkInterfaces: () => NodeJS.Dict<NetworkInterfaceInfo[]>,
): string[] {
  let interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>;
  try {
    interfaces = networkInterfaces();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new AppError('INTERNAL', `读取本机网络接口失败：${reason}`);
  }
  const hosts: string[] = [];
  const seen = new Set<string>();
  for (const entries of Object.values(interfaces)) {
    if (!entries) continue;
    for (const info of entries) {
      if (info.internal) continue;
      // Node 18+ 的 family 为 'IPv4'，旧版本为 4；这里同时兼容两种写法
      const family = info.family as string | number;
      if (family !== 'IPv4' && family !== 4) continue;
      const host = normalizeHost(info.address);
      if (!host || seen.has(host)) continue;
      seen.add(host);
      hosts.push(host);
    }
  }
  return hosts;
}

/**
 * 解析 `local-host` 频道的公开 HTTP 基础地址。
 *
 * 规则（优先级从高到低）：
 *  1. `config.publicBaseUrl`：反向代理/自定义域名场景，完整覆盖（仅补尾部 `/`）；
 *  2. `config.advertiseHost`：`http://<advertiseHost>:<port>/`；
 *  3. `bindHost === '0.0.0.0'` 时取首个非 internal IPv4：`http://<ip>:<port>/`；
 *  4. 回退本机回环：`http://127.0.0.1:<port>/`。
 *
 * 同时返回：
 *  - `localBaseUrl`：恒为回环地址（带尾部 `/`）；
 *  - `lanBaseUrls`：`bindHost === '0.0.0.0'` 时全部非 internal IPv4（带尾部 `/`），否则 `[]`。
 *
 * `publicBaseUrl` / `advertiseHost` 不影响 `lanBaseUrls`（局域网候选始终按 bindHost 给出，
 * 供 UI 展示"其他机器可用的地址"）；覆盖优先规则下二者即使 bindHost 为 127.0.0.1 也会生效，
 * 可达性由调用方保证。
 */
export function resolveLocalHostBaseUrls(
  config: LocalHostStorageConfig,
  options: ResolveLocalHostBaseUrlsOptions = {},
): LocalHostBaseUrls {
  if (config === null || typeof config !== 'object') {
    throw new AppError('VALIDATION', 'local-host 存储配置不能为空');
  }

  const port = resolvePort(options.port ?? config.port);
  const localBaseUrl = `${HTTP_PROTOCOL}://${LOOPBACK_HOST}:${port}/`;

  const bindHost = typeof config.bindHost === 'string' ? config.bindHost.trim() : '';
  const lanBaseUrls =
    bindHost === ALL_INTERFACES_HOST
      ? collectLanHosts(options.networkInterfaces ?? readNetworkInterfaces).map(
          (host) => `${HTTP_PROTOCOL}://${host}:${port}/`,
        )
      : [];

  let preferredBaseUrl: string;
  if (config.publicBaseUrl !== undefined && config.publicBaseUrl !== null) {
    preferredBaseUrl = normalizePublicBaseUrl(config.publicBaseUrl);
  } else if (typeof config.advertiseHost === 'string' && config.advertiseHost.trim().length > 0) {
    const advertiseHost = normalizeHost(config.advertiseHost) ?? LOOPBACK_HOST;
    const candidate = `${HTTP_PROTOCOL}://${advertiseHost}:${port}/`;
    if (!isHttpUrl(candidate)) {
      throw new AppError('VALIDATION', `local-host 的 advertiseHost 非法：${config.advertiseHost}`);
    }
    preferredBaseUrl = candidate;
  } else {
    preferredBaseUrl = lanBaseUrls[0] ?? localBaseUrl;
  }

  return { preferredBaseUrl, localBaseUrl, lanBaseUrls };
}
