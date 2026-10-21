import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiError, ApiResult } from '../types';

export interface AsyncData<T> {
  data: T | null;
  error: ApiError | null;
  /** 首次加载（还没有任何数据）时为 true。 */
  loading: boolean;
  /** 已有数据、正在后台刷新时为 true。 */
  refreshing: boolean;
  reload: () => Promise<void>;
  setData: (data: T | null) => void;
}

/**
 * 统一的「调用 ApiResult 方法 → 维护加载/错误状态」Hook。
 *
 * - 首次加载显示 skeleton；已有数据时刷新不会清空内容；
 * - versionKey 变化（频道切换、dataVersion 变更）时自动重新拉取；
 * - 组件卸载后忽略迟到的响应。
 */
export function useAsyncData<T>(
  loader: () => Promise<ApiResult<T>>,
  versionKey: string | number = 0,
): AsyncData<T> {
  const [data, setDataState] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const mountedRef = useRef(true);
  const hasDataRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const reload = useCallback(async (): Promise<void> => {
    if (hasDataRef.current) setRefreshing(true);
    else setLoading(true);
    try {
      const result = await loaderRef.current();
      if (!mountedRef.current) return;
      if (result.ok) {
        hasDataRef.current = true;
        setDataState(result.value);
        setError(null);
      } else {
        setError(result.error);
      }
    } finally {
      if (mountedRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload, versionKey]);

  const setData = useCallback((value: T | null): void => {
    hasDataRef.current = value !== null;
    setDataState(value);
  }, []);

  return { data, error, loading, refreshing, reload, setData };
}
