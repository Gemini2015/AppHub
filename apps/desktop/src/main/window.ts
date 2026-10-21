import { BrowserWindow } from 'electron';
import type { Session, WebContents } from 'electron';
import type { Logger } from './logger';
import { createSenderPolicy } from './sender';

/**
 * 主窗口创建 + 安全策略。
 *
 * 安全基线（docs/ARCHITECTURE.md §4.3）：
 *  - contextIsolation: true / sandbox: true / nodeIntegration: false；
 *  - 拒绝一切 window.open（setWindowOpenHandler deny）；
 *  - will-navigate / will-redirect / will-attach-webview 只允许应用自身地址；
 *  - 拒绝所有权限请求（摄像头/麦克风/通知/地理位置/剪贴板读取等）；
 *  - CSP：开发环境通过响应头注入（dev server），生产环境通过构建时注入 <meta>；
 *  - 生产模式关闭 DevTools。
 */

/** 开发环境 CSP：允许 Vite HMR（inline script / websocket）。 */
export function buildDevCsp(devServerUrl?: string): string {
  const wsOrigin = devServerUrl ? safeWsOrigin(devServerUrl) : null;
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https: http:",
    "font-src 'self' data:",
    "media-src 'self'",
    `connect-src 'self'${wsOrigin ? ` ${wsOrigin}` : ''} ${devServerUrl ? new URL(devServerUrl).origin : ''}`.trim(),
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "worker-src 'self' blob:",
  ].join('; ');
}

/** 生产环境 CSP（必须与 scripts/build.mjs 注入的 PROD_CSP 保持一致）。 */
export const PROD_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "media-src 'self'",
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "worker-src 'self' blob:",
].join('; ');

function safeWsOrigin(devServerUrl: string): string | null {
  try {
    const url = new URL(devServerUrl);
    return `${url.protocol === 'https:' ? 'wss:' : 'ws:'}//${url.host}`;
  } catch {
    return null;
  }
}

/** 测试可注入的 session 子集（Electron Session 满足该结构）。 */
export interface SessionLike {
  setPermissionRequestHandler(
    handler:
      | ((webContents: WebContents, permission: string, callback: (granted: boolean) => void) => void)
      | null,
  ): void;
  setPermissionCheckHandler(
    handler: ((webContents: WebContents | null, permission: string, requestingOrigin: string) => boolean) | null,
  ): void;
  setDevicePermissionHandler?(handler: ((details: unknown) => boolean) | null): void;
  webRequest: Pick<Session['webRequest'], 'onHeadersReceived'>;
}

export interface SessionSecurityOptions {
  isDev: boolean;
  devServerUrl?: string;
  appIndexFile: string;
  logger: Logger;
}

export interface MainWindowOptions {
  preloadFile: string;
  rendererIndexFile: string;
  devServerUrl?: string;
  logger: Logger;
  /** 测试可注入替身 session。 */
  session?: SessionLike;
  show?: boolean;
  width?: number;
  height?: number;
  minWidth?: number;
  minHeight?: number;
}

export function createSessionSecurityOptions(options: MainWindowOptions): SessionSecurityOptions {
  return {
    isDev: Boolean(options.devServerUrl),
    devServerUrl: options.devServerUrl,
    appIndexFile: options.rendererIndexFile,
    logger: options.logger,
  };
}

/**
 * 给 session 安装安全策略：权限一律拒绝 + 对应用自身页面注入 CSP 响应头。
 * 幂等：重复调用会用新 handler 覆盖旧 handler。
 */
