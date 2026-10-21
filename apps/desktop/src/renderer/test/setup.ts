/**
 * Vitest + jsdom 测试环境初始化（renderer project）。
 *
 * 由 apps/desktop/vitest.config.ts 的 renderer project 通过
 * setupFiles: 'src/renderer/test/setup.ts' 引用。
 */
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// 未开启 vitest globals 时 RTL 不会自动 cleanup，这里显式注册。
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

if (typeof window !== 'undefined') {
  // jsdom 未实现 matchMedia，部分组件/依赖会探测它。
  if (typeof window.matchMedia !== 'function') {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  }

  // jsdom 没有剪贴板实现，测试里通过 spyOn(navigator.clipboard, 'writeText') 断言复制行为。
  if (!navigator.clipboard) {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: vi.fn(async () => undefined),
        readText: vi.fn(async () => ''),
      },
    });
  }
}
