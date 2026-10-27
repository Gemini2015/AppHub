import { promises as fs } from 'node:fs';
import type { AddressInfo, Server } from 'node:net';
import net from 'node:net';
import path from 'node:path';
import FtpSrv from 'ftp-srv';
import { createTempDir, safeRemove } from './temp';

/**
 * 进程内 FTP 服务器（基于 ftp-srv），用于模拟"用户自己的 FTP 服务器"。
 *
 * - 默认在系统临时目录创建 rootDir，测试结束（close）时删除；
 * - 默认自动选择控制端口（0 = 系统分配），并给被动模式分配随机端口段，避免并行测试冲突；
 * - 默认用户名/密码固定，便于测试错误凭据路径；
 * - 服务器日志静默，不污染测试输出；
 * - 自动移除 ftp-srv 注册的 SIGTERM/SIGINT/SIGQUIT 处理器（避免测试进程被意外退出）。
 */
export interface FtpTestServerOptions {
  /** FTP 根目录（登录后看到的 `/`）；默认创建临时目录，close 时删除。 */
  rootDir?: string;
  user?: string;
  password?: string;
  /** 监听地址，默认 127.0.0.1。 */
  host?: string;
  /** 控制端口，默认 0（系统分配空闲端口）。 */
  port?: number;
  /** 被动模式端口段起点，默认自动探测一个空闲端口段（避开 Windows 保留/临时端口范围）。 */
  passivePortMin?: number;
  /** 被动模式端口段终点。 */
  passivePortMax?: number;
  /** 是否允许匿名登录，默认 false。 */
  anonymous?: boolean;
}

export interface FtpTestServer {
  host: string;
  port: number;
  /** 登录后的根目录（绝对路径）。 */
  rootDir: string;
  user: string;
  password: string;
  anonymous: boolean;
  /** 关闭服务器；若 rootDir 为自动创建的临时目录则一并删除。 */
  close(): Promise<void>;
}

type SilentLogger = {
  trace: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  fatal: (...args: unknown[]) => void;
  child: () => SilentLogger;
};

function createSilentLogger(): SilentLogger {
  const logger: SilentLogger = {
    trace: () => undefined,
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    fatal: () => undefined,
    child: () => logger,
  };
  return logger;
}

function canBindPort(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    const finish = (ok: boolean): void => {
      server.removeAllListeners();
      resolve(ok);
    };
    server.once('error', () => finish(false));
    try {
      server.listen(port, host, () => {
        server.close(() => finish(true));
      });
    } catch {
      finish(false);
    }
  });
}

/**
 * 选择一个当前可监听的被动端口段。
 *
 * Windows GitHub Runner 上 49152+ 属于系统临时端口范围，且可能存在
 * Hyper-V/防火墙保留端口段；若 ftp-srv 的被动端口落在这些范围内，
 * 数据传输会卡住（basic-ftp 最终报 "Timeout (control socket)"）。
 * 因此默认在较低端口中探测一段全部可绑定的端口，而不是随机取 40000+。
 */
async function findFreePassivePortRange(host: string, size = 150): Promise<{ min: number; max: number }> {
  const candidateBases = [20_000, 22_000, 24_000, 26_000, 28_000, 30_000, 32_000, 34_000, 36_000, 38_000];
  for (const base of candidateBases) {
    let available = true;
    for (let port = base; port < base + size; port += 1) {
      // 候选段整体探测，避免部分端口被系统保留/占用导致 FTP 数据连接偶发失败。
      // 每个端口只做一次 bind+close，正常情况（第一个候选段）≈150ms 内完成。
      if (!(await canBindPort(port, host))) {
        available = false;
        break;
      }
    }
    if (available) return { min: base, max: base + size - 1 };
  }
  // 兜底：旧行为（极少数环境所有候选段都不可用）
  const min = 20_000 + Math.floor(Math.random() * 20_000);
  return { min, max: min + size - 1 };
}

