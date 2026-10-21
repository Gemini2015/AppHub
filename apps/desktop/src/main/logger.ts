import type { Logger } from '@apphub/core';
import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import path from 'node:path';

export type { Logger };

/**
 * 主进程文件日志。
 *
 * 规则：
 *  - 日志写入 `<userData>/logs/main.log`，超过 maxBytes 轮转为 main.log.1；
 *  - 文件不可写（只读环境/测试）时退化为仅控制台输出，绝不因为日志导致主进程崩溃；
 *  - 只记录安全信息：调用方不得把凭据、密文、文件绝对路径等敏感内容放进 message/meta
 *    （主进程内部会在必要时自行脱敏）。
 */

export interface LoggerOptions {
  /** 日志目录；缺省则仅输出控制台。 */
  logDir?: string;
  /** 是否同时输出控制台（开发模式建议 true）。 */
  console?: boolean;
  fileName?: string;
  maxBytes?: number;
}

export interface AppHubLogger extends Logger {
  readonly logPath?: string;
  flush(): Promise<void>;
  close(): Promise<void>;
}

const MAX_META_LENGTH = 4096;

function safeSerialize(value: unknown): string {
  if (value === undefined) return '';
  try {
    const json = JSON.stringify(value, (_key, raw) => {
      if (typeof raw === 'bigint') return raw.toString();
      if (raw instanceof Error) return { name: raw.name, message: raw.message };
      return raw;
    });
    if (json === undefined) return '';
    return json.length > MAX_META_LENGTH ? `${json.slice(0, MAX_META_LENGTH)}…(truncated)` : json;
  } catch {
    return '[unserializable meta]';
  }
}

function formatLine(level: string, message: string, meta?: unknown): string {
  const time = new Date().toISOString();
  const metaText = safeSerialize(meta);
  return metaText ? `[${time}] [${level.toUpperCase()}] ${message} ${metaText}\n` : `[${time}] [${level.toUpperCase()}] ${message}\n`;
}

export function createLogger(options: LoggerOptions = {}): AppHubLogger {
  const useConsole = options.console ?? true;
  const maxBytes = options.maxBytes ?? 5 * 1024 * 1024;
  const logDir = options.logDir ? path.resolve(options.logDir) : undefined;
  const fileName = options.fileName ?? 'main.log';
  const logPath = logDir ? path.join(logDir, fileName) : undefined;

  let closed = false;
  let failedWrites = 0;
  let knownSize = 0;
  let pending: Promise<void> = Promise.resolve();
  let ready: Promise<boolean> | null = null;
  let warnedNoFile = false;

  const ensureReady = (): Promise<boolean> => {
    if (!ready) {
      ready = (async () => {
        if (!logDir || !logPath) return false;
        try {
          await mkdir(logDir, { recursive: true });
        } catch {
          return false;
        }
        try {
          knownSize = (await stat(logPath)).size;
        } catch {
          // 首次写入时文件还不存在
          knownSize = 0;
        }
        return true;
      })();
    }
    return ready;
  };

  const write = (line: string): void => {
    if (useConsole) {
      // 控制台保留 level 信息，便于 dev / e2e 观察
      const trimmed = line.trimEnd();
      if (trimmed.includes('[ERROR]')) console.error(trimmed);
      else if (trimmed.includes('[WARN]')) console.warn(trimmed);
      else console.log(trimmed);
    }
    if (!logPath) return;
    pending = pending
      .then(async () => {
        if (closed) return;
        if (!(await ensureReady())) {
          if (!warnedNoFile) {
            warnedNoFile = true;
            console.warn(`[logger] 日志目录不可写，后续仅输出控制台：${logDir}`);
          }
          return;
        }
        const lineBytes = Buffer.byteLength(line, 'utf8');
        if (knownSize + lineBytes > maxBytes) {
          try {
            await rename(logPath, `${logPath}.1`);
          } catch {
            /* 首次轮转失败可忽略 */
          }
          knownSize = 0;
        }
        await appendFile(logPath, line, 'utf8');
        knownSize += lineBytes;
        failedWrites = 0;
      })
      .catch(() => {
        failedWrites += 1;
        if (failedWrites === 1) console.warn('[logger] 写入日志文件失败，后续静默降级');
      });
  };

  const logger: AppHubLogger = {
    logPath,
    debug(message, meta) {
      write(formatLine('debug', message, meta));
    },
    info(message, meta) {
      write(formatLine('info', message, meta));
    },
    warn(message, meta) {
      write(formatLine('warn', message, meta));
    },
    error(message, meta) {
      write(formatLine('error', message, meta));
    },
    async flush() {
      await pending;
    },
    async close() {
      closed = true;
      await pending;
    },
  };
  return logger;
}
