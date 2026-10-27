import { useEffect, useRef, useState } from 'react';
import { useApi } from '../api';
import { ApiErrorBanner, CheckboxField, InfoBanner, SelectField, TextAreaField, TextField } from '../components/Form';
import { Icon } from '../components/Icon';
import { Modal } from '../components/Modal';
import { useToast } from '../components/Toast';
import { bindHostLabel } from '../format';
import type {
  ApiError,
  BindHost,
  ChannelDetailDTO,
  StorageConfig,
  StorageProvider,
  Visibility,
} from '../types';

export interface CreateChannelWizardProps {
  onClose: () => void;
  onCreated: (detail: ChannelDetailDTO) => void;
}

interface LocalForm {
  rootDir: string;
  publicBaseUrl: string;
}

interface LocalHostForm {
  rootDir: string;
  port: string;
  bindHost: BindHost;
  advertiseHost: string;
  publicBaseUrl: string;
}

interface FtpForm {
  host: string;
  port: string;
  user: string;
  password: string;
  rootDir: string;
  secure: boolean;
  baseUrl: string;
}

interface S3Form {
  endpoint: string;
  region: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  pathStyle: boolean;
  secure: boolean;
  prefix: string;
  publicBaseUrl: string;
}

type FieldErrors = Record<string, string>;

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

const STEPS = [
  { key: 1, title: '基本信息', hint: '名称、可见性' },
  { key: 2, title: '存储配置', hint: '文件写入哪里' },
  { key: 3, title: '确认创建', hint: '探测并写入' },
] as const;

const PROVIDER_OPTIONS = [
  { value: 'local-host', label: '本机 Host（local-host）' },
  { value: 'local', label: '本地目录（local）' },
  { value: 'ftp-http', label: 'FTP + HTTP（ftp-http）' },
  { value: 's3', label: 'S3 / MinIO（s3）' },
];

/** advertiseHost 只能是主机名或 IPv4（与协议/主进程 schema 保持一致）。 */
const ADVERTISE_HOST_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/;

/** local-host 端口建议的起始值。 */
const DEFAULT_LOCAL_HOST_PORT = 8787;

/** 从 8787 开始找最小的、未被现有 local-host 频道使用的端口。 */
function suggestLocalHostPort(usedPorts: readonly number[]): number {
  const used = new Set(usedPorts);
  let candidate = DEFAULT_LOCAL_HOST_PORT;
  while (used.has(candidate) && candidate < 65535) candidate += 1;
  return candidate;
}