/** ftp-srv 内部结构（类型声明未暴露 server 字段）。 */
interface FtpSrvInternals {
  server: Server;
}

/**
 * 执行 create，并移除 ftp-srv 构造函数里注册到当前进程的退出信号处理器。
 * ftp-srv 的 quit() 会调用 process.exit(0)，在测试进程里必须避免。
 */
function createWithoutSignalHandlers(create: () => FtpSrv): FtpSrv {
  const signals: NodeJS.Signals[] = ['SIGTERM', 'SIGINT', 'SIGQUIT'];
  const before = new Map<NodeJS.Signals, Set<(...args: unknown[]) => void>>();
  for (const signal of signals) {
    before.set(signal, new Set(process.listeners(signal) as ((...args: unknown[]) => void)[]));
  }
  const instance = create();
  for (const signal of signals) {
    const existing = before.get(signal);
    for (const listener of process.listeners(signal) as ((...args: unknown[]) => void)[]) {
      if (existing && !existing.has(listener)) process.removeListener(signal, listener);
    }
  }
  return instance;
}

export async function startFtpTestServer(
  options: FtpTestServerOptions = {},
): Promise<FtpTestServer> {
  const host = options.host ?? '127.0.0.1';
  const autoRoot = options.rootDir === undefined;
  const rootDir = path.resolve(options.rootDir ?? (await createTempDir('apphub-ftp-')));
  await fs.mkdir(rootDir, { recursive: true });

  const user = options.user ?? 'apphub';
  const password = options.password ?? 'apphub-test-password';
  const anonymous = options.anonymous ?? false;
  const port = options.port ?? 0;
  // 每个服务器实例使用自动探测的被动端口段：并行测试时互不干扰，并避开
  // Windows 系统临时端口/保留端口段（否则 FTP 数据连接会超时）。
  const detectedPassiveRange =
    options.passivePortMin === undefined && options.passivePortMax === undefined
      ? await findFreePassivePortRange(host)
      : null;
  const passivePortMin = options.passivePortMin ?? detectedPassiveRange?.min ?? 20_000;
  const passivePortMax = options.passivePortMax ?? detectedPassiveRange?.max ?? Math.min(passivePortMin + 500, 65_535);

  const server = createWithoutSignalHandlers(
    () =>
      new FtpSrv({
        url: `ftp://${host}:${port}`,
        pasv_url: host,
        pasv_min: passivePortMin,
        pasv_max: passivePortMax,
        anonymous,
        greeting: 'AppHub test FTP server',
        log: createSilentLogger(),
      }),
  );

  server.on('login', ({ username, password: provided }, resolve, reject) => {
    if (anonymous && username === 'anonymous') {
      resolve({ root: rootDir });
      return;
    }
    if (username !== user || provided !== password) {
      // ftp-srv 会把 reject 的原因以 530 返回给客户端
      reject(new Error('用户名或密码错误'));
      return;
    }
    resolve({ root: rootDir });
  });
  // 避免错误日志打到控制台；测试里通过断言 client error 是否出现来判断即可。
  server.on('client-error', () => undefined);
  (server as unknown as NodeJS.EventEmitter).on('server-error', () => undefined);

  await server.listen();
  const address = (server as unknown as FtpSrvInternals).server.address() as AddressInfo | null;
  if (!address) {
    await Promise.resolve(server.close()).catch(() => undefined);
    throw new Error('FTP 测试服务器启动失败：未能获取监听端口');
  }

  let closed = false;
  return {
    host,
    port: address.port,
    rootDir,
    user,
    password,
    anonymous,
    async close() {
      if (closed) return;
      closed = true;
      await Promise.resolve(server.close()).catch(() => undefined);
      if (autoRoot) await safeRemove(rootDir);
    },
  };
}

/** `startFtpServer` 是 `startFtpTestServer` 的简写别名。 */
export const startFtpServer = startFtpTestServer;
