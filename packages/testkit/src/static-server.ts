import { createReadStream, promises as fs } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

/**
 * 极简静态文件服务器，模拟 nginx 的只读 HTTP 下载能力。
 * 用于集成测试中验证"FTP 上传 + HTTP 下载"组合。
 */
export interface StaticServer {
  rootDir: string;
  baseUrl: string;
  port: number;
  /** 已处理的请求路径（便于断言"确实走了 HTTP 下载"）。 */
  requests: string[];
  close(): Promise<void>;
}

const MIME: Record<string, string> = {
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.exe': 'application/octet-stream',
  '.zip': 'application/zip',
  '.bin': 'application/octet-stream',
};

export async function startStaticServer(rootDir: string): Promise<StaticServer> {
  const resolvedRoot = path.resolve(rootDir);
  const requests: string[] = [];
  const server: Server = createServer((req, res) => {
    const rawUrl = req.url ?? '/';
    requests.push(rawUrl);
    let pathname: string;
    try {
      pathname = decodeURIComponent(rawUrl.split('?')[0] ?? '/');
    } catch {
      res.statusCode = 400;
      res.end('bad url');
      return;
    }
    const filePath = path.resolve(resolvedRoot, `.${path.posix.normalize(pathname)}`);
    if (filePath !== resolvedRoot && !filePath.startsWith(`${resolvedRoot}${path.sep}`)) {
      res.statusCode = 403;
      res.end('forbidden');
      return;
    }
    void (async () => {
      try {
        const stat = await fs.stat(filePath);
        if (!stat.isFile()) {
          res.statusCode = 404;
          res.end('not found');
          return;
        }
        res.setHeader('content-length', String(stat.size));
        res.setHeader('content-type', MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream');
        createReadStream(filePath).pipe(res);
      } catch {
        res.statusCode = 404;
        res.end('not found');
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo;
  return {
    rootDir: resolvedRoot,
    baseUrl: `http://127.0.0.1:${address.port}/`,
    port: address.port,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        // fetch/undici 会保持 keep-alive 连接，不主动断开会让 server.close 等到连接空闲超时。
        server.closeIdleConnections?.();
        server.closeAllConnections?.();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
