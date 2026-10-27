import { useState } from 'react';
import { useApi } from '../api';
import { copyText } from '../clipboard';
import { Badge } from './Badges';
import { ApiErrorBanner, InfoBanner, SelectField, TextField } from './Form';
import { Icon } from './Icon';
import { Modal } from './Modal';
import { useToast } from './Toast';
import { useAsyncData } from '../hooks/useAsyncData';
import { bindHostLabel, formatDateTime } from '../format';
import type { ApiError, BindHost, HostStatusDTO, UpdateHostConfigRequestDTO } from '../types';

const ADVERTISE_HOST_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/;

const BIND_HOST_OPTIONS = [
  { value: '0.0.0.0', label: '局域网可访问（0.0.0.0，推荐）' },
  { value: '127.0.0.1', label: '仅本机（127.0.0.1，调试用）' },
];

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** 从首选订阅地址推导当前对外主机名（仅用于编辑弹窗回显，不保证等于已保存配置）。 */
function hostFromUrl(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// 编辑 Host 配置
// ---------------------------------------------------------------------------

interface HostConfigModalProps {
  channelId: string;
  status: HostStatusDTO;
  onClose: () => void;
  onSaved: (next: HostStatusDTO) => void;
}

function HostConfigModal({ channelId, status, onClose, onSaved }: HostConfigModalProps) {
  const api = useApi();
  const toast = useToast();
  const [port, setPort] = useState(String(status.configuredPort));
  const [bindHost, setBindHost] = useState<BindHost>(status.bindHost === '127.0.0.1' ? '127.0.0.1' : '0.0.0.0');
  // HostStatusDTO 不包含已保存的 advertiseHost/publicBaseUrl，这里用首选订阅地址的主机名回显；
  // 只有用户实际改过（touched）才提交该字段，清空后提交 '' 表示清除配置。
  const [advertiseHost, setAdvertiseHost] = useState(() => hostFromUrl(status.urls.channelUrl));
  const [publicBaseUrl, setPublicBaseUrl] = useState('');
  const [advertiseHostTouched, setAdvertiseHostTouched] = useState(false);
  const [publicBaseUrlTouched, setPublicBaseUrlTouched] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<ApiError | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    const nextErrors: Record<string, string> = {};
    const portNumber = Number.parseInt(port, 10);
    if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
      nextErrors.port = '端口必须是 1-65535 的整数';
    }
    if (advertiseHost.trim() && !ADVERTISE_HOST_PATTERN.test(advertiseHost.trim())) {
      nextErrors.advertiseHost = '只能是主机名或 IPv4（不含协议、端口、路径），例如 192.168.1.10';
    }
    if (publicBaseUrl.trim() && !isHttpUrl(publicBaseUrl.trim())) {
      nextErrors.publicBaseUrl = '必须是 http(s) 地址，例如 http://192.168.1.10:8787/';
    }
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    setSubmitting(true);
    setSubmitError(null);
    try {
      const input: UpdateHostConfigRequestDTO = {
        channelId,
        patch: {
          port: portNumber,
          bindHost,
          // 未修改的可选字段不传（保持原值）；修改后清空则传空字符串（清除配置）。
          ...(advertiseHostTouched ? { advertiseHost: advertiseHost.trim() } : {}),
          ...(publicBaseUrlTouched ? { publicBaseUrl: publicBaseUrl.trim() } : {}),
        },
      };
      const result = await api.host.updateConfig(input);
      if (!result.ok) {
        setSubmitError(result.error);
        toast.error(result.error, '更新 Host 配置失败');
        return;
      }
      toast.success('Host 配置已更新，下次启动生效');
      onSaved(result.value);
    } catch {
      const error: ApiError = { code: 'INTERNAL', message: '更新 Host 配置时发生未知错误。' };
      setSubmitError(error);
      toast.error(error, '更新 Host 配置失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      title="编辑 Host 配置"
      subtitle="仅停止状态下可修改；rootDir 与频道本身不可更改"
      testId="host-config-dialog"
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
            data-testid="host-config-submit"
            onClick={() => void submit()}
            disabled={submitting}
          >
            {submitting ? '保存中…' : '保存配置'}
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
            <ApiErrorBanner error={submitError} title="更新 Host 配置失败" />
          </div>
        ) : null}
        <div className="grid grid-2">
          <TextField
            label="监听端口"
            testId="host-config-port"
            value={port}
            onChange={(value) => {
              setPort(value);
              setErrors((current) => {
                if (!('port' in current)) return current;
                const next = { ...current };
                delete next.port;
                return next;
              });
            }}
            required
            type="number"
            mono
            hint="默认 8787；被占用时可换一个端口。"
            error={errors.port}
            disabled={submitting}
          />
          <SelectField
            label="访问范围"
            testId="host-config-bind-host"
            value={bindHost}
            onChange={(value) => setBindHost(value === '127.0.0.1' ? '127.0.0.1' : '0.0.0.0')}
            options={BIND_HOST_OPTIONS}
            required
            hint="0.0.0.0 允许局域网访问；127.0.0.1 仅本机调试。"
            disabled={submitting}
          />
        </div>
        <TextField
          label="对外主机名（advertiseHost，可选）"
          testId="host-config-advertise-host"
          value={advertiseHost}
          onChange={(value) => {
            setAdvertiseHost(value);
            setAdvertiseHostTouched(true);
          }}
          placeholder="例如 192.168.1.10 或 my-pc.local"
          hint="用于生成订阅 URL 的主机名/IPv4；留空表示清除，自动使用本机检测到的局域网地址。"
          error={errors.advertiseHost}
          disabled={submitting}
          mono
        />
        <TextField
          label="公开基地址（publicBaseUrl，可选）"
          testId="host-config-public-base-url"
          value={publicBaseUrl}
          onChange={(value) => {
            setPublicBaseUrl(value);
            setPublicBaseUrlTouched(true);
          }}
          type="url"
          placeholder="例如 https://apphub.example.com/"
          hint="反向代理/自定义域名场景下完整覆盖订阅 URL；留空表示清除，订阅地址使用 Host 自动生成的地址。"
          error={errors.publicBaseUrl}
          disabled={submitting}
          mono
        />
        <InfoBanner tone="info" title="留空 = 清除可选配置">
          <code>advertiseHost</code> 留空会清除已保存的对外主机名，订阅地址自动使用本机检测到的局域网地址；
          <code>publicBaseUrl</code> 留空会清除自定义公开地址，不再覆盖自动生成的订阅地址。
          未修改的字段保持原值。
        </InfoBanner>
        <InfoBanner tone="info" title="配置何时生效">
          修改会写入频道的 <code>channel_pri.json</code> 并加密保存在本机；端口/监听范围的变更在下次启动 Host 时生效。
        </InfoBanner>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Host 面板
// ---------------------------------------------------------------------------

export interface HostPanelProps {
  channelId: string;
  /** App 全局数据版本：host 数据变更后自增，驱动刷新。 */
  dataVersion?: number;
  /** Host 状态变化后通知父视图（刷新频道列表徽标等）。 */
  onChanged?: () => void | Promise<void>;
}

/**
 * 本机 Host（local-host 频道）状态面板。
 *
 * - 非 local-host 频道（UNSUPPORTED/NOT_FOUND）静默不渲染；
 * - 展示运行状态/端口/监听范围/URL，支持启动、停止、编辑配置；
 * - 只在 AppHub 运行期间有效，局域网访问受系统防火墙影响。
 */
export function HostPanel({ channelId, dataVersion = 0, onChanged }: HostPanelProps) {
  const api = useApi();
  const toast = useToast();
  const state = useAsyncData<HostStatusDTO>(
    () => api.host.status(channelId),
    `${channelId}:${dataVersion}`,
  );
  const [busy, setBusy] = useState<'start' | 'stop' | null>(null);
  const [editOpen, setEditOpen] = useState(false);

  const status = state.data;

  const copyUrl = async (url: string, label: string) => {
    const copied = await copyText(url);
    if (copied) toast.success(`${label}已复制`);
    else toast.error({ code: 'INTERNAL', message: '复制失败，请手动选中地址复制。' });
  };

  const startHost = async () => {
    setBusy('start');
    try {
      const result = await api.host.start(channelId);
      if (!result.ok) {
        toast.error(result.error, '启动本机 Host 失败');
        return;
      }
      state.setData(result.value);
      toast.success(`本机 Host 已启动：${result.value.urls.channelUrl}`);
      await onChanged?.();
    } finally {
      setBusy(null);
    }
  };

  const stopHost = async () => {
    setBusy('stop');
    try {
      const result = await api.host.stop(channelId);
      if (!result.ok) {
        toast.error(result.error, '停止本机 Host 失败');
        return;
      }
      state.setData(result.value);
      toast.success('本机 Host 已停止');
      await onChanged?.();
    } finally {
      setBusy(null);
    }
  };

  if (state.loading && !status) return null;
  if (state.error && (state.error.code === 'UNSUPPORTED' || state.error.code === 'NOT_FOUND')) return null;
  if (!status) {
    return (
      <section className="card host-panel" data-testid="host-panel">
        <ApiErrorBanner
          error={state.error ?? { code: 'INTERNAL', message: '无法读取本机 Host 状态。' }}
          title="本机 Host 状态读取失败"
        />
        <div className="host-error-actions">
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => void state.reload()}>
            <Icon name="refresh" size={14} />
            重试
          </button>
        </div>
      </section>
    );
  }

  const port = status.running ? (status.port ?? status.configuredPort) : status.configuredPort;
  const canEdit = !status.running;
  const busyAny = busy !== null;

  return (
    <section className="card host-panel" data-testid="host-panel">
      <div className="host-head">
        <div className="host-title">
          <span className="app-icon host-icon">
            <Icon name="server" size={20} />
          </span>
          <div>
            <h2>
              本机 Host
              <Badge
                tone={status.running ? 'success' : 'muted'}
                icon={status.running ? 'server' : 'x-circle'}
                testId="host-status"
              >
                {status.running ? '运行中' : '已停止'}
              </Badge>
            </h2>
            <p className="field-hint">
              把频道直接托管在本机 AppHub 上，App 运行期间提供订阅与下载，无需 FTP / nginx。
            </p>
          </div>
        </div>
        <div className="host-head-actions">
          {canEdit ? (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              data-testid="host-edit-config"
              onClick={() => setEditOpen(true)}
              disabled={busyAny}
            >
              <Icon name="settings" size={14} />
              编辑配置
            </button>
          ) : null}
          {status.running ? (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              data-testid="host-stop-button"
              onClick={() => void stopHost()}
              disabled={busyAny}
            >
              <Icon name="close" size={14} />
              {busy === 'stop' ? '停止中…' : '停止 Host'}
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              data-testid="host-start-button"
              onClick={() => void startHost()}
              disabled={busyAny}
            >
              <Icon name="play" size={14} />
              {busy === 'start' ? '启动中…' : '启动 Host'}
            </button>
          )}
        </div>
      </div>

      <dl className="detail-meta host-meta">
        <div>
          <dt>监听端口</dt>
          <dd className="mono">
            {port}
            {!status.running ? '（未监听）' : ''}
          </dd>
        </div>
        <div>
          <dt>访问范围</dt>
          <dd>{bindHostLabel(status.bindHost)}</dd>
        </div>
        <div>
          <dt>启动时间</dt>
          <dd>{status.running ? formatDateTime(status.startedAt) : '—'}</dd>
        </div>
        <div>
          <dt>频道可见性</dt>
          <dd>{status.visibility === 'private' ? '私密（能力链接）' : '公开'}</dd>
        </div>
      </dl>

      <div className="host-urls">
        <div className="host-url-row host-url-primary">
          <Icon name="link" size={15} />
          <span className="host-url-label">首选订阅地址</span>
          <code className="host-url-value mono" data-testid="host-url" title={status.urls.channelUrl}>
            {status.urls.channelUrl}
          </code>
          <button
            type="button"
            className="icon-btn"
            aria-label="复制首选地址"
            onClick={() => void copyUrl(status.urls.channelUrl, '首选订阅地址')}
          >
            <Icon name="copy" size={15} />
          </button>
        </div>
        <div className="host-url-row">
          <Icon name="server" size={15} />
          <span className="host-url-label">本机地址</span>
          <code className="host-url-value mono" title={status.urls.localChannelUrl}>
            {status.urls.localChannelUrl}
          </code>
          <button
            type="button"
            className="icon-btn"
            aria-label="复制本机地址"
            onClick={() => void copyUrl(status.urls.localChannelUrl, '本机地址')}
          >
            <Icon name="copy" size={15} />
          </button>
        </div>
        {status.urls.lanChannelUrls.map((url, index) => (
          <div className="host-url-row" key={url}>
            <Icon name="globe" size={15} />
            <span className="host-url-label">局域网地址 {index + 1}</span>
            <code className="host-url-value mono" title={url}>
              {url}
            </code>
            <button
              type="button"
              className="icon-btn"
              aria-label={`复制局域网地址 ${index + 1}`}
              onClick={() => void copyUrl(url, `局域网地址 ${index + 1}`)}
            >
              <Icon name="copy" size={15} />
            </button>
          </div>
        ))}
      </div>

      {status.lastError ? <ApiErrorBanner error={status.lastError} title="上次启动失败" /> : null}

      {status.running ? (
        <InfoBanner tone="warn" title="局域网访问与防火墙">
          正在监听 {status.bindHost}，同一局域网的设备可通过上方地址访问频道。如果其他设备打不开：检查系统防火墙是否放行
          TCP {port}（Windows 首次启动会弹出防火墙授权，需要允许「专用网络」）；跨网段或公网访问需要在路由器做端口转发，
          或使用反向代理并通过 publicBaseUrl 指定对外地址。Host 只在 AppHub 运行期间有效。
        </InfoBanner>
      ) : (
        <InfoBanner tone="info" title="Host 未运行">
          Host 停止时订阅者无法通过本机地址访问频道（App 列表与发布功能不受影响）。点击「启动 Host」
          开始在 App 运行期间提供频道；关闭 AppHub 后链接会失效。
        </InfoBanner>
      )}

      {status.visibility === 'private' ? (
        <InfoBanner tone="warn" title="私密频道：链接即授权，谨慎分享">
          当前订阅地址是包含 accessKey 的能力链接，拿到链接的人即可读取/订阅该私密频道；请只分享给可信的人。
        </InfoBanner>
      ) : null}

      {state.error ? <ApiErrorBanner error={state.error} title="Host 状态刷新失败" /> : null}

      {editOpen ? (
        <HostConfigModal
          channelId={channelId}
          status={status}
          onClose={() => setEditOpen(false)}
          onSaved={(next) => {
            setEditOpen(false);
            state.setData(next);
            void onChanged?.();
          }}
        />
      ) : null}
    </section>
  );
}
