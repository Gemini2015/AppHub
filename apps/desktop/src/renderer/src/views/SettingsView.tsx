import { useState } from 'react';
import { useApi } from '../api';
import { copyText } from '../clipboard';
import { ApiErrorBanner, InfoBanner } from '../components/Form';
import { Icon } from '../components/Icon';
import { ConfirmDialog } from '../components/Modal';
import { ErrorState, LoadingState, PageHeader } from '../components/StateViews';
import { useToast } from '../components/Toast';
import { useAsyncData } from '../hooks/useAsyncData';
import type { ApiError, DataDirSource, SystemInfoDTO } from '../types';

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

/** 设置 / 关于：版本信息、运行环境、数据目录（可迁移）、去中心化说明。 */
export function SettingsView({ dataVersion }: SettingsViewProps) {
  const api = useApi();
  const toast = useToast();
  const state = useAsyncData<SystemInfoDTO>(() => api.system.info(), dataVersion);
  const info = state.data;

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
              <InfoBanner tone="info" title="数据目录由环境变量固定">
                当前数据目录由 <code>APPHUB_USER_DATA_DIR</code>{' '}
                固定，无法在界面修改；移除该环境变量并重启 App 后即可使用默认/自定义目录。
              </InfoBanner>
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
                <li>旧目录不会自动删除，确认迁移成功后可以手动清理。</li>
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
