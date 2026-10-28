import { useState } from 'react';
import { useApi } from '../api';
import { copyText } from '../clipboard';
import { ApiErrorBanner, InfoBanner } from '../components/Form';
import { Icon } from '../components/Icon';
import { ConfirmDialog } from '../components/Modal';
import { ErrorState, LoadingState, PageHeader } from '../components/StateViews';
import { useToast } from '../components/Toast';
import { useUpdate } from '../components/UpdateProvider';
import { useAsyncData } from '../hooks/useAsyncData';
import { formatDateTime } from '../format';
import type { ApiError, DataDirSource, SystemInfoDTO, UpdateStateDTO, UpdateStatus } from '../types';

export interface SettingsViewProps {
  dataVersion: number;
}

function InfoRow({
  label,
  value,
  mono,
  testId,
}: {
  label: string;
  value: string;
  mono?: boolean;
  testId?: string;
}) {
  return (
    <div className="info-row">
      <span className="info-label">{label}</span>
      <span className={mono ? 'info-value mono break-all' : 'info-value'} data-testid={testId}>
        {value || '—'}
      </span>
    </div>
  );
}

function dataDirSourceLabel(source: DataDirSource): string {
  switch (source) {
    case 'custom':
      return '自定义目录';
    case 'env':
      return '环境变量固定';
    default:
      return '默认目录';
  }
}

const UPDATE_STATUS_LABEL: Record<UpdateStatus, string> = {
  unsupported: '当前环境不支持自动更新',
  idle: '未检查',
  checking: '正在检查更新…',
  available: '发现新版本',
  downloading: '正在下载更新…',
  downloaded: '更新已下载，等待重启安装',
  installing: '正在重启并安装更新…',
  'up-to-date': '已是最新版本',
  error: '更新失败',
};

const UNSUPPORTED_REASON_LABEL: Record<NonNullable<UpdateStateDTO['unsupportedReason']>, string> = {
  dev: '开发模式（未打包）不支持自动更新',
  platform: '当前平台不支持自动更新（仅 Windows 安装版）',
  e2e: 'E2E 测试模式下自动更新已禁用',
  env: '环境变量禁用了自动更新',
};

