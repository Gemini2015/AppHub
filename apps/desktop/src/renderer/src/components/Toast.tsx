import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Icon } from './Icon';
import type { ApiError } from '../types';

export type ToastKind = 'success' | 'error' | 'info' | 'warning';

export interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
  code?: string;
}

export interface ToastApi {
  push(input: { kind: ToastKind; message: string; code?: string }): void;
  success(message: string): void;
  info(message: string): void;
  warning(message: string): void;
  error(error: ApiError, prefix?: string): void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const toast = useContext(ToastContext);
  if (!toast) throw new Error('useToast 必须在 ToastProvider 内使用');
  return toast;
}

const TOAST_DURATION = { success: 3500, info: 4000, warning: 6000, error: 7000 } as const;

/** 全局 toast 堆栈：成功/失败/提示均带图标，错误额外展示 error.code。 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextIdRef = useRef(1);
  const timersRef = useRef<number[]>([]);

  const remove = useCallback((id: number) => {
    setToasts((current) => current.filter((item) => item.id !== id));
  }, []);

  const push = useCallback(
    (input: { kind: ToastKind; message: string; code?: string }) => {
      const id = nextIdRef.current;
      nextIdRef.current += 1;
      setToasts((current) => [...current, { id, ...input }]);
      const timer = window.setTimeout(() => remove(id), TOAST_DURATION[input.kind]);
      timersRef.current.push(timer);
    },
    [remove],
  );

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, []);

  const value = useMemo<ToastApi>(
    () => ({
      push,
      success: (message: string) => push({ kind: 'success', message }),
      info: (message: string) => push({ kind: 'info', message }),
      warning: (message: string) => push({ kind: 'warning', message }),
      error: (error: ApiError, prefix?: string) =>
        push({ kind: 'error', message: prefix ? `${prefix}：${error.message}` : error.message, code: error.code }),
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-stack" aria-live="polite">
        {toasts.map((item) => (
          <div
            key={item.id}
            className={`toast toast-${item.kind}`}
            role={item.kind === 'error' ? 'alert' : 'status'}
          >
            <span className="toast-icon">
              <Icon
                name={
                  item.kind === 'success'
                    ? 'check-circle'
                    : item.kind === 'error'
                      ? 'x-circle'
                      : item.kind === 'warning'
                        ? 'alert'
                        : 'info'
                }
                size={18}
              />
            </span>
            <div className="toast-body">
              <p>{item.message}</p>
              {item.code ? <code className="toast-code">{item.code}</code> : null}
            </div>
            <button type="button" className="icon-btn toast-close" aria-label="关闭提示" onClick={() => remove(item.id)}>
              <Icon name="close" size={14} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
