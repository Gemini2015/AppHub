import { createReadStream } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import {
  AppError,
  CHANNEL_SCHEMAS,
  LIMITS,
  appendUrl,
  channelDescriptorKey,
  normalizeRelativePath,
  validationError,
} from '@apphub/protocol';
import type { ChannelPrivateFile, ErrorCode, LocalHostStorageConfig } from '@apphub/protocol';
import { resolveLocalHostBaseUrls } from '@apphub/storage';
import type { StorageFactory } from '@apphub/storage';
import { ensureDir } from './fs';
import type { KeyedMutex } from './mutex';
import type { StateStore } from './state';
import type {
  ChannelRecord,
  Clock,
  HostConfigPatch,
  HostService,
  HostStatus,
  HostUrls,
  Logger,
} from './types';

/**
 * 本机 Host（provider = `local-host`）：
 *  - HostServer：把频道仓库目录安全地暴露为只读静态 HTTP 服务（GET/HEAD）；
 *  - HostService：管理各 local-host 频道的 Host 生命周期（start/stop/status/updateConfig）。
 *
 * 安全约束：
 *  - 无目录列表；仅 GET/HEAD；
 *  - 路径逐段校验（拒绝 `..`、绝对路径、隐藏段、channel_pri.json）；
 *  - lstat 拒绝符号链接/目录/非普通文件，realpath 再做 rootDir containment；
 *  - 日志不输出可能包含 accessKey 的完整请求路径。
 */

const ALLOWED_METHODS = 'GET, HEAD';
const HEADERS_TIMEOUT_MS = 10_000;
const KEEP_ALIVE_TIMEOUT_MS = 5_000;
const REQUEST_TIMEOUT_MS = 5 * 60_000;

const CONTENT_TYPES: Record<string, string> = {
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.zip': 'application/zip',
  '.exe': 'application/octet-stream',
  '.bin': 'application/octet-stream',
  '.dll': 'application/octet-stream',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
};

