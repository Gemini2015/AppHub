/** 内部路由（无需 react-router）：页面切换由 App 的 state 驱动。 */
export type Route =
  | { name: 'channels' }
  | { name: 'channel'; channelId: string }
  | { name: 'app'; channelId: string; appId: string }
  | { name: 'library' }
  | { name: 'settings' };

export type NavKey = 'channels' | 'library' | 'settings';

/** 侧边栏高亮：频道详情 / App 详情都归属「频道」。 */
export function routeNavKey(route: Route): NavKey {
  if (route.name === 'channel' || route.name === 'app') return 'channels';
  return route.name;
}
