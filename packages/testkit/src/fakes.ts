/**
 * 与 @apphub/core 的 SecretBox / Logger 结构兼容的测试替身。
 * 该文件刻意不 import core（避免循环依赖），通过结构类型适配。
 */

export interface FakeSecretBox {
  encrypt(plain: string): Promise<string>;
  decrypt(cipher: string): Promise<string>;
  /** 记录被加密的明文，便于断言"确实加密后落盘"。 */
  encryptedValues: string[];
}

/** 用可逆的 base64 前缀模拟加密（仅测试用，真实环境用 Electron safeStorage）。 */
export function createFakeSecretBox(): FakeSecretBox {
  const encryptedValues: string[] = [];
  return {
    encryptedValues,
    async encrypt(plain: string) {
      encryptedValues.push(plain);
      return `fake:v1:${Buffer.from(plain, 'utf8').toString('base64')}`;
    },
    async decrypt(cipher: string) {
      const prefix = 'fake:v1:';
      if (!cipher.startsWith(prefix)) throw new Error('FakeSecretBox: 非法密文');
      return Buffer.from(cipher.slice(prefix.length), 'base64').toString('utf8');
    },
  };
}

export interface FakeLogger {
  debug(message: string, meta?: unknown): void;
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
  entries: { level: string; message: string; meta?: unknown }[];
}

/** 收集日志的测试 logger。 */
export function createFakeLogger(): FakeLogger {
  const entries: FakeLogger['entries'] = [];
  const push = (level: string) => (message: string, meta?: unknown) => {
    entries.push({ level, message, meta });
  };
  return {
    entries,
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
  };
}

/** 固定时钟，用于生成可断言的 ISO 时间。 */
export function createFakeClock(start = '2026-01-01T00:00:00.000Z') {
  let current = new Date(start);
  let stepMs = 1000;
  return {
    now: () => new Date(current),
    advance: (ms: number) => {
      current = new Date(current.getTime() + ms);
    },
    set: (iso: string) => {
      current = new Date(iso);
    },
    setStep: (ms: number) => {
      stepMs = ms;
    },
    tick: () => {
      const value = new Date(current);
      current = new Date(current.getTime() + stepMs);
      return value;
    },
  };
}

/** 将对象转为可断言的纯 JSON。 */
export function toPlain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
