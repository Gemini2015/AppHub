/**
 * 按 key 串行化的互斥锁。
 *
 * 同一频道/同一 App 的发布、安装等写操作必须串行，避免"读取-合并-写回"丢失更新。
 * 不同 key 之间互不阻塞。
 */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>();

  /** 在指定 key 上独占执行；抛出的错误原样传递。 */
  async runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.tails.set(key, tail);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
      // tail 只会 resolve（current 不会 reject），这里兜底防御。
      void tail.catch(() => undefined);
    }
  }

  /** 当前是否有等待中的 key（测试辅助）。 */
  pendingKeys(): string[] {
    return [...this.tails.keys()];
  }
}

/**
 * 频道级写锁 key：同一频道的 channel.json "读取-合并-写回" 必须串行
 * （docs/ARCHITECTURE.md §7：同一频道/App 的发布串行化）。
 *
 * 发布（publish）、元信息修改（updateMeta）、频道信息修改（channels.update）
 * 都必须使用同一个 key，否则并发合并会丢失 App 或互相覆盖。
 */
export function channelWriteLockKey(channelId: string): string {
  return `channel-write:${channelId}`;
}
