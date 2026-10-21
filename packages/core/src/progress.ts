import type { ProgressEvent, ProgressListener } from './types';

/**
 * 进度回调安全包装：UI 回调抛错不能中断发布/安装流程。
 */
export function createProgressEmitter(
  listener: ProgressListener | undefined,
): (event: ProgressEvent) => void {
  return (event: ProgressEvent): void => {
    if (!listener) return;
    try {
      listener(event);
    } catch {
      // 忽略监听器异常（IPC 断开等场景不应影响核心流程）
    }
  };
}
