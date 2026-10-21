/**
 * @apphub/core 公共入口。
 *
 * - `createAppHubCore(context)`：领域服务工厂（频道 / 发布 / 本地库）；
 * - `inspectZipArchive` / `createZipFromDirectory`：纯函数 ZIP 工具，
 *   供 Electron 主进程的 selection registry 直接调用（不依赖 CoreContext）。
 */
export { createAppHubCore } from './core';
export * from './types';
export { inspectZipArchive, createZipFromDirectory, suggestEntryFromFiles } from './zip';
export type {
  CreatedZip,
  ZipArchiveInspection,
  ZipEntryInfo,
  ZipHashResult,
} from './zip';
