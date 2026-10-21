import { useApi } from '../api';
import { copyText } from '../clipboard';
import { InfoBanner } from '../components/Form';
import { Icon } from '../components/Icon';
import { ErrorState, LoadingState, PageHeader } from '../components/StateViews';
import { useToast } from '../components/Toast';
import { useAsyncData } from '../hooks/useAsyncData';
import type { SystemInfoDTO } from '../types';

export interface SettingsViewProps {
  dataVersion: number;
}

function InfoRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="info-row">
      <span className="info-label">{label}</span>
      <span className={mono ? 'info-value mono break-all' : 'info-value'}>{value || '—'}</span>
    </div>
  );
}

/** 设置 / 关于：版本信息、运行环境、数据目录、去中心化说明。 */
export function SettingsView({ dataVersion }: SettingsViewProps) {
  const api = useApi();
  const toast = useToast();
  const state = useAsyncData<SystemInfoDTO>(() => api.system.info(), dataVersion);
  const info = state.data;

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
              <InfoRow label="本地频道数" value={`${info.channelCount}`} />
              <InfoRow label="已安装 App 数" value={`${info.installedCount}`} />
            </div>
            <div className="settings-actions">
              <button type="button" className="btn btn-secondary" onClick={() => void openDataDir()}>
                <Icon name="folder" size={16} />
                打开数据目录
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => void copyDataDir()}>
                <Icon name="copy" size={16} />
                复制路径
              </button>
            </div>
            <p className="field-hint">
              频道记录、加密的 channel_pri.json、本地库索引与安装文件都保存在该目录，不经过任何中心服务器。
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
                    每个频道（Channel）由所有者把自己的存储（FTP+nginx、本地目录+静态服务、S3/MinIO）当作 App
                    仓库；AppHub 只读写频道所有者配置的存储。
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
    </div>
  );
}
