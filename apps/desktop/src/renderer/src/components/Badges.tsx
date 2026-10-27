import type { ReactNode } from 'react';
import { Icon } from './Icon';
import type { IconName } from './Icon';
import {
  installStatusLabel,
  platformLabel,
  publishModeLabel,
  roleLabel,
  visibilityLabel,
} from '../format';
import type { ChannelRole, Platform, PublishMode, Visibility } from '../types';

export type BadgeTone = 'accent' | 'success' | 'warn' | 'danger' | 'muted' | 'info';

export function Badge({
  children,
  tone = 'muted',
  icon,
  testId,
}: {
  children: ReactNode;
  tone?: BadgeTone;
  icon?: IconName;
  testId?: string;
}) {
  return (
    <span className={`badge badge-${tone}`} data-testid={testId}>
      {icon ? <Icon name={icon} size={12} /> : null}
      {children}
    </span>
  );
}

export function VisibilityBadge({ visibility }: { visibility: Visibility }) {
  return (
    <Badge tone={visibility === 'private' ? 'warn' : 'muted'} icon={visibility === 'private' ? 'lock' : 'globe'}>
      {visibilityLabel(visibility)}
    </Badge>
  );
}

export function RoleBadge({ role }: { role: ChannelRole }) {
  const tone = role === 'owner' ? 'accent' : role === 'admin' ? 'info' : 'muted';
  return <Badge tone={tone}>{roleLabel(role)}</Badge>;
}

export function PlatformBadge({ platform }: { platform: Platform }) {
  return <Badge tone="muted">{platformLabel(platform)}</Badge>;
}

export function PlatformBadges({ platforms }: { platforms: Platform[] }) {
  return (
    <span className="badge-row">
      {platforms.map((platform) => (
        <PlatformBadge key={platform} platform={platform} />
      ))}
    </span>
  );
}

export function PublishModeBadge({ mode }: { mode: PublishMode }) {
  return (
    <Badge tone="info" icon={mode === 'zip' ? 'box' : 'file'}>
      {publishModeLabel(mode)}
    </Badge>
  );
}

export function InstallStatusBadge({ status }: { status: 'installed' | 'outdated' | 'broken' }) {
  const tone: BadgeTone = status === 'installed' ? 'success' : status === 'outdated' ? 'warn' : 'danger';
  return <Badge tone={tone}>{installStatusLabel(status)}</Badge>;
}
