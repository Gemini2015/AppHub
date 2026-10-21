import { createFakeLogger } from '@apphub/testkit';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * window.ts 的安全基线测试：mock Electron 的 BrowserWindow，检查 webPreferences、
 * 导航拦截、权限拒绝、CSP 注入等关键安全配置。
 */

const h = vi.hoisted(() => ({
  windows: [] as any[],
  permissionRequestHandlers: [] as any[],
  permissionCheckHandlers: [] as any[],
  devicePermissionHandlers: [] as any[],
  headersReceivedHandlers: [] as any[],
  windowOpenHandlers: [] as any[],
}));

vi.mock('electron', () => {
  class FakeWebContents {
    id = 42;
    destroyed = false;
    windowOpenHandler: any = null;
    listeners = new Map<string, Array<(...args: any[]) => void>>();
    session: any;
    loadFile = vi.fn(async () => undefined);
    loadURL = vi.fn(async () => undefined);
    constructor() {
      this.session = {
        setPermissionRequestHandler: (handler: any) => h.permissionRequestHandlers.push(handler),
        setPermissionCheckHandler: (handler: any) => h.permissionCheckHandlers.push(handler),
        setDevicePermissionHandler: (handler: any) => h.devicePermissionHandlers.push(handler),
        webRequest: {
          onHeadersReceived: (handler: any) => h.headersReceivedHandlers.push(handler),
        },
      };
    }
    setWindowOpenHandler(handler: any): void {
      this.windowOpenHandler = handler;
      h.windowOpenHandlers.push(handler);
    }
    on(event: string, handler: (...args: any[]) => void): void {
      const list = this.listeners.get(event) ?? [];
      list.push(handler);
      this.listeners.set(event, list);
    }
    once(event: string, handler: (...args: any[]) => void): void {
      this.on(event, handler);
    }
    emit(event: string, ...args: any[]): void {
      for (const handler of this.listeners.get(event) ?? []) handler(...args);
    }
    isDestroyed(): boolean {
      return this.destroyed;
    }
  }

  class FakeBrowserWindow {
    webContents = new FakeWebContents();
    options: any;
    listeners = new Map<string, Array<(...args: any[]) => void>>();
    constructor(options: any) {
      this.options = options;
      h.windows.push(this);
    }
    removeMenu(): void {}
    setMenuBarVisibility(): void {}
    on(event: string, handler: (...args: any[]) => void): void {
      const list = this.listeners.get(event) ?? [];
      list.push(handler);
      this.listeners.set(event, list);
    }
    once(event: string, handler: (...args: any[]) => void): void {
      this.on(event, handler);
    }
    isDestroyed(): boolean {
      return false;
    }
    isMinimized(): boolean {
      return false;
    }
    show(): void {}
    focus(): void {}
    restore(): void {}
  }

  return { BrowserWindow: FakeBrowserWindow };
});

import { PROD_CSP, buildDevCsp, createMainWindow } from './window';
import type { SessionLike } from './window';

const APP_INDEX = path.resolve('out', 'renderer', 'index.html');
const PRELOAD = path.resolve('out', 'preload', 'index.cjs');
const APP_INDEX_URL = pathToFileURL(APP_INDEX).href;
const DEV_URL = 'http://127.0.0.1:5173/';

function lastWindow(): any {
  const window = h.windows[h.windows.length - 1];
  if (!window) throw new Error('没有创建窗口');
  return window;
}

function lastHeadersHandler(): (...args: any[]) => void {
  const handler = h.headersReceivedHandlers[h.headersReceivedHandlers.length - 1];
  if (!handler) throw new Error('没有注册 CSP 响应头处理器');
  return handler;
}

function invokeHeaders(url: string): Record<string, string[]> {
  let response: any;
  lastHeadersHandler()({ url, responseHeaders: { 'content-type': ['text/html'] } }, (result: any) => {
    response = result;
  });
  return response?.responseHeaders ?? {};
}

beforeEach(() => {
  h.windows.length = 0;
  h.permissionRequestHandlers.length = 0;
  h.permissionCheckHandlers.length = 0;
  h.devicePermissionHandlers.length = 0;
  h.headersReceivedHandlers.length = 0;
  h.windowOpenHandlers.length = 0;
});

