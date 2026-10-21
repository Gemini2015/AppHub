import type { ReactNode } from 'react';
import { Icon } from './Icon';
import type { IconName } from './Icon';
import type { ApiError } from '../types';

export function Spinner({ size = 18 }: { size?: number }) {
  return <span className="spinner" style={{ width: size, height: size }} role="status" aria-label="加载中" />;
}

export function LoadingState({ label = '正在加载…' }: { label?: string }) {
  return (
    <div className="state-view">
      <Spinner size={22} />
      <p>{label}</p>
    </div>
  );
}

export function ErrorState({
  error,
  title = '加载失败',
  onRetry,
}: {
  error: ApiError;
  title?: string;
  onRetry?: () => void;
}) {
  return (
    <div className="state-view state-view-error" role="alert">
      <span className="state-icon state-icon-error">
        <Icon name="x-circle" size={26} />
      </span>
      <h3>{title}</h3>
      <p>{error.message}</p>
      <code className="error-code">{error.code}</code>
      {onRetry ? (
        <button type="button" className="btn btn-secondary" onClick={onRetry}>
          <Icon name="refresh" size={16} />
          重试
        </button>
      ) : null}
    </div>
  );
}

export function EmptyState({
  icon = 'channels',
  title,
  description,
  children,
  testId,
}: {
  icon?: IconName;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  testId?: string;
}) {
  return (
    <div className="state-view state-view-empty" data-testid={testId}>
      <span className="state-icon">
        <Icon name={icon} size={28} />
      </span>
      <h3>{title}</h3>
      {description ? <p className="state-desc">{description}</p> : null}
      {children ? <div className="state-actions">{children}</div> : null}
    </div>
  );
}

/** 带标题的页面区块。 */
export function Section({
  title,
  count,
  actions,
  children,
  className,
}: {
  title: string;
  count?: number;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={className ? `section ${className}` : 'section'}>
      <div className="section-head">
        <h2 className="section-title">
          {title}
          {typeof count === 'number' ? <span className="count">{count}</span> : null}
        </h2>
        {actions ? <div className="section-actions">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

export function PageHeader({
  title,
  description,
  actions,
  eyebrow,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  eyebrow?: string;
}) {
  return (
    <header className="page-header">
      <div className="page-header-text">
        {eyebrow ? <span className="page-eyebrow">{eyebrow}</span> : null}
        <h1>{title}</h1>
        {description ? <p>{description}</p> : null}
      </div>
      {actions ? <div className="page-header-actions">{actions}</div> : null}
    </header>
  );
}
