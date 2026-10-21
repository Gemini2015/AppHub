import { APP_ID_PATTERN, FILE_NAMES, LIMITS, PRIVATE_ROOT_DIR } from './constants';
import { AppError } from './errors';

/**
 * 跨平台路径 / URL 工具。
 *
 * 该模块不依赖 node:path，可在渲染进程复用；所有"进入存储或本地文件系统"
 * 的相对路径都必须先经过 normalizeRelativePath / assertSafeRelativePath。
 */

const WINDOWS_RESERVED_SEGMENT = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** 是否像绝对路径（POSIX / Windows 盘符 / UNC）。 */
export function isAbsolutePath(value: string): boolean {
  return value.startsWith('/') || value.startsWith('\\') || /^[a-zA-Z]:[\\/]/.test(value);
}

/**
 * 归一化并校验相对路径：
 *  - 统一为 `/` 分隔的 POSIX 形式
 *  - 去除 `./` 与冗余斜杠
 *  - 拒绝绝对路径、盘符、UNC、`..`、空字节、Windows 保留设备名
 */
export function normalizeRelativePath(input: string, label = '路径'): string {
  if (typeof input !== 'string') {
    throw new AppError('VALIDATION', `${label}必须是字符串`);
  }
  const raw = input.trim();
  if (raw.length === 0) throw new AppError('VALIDATION', `${label}不能为空`);
  if (raw.length > LIMITS.relativePath) {
    throw new AppError('VALIDATION', `${label}过长（上限 ${LIMITS.relativePath} 字符）`);
  }
  if (raw.includes('\0')) throw new AppError('SECURITY', `${label}包含非法空字符`);
  if (isAbsolutePath(raw)) {
    throw new AppError('SECURITY', `${label}不能是绝对路径：${input}`);
  }
  const normalized = raw.replace(/\\/g, '/');
  const segments = normalized.split('/');
  const result: string[] = [];
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      throw new AppError('SECURITY', `${label}不能包含 '..' 路径段：${input}`);
    }
    if (WINDOWS_RESERVED_SEGMENT.test(segment)) {
      throw new AppError('SECURITY', `${label}包含 Windows 保留名：${segment}`);
    }
    if (/[<>:"|?*\u0000-\u001f]/.test(segment)) {
      throw new AppError('VALIDATION', `${label}包含非法字符：${segment}`);
    }
    if (/[. ]$/.test(segment)) {
      throw new AppError('VALIDATION', `${label}的路径段不能以点或空格结尾：${segment}`);
    }
    result.push(segment);
  }
  if (result.length === 0) throw new AppError('VALIDATION', `${label}不能为空`);
  return result.join('/');
}

export function isSafeRelativePath(input: string): boolean {
  try {
    normalizeRelativePath(input);
    return true;
  } catch {
    return false;
  }
}

/** 归一化相对路径，不合法时抛错。 */
export function assertSafeRelativePath(input: string, label?: string): string {
  return normalizeRelativePath(input, label);
}

/** 校验 App 标识（同时作为存储目录名）。 */
export function assertAppId(appId: string): string {
  if (typeof appId !== 'string' || !APP_ID_PATTERN.test(appId)) {
    throw new AppError(
      'VALIDATION',
      `App 标识非法：${String(appId)}（须匹配 ${APP_ID_PATTERN}，小写字母/数字/._-，1-63 位，首尾为字母或数字）`,
    );
  }
  return appId;
}

/** 校验单个文件名（不允许路径分隔符）。 */
export function assertFileName(name: string, label = '文件名'): string {
  const normalized = normalizeRelativePath(name, label);
  if (normalized.includes('/')) {
    throw new AppError('VALIDATION', `${label}不能包含目录：${name}`);
  }
  return normalized;
}

/** URL 路径编码：按 `/` 分段 encodeURIComponent。 */
export function encodeUrlPath(relativePath: string): string {
  return relativePath
    .replace(/^\/+/, '')
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

/** 将对象 key 拼接为公开可访问的 URL（baseUrl 需以 / 结尾或自动补齐）。 */
export function appendUrl(baseUrl: string, objectKey: string): string {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return base + encodeUrlPath(objectKey);
}

/** 拼接目录 URL（保证以 / 结尾）。 */
export function appendUrlDir(baseUrl: string, prefix = ''): string {
  const url = appendUrl(baseUrl, prefix);
  return url.endsWith('/') ? url : `${url}/`;
}

/**
 * 解析"相对地址"为绝对 URL。
 * 已是 http(s) 绝对地址时原样返回；否则以 base 为基准解析。
 */
export function resolveUrl(base: string, target: string): string {
  if (typeof target !== 'string' || target.length === 0) {
    throw new AppError('VALIDATION', '待解析的地址不能为空');
  }
  if (isHttpUrl(target)) return target;
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new AppError('VALIDATION', `基准地址不是合法 URL：${base}`);
  }
  let resolved: URL;
  try {
    resolved = new URL(target, url);
  } catch {
    throw new AppError('VALIDATION', `无法解析相对地址：${target}`);
  }
  if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
    throw new AppError('SECURITY', `不支持的协议：${resolved.protocol}`);
  }
  return resolved.toString();
}

