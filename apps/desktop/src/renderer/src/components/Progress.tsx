import { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useApi } from '../api';
import { progressPercent, progressPhaseLabel, progressOperationLabel } from '../format';
import type { ProgressEventDTO } from '../types';

export interface ProgressContextValue {
  event: ProgressEventDTO | null;
  clear: () => void;
}

const ProgressContext = createContext<ProgressContextValue | null>(null);

export function useProgress(): ProgressContextValue {
  const progress = useContext(ProgressContext);
  if (!progress) throw new Error('useProgress 必须在 ProgressProvider 内使用');
  return progress;
}

/** 进度条（0-100）；percent 未知时显示不确定态。 */
export function ProgressBar({
  percent,
  label,
  detail,
  currentFile,
  index,
  count,
}: {
  percent: number | undefined;
  label?: string;
  detail?: string;
  currentFile?: string;
  index?: number;
  count?: number;
}) {
  return (
    <div className="progress-panel">
      <div className="progress-head">
        <span className="progress-label">{label ?? '处理中…'}</span>
        {percent !== undefined ? <span className="progress-num">{percent}%</span> : null}
      </div>
      <div
        className={percent === undefined ? 'progress-track progress-indeterminate' : 'progress-track'}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-label={label ?? '处理进度'}
      >
        <div className="progress-fill" style={percent === undefined ? undefined : { width: `${percent}%` }} />
      </div>
      {detail ? <p className="progress-detail">{detail}</p> : null}
      {currentFile ? (
        <p className="progress-file" title={currentFile}>
          {currentFile}
        </p>
      ) : null}
      {typeof index === 'number' && typeof count === 'number' && count > 0 ? (
        <p className="progress-detail">
          文件 {index}/{count}
        </p>
      ) : null}
    </div>
  );
}

function ProgressHud({ event }: { event: ProgressEventDTO }) {
  const percent = progressPercent(event);
  const op = progressOperationLabel(event.operation);
  const phase = progressPhaseLabel(event.phase);
  return (
    <div className="progress-hud" role="status">
      <ProgressBar
        percent={percent}
        label={`${op} · ${phase}`}
        detail={event.message}
        currentFile={event.currentFile}
        index={event.index}
        count={event.count}
      />
    </div>
  );
}

/**
 * 订阅主进程进度事件，显示右下角全局进度浮层；2.5s 内没有新事件自动隐藏。
 * 发布向导等需要精确进度的场景可另外监听事件。
 */
export function ProgressProvider({ children }: { children: ReactNode }) {
  const api = useApi();
  const [event, setEvent] = useState<ProgressEventDTO | null>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    const clearTimer = () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
    const unsubscribe = api.events.onProgress((nextEvent) => {
      setEvent(nextEvent);
      clearTimer();
      timerRef.current = window.setTimeout(() => {
        setEvent(null);
        timerRef.current = null;
      }, 2500);
    });
    return () => {
      unsubscribe();
      clearTimer();
    };
  }, [api]);

  const clear = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setEvent(null);
  };

  return (
    <ProgressContext.Provider value={{ event, clear }}>
      {children}
      {event ? <ProgressHud event={event} /> : null}
    </ProgressContext.Provider>
  );
}
