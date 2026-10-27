import { appendUrl } from '@apphub/protocol';
import type { LocalHostStorageConfig } from '@apphub/protocol';
import { assertStorageKey } from '../memory';
import { resolveLocalHostBaseUrls } from '../local-host-url';
import type { LocalHostBaseUrls, ResolveLocalHostBaseUrlsOptions } from '../local-host-url';
import type {
  StorageAdapter,
  StorageAdapterProvider,
  StorageEntry,
  StorageStat,
  StorageWriteOptions,
} from '../types';
import { LocalStorageAdapter } from './local';

/**
 * 本机 Host 存储适配器（provider `local-host`）。
 *
 * 设计：`local-host` 的**文件读写**与 `local` 完全一致，区别只在于
 * "公开下载地址从本机网卡/端口推导"而不是用户手填 publicBaseUrl。
 * 因此这里组合委托一个内部 `LocalStorageAdapter`：
 *  - 读写/探测/列表/删除全部复用 local 实现（rootDir 内路径安全校验等）；
 *  - `getDownloadUrl` 使用 `resolveLocalHostBaseUrls` 得到的 preferredBaseUrl；
 *  - `probe` 只校验目录可写，**不监听/占用端口**（HTTP 服务由 core 的 HostService 负责）；
 *  - `close` 为 no-op。
 *
 * 关于端口：适配器本身不绑定端口。若 HostService 实际监听端口与 `config.port` 不同
 * （例如端口冲突回退、测试中注入），可通过可选第二参数 `options.port` 覆盖 URL 里的端口。
 */
export class LocalHostStorageAdapter implements StorageAdapter {
  readonly provider: StorageAdapterProvider = 'local-host';
  /** 原始 local-host 配置（供 core 展示/更新，不包含额外凭据）。 */
  readonly config: LocalHostStorageConfig;

  private readonly baseUrls: LocalHostBaseUrls;
  private readonly delegate: LocalStorageAdapter;

  constructor(config: LocalHostStorageConfig, options?: ResolveLocalHostBaseUrlsOptions) {
    this.config = config;
    this.baseUrls = resolveLocalHostBaseUrls(config, options);
    this.delegate = new LocalStorageAdapter({
      provider: 'local',
      rootDir: config.rootDir,
      publicBaseUrl: this.baseUrls.preferredBaseUrl,
    });
  }

  /** 本次解析出的公开地址（preferred/local/lan），便于 HostService 展示与测试断言。 */
  get urls(): LocalHostBaseUrls {
    return this.baseUrls;
  }

  // ---------------------------------------------------------------- 委托 local

  async probe(): Promise<void> {
    // 只做 rootDir 创建 + 可写探针；不绑定端口（端口由 HostService 的 HTTP server 负责）
    await this.delegate.probe();
  }

  readText(key: string): Promise<string | null> {
    return this.delegate.readText(key);
  }

  readBinary(key: string): Promise<Buffer | null> {
    return this.delegate.readBinary(key);
  }

  exists(key: string): Promise<boolean> {
    return this.delegate.exists(key);
  }

  stat(key: string): Promise<StorageStat | null> {
    return this.delegate.stat(key);
  }

  list(prefix: string): Promise<StorageEntry[]> {
    return this.delegate.list(prefix);
  }

  writeText(key: string, content: string): Promise<void> {
    return this.delegate.writeText(key, content);
  }

  writeBinary(key: string, data: Buffer, options?: StorageWriteOptions): Promise<void> {
    return this.delegate.writeBinary(key, data, options);
  }

  delete(key: string): Promise<void> {
    return this.delegate.delete(key);
  }

  // ---------------------------------------------------------------- 差异部分

  /** 公开下载地址 = preferredBaseUrl + 编码后的 key（私密频道的 `_private/...` 前缀照常拼接）。 */
  async getDownloadUrl(key: string): Promise<string> {
    return appendUrl(this.baseUrls.preferredBaseUrl, assertStorageKey(key));
  }

  async close(): Promise<void> {
    // 内部 LocalStorageAdapter 的 close 为 no-op；仍调用以保持委托语义一致
    await this.delegate.close();
  }
}
