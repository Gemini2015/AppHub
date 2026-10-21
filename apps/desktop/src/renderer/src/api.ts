import { createContext, useContext } from 'react';
import type { AppHubApi } from './types';

/**
 * window.apphub 由 preload 通过 contextBridge 注入（见 shared/ipc.ts 的 AppHubApi）。
 * 渲染进程只通过它访问主进程，不直接使用 Node / Electron API，也不直接 fetch 远端。
 */
declare global {
  interface Window {
    apphub?: AppHubApi;
  }
}

/** React 上下文中注入的 API；测试时可用 mock 实现替代 window.apphub。 */
export const ApiContext = createContext<AppHubApi | null>(null);

/** 读取当前注入的 API；未注入时抛出可读错误（正常都由 ApiProvider 保证存在）。 */
export function useApi(): AppHubApi {
  const api = useContext(ApiContext);
  if (!api) {
    throw new Error('AppHub API 未初始化：请通过 <ApiProvider> 或 Electron 运行时使用界面组件。');
  }
  return api;
}

/** 获取 Electron 运行时注入的 window.apphub；在普通浏览器/测试环境中可能不存在。 */
export function getRuntimeApi(): AppHubApi | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.apphub;
}
