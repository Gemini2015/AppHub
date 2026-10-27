import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';

/**
 * 获取一个当前空闲的本地 TCP 端口。
 *
 * 实现：监听 `127.0.0.1:0` 让操作系统分配端口，读出端口后立即关闭服务器。
 * 返回的端口在"关闭 ~ 使用"之间存在极小竞争窗口，仅适合测试/演示中为
 * 需要显式端口的服务（例如本机 Host）挑选端口；生产代码请直接用 `listen(0)`。
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
