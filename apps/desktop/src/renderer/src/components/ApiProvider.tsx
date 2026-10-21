import type { ReactNode } from 'react';
import { ApiContext } from '../api';
import type { AppHubApi } from '../types';

/** 通过上下文把 AppHubApi 注入组件树；默认由 App 用 window.apphub 提供，测试时注入 mock。 */
export function ApiProvider({ api, children }: { api: AppHubApi; children: ReactNode }) {
  return <ApiContext.Provider value={api}>{children}</ApiContext.Provider>;
}
