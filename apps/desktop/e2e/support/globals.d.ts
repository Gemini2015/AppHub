import type { StaticServer } from './static-server';

/**
 * globalSetup 与 globalTeardown 通过 globalThis 共享同一进程内的静态服务器实例。
 * 单个 d.ts 声明，避免在多个模块里重复 `declare global` 造成类型冲突。
 */
declare global {
  // eslint-disable-next-line no-var
  var __APPHUB_E2E_STATIC_SERVER__: StaticServer | undefined;
}

export {};
