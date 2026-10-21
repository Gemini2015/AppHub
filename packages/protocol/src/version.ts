import { AppError } from './errors';

/**
 * 语义化版本（semver）解析与比较。
 *
 * App 版本号同时会被用作存储目录名，因此这里严格要求符合 semver 2.0.0
 * （不允许 `v` 前缀、不允许空格、不允许路径分隔符）。
 */

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
  build: string[];
  raw: string;
}

const NUMERIC = '0|[1-9]\\d*';
const PRERELEASE_ID =
  `(?:${NUMERIC}|\\d*[a-zA-Z-][0-9a-zA-Z-]*)`;
const SEMVER_RE = new RegExp(
  `^(${NUMERIC})\\.(${NUMERIC})\\.(${NUMERIC})` +
    `(?:-(${PRERELEASE_ID}(?:\\.${PRERELEASE_ID})*))?` +
    `(?:\\+([0-9a-zA-Z-]+(?:\\.[0-9a-zA-Z-]+)*))?$`,
);

export function parseVersion(version: string): ParsedVersion | null {
  if (typeof version !== 'string' || version.length === 0 || version.length > 128) return null;
  const match = SEMVER_RE.exec(version);
  if (!match) return null;
  const [, major, minor, patch, prerelease, build] = match;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: prerelease ? prerelease.split('.') : [],
    build: build ? build.split('.') : [],
    raw: version,
  };
}

export function isValidVersion(version: string): boolean {
  return parseVersion(version) !== null;
}

function compareIdentifier(a: string, b: string): number {
  const aNumeric = /^\d+$/.test(a);
  const bNumeric = /^\d+$/.test(b);
  if (aNumeric && bNumeric) {
    const an = Number(a);
    const bn = Number(b);
    return an === bn ? 0 : an < bn ? -1 : 1;
  }
  if (aNumeric) return -1; // 数字标识优先级低于字母数字标识
  if (bNumeric) return 1;
  return a === b ? 0 : a < b ? -1 : 1;
}

/**
 * 按 semver 规则比较两个版本。
 * @returns 负数表示 a < b，0 表示相等（忽略 build 元数据），正数表示 a > b。
 * @throws AppError 版本号非法时
 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa) throw new AppError('VALIDATION', `版本号非法：${a}`, { version: a });
  if (!pb) throw new AppError('VALIDATION', `版本号非法：${b}`, { version: b });
  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  if (pa.patch !== pb.patch) return pa.patch - pb.patch;

  const aPre = pa.prerelease;
  const bPre = pb.prerelease;
  if (aPre.length === 0 && bPre.length === 0) return 0;
  if (aPre.length === 0) return 1; // 正式版 > 预发布版
  if (bPre.length === 0) return -1;
  const len = Math.min(aPre.length, bPre.length);
  for (let i = 0; i < len; i += 1) {
    const cmp = compareIdentifier(aPre[i]!, bPre[i]!);
    if (cmp !== 0) return cmp;
  }
  return aPre.length - bPre.length;
}

/** 比较版本，非法版本视为最小（用于 UI 排序容错）。 */
export function compareVersionsLenient(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa && !pb) return a.localeCompare(b);
  if (!pa) return -1;
  if (!pb) return 1;
  return compareVersions(a, b);
}

/** 从版本列表中取最大值（非法版本会被忽略）。 */
export function maxVersion(versions: readonly string[]): string | undefined {
  let best: string | undefined;
  for (const version of versions) {
    if (!isValidVersion(version)) continue;
    if (best === undefined || compareVersions(version, best) > 0) best = version;
  }
  return best;
}

/** 版本降序排序（非法版本排在最后）。 */
export function sortVersionsDesc(versions: readonly string[]): string[] {
  return [...versions].sort((a, b) => compareVersionsLenient(b, a));
}

/** 断言版本号合法，返回原值。 */
export function assertValidVersion(version: string, label = '版本号'): string {
  const parsed = parseVersion(version);
  if (!parsed) throw new AppError('VALIDATION', `${label}非法（必须符合 semver，如 1.0.0）：${version}`);
  return version;
}