export function applySessionSecurity(targetSession: SessionLike, options: SessionSecurityOptions): string {
  const csp = options.isDev ? buildDevCsp(options.devServerUrl) : PROD_CSP;
  const policy = createSenderPolicy({ devServerUrl: options.devServerUrl, appIndexFile: options.appIndexFile });

  targetSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    options.logger.warn('已拒绝渲染进程权限请求', { permission });
    callback(false);
  });
  targetSession.setPermissionCheckHandler(() => false);
  targetSession.setDevicePermissionHandler?.(() => false);

  targetSession.webRequest.onHeadersReceived((details, callback) => {
    if (!policy.isAllowed(details.url)) {
      callback({ responseHeaders: details.responseHeaders });
      return;
    }
    const headers: Record<string, string[]> = { ...(details.responseHeaders ?? {}) };
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === 'content-security-policy') delete headers[key];
    }
    headers['Content-Security-Policy'] = [csp];
    callback({ responseHeaders: headers });
  });

  return csp;
}

/** 创建主窗口并绑定导航/权限/新窗口安全策略。 */
export function createMainWindow(options: MainWindowOptions): BrowserWindow {
  const isDev = Boolean(options.devServerUrl);
  const rendererIndexFile = options.rendererIndexFile;

  const window = new BrowserWindow({
    width: options.width ?? 1280,
    height: options.height ?? 840,
    minWidth: options.minWidth ?? 960,
    minHeight: options.minHeight ?? 640,
    title: 'AppHub',
    show: false,
    backgroundColor: '#111318',
    autoHideMenuBar: true,
    webPreferences: {
      preload: options.preloadFile,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      spellcheck: false,
      // 生产环境不开放 DevTools；开发环境保留便于调试（可再被 --no-devtools 关闭）
      devTools: isDev,
    },
  });

  if (process.platform !== 'darwin') window.removeMenu();
  window.setMenuBarVisibility(false);

  const policy = createSenderPolicy({ devServerUrl: options.devServerUrl, appIndexFile: rendererIndexFile });
  const webContents = window.webContents;

  webContents.setWindowOpenHandler(({ url }) => {
    options.logger.warn('已阻止 window.open', { url: truncateUrl(url) });
    return { action: 'deny' };
  });

  webContents.on('will-navigate', (event, url) => {
    if (!policy.isAllowed(url)) {
      event.preventDefault();
      options.logger.warn('已阻止页面导航', { url: truncateUrl(url) });
    }
  });

  webContents.on('will-redirect', (event, url) => {
    if (!policy.isAllowed(url)) {
      event.preventDefault();
      options.logger.warn('已阻止页面重定向', { url: truncateUrl(url) });
    }
  });

  webContents.on('will-attach-webview', (event) => {
    event.preventDefault();
    options.logger.warn('已阻止 <webview> 挂载');
  });

  webContents.on('render-process-gone', (_event, details) => {
    options.logger.error('渲染进程异常退出', { reason: details.reason, exitCode: details.exitCode });
  });

  webContents.on('preload-error', (_event, preloadPath, error) => {
    options.logger.error('preload 脚本执行失败', {
      preload: preloadPath,
      message: error instanceof Error ? error.message : String(error),
    });
  });

  webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    options.logger.error('页面加载失败', {
      errorCode,
      errorDescription,
      url: truncateUrl(validatedURL),
    });
  });

  const targetSession = (options.session ?? (webContents.session as unknown as SessionLike)) as SessionLike;
  applySessionSecurity(targetSession, createSessionSecurityOptions(options));

  if (options.show !== false) {
    window.once('ready-to-show', () => {
      if (!window.isDestroyed()) window.show();
    });
  }

  const loadPromise = isDev
    ? webContents.loadURL(options.devServerUrl as string)
    : webContents.loadFile(rendererIndexFile);
  loadPromise.catch((err: unknown) => {
    options.logger.error('渲染进程入口加载失败', {
      message: err instanceof Error ? err.message : String(err),
    });
  });

  return window;
}

function truncateUrl(url: string): string {
  if (typeof url !== 'string') return '';
  // 不记录过长 URL，避免把 query 中的能力链接写进日志
  return url.length > 200 ? `${url.slice(0, 200)}…` : url;
}
