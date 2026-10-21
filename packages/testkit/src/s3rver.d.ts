/**
 * s3rver 没有发布 TypeScript 类型，这里声明测试基础设施需要的最小 API。
 * 只允许在 @apphub/testkit 的进程内 S3 测试服务器中使用（生产代码不要依赖 s3rver）。
 */
declare module 's3rver' {
  export interface S3rverAddress {
    address: string;
    family: string;
    port: number;
  }

  export interface S3rverBucketConfig {
    name: string;
    /** 可选的桶子资源配置 XML（CORS / Website 等）。 */
    configs?: unknown[];
  }

  export interface S3rverOptions {
    address?: string;
    port?: number;
    key?: string;
    cert?: string;
    pfx?: string;
    silent?: boolean;
    serviceEndpoint?: string;
    directory?: string;
    resetOnClose?: boolean;
    allowMismatchedSignatures?: boolean;
    vhostBuckets?: boolean;
    configureBuckets?: S3rverBucketConfig[];
    [key: string]: unknown;
  }

  export default class S3rver {
    constructor(options?: S3rverOptions);
    /** 启动 HTTP 服务器；不传 callback 时返回 Promise<AddressInfo>。 */
    run(): Promise<S3rverAddress>;
    run(callback: (err: Error | null, address?: S3rverAddress) => void): this;
    /** 关闭 HTTP 服务器。 */
    close(): Promise<void>;
    close(callback: (err?: Error) => void): this;
    /** 按 configureBuckets 创建/更新桶（run() 会自动调用）。 */
    configureBuckets(): Promise<void>;
    /** 清空所有桶（resetOnClose 为 true 时随 close 调用）。 */
    reset(): void;
  }
}
