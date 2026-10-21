import { createReadStream, promises as fs } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

/**
 * E2E 专用极简静态文件服务器（模拟频道所有者的 nginx / 静态托管）。
 *
 * 为什么不直接复用 @apphub/testkit 的 startStaticServer：
 *  - E2E 运行在 Playwright 自己的 TS 加载器里，fixture 构造刻意**不依赖** workspace TS 包，
 *    避免 Playwright 转译 workspace 包与 core/storage 实现进度给 E2E 引入额外耦合；
 *  - 这里只需要"按目录只读地提供 HTTP 下载"这一最小能力，40 行即可，行为完全可控。
 *
 * 行为与 nginx 的静态文件服务对齐：GET/HEAD、目录越界 403、不存在 404、按扩展名给 Content-Type。
 */
export interface StaticServer {
  rootDir: string;
  baseUrl: string;
  port: number;
  /** 已处理的请求路径（便于断言"确实走了 HTTP 下载"、排查 404）。 */
  requests: string[];
  close(): Promise<void>;
}

const MIME: Record<string, string> = {
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.cmd': 'text/plain; charset=utf-8',
  '.sh': 'text/x-shellscript; charset=utf-8',
  '.exe': 'application/octet-stream',
  '.zip': 'application/zip',
  '.bin': 'application/octet-stream',
  '.ini': 'text/plain; charset=utf-8',
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
        res.setHeader(
          'content-type',
          MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream',
        );
        if (req.method === 'HEAD') {
          res.end();
          return;
        }
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
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
