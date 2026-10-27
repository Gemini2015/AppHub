import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';

/**
 * 获取当前空闲的本机 TCP 端口（E2E 用）。
 *
 * 为什么不用 @apphub/testkit 里的同名实现：E2E 运行在 Playwright 自己的 TS 加载器里，
 * 刻意让 E2E 只依赖 Node 内置模块与相对路径文件，避免把 workspace 包（及其传递依赖
 * fflate/ftp-srv/s3rver 等）拉进 Playwright 进程，降低转译/解析失败风险。
 *
 * 语义与 testkit 版本一致：listen(127.0.0.1:0) → 读端口 → 立即 close。
 * "关闭→使用"之间存在极小竞争窗口，仅适合测试为需要显式端口的服务（本机 Host）挑端口。
 */
export async function getFreePort(): Promise<number> {
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      server.once('error', onError);
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', onError);
        resolve();
      });
    });
    const address = server.address() as AddressInfo | string | null;
    if (!address || typeof address === 'string') {
      throw new Error('getFreePort: 未能获取系统分配的空闲端口');
    }
    return address.port;
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
}
