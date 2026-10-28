import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useApi } from '../api';
import { useToast } from './Toast';
import type { ApiError, ApiResult, UpdateStateDTO } from '../types';

type UpdateAction = 'check' | 'download' | 'install' | 'dismiss';

export interface UpdateContextValue {
  state: UpdateStateDTO | null;
  /** 首次读取更新状态的加载态。 */
  loading: boolean;
  /** 当前进行中的更新操作。 */
  busy: UpdateAction | null;
  /** 最近一次动作的错误（内联展示用）。 */
  error: ApiError | null;
  dialogOpen: boolean;
  openDialog: () => void;
  closeDialog: () => void;
  check: () => Promise<void>;
  download: () => Promise<void>;
  install: () => Promise<void>;
  dismiss: () => Promise<void>;
  retry: () => Promise<void>;
}

const UpdateContext = createContext<UpdateContextValue | null>(null);

export function useUpdate(): UpdateContextValue {
  const value = useContext(UpdateContext);
  if (!value) throw new Error('useUpdate 必须在 UpdateProvider 内使用');
  return value;
}

/**
 * 自动更新状态容器：
 * - 挂载时读取 api.updates.state()（只读本地状态，不主动发起网络检查）；
 * - 订阅 api.events.onUpdateState 跟随主进程状态；
 * - 对外提供 check/download/install/dismiss/retry 动作与错误信息。
 *
 * 注意：不支持更新的环境（dev/platform/e2e/env）所有动作按钮都应禁用，避免无意义的网络请求。
 */
export function UpdateProvider({ children }: { children: ReactNode }) {
  const api = useApi();
  const toast = useToast();

  const [state, setState] = useState<UpdateStateDTO | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<UpdateAction | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const previousStatusRef = useRef<string | null>(null);

  const applyState = (next: UpdateStateDTO): void => {
    setState(next);
    setError(next.error ?? null);
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await api.updates.state();
      if (cancelled) return;
      if (result.ok) {
        setState(result.value);
        setError(result.value.error ?? null);
      } else {
        setError(result.error);
      }
      setLoading(false);
    })();

    const unsubscribe = api.events.onUpdateState((next) => {
      setState(next);
      setError(next.error ?? null);
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [api]);

  // 状态流转提示（下载完成 / 已是最新）；首次加载不提示。
  useEffect(() => {
    if (!state) return;
    const previous = previousStatusRef.current;
    previousStatusRef.current = state.status;
    if (previous === null) return;
    if (state.status === 'downloaded' && previous !== 'downloaded') {
      toast.success('更新已下载，重启 App 即可安装');
    }
    if (state.status === 'up-to-date' && previous === 'checking') {
      toast.success('当前已是最新版本');
    }
  }, [state, toast]);

  const runStateAction = async (
    action: UpdateAction,
    failLabel: string,
    call: () => Promise<ApiResult<UpdateStateDTO>>,
  ): Promise<void> => {
    setBusy(action);
    setError(null);
    try {
      const result = await call();
      if (!result.ok) {
        setError(result.error);
        toast.error(result.error, failLabel);
        return;
      }
      applyState(result.value);
    } catch {
      const nextError: ApiError = { code: 'INTERNAL', message: '更新操作失败，请稍后重试。' };
      setError(nextError);
      toast.error(nextError, failLabel);
    } finally {
      setBusy(null);
    }
  };

  const check = () => runStateAction('check', '检查更新失败', () => api.updates.check());
  const download = () => runStateAction('download', '下载更新失败', () => api.updates.download());

  const dismiss = async (): Promise<void> => {
    setBusy('dismiss');
    try {
      const result = await api.updates.dismiss();
      if (!result.ok) {
        toast.error(result.error, '操作失败');
        return;
      }
      applyState(result.value);
    } finally {
      setBusy(null);
    }
  };

  const install = async (): Promise<void> => {
    setBusy('install');
    setError(null);
    try {
      const result = await api.updates.install();
      if (!result.ok) {
        setError(result.error);
        toast.error(result.error, '安装更新失败');
        return;
      }
      toast.info('正在重启并安装更新…');
    } catch {
      const nextError: ApiError = { code: 'INTERNAL', message: '安装更新失败，请重新下载后再试。' };
      setError(nextError);
      toast.error(nextError, '安装更新失败');
    } finally {
      setBusy(null);
    }
  };

  const retry = async (): Promise<void> => {
    if (state?.availableVersion) await download();
    else await check();
  };

  const value = useMemo<UpdateContextValue>(
    () => ({
      state,
      loading,
      busy,
      error,
      dialogOpen,
      openDialog: () => setDialogOpen(true),
      closeDialog: () => setDialogOpen(false),
      check,
      download,
      install,
      dismiss,
      retry,
    }),
    // 动作闭包依赖 state/busy/api/toast，随渲染更新即可（保持简单、避免陈旧闭包）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state, loading, busy, error, dialogOpen],
  );

  return <UpdateContext.Provider value={value}>{children}</UpdateContext.Provider>;
}