function contentTypeOf(filePath: string): string {
  return CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

function isPathInside(rootDir: string, target: string): boolean {
  const relative = path.relative(rootDir, target);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function mapListenError(error: unknown, port: number): AppError {
  const errno = (error as NodeJS.ErrnoException | undefined)?.code;
  if (errno === 'EADDRINUSE') {
    return new AppError('CONFLICT', `本机 Host 端口 ${port} 已被占用，请更换端口后重试`, { port });
  }
  if (errno === 'EACCES' || errno === 'EPERM') {
    return new AppError('AUTH', `没有权限监听本机 Host 端口 ${port}`, { port });
  }
  return new AppError('STORAGE', `启动本机 Host 失败：${AppError.from(error).message}`, { port });
}

export interface HostServerOptions {
  /** 要暴露的频道仓库根目录（绝对路径）。 */
  rootDir: string;
  /** 监听端口；允许 0（由系统分配，测试用）。 */
  port: number;
  /** 监听地址：默认 0.0.0.0（局域网），127.0.0.1 仅本机。 */
  bindHost: string;
  logger?: Logger;
  /** 日志标签（channelId 等，不含 accessKey）。 */
  label?: string;
}

/**
 * 单频道本机静态 HTTP 服务。
 *
 * 一个实例只服务一个 rootDir；start/stop 幂等，stop 后端口立即可复用。
 */
export class HostServer {
  private readonly rootDir: string;
  private readonly options: HostServerOptions;
  private server: Server | null = null;
  private actualPort: number | null = null;

  constructor(options: HostServerOptions) {
    this.options = options;
    this.rootDir = path.resolve(options.rootDir);
  }

  get port(): number | null {
    return this.actualPort;
  }

  get running(): boolean {
    return this.server !== null;
  }

  /** 开始监听并返回实际端口（port=0 时由系统分配）。 */
  async start(): Promise<number> {
    if (this.server !== null && this.actualPort !== null) return this.actualPort;
    const server = createServer((request, response) => {
      void this.handleRequest(request, response);
    });
    server.headersTimeout = HEADERS_TIMEOUT_MS;
    server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
    server.requestTimeout = REQUEST_TIMEOUT_MS;
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => {
          server.removeListener('listening', onListening);
          reject(error);
        };
        const onListening = (): void => {
          server.removeListener('error', onError);
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(this.options.port, this.options.bindHost);
      });
    } catch (error) {
      this.closeServerQuietly(server);
      throw mapListenError(error, this.options.port);
    }
    this.server = server;
    // 监听成功后保留 error 监听，避免运行期异常触发 EventEmitter 未捕获错误导致进程崩溃
    server.on('error', (error: Error) => {
      this.options.logger?.warn('本机 Host 服务运行异常', {
        label: this.options.label,
        code: AppError.from(error).code,
      });
    });
    const address = server.address();
    this.actualPort = address && typeof address === 'object' ? (address as AddressInfo).port : this.options.port;
    return this.actualPort;
  }

  /** 停止监听（幂等）；使用 closeAllConnections 保证端口立即可复用。 */
  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;
    this.actualPort = null;
    await new Promise<void>((resolve) => {
      let settled = false;
      const done = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };
      try {
        (server as Server & { closeAllConnections?: () => void }).closeAllConnections?.();
      } catch {
        // 忽略：部分运行时/测试替身没有该 API
      }
      try {
        server.close(done);
      } catch {
        done();
      }
      // 兜底：极端情况下 close 回调不触发也不能卡住 stop
      setTimeout(done, 1000).unref?.();
    });
  }

  private closeServerQuietly(server: Server): void {
    try {
      (server as Server & { closeAllConnections?: () => void }).closeAllConnections?.();
      server.close();
    } catch {
      // 忽略监听失败后的清理错误
    }
  }

  // -------------------------------------------------------------------------
  // HTTP 处理
  // -------------------------------------------------------------------------

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        this.writeError(request, response, 405, { Allow: ALLOWED_METHODS });
        return;
      }
      const rawUrl = request.url ?? '/';
      const queryIndex = rawUrl.indexOf('?');
      const rawPath = queryIndex >= 0 ? rawUrl.slice(0, queryIndex) : rawUrl;
      let decodedPath: string;
      try {
        decodedPath = decodeURIComponent(rawPath);
      } catch {
        this.writeError(request, response, 400);
        return;
      }
      const relativePath = this.parseRequestPath(decodedPath);
      if (relativePath === null) {
        this.writeError(request, response, 404);
        return;
      }
      const file = await this.resolveFile(relativePath);
      if (!file) {
        this.writeError(request, response, 404);
        return;
      }
      this.sendFile(request, response, file);
    } catch (error) {
      if (!response.headersSent) {
        this.writeError(request, response, 500);
      } else {
        response.destroy();
      }
      // 只记录错误码，绝不打印可能含 accessKey 的请求路径
      this.options.logger?.warn('本机 Host 请求处理失败', {
        label: this.options.label,
        code: AppError.from(error).code,
      });
    }
  }

  /** 归一化并校验请求路径；任何不安全/非法输入返回 null（由调用方回 404）。 */
  private parseRequestPath(decodedPath: string): string | null {
    const raw = decodedPath.replace(/\\/g, '/').replace(/^\/+/, '');
    if (raw.length === 0 || raw.length > LIMITS.relativePath) return null;
    const rawSegments = raw.split('/');
    for (const segment of rawSegments) {
      if (segment.length === 0) return null; // 隐藏的空段（重复斜杠）
      if (segment.startsWith('.')) return null; // 隐藏文件/`..`/`.`
      if (segment === 'channel_pri.json') return null; // 私有凭据绝不对外
    }
    let normalized: string;
    try {
      normalized = normalizeRelativePath(raw, 'Host 请求路径');
    } catch {
      return null;
    }
    const segments = normalized.split('/');
    for (const segment of segments) {
      if (segment.startsWith('.') || segment === 'channel_pri.json') return null;
    }
    return normalized;
  }

  /** 解析为可读取的真实文件路径；不存在/不安全时返回 null。 */
  private async resolveFile(
    relativePath: string,
  ): Promise<{ absolutePath: string; size: number } | null> {
    const targetPath = path.resolve(this.rootDir, ...relativePath.split('/'));
    if (!isPathInside(this.rootDir, targetPath)) return null;
    let stats: import('node:fs').Stats;
    try {
      stats = await lstat(targetPath);
    } catch {
      return null;
    }
    if (stats.isSymbolicLink()) return null;
    if (!stats.isFile()) return null;
    let realRoot: string;
    let realTarget: string;
    try {
      [realRoot, realTarget] = await Promise.all([realpath(this.rootDir), realpath(targetPath)]);
    } catch {
      return null;
    }
    if (!isPathInside(realRoot, realTarget)) return null;
    return { absolutePath: realTarget, size: stats.size };
  }

  private sendFile(
    request: IncomingMessage,
    response: ServerResponse,
    file: { absolutePath: string; size: number },
  ): void {
    const headers: Record<string, string> = {
      'Content-Type': contentTypeOf(file.absolutePath),
      'Content-Length': String(file.size),
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    };
    response.writeHead(200, headers);
    if (request.method === 'HEAD') {
      response.end();
      return;
    }
    const stream = createReadStream(file.absolutePath);
    stream.on('error', () => {
      if (!response.headersSent) {
        response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('Internal Server Error');
      } else {
        response.destroy();
      }
    });
    response.on('close', () => stream.destroy());
    stream.pipe(response);
  }

  private writeError(
    request: IncomingMessage,
    response: ServerResponse,
    status: number,
    extraHeaders: Record<string, string> = {},
  ): void {
    if (response.headersSent) {
      response.destroy();
      return;
    }
    const body = `${status} ${statusText(status)}`;
    response.writeHead(status, {
      ...extraHeaders,
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Length': String(Buffer.byteLength(body, 'utf8')),
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    if (request.method === 'HEAD') response.end();
    else response.end(body);
  }
}

function statusText(status: number): string {
  if (status === 400) return 'Bad Request';
  if (status === 403) return 'Forbidden';
  if (status === 404) return 'Not Found';
  if (status === 405) return 'Method Not Allowed';
  if (status === 500) return 'Internal Server Error';
  return 'Error';
}

// ---------------------------------------------------------------------------
// HostService
// ---------------------------------------------------------------------------

export interface HostServiceDeps {
  state: StateStore;
  mutex: KeyedMutex;
  clock: Clock;
  logger?: Logger;
  storageFactory: StorageFactory;
  ready: Promise<void>;
}

interface RunningHost {
  server: HostServer;
  startedAt: string;
}

interface ManagedChannel {
  record: ChannelRecord;
  pri: ChannelPrivateFile;
  config: LocalHostStorageConfig;
}

export class HostServiceImpl implements HostService {
  private readonly deps: HostServiceDeps;
  private readonly running = new Map<string, RunningHost>();
  private readonly lastErrors = new Map<string, { code: ErrorCode; message: string }>();

  constructor(deps: HostServiceDeps) {
    this.deps = deps;
  }

  async list(): Promise<HostStatus[]> {
    await this.deps.ready;
    const records = await this.deps.state.listChannelRecords();
    const statuses: HostStatus[] = [];
    for (const record of records) {
      if (record.role === 'subscriber') continue;
      let pri: ChannelPrivateFile | null;
      try {
        pri = await this.deps.state.readPrivateConfig(record.channelId);
      } catch (error) {
        this.deps.logger?.warn('读取频道私有配置失败，跳过本机 Host 状态', {
          channelId: record.channelId,
          reason: AppError.from(error).message,
        });
        continue;
      }
      if (!pri || pri.storage.provider !== 'local-host') continue;
      statuses.push(this.buildStatus(record, pri));
    }
    return statuses.sort((a, b) => a.channelName.localeCompare(b.channelName));
  }

  async status(channelId: string): Promise<HostStatus> {
    await this.deps.ready;
    const managed = await this.requireManaged(channelId);
    return this.buildStatus(managed.record, managed.pri);
  }

  async start(channelId: string): Promise<HostStatus> {
    await this.deps.ready;
    return this.deps.mutex.runExclusive(`host:${channelId}`, async () => {
      const managed = await this.requireManaged(channelId);
      const existing = this.running.get(channelId);
      if (existing) {
        return this.buildStatus(managed.record, managed.pri);
      }
      const { config } = managed;
      try {
        await ensureDir(config.rootDir);
      } catch (error) {
        const appError = new AppError(
          'STORAGE',
          `本机 Host 根目录不可用：${AppError.from(error).message}`,
        );
        this.recordError(channelId, appError);
        throw appError;
      }
      const server = new HostServer({
        rootDir: config.rootDir,
        port: config.port,
        bindHost: config.bindHost,
        logger: this.deps.logger,
        label: channelId,
      });
      try {
        await server.start();
      } catch (error) {
        const appError = AppError.from(error);
        this.recordError(channelId, appError);
        this.deps.logger?.warn('启动本机 Host 失败', {
          channelId,
          code: appError.code,
        });
        throw appError;
      }
      this.running.set(channelId, {
        server,
        startedAt: this.deps.clock.now().toISOString(),
      });
      this.lastErrors.delete(channelId);
      // 启动成功后把本地记录的订阅地址同步为当前 Host 实际对外地址
      await this.syncRecordUrl(managed.record, managed.pri, server.port ?? config.port);
      return this.buildStatus(managed.record, managed.pri);
    });
  }

  async stop(channelId: string): Promise<HostStatus> {
    await this.deps.ready;
    return this.deps.mutex.runExclusive(`host:${channelId}`, async () => {
      const managed = await this.requireManaged(channelId);
      await this.stopServer(channelId);
      return this.buildStatus(managed.record, managed.pri);
    });
  }

  /**
   * 仅停止运行中的 Host，不校验频道记录（供频道被删除时的 best-effort 清理调用）。
   * 幂等；与 start/stop 共用 channelId 互斥，避免与正在进行的 start 竞争。
   */
  async stopInternal(channelId: string): Promise<void> {
    try {
      await this.deps.mutex.runExclusive(`host:${channelId}`, async () => {
        await this.stopServer(channelId);
        this.lastErrors.delete(channelId);
      });
    } catch (error) {
      this.deps.logger?.warn('停止本机 Host 失败', {
        channelId,
        reason: AppError.from(error).message,
      });
      // 兜底：确保运行中的 server 一定被关闭
      await this.stopServer(channelId);
    }
  }

  async updateConfig(channelId: string, patch: HostConfigPatch): Promise<HostStatus> {
    await this.deps.ready;
    return this.deps.mutex.runExclusive(`host:${channelId}`, async () => {
      const managed = await this.requireManaged(channelId);
      if (this.running.has(channelId)) {
        throw new AppError('STATE', '本机 Host 正在运行，请先停止后再修改配置');
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'rootDir')) {
        throw new AppError('VALIDATION', '本机 Host 的根目录（rootDir）不可修改');
      }
      const nextConfig = this.mergeConfig(managed.config, patch);
      const mergedPri: ChannelPrivateFile = {
        ...managed.pri,
        storage: nextConfig,
        updatedAt: this.deps.clock.now().toISOString(),
      };
      const parsed = CHANNEL_SCHEMAS.channelPrivate.safeParse(mergedPri);
      if (!parsed.success) throw validationError('本机 Host 配置', parsed.error);
      const validPri = parsed.data as ChannelPrivateFile;
      await this.deps.state.writePrivateConfig(validPri);
      const updatedRecord = await this.syncRecordUrl(
        managed.record,
        validPri,
        (validPri.storage as LocalHostStorageConfig).port,
      );
      this.lastErrors.delete(channelId);
      this.deps.logger?.info('已更新本机 Host 配置', { channelId });
      return this.buildStatus(updatedRecord, validPri);
    });
  }

  async stopAll(): Promise<void> {
    const ids = [...this.running.keys()];
    await Promise.all(
      ids.map(async (channelId) => {
        try {
          await this.stopServer(channelId);
        } catch (error) {
          this.deps.logger?.warn('停止本机 Host 失败', {
            channelId,
            reason: AppError.from(error).message,
          });
        }
      }),
    );
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  private async requireManaged(channelId: string): Promise<ManagedChannel> {
    const record = await this.deps.state.getChannelRecord(channelId);
    if (!record) throw new AppError('NOT_FOUND', `频道不存在：${channelId}`);
    let pri: ChannelPrivateFile | null = null;
    try {
      pri = await this.deps.state.readPrivateConfig(channelId);
    } catch (error) {
      throw AppError.from(error);
    }
    if (!pri || pri.storage.provider !== 'local-host') {
      throw new AppError(
        'UNSUPPORTED',
        `频道 ${channelId} 不是本机 Host 托管频道（provider 必须为 local-host）`,
      );
    }
    return { record, pri, config: pri.storage };
  }

  private recordError(channelId: string, error: AppError): void {
    this.lastErrors.set(channelId, { code: error.code, message: error.message });
  }

  private async stopServer(channelId: string): Promise<void> {
    const running = this.running.get(channelId);
    if (!running) return;
    this.running.delete(channelId);
    try {
      await running.server.stop();
    } catch (error) {
      this.deps.logger?.warn('关闭本机 Host 失败', {
        channelId,
        reason: AppError.from(error).message,
      });
    }
  }

  private mergeConfig(
    config: LocalHostStorageConfig,
    patch: HostConfigPatch,
  ): LocalHostStorageConfig {
    const next: LocalHostStorageConfig = { ...config };
    if (patch.port !== undefined) {
      if (!Number.isInteger(patch.port) || patch.port < 1 || patch.port > 65535) {
        throw new AppError('VALIDATION', `本机 Host 端口非法：${String(patch.port)}（需 1-65535）`);
      }
      next.port = patch.port;
    }
    if (patch.bindHost !== undefined) {
      if (patch.bindHost !== '0.0.0.0' && patch.bindHost !== '127.0.0.1') {
        throw new AppError('VALIDATION', `本机 Host 监听地址非法：${String(patch.bindHost)}`);
      }
      next.bindHost = patch.bindHost;
    }
    if (patch.advertiseHost !== undefined) {
      if (patch.advertiseHost === '') delete next.advertiseHost;
      else next.advertiseHost = patch.advertiseHost;
    }
    if (patch.publicBaseUrl !== undefined) {
      if (patch.publicBaseUrl === '') delete next.publicBaseUrl;
      else next.publicBaseUrl = patch.publicBaseUrl;
    }
    return next;
  }

  private buildUrls(pri: ChannelPrivateFile, port: number): HostUrls {
    const config = pri.storage as LocalHostStorageConfig;
    const base = resolveLocalHostBaseUrls(config, { port });
    const key = channelDescriptorKey(pri.visibility, pri.channelId, pri.accessKey);
    return {
      channelUrl: appendUrl(base.preferredBaseUrl, key),
      localChannelUrl: appendUrl(base.localBaseUrl, key),
      lanChannelUrls: base.lanBaseUrls.map((baseUrl) => appendUrl(baseUrl, key)),
    };
  }

  private buildStatus(record: ChannelRecord, pri: ChannelPrivateFile): HostStatus {
    const config = pri.storage as LocalHostStorageConfig;
    const running = this.running.get(record.channelId);
    const port = running?.server.port ?? config.port;
    const lastError = this.lastErrors.get(record.channelId);
    return {
      channelId: record.channelId,
      channelName: record.channelName,
      visibility: pri.visibility,
      running: running !== undefined,
      configuredPort: config.port,
      port: running?.server.port ?? null,
      bindHost: config.bindHost,
      urls: this.buildUrls(pri, port),
      ...(running ? { startedAt: running.startedAt } : {}),
      ...(lastError ? { lastError } : {}),
    };
  }

  /** 重新计算本地频道的订阅地址（ChannelRecord.url），并持久化。 */
  private async syncRecordUrl(
    record: ChannelRecord,
    pri: ChannelPrivateFile,
    port: number,
  ): Promise<ChannelRecord> {
    const urls = this.buildUrls(pri, port);
    if (record.url === urls.channelUrl) return record;
    const updated: ChannelRecord = { ...record, url: urls.channelUrl };
    await this.deps.state.upsertChannelRecord(updated);
    return updated;
  }
}