/** 设置 / 关于：版本信息、运行环境、数据目录（可迁移）、去中心化说明。 */
export function SettingsView({ dataVersion }: SettingsViewProps) {
  const api = useApi();
  const toast = useToast();
  const update = useUpdate();
  const state = useAsyncData<SystemInfoDTO>(() => api.system.info(), dataVersion);
  const info = state.data;
  const updateState = update.state;
  const updateSupported = updateState ? updateState.supported : true;
  const updateError = update.error ?? updateState?.error ?? null;
  const updateStatusLabel = updateState
    ? UPDATE_STATUS_LABEL[updateState.status]
    : '正在读取更新状态…';
  const unsupportedReasonText =
    updateState && !updateState.supported
      ? (UNSUPPORTED_REASON_LABEL[updateState.unsupportedReason ?? 'env'] ??
        '当前环境不支持自动更新')
      : null;
  const updateCheckDisabled =
    !updateSupported ||
    update.loading ||
    update.busy !== null ||
    updateState?.status === 'downloading' ||
    updateState?.status === 'installing';

  /** 已选择、等待确认的新数据目录。 */
  const [changeTarget, setChangeTarget] = useState<string | null>(null);
  const [changing, setChanging] = useState(false);
  const [changeError, setChangeError] = useState<ApiError | null>(null);

  const openDataDir = async () => {
    const result = await api.system.openDataDir();
    if (!result.ok) {
      toast.error(result.error, '打开数据目录失败');
      return;
    }
    toast.success('已在文件管理器中打开数据目录');
  };

  const copyDataDir = async () => {
    if (!info) return;
    const copied = await copyText(info.dataDir);
    if (copied) toast.success('数据目录路径已复制');
    else toast.error({ code: 'INTERNAL', message: '复制失败，请手动选中路径复制。' });
  };

  const pickNewDataDir = async () => {
    setChangeError(null);
    const result = await api.system.pickDirectory();
    if (!result.ok) {
      toast.error(result.error, '选择数据目录失败');
      return;
    }
    const picked = result.value;
    if (!picked) return; // 用户取消：不做任何事
    setChangeTarget(picked);
  };

  const confirmChangeDataDir = async () => {
    if (!changeTarget) return;
    setChanging(true);
    setChangeError(null);
    try {
      const result = await api.system.changeDataDir({ path: changeTarget });
      if (!result.ok) {
        setChangeError(result.error);
        toast.error(result.error, '更改数据目录失败');
        return;
      }
      setChangeTarget(null);
      toast.success('数据目录已迁移，App 即将重启…');
    } catch {
      const error: ApiError = { code: 'INTERNAL', message: '更改数据目录时发生未知错误。' };
      setChangeError(error);
      toast.error(error, '更改数据目录失败');
    } finally {
      setChanging(false);
    }
  };

  return (
    <div className="page">
      <PageHeader
        eyebrow="AppHub"
        title="设置 / 关于"
        description="运行环境、数据目录与去中心化设计说明。"
      />

      {state.data === null && state.loading ? <LoadingState label="正在读取系统信息…" /> : null}
      {state.data === null && state.error ? (
        <ErrorState error={state.error} title="系统信息读取失败" onRetry={() => void state.reload()} />
      ) : null}

      {info ? (
        <div className="settings-grid">
          <section className="card settings-card">
            <h2>
              <Icon name="info" size={18} />
              关于 AppHub
            </h2>
            <div className="info-list">
              <InfoRow label="应用名称" value={info.appName} />
              <InfoRow label="应用版本" value={info.appVersion} mono />
              <InfoRow label="平台" value={`${info.platform} / ${info.arch}`} mono />
              <InfoRow label="Electron" value={info.electronVersion} mono />
              <InfoRow label="Chrome" value={info.chromeVersion} mono />
              <InfoRow label="Node.js" value={info.nodeVersion} mono />
            </div>
          </section>

          <section className="card settings-card">
            <h2>
              <Icon name="database" size={18} />
              数据与统计
            </h2>
            <div className="info-list">
              <InfoRow label="数据目录" value={info.dataDir} mono />
              <InfoRow
                label="目录来源"
                value={dataDirSourceLabel(info.dataDirSource)}
                testId="data-dir-source"
              />
              <InfoRow label="本地频道数" value={`${info.channelCount}`} />
              <InfoRow label="已安装 App 数" value={`${info.installedCount}`} />
            </div>
            <p className="field-hint" data-testid="data-dir-default-hint">
              默认数据目录：<code className="break-all">{info.defaultDataDir}</code>
              {info.dataDirSource === 'default' ? '（当前使用）' : ''}
              <br />
              默认数据目录是 Electron userData 下的独立子目录 <code>AppHubData</code>，与 Electron/Chromium
              的缓存与配置文件分离；修改 AppHub 数据目录不会改变 Electron 自身的缓存/配置路径。
            </p>
            <div className="settings-actions">
              <button type="button" className="btn btn-secondary" onClick={() => void openDataDir()}>
                <Icon name="folder" size={16} />
                打开数据目录
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => void copyDataDir()}>
                <Icon name="copy" size={16} />
                复制路径
              </button>
              <button
                type="button"
                className="btn btn-primary"
                data-testid="change-data-dir-button"
                onClick={() => void pickNewDataDir()}
                disabled={!info.dataDirEditable || changing}
              >
                <Icon name="database" size={16} />
                更改数据目录
              </button>
            </div>
            {!info.dataDirEditable ? (
              <div data-testid="data-dir-env-hint">
                <InfoBanner tone="info" title="数据目录由环境变量固定">
                  当前数据目录由环境变量固定，无法在界面修改。两个环境变量的语义不同：
                  <ul className="env-var-list">
                    <li>
                      <code>APPHUB_DATA_DIR</code>：只修改 AppHub 数据目录（默认位于{' '}
                      <code>&lt;Electron userData&gt;/AppHubData</code>），不影响 Electron
                      自身的缓存/配置路径；
                    </li>
                    <li>
                      <code>APPHUB_USER_DATA_DIR</code>：整体覆盖 Electron 的 userData
                      目录（测试/多实例用），AppHub 数据目录默认随之变为{' '}
                      <code>&lt;userData&gt;/AppHubData</code>。
                    </li>
                  </ul>
                  移除环境变量并重启 App 后即可在界面修改数据目录。
                </InfoBanner>
              </div>
            ) : null}
            {changeError ? (
              <div data-testid="data-dir-change-error">
                <ApiErrorBanner error={changeError} title="更改数据目录失败" />
              </div>
            ) : null}
            <p className="field-hint">
              频道记录、加密的 channel_pri.json、本地库索引与安装文件都保存在数据目录，不经过任何中心服务器。
            </p>
          </section>

          <section className="card settings-card settings-card-wide">
            <h2>
              <Icon name="refresh" size={18} />
              软件更新
            </h2>
            <div className="update-card-body">
              <div className="update-card-main">
                <div className="info-list">
                  <InfoRow
                    label="当前版本"
                    value={`v${updateState ? updateState.currentVersion : info.appVersion}`}
                    mono
                  />
                  <InfoRow label="更新状态" value={updateStatusLabel} testId="update-status" />
                  {updateState?.availableVersion ? (
                    <InfoRow label="可用版本" value={`v${updateState.availableVersion}`} mono />
                  ) : null}
                  {updateState?.lastCheckedAt ? (
                    <InfoRow label="最近检查" value={formatDateTime(updateState.lastCheckedAt)} />
                  ) : null}
                </div>

                {unsupportedReasonText ? (
                  <InfoBanner tone="info" title="当前环境不支持自动更新">
                    {unsupportedReasonText}；不会发起更新检查网络请求。
                  </InfoBanner>
                ) : null}

                {updateState?.releaseNotes ? (
                  <div className="update-notes-wrap">
                    <h3>更新说明</h3>
                    <pre className="update-notes update-notes-preview">{updateState.releaseNotes}</pre>
                  </div>
                ) : null}

                {updateState?.status === 'downloading' && updateState.progress ? (
                  <div className="update-card-progress" data-testid="settings-update-progress">
                    <span>正在下载：{Math.round(updateState.progress.percent)}%</span>
                    <span className="progress-track">
                      <span
                        className="progress-fill"
                        style={{
                          width: `${Math.max(0, Math.min(100, updateState.progress.percent))}%`,
                        }}
                      />
                    </span>
                  </div>
                ) : null}

                {updateError ? (
                  <div data-testid="settings-update-error">
                    <ApiErrorBanner error={updateError} title="更新失败" />
                  </div>
                ) : null}
              </div>

              <div className="settings-actions update-card-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  data-testid="update-check-button"
                  onClick={() => void update.check()}
                  disabled={updateCheckDisabled}
                >
                  <Icon name="refresh" size={16} />
                  {update.busy === 'check' || updateState?.status === 'checking'
                    ? '检查中…'
                    : '检查更新'}
                </button>
                {updateState?.status === 'available' ? (
                  <button
                    type="button"
                    className="btn btn-primary"
                    data-testid="settings-update-download-button"
                    onClick={() => void update.download()}
                    disabled={update.busy !== null}
                  >
                    <Icon name="download" size={16} />
                    {update.busy === 'download' ? '开始下载…' : '下载更新'}
                  </button>
                ) : null}
                {updateState?.status === 'downloaded' ? (
                  <button
                    type="button"
                    className="btn btn-primary"
                    data-testid="settings-update-install-button"
                    onClick={() => void update.install()}
                    disabled={update.busy !== null}
                  >
                    <Icon name="refresh" size={16} />
                    {update.busy === 'install' ? '正在重启…' : '重启并安装'}
                  </button>
                ) : null}
                {updateState &&
                (updateState.status === 'available' ||
                  updateState.status === 'downloaded' ||
                  updateState.status === 'downloading' ||
                  updateState.status === 'error') ? (
                  <button type="button" className="btn btn-ghost" onClick={update.openDialog}>
                    <Icon name="info" size={16} />
                    查看详情
                  </button>
                ) : null}
              </div>
            </div>
            <p className="field-hint">
              更新为非强制：仅在你有空时下载/安装；「稍后」只隐藏提示，不会改变更新状态或影响 App 使用。
            </p>
          </section>

          <section className="card settings-card settings-card-wide">
            <h2>
              <Icon name="logo" size={18} />
              去中心化说明
            </h2>
            <div className="decentralized-list">
              <div className="decentralized-item">
                <span className="decentralized-icon">
                  <Icon name="server" size={18} />
                </span>
                <div>
                  <strong>没有中心服务器</strong>
                  <p>
                    每个频道（Channel）由所有者把自己的存储（FTP+nginx、本地目录+静态服务、S3/MinIO、本机
                    Host）当作 App 仓库；AppHub 只读写频道所有者配置的存储。
                  </p>
                </div>
              </div>
              <div className="decentralized-item">
                <span className="decentralized-icon">
                  <Icon name="globe" size={18} />
                </span>
                <div>
                  <strong>订阅 = 一个 channel.json 链接</strong>
                  <p>
                    任何拿到 <code>channel.json</code> URL 的人都能订阅公开频道；私密频道使用包含 accessKey
                    的「能力链接」，链接泄露等同于读取权限泄露。
                  </p>
                </div>
              </div>
              <div className="decentralized-item">
                <span className="decentralized-icon">
                  <Icon name="lock" size={18} />
                </span>
                <div>
                  <strong>发布权限 = 持有 channel_pri.json</strong>
                  <p>
                    <code>channel_pri.json</code> 包含存储凭据与 accessKey，只在本机用 Electron safeStorage
                    加密保存；私下分享给管理员即可授予发布权限。
                  </p>
                </div>
              </div>
              <div className="decentralized-item">
                <span className="decentralized-icon">
                  <Icon name="shield" size={18} />
                </span>
                <div>
                  <strong>完整性校验的边界</strong>
                  <p>
                    安装/更新使用 size + MD5 校验文件完整性，用于发现传输损坏与错版本，<strong>不是防篡改签名</strong>
                    ；安全性依赖 HTTPS 与可信的订阅来源。
                  </p>
                </div>
              </div>
            </div>
          </section>

          <section className="card settings-card settings-card-wide">
            <h2>
              <Icon name="upload" size={18} />
              文件与协议
            </h2>
            <div className="file-layout-grid">
              <div>
                <h3>频道存储布局</h3>
                <pre className="code-block">{`channel.json
<appId>/app.meta.json
<appId>/<version>/files.json
<appId>/<version>/<文件相对路径>`}</pre>
              </div>
              <div>
                <h3>本地数据目录</h3>
                <pre className="code-block">{`channels.json
channels/<channelId>/channel.json
secrets/channel_pri/<channelId>.enc
library/index.json
library/<channelId>/<appId>/install.json`}</pre>
              </div>
            </div>
            <InfoBanner tone="info" title="如何开始">
              在「频道」页创建自己的频道（需要可写入的存储），或向频道所有者索要 channel.json
              链接订阅；在频道详情里安装 App 后即可在「本地库」管理。
            </InfoBanner>
          </section>
        </div>
      ) : null}

      {changeTarget ? (
        <ConfirmDialog
          title="更改数据目录"
          message={
            <>
              <p>
                将把 AppHub 数据目录迁移到：<code className="break-all">{changeTarget}</code>
              </p>
              <ul className="migration-list">
                <li>迁移前会关闭本机 Host（迁移后可在频道详情重新启动）；</li>
                <li>频道记录、本地库、加密配置会复制到新目录；</li>
                <li>复制完成后 App 会自动重启使新目录生效；</li>
                <li>旧目录不会自动删除，确认迁移成功后可以手动清理；</li>
                <li>修改 AppHub 数据目录不会改变 Electron 自身的缓存/配置路径。</li>
              </ul>
            </>
          }
          confirmLabel="迁移并重启"
          confirmTestId="change-data-dir-confirm-ok"
          busy={changing}
          onCancel={() => setChangeTarget(null)}
          onConfirm={() => void confirmChangeDataDir()}
        />
      ) : null}
    </div>
  );
}
