import { useState } from 'react';
import { useApi } from '../api';
import { ApiErrorBanner, TextField } from '../components/Form';
import { Icon } from '../components/Icon';
import { Modal } from '../components/Modal';
import { useToast } from '../components/Toast';
import type { ApiError, ChannelDetailDTO } from '../types';

export interface SubscribeDialogProps {
  onClose: () => void;
  onSubscribed: (detail: ChannelDetailDTO) => void;
}

interface HeaderRow {
  id: number;
  key: string;
  value: string;
}

let headerRowId = 0;
function createHeaderRow(): HeaderRow {
  headerRowId += 1;
  return { id: headerRowId, key: '', value: '' };
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** 订阅频道：channel.json URL（私密频道即能力链接）+ 可选 HTTP headers。 */
export function SubscribeDialog({ onClose, onSubscribed }: SubscribeDialogProps) {
  const api = useApi();
  const toast = useToast();

  const [url, setUrl] = useState('');
  const [showHeaders, setShowHeaders] = useState(false);
  const [headers, setHeaders] = useState<HeaderRow[]>([]);
  const [urlError, setUrlError] = useState<string | undefined>();
  const [headerErrors, setHeaderErrors] = useState<Record<number, string>>({});
  const [submitError, setSubmitError] = useState<ApiError | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const updateHeader = (id: number, patch: Partial<Pick<HeaderRow, 'key' | 'value'>>) => {
    setHeaders((current) => current.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  };

  const collectHeaders = (): { headers?: Record<string, string>; errors: Record<number, string> } => {
    const errors: Record<number, string> = {};
    const result: Record<string, string> = {};
    for (const row of headers) {
      const key = row.key.trim();
      const value = row.value.trim();
      if (!key && !value) continue;
      if (!key) {
        errors[row.id] = '请填写请求头名称';
        continue;
      }
      if (!value) {
        errors[row.id] = '请填写该请求头的值';
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(result, key)) {
        errors[row.id] = '请求头名称重复';
        continue;
      }
      result[key] = value;
    }
    return {
      errors,
      ...(Object.keys(result).length > 0 ? { headers: result } : {}),
    };
  };

  const submit = async () => {
    const trimmed = url.trim();
    const nextHeaderErrors: Record<number, string> = {};
    let urlMessage: string | undefined;
    if (!trimmed) urlMessage = '请输入 channel.json 地址';
    else if (!isHttpUrl(trimmed)) urlMessage = '请输入合法的 http(s) 地址，例如 http://example.com/app_repo/channel.json';
    const collected = collectHeaders();
    if (!urlMessage) setUrlError(undefined);
    else setUrlError(urlMessage);
    Object.assign(nextHeaderErrors, collected.errors);
    setHeaderErrors(nextHeaderErrors);
    if (urlMessage || Object.keys(nextHeaderErrors).length > 0) return;

    setSubmitting(true);
    setSubmitError(null);
    try {
      const result = await api.channels.subscribe({
        url: trimmed,
        ...(collected.headers ? { headers: collected.headers } : {}),
      });
      if (!result.ok) {
        setSubmitError(result.error);
        toast.error(result.error, '订阅频道失败');
        return;
      }
      toast.success(`已订阅频道「${result.value.summary.name}」`);
      onSubscribed(result.value);
    } catch {
      const error: ApiError = { code: 'INTERNAL', message: '订阅频道时发生未知错误，请查看主进程日志。' };
      setSubmitError(error);
      toast.error(error, '订阅频道失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      title="订阅频道"
      subtitle="粘贴频道所有者提供的 channel.json 地址（私密频道即能力链接）"
      testId="subscribe-dialog"
      size="md"
      closable={!submitting}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={submitting}>
            取消
          </button>
          <div className="footer-spacer" />
          <button
            type="button"
            className="btn btn-primary"
            data-testid="subscribe-submit"
            onClick={() => void submit()}
            disabled={submitting}
          >
            {submitting ? '订阅中…' : '订阅'}
          </button>
        </>
      }
    >
      <form
        className="form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {submitError ? (
          <div data-testid="dialog-error">
            <ApiErrorBanner error={submitError} title="订阅频道失败" />
          </div>
        ) : null}

        <TextField
          label="channel.json 地址"
          testId="subscribe-url-input"
          value={url}
          onChange={setUrl}
          required
          type="url"
          placeholder="http://127.0.0.1:8080/app_repo/channel.json"
          hint="公开频道就是频道根目录下的 channel.json；私密频道链接中会包含 accessKey。"
          error={urlError}
          disabled={submitting}
          mono
        />

        <div className="collapse">
          <button
            type="button"
            className="collapse-toggle"
            aria-expanded={showHeaders}
            onClick={() => setShowHeaders((current) => !current)}
          >
            <Icon name={showHeaders ? 'chevron-right' : 'chevron-right'} size={14} className={showHeaders ? 'chevron-open' : undefined} />
            高级：HTTP 请求头（可选）
          </button>
          {showHeaders ? (
            <div className="collapse-body">
              <p className="field-hint">
                如果频道由 Basic Auth 或无头浏览器之外的网关保护，可在这里附加请求头（例如{' '}
                <code>Authorization: Basic ...</code>）。请求头会随订阅记录加密保存，用于后续刷新。
              </p>
              {headers.length === 0 ? (
                <p className="muted">暂未添加请求头。</p>
              ) : (
                <div className="kv-list">
                  {headers.map((row, index) => (
                    <div className="kv-row" key={row.id}>
                      <input
                        className="input mono"
                        placeholder={`请求头名称（如 Authorization）`}
                        aria-label={`请求头名称 ${index + 1}`}
                        value={row.key}
                        disabled={submitting}
                        onChange={(event) => updateHeader(row.id, { key: event.target.value })}
                      />
                      <input
                        className="input mono"
                        placeholder="请求头值"
                        aria-label={`请求头值 ${index + 1}`}
                        value={row.value}
                        disabled={submitting}
                        onChange={(event) => updateHeader(row.id, { value: event.target.value })}
                      />
                      <button
                        type="button"
                        className="icon-btn"
                        aria-label={`删除请求头 ${index + 1}`}
                        disabled={submitting}
                        onClick={() =>
                          setHeaders((current) => current.filter((item) => item.id !== row.id))
                        }
                      >
                        <Icon name="trash" size={15} />
                      </button>
                      {headerErrors[row.id] ? (
                        <p className="field-error" role="alert">
                          {headerErrors[row.id]}
                        </p>
                      ) : null}
                    </div>
                  ))}
                </div>
              )}
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setHeaders((current) => [...current, createHeaderRow()])}
                disabled={submitting}
              >
                <Icon name="plus" size={14} />
                添加请求头
              </button>
            </div>
          ) : null}
        </div>
      </form>
    </Modal>
  );
}
