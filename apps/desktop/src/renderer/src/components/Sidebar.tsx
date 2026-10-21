import { Icon } from './Icon';
import type { IconName } from './Icon';
import { routeNavKey } from '../routes';
import type { NavKey, Route } from '../routes';

export interface SidebarProps {
  route: Route;
  channelCount: number;
  installedCount: number;
  appVersion?: string;
  onNavigate: (route: Route) => void;
}

interface NavItem {
  key: NavKey;
  label: string;
  icon: IconName;
  route: Route;
  count?: number;
}

export function Sidebar({ route, channelCount, installedCount, appVersion, onNavigate }: SidebarProps) {
  const active = routeNavKey(route);
  const items: NavItem[] = [
    { key: 'channels', label: '频道', icon: 'channels', route: { name: 'channels' }, count: channelCount },
    { key: 'library', label: '本地库', icon: 'library', route: { name: 'library' }, count: installedCount },
    { key: 'settings', label: '设置 / 关于', icon: 'settings', route: { name: 'settings' } },
  ];

  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-icon">
          <Icon name="logo" size={22} />
        </span>
        <div className="brand-text">
          <strong>AppHub</strong>
          <span className="brand-sub">去中心化 App 分享</span>
        </div>
      </div>

      <nav className="nav" aria-label="主导航">
        {items.map((item) => (
          <button
            type="button"
            key={item.key}
            data-testid={`nav-${item.key}`}
            className={active === item.key ? 'nav-item nav-item-active' : 'nav-item'}
            aria-current={active === item.key ? 'page' : undefined}
            onClick={() => onNavigate(item.route)}
          >
            <Icon name={item.icon} size={18} />
            <span className="nav-label">{item.label}</span>
            {typeof item.count === 'number' && item.count > 0 ? (
              <span className="nav-count">{item.count}</span>
            ) : null}
          </button>
        ))}
      </nav>

      <div className="sidebar-foot">
        <div className="sidebar-note">
          <Icon name="shield" size={16} />
          <span>
            无中心服务器
            <br />
            频道由你自己的存储承载
          </span>
        </div>
        {appVersion ? <span className="sidebar-version">v{appVersion}</span> : null}
      </div>
    </aside>
  );
}
