import type { ReactNode } from 'react';

export type IconName =
  | 'logo'
  | 'channels'
  | 'library'
  | 'settings'
  | 'plus'
  | 'link'
  | 'refresh'
  | 'upload'
  | 'download'
  | 'publish'
  | 'play'
  | 'shield'
  | 'folder'
  | 'trash'
  | 'copy'
  | 'check'
  | 'check-circle'
  | 'alert'
  | 'info'
  | 'close'
  | 'x-circle'
  | 'chevron-left'
  | 'chevron-right'
  | 'box'
  | 'external'
  | 'lock'
  | 'globe'
  | 'clock'
  | 'file'
  | 'server'
  | 'database'
  | 'tag'
  | 'arrow-right';

export interface IconProps {
  name: IconName;
  size?: number;
  className?: string;
  strokeWidth?: number;
}

function renderPaths(name: IconName): ReactNode {
  switch (name) {
    case 'logo':
      return (
        <>
          <circle cx="12" cy="12" r="2.2" />
          <circle cx="12" cy="4" r="1.7" />
          <circle cx="20" cy="12" r="1.7" />
          <circle cx="12" cy="20" r="1.7" />
          <circle cx="4" cy="12" r="1.7" />
          <path d="M12 6.1v3.7M17.9 12h-3.7M12 17.9v-3.7M6.1 12h3.7" />
        </>
      );
    case 'channels':
      return (
        <>
          <path d="m12 3 9 4.5-9 4.5-9-4.5L12 3Z" />
          <path d="m3 12.2 9 4.5 9-4.5" />
          <path d="m3 16.7 9 4.5 9-4.5" />
        </>
      );
    case 'library':
      return (
        <>
          <rect x="3.5" y="3.5" width="7" height="7" rx="1.6" />
          <rect x="13.5" y="3.5" width="7" height="7" rx="1.6" />
          <rect x="3.5" y="13.5" width="7" height="7" rx="1.6" />
          <rect x="13.5" y="13.5" width="7" height="7" rx="1.6" />
        </>
      );
    case 'settings':
      return (
        <>
          <circle cx="12" cy="12" r="3.2" />
          <path d="M12 2.8v2.3M12 18.9v2.3M2.8 12h2.3M18.9 12h2.3M5.5 5.5l1.6 1.6M16.9 16.9l1.6 1.6M18.5 5.5l-1.6 1.6M7.1 16.9l-1.6 1.6" />
        </>
      );
    case 'plus':
      return <path d="M12 5v14M5 12h14" />;
    case 'link':
      return (
        <>
          <path d="M10 13.5a5 5 0 0 0 7.4.5l2.4-2.4a5 5 0 0 0-7-7l-1.4 1.4" />
          <path d="M14 10.5a5 5 0 0 0-7.4-.5L4.2 12.4a5 5 0 0 0 7 7l1.4-1.4" />
        </>
      );
    case 'refresh':
      return (
        <>
          <path d="M20.5 12a8.5 8.5 0 1 1-2.5-6" />
          <path d="M20.5 3.5V9H15" />
        </>
      );
    case 'upload':
      return (
        <>
          <path d="M12 16.5V4" />
          <path d="m6.5 10.5 5.5-6 5.5 6" />
          <path d="M4.5 20h15" />
        </>
      );
    case 'download':
      return (
        <>
          <path d="M12 4v12.5" />
          <path d="m6.5 11 5.5 6 5.5-6" />
          <path d="M4.5 20h15" />
        </>
      );
    case 'publish':
      return (
        <>
          <path d="M12 15.5V5" />
          <path d="m7 10 5-5 5 5" />
          <path d="M5 19h14" />
          <path d="M8.5 21h7" />
        </>
      );
    case 'play':
      return <path d="m8.5 5.2 10.5 6.8-10.5 6.8V5.2Z" />;
    case 'shield':
      return (
        <>
          <path d="M12 3 5 6v6c0 4.3 2.9 7.4 7 9 4.1-1.6 7-4.7 7-9V6l-7-3Z" />
          <path d="m9 12 2.1 2.1L15.2 10" />
        </>
      );
    case 'folder':
      return (
        <path d="M3.5 7a2 2 0 0 1 2-2h3.7l2 2H18.5a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2V7Z" />
      );
    case 'trash':
      return (
        <>
          <path d="M4 7h16" />
          <path d="M9.5 7V5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v2" />
          <path d="m6.5 7 1 13a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1l1-13" />
          <path d="M10 11v6M14 11v6" />
        </>
      );
    case 'copy':
      return (
        <>
          <rect x="9" y="9" width="11" height="11" rx="2" />
          <path d="M15 5.5V4a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h1.5" />
        </>
      );
    case 'check':
      return <path d="m5 12.5 4.5 4.5L19.5 7" />;
    case 'check-circle':
      return (
        <>
          <circle cx="12" cy="12" r="8.5" />
          <path d="m8.2 12.2 2.6 2.6 5-5.2" />
        </>
      );
    case 'alert':
      return (
        <>
          <path d="M12 3.4 2.6 19.8h18.8L12 3.4Z" />
          <path d="M12 9.2v4.6" />
          <path d="M12 17.2h.01" strokeWidth={2.4} />
        </>
      );
    case 'info':
      return (
        <>
          <circle cx="12" cy="12" r="8.7" />
          <path d="M12 11v5.2" />
          <path d="M12 7.8h.01" strokeWidth={2.4} />
        </>
      );
    case 'close':
      return <path d="M6 6l12 12M18 6 6 18" />;
    case 'x-circle':
      return (
        <>
          <circle cx="12" cy="12" r="8.7" />
          <path d="m9.2 9.2 5.6 5.6M14.8 9.2l-5.6 5.6" />
        </>
      );
    case 'chevron-left':
      return <path d="m14.5 5.5-6.5 6.5 6.5 6.5" />;
    case 'chevron-right':
      return <path d="m9.5 5.5 6.5 6.5-6.5 6.5" />;
    case 'box':
      return (
        <>
          <path d="m12 3 8.5 4.7v8.6L12 21l-8.5-4.7V7.7L12 3Z" />
          <path d="m3.5 7.7 8.5 4.8 8.5-4.8" />
          <path d="M12 12.5V21" />
        </>
      );
    case 'external':
      return (
        <>
          <path d="M14 4h6v6" />
          <path d="M20 4 10.5 13.5" />
          <path d="M18 14.5V19a1.5 1.5 0 0 1-1.5 1.5h-12A1.5 1.5 0 0 1 3 19V7a1.5 1.5 0 0 1 1.5-1.5H9" />
        </>
      );
    case 'lock':
      return (
        <>
          <rect x="4.5" y="10" width="15" height="10.5" rx="2" />
          <path d="M8.2 10V7.3a3.8 3.8 0 0 1 7.6 0V10" />
          <path d="M12 14v2.5" />
        </>
      );
    case 'globe':
      return (
        <>
          <circle cx="12" cy="12" r="8.7" />
          <path d="M3.5 12h17" />
          <path d="M12 3.3c2.4 2.3 3.7 5.4 3.7 8.7 0 3.3-1.3 6.4-3.7 8.7-2.4-2.3-3.7-5.4-3.7-8.7 0-3.3 1.3-6.4 3.7-8.7Z" />
        </>
      );
    case 'clock':
      return (
        <>
          <circle cx="12" cy="12" r="8.7" />
          <path d="M12 7v5.2l3.4 2" />
        </>
      );
    case 'file':
      return (
        <>
          <path d="M13.8 3H7.5A2.5 2.5 0 0 0 5 5.5v13A2.5 2.5 0 0 0 7.5 21h9a2.5 2.5 0 0 0 2.5-2.5V8.2L13.8 3Z" />
          <path d="M13.5 3v5.5H19" />
        </>
      );
    case 'server':
      return (
        <>
          <rect x="3.5" y="4" width="17" height="6" rx="1.8" />
          <rect x="3.5" y="14" width="17" height="6" rx="1.8" />
          <path d="M7 7h.01M7 17h.01" strokeWidth={2.4} />
        </>
      );
    case 'database':
      return (
        <>
          <ellipse cx="12" cy="6" rx="8" ry="3.2" />
          <path d="M4 6v12c0 1.8 3.6 3.2 8 3.2s8-1.4 8-3.2V6" />
          <path d="M4 12c0 1.8 3.6 3.2 8 3.2s8-1.4 8-3.2" />
        </>
      );
    case 'tag':
      return (
        <>
          <path d="M3.5 12.2V4.8a1.3 1.3 0 0 1 1.3-1.3h7.4l8.3 8.3a1.8 1.8 0 0 1 0 2.6l-6.2 6.2a1.8 1.8 0 0 1-2.6 0l-8.2-8.2Z" />
          <circle cx="8" cy="8" r="1.4" />
        </>
      );
    case 'arrow-right':
      return (
        <>
          <path d="M4.5 12h15" />
          <path d="m13.5 6 6 6-6 6" />
        </>
      );
    default:
      return null;
  }
}

/** 内联 SVG 图标（不引入图标库）。 */
export function Icon({ name, size = 18, className, strokeWidth = 1.8 }: IconProps) {
  return (
    <svg
      className={className ? `icon ${className}` : 'icon'}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {renderPaths(name)}
    </svg>
  );
}
