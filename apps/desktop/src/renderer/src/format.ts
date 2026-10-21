import type { ApiError, Platform, ProgressEventDTO } from './types';

/** 字节数 → 人类可读大小。 */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unitIndex]}`;
}

/** ISO 时间 → 中文可读时间。 */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

export function platformLabel(platform: Platform | string): string {
  switch (platform) {
    case 'windows':
      return 'Windows';
    case 'linux':
      return 'Linux';
    case 'mac':
      return 'macOS';
    default:
      return platform;
  }
}

export function publishModeLabel(mode: string): string {
  switch (mode) {
    case 'files':
      return '散文件';
    case 'zip':
      return '压缩包';
    default:
      return mode;
  }
}

export function visibilityLabel(visibility: string): string {
  return visibility === 'private' ? '私密' : '公开';
}

export function roleLabel(role: string): string {
  switch (role) {
    case 'owner':
      return '拥有者';
    case 'admin':
      return '管理员';
    case 'subscriber':
      return '订阅者';
    default:
      return role;
  }
}

export function installStatusLabel(status: string): string {
  switch (status) {
    case 'installed':
      return '已安装';
    case 'outdated':
      return '可更新';
    case 'broken':
      return '文件损坏';
    default:
      return status;
  }
}

export function progressOperationLabel(operation: string): string {
  switch (operation) {
    case 'publish':
      return '发布';
    case 'install':
      return '安装';
    case 'update':
      return '更新';
    case 'verify':
      return '校验';
    default:
      return operation;
  }
}

export function progressPhaseLabel(phase: string): string {
  switch (phase) {
    case 'prepare':
      return '准备';
    case 'transfer':
      return '传输文件';
    case 'verify':
      return '校验文件';
    case 'extract':
      return '解压';
    case 'commit':
      return '写入提交';
    case 'cleanup':
      return '清理';
    case 'fetch':
      return '获取元信息';
    default:
      return phase;
  }
}

/** 计算进度百分比（0-100），事件未给出 percent 时按 bytes / index 推算。 */
export function progressPercent(event: ProgressEventDTO | null): number | undefined {
  if (!event) return undefined;
  if (typeof event.percent === 'number' && Number.isFinite(event.percent)) {
    return Math.max(0, Math.min(100, Math.round(event.percent)));
  }
  if (
    typeof event.transferredBytes === 'number' &&
    typeof event.totalBytes === 'number' &&
    event.totalBytes > 0
  ) {
    return Math.max(0, Math.min(100, Math.round((event.transferredBytes / event.totalBytes) * 100)));
  }
  if (typeof event.index === 'number' && typeof event.count === 'number' && event.count > 0) {
    return Math.max(0, Math.min(100, Math.round((event.index / event.count) * 100)));
  }
  return undefined;
}

/**
 * semver 校验（与协议层 rules 保持一致，允许 pre-release / build 元数据）。
 * 渲染进程不能 import core/protocol 运行时代码，因此这里做一份轻量实现。
 */
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function isValidSemver(version: string): boolean {
  return SEMVER_PATTERN.test(version.trim());
}

/** 比较两个 semver 版本：a > b 返回 1，a < b 返回 -1，相等返回 0。 */
export function compareSemver(a: string, b: string): number {
  const parse = (value: string): { main: number[]; pre: string[] } => {
    const cleaned = value.trim().replace(/\+.*$/, '');
    const [mainPart, prePart] = cleaned.split('-', 2) as [string, string | undefined];
    return {
      main: mainPart.split('.').map((part) => Number.parseInt(part, 10) || 0),
      pre: prePart ? prePart.split('.') : [],
    };
  };
  const left = parse(a);
  const right = parse(b);
  for (let index = 0; index < 3; index += 1) {
    const lv = left.main[index] ?? 0;
    const rv = right.main[index] ?? 0;
    if (lv !== rv) return lv > rv ? 1 : -1;
  }
  if (left.pre.length === 0 && right.pre.length > 0) return 1;
  if (left.pre.length > 0 && right.pre.length === 0) return -1;
  for (let index = 0; index < Math.max(left.pre.length, right.pre.length); index += 1) {
    const lv = left.pre[index];
    const rv = right.pre[index];
    if (lv === undefined) return -1;
    if (rv === undefined) return 1;
    const ln = /^\d+$/.test(lv) ? Number.parseInt(lv, 10) : null;
    const rn = /^\d+$/.test(rv) ? Number.parseInt(rv, 10) : null;
    if (ln !== null && rn !== null && ln !== rn) return ln > rn ? 1 : -1;
    if (ln === null && rn !== null) return 1;
    if (ln !== null && rn === null) return -1;
    if (lv !== rv) return lv > rv ? 1 : -1;
  }
  return 0;
}

/** latest 是否比 current 新。 */
export function isNewerVersion(latest: string | undefined | null, current: string | undefined | null): boolean {
  if (!latest || !current) return false;
  return compareSemver(latest, current) > 0;
}

/** 文件选择的大小写相对路径友好展示。 */
export function shortPath(path: string, maxLength = 48): string {
  if (path.length <= maxLength) return path;
  const head = Math.max(8, Math.floor((maxLength - 3) / 2));
  const tail = Math.max(8, maxLength - 3 - head);
  return `${path.slice(0, head)}…${path.slice(-tail)}`;
}

export function errorTitle(error: ApiError): string {
  return error.code ? `${error.code}：${error.message}` : error.message;
}