/** 创建频道向导：基础信息 → 存储 provider 配置 → 确认创建（含 probe/进度/错误）。 */
export function CreateChannelWizard({ onClose, onCreated }: CreateChannelWizardProps) {
  const api = useApi();
  const toast = useToast();

  const [step, setStep] = useState(1);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [visibility, setVisibility] = useState<Visibility>('public');
  const [ownerName, setOwnerName] = useState('');
  const [ownerContact, setOwnerContact] = useState('');
  const [provider, setProvider] = useState<StorageProvider>('local-host');
  const [local, setLocal] = useState<LocalForm>({ rootDir: '', publicBaseUrl: '' });
  // 默认对局域网开放（0.0.0.0）：本机 Host 的主要用途是让同一局域网的其他设备订阅。
  const [localHost, setLocalHost] = useState<LocalHostForm>({
    rootDir: '',
    port: String(DEFAULT_LOCAL_HOST_PORT),
    bindHost: '0.0.0.0',
    advertiseHost: '',
    publicBaseUrl: '',
  });
  /** 现有 local-host 频道已使用的端口（来自 host.list）。 */
  const [usedPorts, setUsedPorts] = useState<number[]>([]);
  /** 用户手动改过端口后，不再自动覆盖建议值。 */
  const portTouchedRef = useRef(false);
  const [ftp, setFtp] = useState<FtpForm>({
    host: '',
    port: '21',
    user: 'anonymous',
    password: '',
    rootDir: '',
    secure: false,
    baseUrl: '',
  });
  const [s3, setS3] = useState<S3Form>({
    endpoint: '',
    region: 'us-east-1',
    bucket: '',
    accessKey: '',
    secretKey: '',
    pathStyle: true,
    secure: true,
    prefix: '',
    publicBaseUrl: '',
  });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [submitError, setSubmitError] = useState<ApiError | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // 挂载时读取现有 local-host 频道占用的端口，自动避开并推荐未占用端口；失败静默忽略。
  useEffect(() => {
    let cancelled = false;
    const loadUsedPorts = async () => {
      const result = await api.host.list();
      if (cancelled || !result.ok) return;
      const ports = result.value
        .map((host) => host.configuredPort)
        .filter((port) => Number.isInteger(port) && port > 0);
      setUsedPorts(ports);
      if (!portTouchedRef.current) {
        setLocalHost((current) => ({ ...current, port: String(suggestLocalHostPort(ports)) }));
      }
    };
    void loadUsedPorts();
    return () => {
      cancelled = true;
    };
  }, [api]);

  const validateStep1 = (): FieldErrors => {
    const next: FieldErrors = {};
    const trimmedName = name.trim();
    if (!trimmedName) next.name = '请输入频道名称';
    else if (trimmedName.length > 64) next.name = '频道名称不能超过 64 个字符';
    if (description.length > 2048) next.description = '频道描述不能超过 2048 个字符';
    if (ownerName.length > 128) next.ownerName = '所有者名称不能超过 128 个字符';
    if (ownerContact.length > 256) next.ownerContact = '联系方式不能超过 256 个字符';
    return next;
  };

  const validateStep2 = (): FieldErrors => {
    const next: FieldErrors = {};
    if (provider === 'local') {
      if (!local.rootDir.trim()) next.localRootDir = '请输入本地存储根目录';
      if (!local.publicBaseUrl.trim()) next.localPublicBaseUrl = '请输入对外访问的 HTTP 地址';
      else if (!isHttpUrl(local.publicBaseUrl.trim())) next.localPublicBaseUrl = '必须是 http(s) 地址，例如 http://127.0.0.1:8080/app_repo/';
    } else if (provider === 'local-host') {
      if (!localHost.rootDir.trim()) next.localHostRootDir = '请选择或输入 Host 仓库根目录';
      const port = Number.parseInt(localHost.port, 10);
      if (!Number.isInteger(port) || port < 1 || port > 65535) next.localHostPort = '端口必须是 1-65535 的整数';
      else if (usedPorts.includes(port)) {
        next.localHostPort = `端口 ${port} 已被现有 local-host 频道使用，推荐 ${suggestLocalHostPort(usedPorts)}`;
      }
      if (localHost.advertiseHost.trim() && !ADVERTISE_HOST_PATTERN.test(localHost.advertiseHost.trim())) {
        next.localHostAdvertiseHost = '只能是主机名或 IPv4（不含协议、端口、路径），例如 192.168.1.10';
      }
      if (localHost.publicBaseUrl.trim() && !isHttpUrl(localHost.publicBaseUrl.trim())) {
        next.localHostPublicBaseUrl = '必须是 http(s) 地址，例如 http://192.168.1.10:8787/';
      }
    } else if (provider === 'ftp-http') {
      if (!ftp.host.trim()) next.ftpHost = '请输入 FTP 主机地址';
      const port = Number.parseInt(ftp.port, 10);
      if (!Number.isInteger(port) || port < 1 || port > 65535) next.ftpPort = '端口必须是 1-65535 的整数';
      if (!ftp.baseUrl.trim()) next.ftpBaseUrl = '请输入 nginx / 静态服务的 HTTP 地址';
      else if (!isHttpUrl(ftp.baseUrl.trim())) next.ftpBaseUrl = '必须是 http(s) 地址，例如 http://127.0.0.1:8080/app_repo/';
    } else {
      if (!s3.bucket.trim()) next.s3Bucket = '请输入 Bucket 名称';
      if (!s3.region.trim()) next.s3Region = '请输入 Region';
      if (!s3.accessKey.trim()) next.s3AccessKey = '请输入 Access Key';
      if (!s3.secretKey.trim()) next.s3SecretKey = '请输入 Secret Key';
      if (s3.endpoint.trim() && !isHttpUrl(s3.endpoint.trim())) {
        next.s3Endpoint = 'Endpoint 必须是 http(s) 地址，例如 http://127.0.0.1:9000';
      }
      if (s3.publicBaseUrl.trim() && !isHttpUrl(s3.publicBaseUrl.trim())) {
        next.s3PublicBaseUrl = '必须是 http(s) 地址，例如 https://cdn.example.com/apphub/';
      }
    }
    return next;
  };

  const validateAll = (): FieldErrors => ({ ...validateStep1(), ...validateStep2() });

  const clearError = (field: string): void => {
    setErrors((current) => {
      if (!(field in current)) return current;
      const next = { ...current };
      delete next[field];
      return next;
    });
  };

  const goNext = () => {
    const nextErrors = step === 1 ? validateStep1() : validateStep2();
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
    setSubmitError(null);
    setStep((current) => Math.min(3, current + 1));
  };

  const goBack = () => {
    setSubmitError(null);
    setErrors({});
    setStep((current) => Math.max(1, current - 1));
  };

  const buildStorage = (): StorageConfig => {
    if (provider === 'local') {
      return { provider: 'local', rootDir: local.rootDir.trim(), publicBaseUrl: local.publicBaseUrl.trim() };
    }
    if (provider === 'local-host') {
      return {
        provider: 'local-host',
        rootDir: localHost.rootDir.trim(),
        port: Number.parseInt(localHost.port, 10),
        bindHost: localHost.bindHost,
        ...(localHost.advertiseHost.trim() ? { advertiseHost: localHost.advertiseHost.trim() } : {}),
        ...(localHost.publicBaseUrl.trim() ? { publicBaseUrl: localHost.publicBaseUrl.trim() } : {}),
      };
    }
    if (provider === 'ftp-http') {
      return {
        provider: 'ftp-http',
        ftp: {
          host: ftp.host.trim(),
          port: Number.parseInt(ftp.port, 10),
          secure: ftp.secure,
          user: ftp.user.trim() || 'anonymous',
          password: ftp.password,
          rootDir: ftp.rootDir.trim(),
          passive: true,
          timeoutMs: 20_000,
        },
        http: { baseUrl: ftp.baseUrl.trim() },
      };
    }
    const storage: StorageConfig = {
      provider: 's3',
      region: s3.region.trim(),
      bucket: s3.bucket.trim(),
      accessKey: s3.accessKey.trim(),
      secretKey: s3.secretKey.trim(),
      pathStyle: s3.pathStyle,
      secure: s3.secure,
      prefix: s3.prefix.trim(),
    };
    if (s3.endpoint.trim()) storage.endpoint = s3.endpoint.trim();
    if (s3.publicBaseUrl.trim()) storage.publicBaseUrl = s3.publicBaseUrl.trim();
    return storage;
  };

  /** 浏览选择 local-host 的仓库根目录（取消不改变已填内容）。 */
  const browseLocalHostRoot = async () => {
    const result = await api.system.pickDirectory();
    if (!result.ok) {
      toast.error(result.error, '选择目录失败');
      return;
    }
    const picked = result.value;
    if (!picked) return;
    setLocalHost((current) => ({ ...current, rootDir: picked }));
    clearError('localHostRootDir');
  };

  const submit = async () => {
    const nextErrors = validateAll();
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      setStep(nextErrors.name || nextErrors.description || nextErrors.ownerName || nextErrors.ownerContact ? 1 : 2);
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      const owner =
        ownerName.trim() || ownerContact.trim()
          ? {
              ...(ownerName.trim() ? { name: ownerName.trim() } : {}),
              ...(ownerContact.trim() ? { contact: ownerContact.trim() } : {}),
            }
          : undefined;
      const result = await api.channels.create({
        name: name.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
        visibility,
        ...(owner ? { owner } : {}),
        storage: buildStorage(),
      });
      if (!result.ok) {
        setSubmitError(result.error);
        toast.error(result.error, '创建频道失败');
        return;
      }
      toast.success(`频道「${result.value.summary.name}」创建成功`);
      // local-host 频道创建后尽力启动本机 Host；失败只警告，不阻断创建结果。
      if (provider === 'local-host') {
        const started = await api.host.start(result.value.summary.id);
        if (started.ok) {
          toast.success(`本机 Host 已启动：${started.value.urls.channelUrl}`);
        } else {
          toast.warning(
            `频道已创建，但本机 Host 启动失败：${started.error.message}（${started.error.code}）。可在频道详情页手动启动。`,
          );
        }
      }
      onCreated(result.value);
    } catch {
      const error: ApiError = { code: 'INTERNAL', message: '创建频道时发生未知错误，请查看主进程日志。' };
      setSubmitError(error);
      toast.error(error, '创建频道失败');
    } finally {
      setSubmitting(false);
    }
  };

  const footer = (
    <>
      <button type="button" className="btn btn-ghost" onClick={onClose} disabled={submitting}>
        取消
      </button>
      <div className="footer-spacer" />
      {step > 1 ? (
        <button type="button" className="btn btn-secondary" onClick={goBack} disabled={submitting}>
          上一步
        </button>
      ) : null}
      {step < 3 ? (
        <button type="button" className="btn btn-primary" data-testid="create-channel-next" onClick={goNext}>
          下一步
          <Icon name="chevron-right" size={16} />
        </button>
      ) : (
        <button
          type="button"
          className="btn btn-primary"
          data-testid="create-channel-submit"
          onClick={() => void submit()}
          disabled={submitting}
        >
          {submitting ? '正在创建…' : '创建频道'}
        </button>
      )}
    </>
  );

  return (
    <Modal
      title="创建频道"
      subtitle="频道由你自己的存储承载，无需中心服务器"
      size="lg"
      closable={!submitting}
      onClose={onClose}
      footer={footer}
      headerExtra={
        <ol className="steps">
          {STEPS.map((item) => (
            <li
              key={item.key}
              className={
                step === item.key ? 'step step-active' : step > item.key ? 'step step-done' : 'step'
              }
            >
              <span className="step-index">{step > item.key ? <Icon name="check" size={13} /> : item.key}</span>
              <span className="step-text">
                <strong>{item.title}</strong>
                <small>{item.hint}</small>
              </span>
            </li>
          ))}
        </ol>
      }
    >
      <form
        data-testid="create-channel-form"
        className="form"
        onSubmit={(event) => {
          event.preventDefault();
          if (step === 3) void submit();
        }}
      >
        {submitError ? (
          <div data-testid="dialog-error">
            <ApiErrorBanner error={submitError} title="创建频道失败" />
          </div>
        ) : null}

        {step === 1 ? (
          <div className="form-section">
            <TextField
              label="频道名称"
              testId="create-channel-name"
              value={name}
              onChange={(value) => {
                setName(value);
                clearError('name');
              }}
              required
              maxLength={64}
              placeholder="例如：Alice 的工具箱"
              hint="会展示给所有订阅者，最多 64 个字符。"
              error={errors.name}
              disabled={submitting}
            />
            <TextAreaField
              label="频道描述"
              value={description}
              onChange={setDescription}
              rows={3}
              maxLength={2048}
              placeholder="这个频道分享什么 App？"
              hint="可选，最多 2048 个字符。"
              error={errors.description}
              disabled={submitting}
            />
            <div className="field">
              <span className="field-label">可见性</span>
              <div className="segmented" role="group" aria-label="可见性">
                <button
                  type="button"
                  className={visibility === 'public' ? 'segment segment-active' : 'segment'}
                  aria-pressed={visibility === 'public'}
                  onClick={() => setVisibility('public')}
                  disabled={submitting}
                >
                  <Icon name="globe" size={16} />
                  公开
                </button>
                <button
                  type="button"
                  className={visibility === 'private' ? 'segment segment-active' : 'segment'}
                  aria-pressed={visibility === 'private'}
                  onClick={() => setVisibility('private')}
                  disabled={submitting}
                >
                  <Icon name="lock" size={16} />
                  私密
                </button>
              </div>
              <p className="field-hint">
                {visibility === 'public'
                  ? '公开频道的 channel.json 可被任何拿到 URL 的人订阅。'
                  : '私密频道使用「能力链接」：只有拿到包含 accessKey 的 channel.json URL 的人才能订阅。'}
              </p>
            </div>

            {visibility === 'private' ? (
              <InfoBanner tone="warn" title="私密频道说明">
                创建后会生成一次性 accessKey，并写入订阅链接。发布权限由 <code>channel_pri.json</code>{' '}
                决定：把它私下分享给管理员，对方导入后即可发布。
              </InfoBanner>
            ) : null}

            <div className="grid grid-2">
              <TextField
                label="所有者名称（可选）"
                value={ownerName}
                onChange={setOwnerName}
                maxLength={128}
                placeholder="例如：Alice"
                error={errors.ownerName}
                disabled={submitting}
              />
              <TextField
                label="联系方式（可选）"
                value={ownerContact}
                onChange={setOwnerContact}
                maxLength={256}
                placeholder="例如：alice@example.com"
                error={errors.ownerContact}
                disabled={submitting}
              />
            </div>
          </div>
        ) : null}

        {step === 2 ? (
          <div className="form-section">
            <SelectField
              label="存储类型"
              testId="storage-provider-select"
              value={provider}
              onChange={(value) => {
                const nextProvider = value as StorageProvider;
                setProvider(nextProvider);
                // 切回 local-host 且用户未手动改过端口时，按最新已用端口重新推荐。
                if (nextProvider === 'local-host' && !portTouchedRef.current) {
                  setLocalHost((current) => ({
                    ...current,
                    port: String(suggestLocalHostPort(usedPorts)),
                  }));
                }
              }}
              options={PROVIDER_OPTIONS}
              required
              hint="发布端把 channel.json / App 文件写到这里；订阅者通过对应的 HTTP 地址读取。"
              disabled={submitting}
            />

            {provider === 'local' ? (
              <div className="form-section provider-panel">
                <div className="grid grid-2">
                  <TextField
                    label="本地根目录"
                    value={local.rootDir}
                    onChange={(value) => setLocal((current) => ({ ...current, rootDir: value }))}
                    required
                    placeholder="D:\\www\\app_repo 或 /var/www/app_repo"
                    hint="AppHub 会直接写入这个目录，通常是 nginx / 静态服务器的 webroot。"
                    error={errors.localRootDir}
                    disabled={submitting}
                    mono
                  />
                  <TextField
                    label="公开 HTTP 地址（publicBaseUrl）"
                    value={local.publicBaseUrl}
                    onChange={(value) => setLocal((current) => ({ ...current, publicBaseUrl: value }))}
                    required
                    type="url"
                    placeholder="http://127.0.0.1:8080/app_repo/"
                    hint="订阅者通过这个地址读取 channel.json 与 App 文件。"
                    error={errors.localPublicBaseUrl}
                    disabled={submitting}
                    mono
                  />
                </div>
                <InfoBanner tone="info" title="示例部署">
                  <code>python -m http.server 8080 --directory D:\www\app_repo</code>{' '}
                  即可把这个目录变成可订阅的频道仓库；生产环境建议使用 nginx。
                </InfoBanner>
              </div>
            ) : null}

            {provider === 'local-host' ? (
              <div className="form-section provider-panel">
                <div className="field input-with-action">
                  <TextField
                    label="Host 仓库根目录（rootDir）"
                    testId="local-host-root-dir"
                    value={localHost.rootDir}
                    onChange={(value) => {
                      setLocalHost((current) => ({ ...current, rootDir: value }));
                      clearError('localHostRootDir');
                    }}
                    required
                    placeholder="例如 D:\AppHub\channel-repo 或 /home/alice/apphub-repo"
                    hint="AppHub 会在这个目录写入 channel.json 与 App 文件，并且只对外提供该目录下的文件。"
                    error={errors.localHostRootDir}
                    disabled={submitting}
                    mono
                  />
                  <button
                    type="button"
                    className="btn btn-secondary"
                    data-testid="local-host-browse-root"
                    onClick={() => void browseLocalHostRoot()}
                    disabled={submitting}
                  >
                    <Icon name="folder" size={16} />
                    浏览…
                  </button>
                </div>

                <div className="grid grid-2">
                  <TextField
                    label="Host 端口"
                    testId="local-host-port"
                    value={localHost.port}
                    onChange={(value) => {
                      portTouchedRef.current = true;
                      setLocalHost((current) => ({ ...current, port: value }));
                      clearError('localHostPort');
                    }}
                    required
                    type="number"
                    placeholder="8787"
                    hint={
                      usedPorts.length > 0
                        ? `已用端口：${usedPorts.join('、')}；已自动避开已使用端口，推荐 ${suggestLocalHostPort(usedPorts)}。手动修改后不再自动调整。`
                        : '默认 8787；如果端口被占用，启动时会报错，可在这里换一个。'
                    }
                    error={errors.localHostPort}
                    disabled={submitting}
                    mono
                  />
                  <SelectField
                    label="访问范围"
                    testId="local-host-bind-host"
                    value={localHost.bindHost}
                    onChange={(value) =>
                      setLocalHost((current) => ({
                        ...current,
                        bindHost: value === '127.0.0.1' ? '127.0.0.1' : '0.0.0.0',
                      }))
                    }
                    options={[
                      { value: '0.0.0.0', label: '局域网可访问（0.0.0.0，推荐）' },
                      { value: '127.0.0.1', label: '仅本机（127.0.0.1，调试用）' },
                    ]}
                    required
                    hint="0.0.0.0 允许同一局域网的设备订阅；127.0.0.1 只在本机可访问。"
                    disabled={submitting}
                  />
                  <TextField
                    label="对外主机名（advertiseHost，可选）"
                    value={localHost.advertiseHost}
                    onChange={(value) => {
                      setLocalHost((current) => ({ ...current, advertiseHost: value }));
                      clearError('localHostAdvertiseHost');
                    }}
                    placeholder="例如 192.168.1.10 或 my-pc.local"
                    hint="用于生成订阅 URL 的主机名/IPv4；留空则自动使用本机检测到的地址。"
                    error={errors.localHostAdvertiseHost}
                    disabled={submitting}
                    mono
                  />
                  <TextField
                    label="公开基地址（publicBaseUrl，可选）"
                    value={localHost.publicBaseUrl}
                    onChange={(value) => {
                      setLocalHost((current) => ({ ...current, publicBaseUrl: value }));
                      clearError('localHostPublicBaseUrl');
                    }}
                    type="url"
                    placeholder="例如 https://apphub.example.com/"
                    hint="反向代理/自定义域名场景下完整覆盖订阅地址；留空使用 Host 自动生成的地址。"
                    error={errors.localHostPublicBaseUrl}
                    disabled={submitting}
                    mono
                  />
                </div>

                <InfoBanner tone="warn" title="注意：默认对局域网开放">
                  默认绑定 <code>0.0.0.0</code>，同一局域网的设备都能访问这个频道；只想本机调试请选择「仅本机」。
                  Windows / macOS 首次启动 Host 时可能弹出防火墙授权，需要允许「专用网络 / 本地网络」；其他设备打不开时请优先检查防火墙。
                  Host 只在 AppHub 运行期间有效，关闭 App 后订阅链接会失效；私密频道的链接包含 accessKey，拿到链接即等同读取授权。
                </InfoBanner>
              </div>
            ) : null}

            {provider === 'ftp-http' ? (
              <div className="form-section provider-panel">
                <div className="grid grid-2">
                  <TextField
                    label="FTP 主机"
                    value={ftp.host}
                    onChange={(value) => setFtp((current) => ({ ...current, host: value }))}
                    required
                    placeholder="127.0.0.1"
                    error={errors.ftpHost}
                    disabled={submitting}
                    mono
                  />
                  <TextField
                    label="FTP 端口"
                    value={ftp.port}
                    onChange={(value) => setFtp((current) => ({ ...current, port: value }))}
                    required
                    type="number"
                    placeholder="21"
                    error={errors.ftpPort}
                    disabled={submitting}
                    mono
                  />
                  <TextField
                    label="FTP 用户名"
                    value={ftp.user}
                    onChange={(value) => setFtp((current) => ({ ...current, user: value }))}
                    placeholder="apphub"
                    hint="匿名 FTP 可填 anonymous。"
                    disabled={submitting}
                    mono
                  />
                  <TextField
                    label="FTP 密码"
                    value={ftp.password}
                    onChange={(value) => setFtp((current) => ({ ...current, password: value }))}
                    type="password"
                    placeholder="••••••"
                    hint="凭据只会加密保存在本机，不会写入远端。"
                    disabled={submitting}
                  />
                  <TextField
                    label="FTP 根目录（rootDir）"
                    value={ftp.rootDir}
                    onChange={(value) => setFtp((current) => ({ ...current, rootDir: value }))}
                    placeholder="app_repo/"
                    hint="相对于 FTP 用户根目录，可留空。"
                    disabled={submitting}
                    mono
                  />
                  <TextField
                    label="公开 HTTP 地址（nginx）"
                    value={ftp.baseUrl}
                    onChange={(value) => setFtp((current) => ({ ...current, baseUrl: value }))}
                    required
                    type="url"
                    placeholder="http://127.0.0.1:8080/app_repo/"
                    hint="读取通道：FTP 负责写入，HTTP 负责读取。"
                    error={errors.ftpBaseUrl}
                    disabled={submitting}
                    mono
                  />
                </div>
                <CheckboxField
                  label="使用 FTPS（显式 TLS）"
                  checked={ftp.secure}
                  onChange={(checked) => setFtp((current) => ({ ...current, secure: checked }))}
                  hint="多数内网 vsftpd 不需要开启；公网建议使用 FTPS。"
                  disabled={submitting}
                />
                <InfoBanner tone="info" title="示例部署（FTP 写入 + nginx 读取）">
                  <code>ftp://apphub:******@127.0.0.1:21/app_repo/</code> 写入，
                  nginx 把 <code>/app_repo/</code> 映射到同一目录即可提供下载地址。
                </InfoBanner>
              </div>
            ) : null}

            {provider === 's3' ? (
              <div className="form-section provider-panel">
                <div className="grid grid-2">
                  <TextField
                    label="Endpoint"
                    value={s3.endpoint}
                    onChange={(value) => setS3((current) => ({ ...current, endpoint: value }))}
                    type="url"
                    placeholder="http://127.0.0.1:9000（留空使用 AWS S3）"
                    hint="MinIO / 兼容 S3 的服务地址。"
                    error={errors.s3Endpoint}
                    disabled={submitting}
                    mono
                  />
                  <TextField
                    label="Region"
                    value={s3.region}
                    onChange={(value) => setS3((current) => ({ ...current, region: value }))}
                    required
                    placeholder="us-east-1"
                    error={errors.s3Region}
                    disabled={submitting}
                    mono
                  />
                  <TextField
                    label="Bucket"
                    value={s3.bucket}
                    onChange={(value) => setS3((current) => ({ ...current, bucket: value }))}
                    required
                    placeholder="apphub"
                    error={errors.s3Bucket}
                    disabled={submitting}
                    mono
                  />
                  <TextField
                    label="对象前缀（prefix）"
                    value={s3.prefix}
                    onChange={(value) => setS3((current) => ({ ...current, prefix: value }))}
                    placeholder="apphub/"
                    hint="频道在 Bucket 内的路径前缀，可留空。"
                    disabled={submitting}
                    mono
                  />
                  <TextField
                    label="Access Key"
                    value={s3.accessKey}
                    onChange={(value) => setS3((current) => ({ ...current, accessKey: value }))}
                    required
                    placeholder="AKIA..."
                    error={errors.s3AccessKey}
                    disabled={submitting}
                    mono
                  />
                  <TextField
                    label="Secret Key"
                    value={s3.secretKey}
                    onChange={(value) => setS3((current) => ({ ...current, secretKey: value }))}
                    required
                    type="password"
                    placeholder="••••••"
                    error={errors.s3SecretKey}
                    disabled={submitting}
                  />
                  <TextField
                    label="公开访问基地址（publicBaseUrl，可选）"
                    value={s3.publicBaseUrl}
                    onChange={(value) => setS3((current) => ({ ...current, publicBaseUrl: value }))}
                    type="url"
                    placeholder="https://cdn.example.com/apphub/"
                    hint="留空时使用预签名 URL（私有桶场景）。"
                    error={errors.s3PublicBaseUrl}
                    disabled={submitting}
                    mono
                  />
                </div>
                <div className="grid grid-2">
                  <CheckboxField
                    label="使用 path-style 访问"
                    checked={s3.pathStyle}
                    onChange={(checked) => setS3((current) => ({ ...current, pathStyle: checked }))}
                    hint="MinIO 通常需要；AWS S3 建议关闭。"
                    disabled={submitting}
                  />
                  <CheckboxField
                    label="使用 HTTPS 连接 S3"
                    checked={s3.secure}
                    onChange={(checked) => setS3((current) => ({ ...current, secure: checked }))}
                    disabled={submitting}
                  />
                </div>
                <InfoBanner tone="info" title="示例（MinIO）">
                  <code>mc alias set local http://127.0.0.1:9000 minioadmin minioadmin</code>，Bucket{' '}
                  <code>apphub</code>，前缀 <code>apphub/</code>，publicBaseUrl 设为{' '}
                  <code>https://cdn.example.com/apphub/</code>（或 MinIO 公开读地址）。
                </InfoBanner>
              </div>
            ) : null}
          </div>
        ) : null}

        {step === 3 ? (
          <div className="form-section">
            <div className="summary card summary-card">
              <h3>请确认频道配置</h3>
              <dl className="summary-list">
                <div>
                  <dt>频道名称</dt>
                  <dd>{truncate(name.trim(), 64) || '—'}</dd>
                </div>
                <div>
                  <dt>描述</dt>
                  <dd>{description.trim() || '—'}</dd>
                </div>
                <div>
                  <dt>可见性</dt>
                  <dd>{visibility === 'private' ? '私密（能力链接）' : '公开'}</dd>
                </div>
                <div>
                  <dt>存储类型</dt>
                  <dd>{PROVIDER_OPTIONS.find((item) => item.value === provider)?.label}</dd>
                </div>
                {provider === 'local' ? (
                  <>
                    <div>
                      <dt>本地根目录</dt>
                      <dd className="mono">{local.rootDir.trim() || '—'}</dd>
                    </div>
                    <div>
                      <dt>公开地址</dt>
                      <dd className="mono">{local.publicBaseUrl.trim() || '—'}</dd>
                    </div>
                  </>
                ) : null}
                {provider === 'local-host' ? (
                  <>
                    <div>
                      <dt>Host 仓库根目录</dt>
                      <dd className="mono">{localHost.rootDir.trim() || '—'}</dd>
                    </div>
                    <div>
                      <dt>监听地址</dt>
                      <dd className="mono">
                        {localHost.bindHost}:{localHost.port}
                      </dd>
                    </div>
                    <div>
                      <dt>访问范围</dt>
                      <dd>{bindHostLabel(localHost.bindHost)}</dd>
                    </div>
                    <div>
                      <dt>对外地址</dt>
                      <dd className="mono">
                        {localHost.publicBaseUrl.trim() ||
                          (localHost.advertiseHost.trim()
                            ? `http://${localHost.advertiseHost.trim()}:${localHost.port}/`
                            : '自动检测本机地址')}
                      </dd>
                    </div>
                  </>
                ) : null}
                {provider === 'ftp-http' ? (
                  <>
                    <div>
                      <dt>FTP 服务器</dt>
                      <dd className="mono">
                        {ftp.host.trim()}:{ftp.port}
                        {ftp.rootDir.trim() ? ` / ${ftp.rootDir.trim()}` : ''}
                      </dd>
                    </div>
                    <div>
                      <dt>公开地址</dt>
                      <dd className="mono">{ftp.baseUrl.trim() || '—'}</dd>
                    </div>
                  </>
                ) : null}
                {provider === 's3' ? (
                  <>
                    <div>
                      <dt>S3 服务</dt>
                      <dd className="mono">
                        {s3.endpoint.trim() || 'AWS S3'} / {s3.bucket} / {s3.prefix || '（无前缀）'}
                      </dd>
                    </div>
                    <div>
                      <dt>公开地址</dt>
                      <dd className="mono">{s3.publicBaseUrl.trim() || '预签名 URL'}</dd>
                    </div>
                  </>
                ) : null}
              </dl>
            </div>
            {provider === 'local-host' ? (
              <InfoBanner tone="warn" title="创建成功后会自动尝试启动本机 Host">
                频道创建完成后会立即启动 Host 并在 App 运行期间提供订阅地址（默认对局域网开放）。如果启动失败（例如端口被占用或防火墙拦截），
                频道仍会创建成功，可以在「频道详情 → 本机 Host」面板中修改配置后手动启动。
              </InfoBanner>
            ) : null}
            <InfoBanner tone="info" title="创建时会做什么">
              生成频道 ID（私密频道还会生成 accessKey）→ 连接存储并探测（probe，可能需要几秒）→ 写入
              channel.json → 在本机加密保存 channel_pri.json。
            </InfoBanner>
            {submitting ? (
              <InfoBanner tone="info" title="正在探测存储并写入 channel.json…">
                如果 FTP/S3 网络较慢，这一步可能需要几秒钟，请不要关闭窗口。
              </InfoBanner>
            ) : null}
          </div>
        ) : null}
      </form>
    </Modal>
  );
}