describe('window：生产模式安全配置', () => {
  it('contextIsolation/sandbox/nodeIntegration/安全开关符合基线', () => {
    createMainWindow({
      preloadFile: PRELOAD,
      rendererIndexFile: APP_INDEX,
      logger: createFakeLogger(),
    });
    const window = lastWindow();
    const webPreferences = window.options.webPreferences;
    expect(webPreferences.contextIsolation).toBe(true);
    expect(webPreferences.sandbox).toBe(true);
    expect(webPreferences.nodeIntegration).toBe(false);
    expect(webPreferences.nodeIntegrationInSubFrames).toBe(false);
    expect(webPreferences.webSecurity).toBe(true);
    expect(webPreferences.allowRunningInsecureContent).toBe(false);
    expect(webPreferences.devTools).toBe(false);
    expect(webPreferences.preload).toBe(PRELOAD);
    expect(window.options.title).toBe('AppHub');
    expect(window.options.minWidth).toBeGreaterThanOrEqual(960);
    expect(window.options.minHeight).toBeGreaterThanOrEqual(640);
  });

  it('生产模式用 loadFile 加载 out/renderer/index.html', () => {
    createMainWindow({
      preloadFile: PRELOAD,
      rendererIndexFile: APP_INDEX,
      logger: createFakeLogger(),
    });
    const webContents = lastWindow().webContents;
    expect(webContents.loadFile).toHaveBeenCalledWith(APP_INDEX);
    expect(webContents.loadURL).not.toHaveBeenCalled();
  });

  it('window.open 一律 deny', () => {
    createMainWindow({
      preloadFile: PRELOAD,
      rendererIndexFile: APP_INDEX,
      logger: createFakeLogger(),
    });
    const handler = lastWindow().webContents.windowOpenHandler;
    expect(handler({ url: 'https://evil.example/steal' })).toEqual({ action: 'deny' });
    expect(handler({ url: APP_INDEX_URL })).toEqual({ action: 'deny' });
  });

  it('will-navigate 只允许应用自身 index.html', () => {
    createMainWindow({
      preloadFile: PRELOAD,
      rendererIndexFile: APP_INDEX,
      logger: createFakeLogger(),
    });
    const webContents = lastWindow().webContents;
    const blocked = { preventDefault: vi.fn() };
    webContents.emit('will-navigate', blocked, 'https://evil.example/');
    expect(blocked.preventDefault).toHaveBeenCalledTimes(1);

    const allowed = { preventDefault: vi.fn() };
    webContents.emit('will-navigate', allowed, APP_INDEX_URL);
    expect(allowed.preventDefault).not.toHaveBeenCalled();
  });

  it('<webview> 与重定向被阻止', () => {
    createMainWindow({
      preloadFile: PRELOAD,
      rendererIndexFile: APP_INDEX,
      logger: createFakeLogger(),
    });
    const webContents = lastWindow().webContents;
    const attachEvent = { preventDefault: vi.fn() };
    webContents.emit('will-attach-webview', attachEvent);
    expect(attachEvent.preventDefault).toHaveBeenCalledTimes(1);

    const redirectEvent = { preventDefault: vi.fn() };
    webContents.emit('will-redirect', redirectEvent, 'https://evil.example/');
    expect(redirectEvent.preventDefault).toHaveBeenCalledTimes(1);
    const allowedRedirect = { preventDefault: vi.fn() };
    webContents.emit('will-redirect', allowedRedirect, APP_INDEX_URL);
    expect(allowedRedirect.preventDefault).not.toHaveBeenCalled();
  });

  it('权限请求一律拒绝', () => {
    createMainWindow({
      preloadFile: PRELOAD,
      rendererIndexFile: APP_INDEX,
      logger: createFakeLogger(),
    });
    const requestHandler = h.permissionRequestHandlers[h.permissionRequestHandlers.length - 1];
    const callback = vi.fn();
    requestHandler({}, 'media', callback);
    expect(callback).toHaveBeenCalledWith(false);
    const checkHandler = h.permissionCheckHandlers[h.permissionCheckHandlers.length - 1];
    expect(checkHandler(null, 'media', 'file://')).toBe(false);
    const deviceHandler = h.devicePermissionHandlers[h.devicePermissionHandlers.length - 1];
    expect(deviceHandler({})).toBe(false);
  });

  it('响应头注入生产 CSP（仅应用页面）', () => {
    createMainWindow({
      preloadFile: PRELOAD,
      rendererIndexFile: APP_INDEX,
      logger: createFakeLogger(),
    });
    const ownHeaders = invokeHeaders(APP_INDEX_URL);
    expect(ownHeaders['Content-Security-Policy']).toEqual([PROD_CSP]);
    expect(ownHeaders['content-type']).toEqual(['text/html']);

    const evilHeaders = invokeHeaders('https://evil.example/');
    expect(evilHeaders['Content-Security-Policy']).toBeUndefined();
  });
});

describe('window：开发模式', () => {
  it('加载 dev server 并启用 DevTools', () => {
    createMainWindow({
      preloadFile: PRELOAD,
      rendererIndexFile: APP_INDEX,
      devServerUrl: DEV_URL,
      logger: createFakeLogger(),
    });
    const window = lastWindow();
    expect(window.webContents.loadURL).toHaveBeenCalledWith(DEV_URL);
    expect(window.webContents.loadFile).not.toHaveBeenCalled();
    expect(window.options.webPreferences.devTools).toBe(true);
  });

  it('CSP 允许 Vite HMR websocket 与 inline script', () => {
    createMainWindow({
      preloadFile: PRELOAD,
      rendererIndexFile: APP_INDEX,
      devServerUrl: DEV_URL,
      logger: createFakeLogger(),
    });
    const headers = invokeHeaders(`${DEV_URL}index.html`);
    const csp = headers['Content-Security-Policy']?.[0] ?? '';
    expect(csp).toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).toContain('ws://127.0.0.1:5173');
    expect(csp).toContain("object-src 'none'");
    // dev mode 下 file:// index.html 不是受信任来源，不该注入 CSP
    expect(invokeHeaders(APP_INDEX_URL)['Content-Security-Policy']).toBeUndefined();
  });

  it('buildDevCsp 不包含生产模式的 connect-src none', () => {
    const devCsp = buildDevCsp(DEV_URL);
    expect(devCsp).not.toBe(PROD_CSP);
    expect(devCsp).toContain("connect-src 'self' ws://127.0.0.1:5173 http://127.0.0.1:5173");
    expect(PROD_CSP).toContain("connect-src 'none'");
  });

  it('可注入 session（便于测试/复用）', () => {
    const fakeSession: SessionLike = {
      setPermissionRequestHandler: vi.fn(),
      setPermissionCheckHandler: vi.fn(),
      setDevicePermissionHandler: vi.fn(),
      webRequest: { onHeadersReceived: vi.fn() },
    };
    createMainWindow({
      preloadFile: PRELOAD,
      rendererIndexFile: APP_INDEX,
      logger: createFakeLogger(),
      session: fakeSession,
    });
    expect(fakeSession.setPermissionRequestHandler).toHaveBeenCalledTimes(1);
    expect(fakeSession.webRequest.onHeadersReceived).toHaveBeenCalledTimes(1);
  });
});