/** 比较两个 URL 的主机部分是否一致（用于下载域名安全检查）。 */
export function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 存储对象 key / 公开 URL 规则
// ---------------------------------------------------------------------------

/** 私密频道在存储中的隔离前缀，例如 `_private/ch_abc/xxxx`。 */
export function privatePrefix(channelId: string, accessKey: string): string {
  return `${PRIVATE_ROOT_DIR}/${channelId}/${accessKey}`;
}

/** channel.json 的存储对象 key（私密频道带隔离前缀）。 */
export function channelDescriptorKey(
  visibility: 'public' | 'private',
  channelId: string,
  accessKey?: string,
): string {
  if (visibility === 'private') {
    if (!accessKey) throw new AppError('VALIDATION', '私密频道缺少 accessKey');
    return `${privatePrefix(channelId, accessKey)}/${FILE_NAMES.channel}`;
  }
  return FILE_NAMES.channel;
}

/** 频道内 App 元信息对象 key（相对频道根目录）。 */
export function appMetaKey(appId: string): string {
  return `${assertAppId(appId)}/${FILE_NAMES.appMeta}`;
}

/** 版本目录 key，例如 `foobar/1.0.0/`。 */
export function versionDirKey(appId: string, version: string): string {
  assertValidVersionKey(version);
  return `${assertAppId(appId)}/${version}/`;
}

/** 版本 files.json 的对象 key。 */
export function versionFilesKey(appId: string, version: string): string {
  return `${versionDirKey(appId, version)}${FILE_NAMES.files}`;
}

/** 版本内某个文件的对象 key（filePath 为相对路径）。 */
export function versionFilePathKey(appId: string, version: string, filePath: string): string {
  return `${versionDirKey(appId, version)}${normalizeRelativePath(filePath, '文件路径')}`;
}

/** 版本压缩包的对象 key，例如 `foobar/1.0.0/foobar-1.0.0.zip`。 */
export function versionArchiveKey(appId: string, version: string, archiveName: string): string {
  return `${versionDirKey(appId, version)}${assertFileName(archiveName)}`;
}

/** app.meta.json 中记录的"相对 meta 文件所在目录"的 files.json 地址。 */
export function versionFilesUrl(version: string): string {
  assertValidVersionKey(version);
  return `${version}/${FILE_NAMES.files}`;
}

/** app.meta.json 中记录的"下载基准目录"（相对 meta 文件所在目录）。 */
export function versionDownloadBaseUrl(version: string): string {
  assertValidVersionKey(version);
  return `${version}/`;
}

/** app.meta.json 中记录的压缩包地址（相对 meta 文件所在目录）。 */
export function versionArchiveUrl(version: string, archiveName: string): string {
  assertValidVersionKey(version);
  return `${version}/${assertFileName(archiveName)}`;
}

function assertValidVersionKey(version: string): void {
  // 避免把协议包里的 semver 解析器引入此模块造成循环，这里用轻量校验：
  // 版本目录名不允许路径分隔符与特殊字符，semver 的结构校验由调用方 schemas 负责。
  if (
    typeof version !== 'string' ||
    version.length === 0 ||
    version.length > 128 ||
    version.includes('/') ||
    version.includes('\\') ||
    version.includes('..')
  ) {
    throw new AppError('VALIDATION', `版本目录名非法：${version}`);
  }
}

/**
 * 由 channel.json 的公开地址解析某个 App 的 app.meta.json 地址。
 * metaUrl 为相对路径时，相对于 channel.json 所在目录。
 */
export function resolveAppMetaUrl(channelDescriptorUrl: string, metaUrl: string): string {
  return resolveUrl(channelDescriptorUrl, metaUrl);
}

/** 由 app.meta.json 的地址解析 files.json 地址。 */
export function resolveFilesUrl(appMetaUrl: string, filesUrl: string): string {
  return resolveUrl(appMetaUrl, filesUrl);
}

/** 由 app.meta.json 的地址解析下载基准目录。 */
export function resolveDownloadBaseUrl(appMetaUrl: string, downloadBaseUrl: string): string {
  const url = resolveUrl(appMetaUrl, downloadBaseUrl);
  return url.endsWith('/') ? url : `${url}/`;
}

/** 拼接下载基准目录与版本内文件相对路径。 */
export function resolveFileDownloadUrl(downloadBaseUrl: string, filePath: string): string {
  const base = downloadBaseUrl.endsWith('/') ? downloadBaseUrl : `${downloadBaseUrl}/`;
  return base + encodeUrlPath(normalizeRelativePath(filePath, '文件路径'));
}

/** 从带路径的 URL 中取"目录部分"（以 / 结尾），用于展示或相对解析。 */
export function urlDirectory(url: string): string {
  const base = url.endsWith('/') ? url : `${url}/`;
  return new URL('.', base).toString();
}
