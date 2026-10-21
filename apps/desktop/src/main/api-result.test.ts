import { AppError } from '@apphub/protocol';
import { createFakeLogger } from '@apphub/testkit';
import { describe, expect, it } from 'vitest';
import { errorResult, okResult, runApi, sanitizeDetails, toApiError } from './api-result';

describe('api-result：统一 ApiResult 包装', () => {
  it('成功结果包装为 { ok: true, value }', () => {
    expect(okResult({ a: 1 })).toEqual({ ok: true, value: { a: 1 } });
    expect(okResult(undefined)).toEqual({ ok: true, value: undefined });
  });

  it('AppError 序列化为 code/message/details（不含 stack）', () => {
    const error = toApiError(new AppError('VALIDATION', '参数不合法', { issues: [{ path: 'name' }] }));
    expect(error).toEqual({
      code: 'VALIDATION',
      message: '参数不合法',
      details: { issues: [{ path: 'name' }] },
    });
    expect(JSON.stringify(error)).not.toContain('stack');
  });

  it('普通 Error 统一为 INTERNAL，且不把 stack 传给渲染进程', () => {
    const result = errorResult(new Error('内部错误 boom'));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('INTERNAL');
    expect(result.error.message).toBe('内部错误 boom');
    expect(JSON.stringify(result)).not.toContain('api-result.test');
  });

  it('Node 错误码映射：ENOENT -> NOT_FOUND / EACCES -> AUTH', () => {
    const notFound = Object.assign(new Error('文件不存在'), { code: 'ENOENT' });
    expect(toApiError(notFound).code).toBe('NOT_FOUND');
    const denied = Object.assign(new Error('拒绝访问'), { code: 'EACCES' });
    expect(toApiError(denied).code).toBe('AUTH');
  });

  it('非 Error 抛出值（字符串/对象）也能安全序列化', () => {
    expect(toApiError('字符串错误')).toMatchObject({ code: 'INTERNAL', message: '字符串错误' });
    expect(toApiError({ weird: true }).code).toBe('INTERNAL');
  });

  it('details 不可 JSON 序列化时丢弃，避免 IPC 结构化克隆失败', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    expect(sanitizeDetails(circular)).toBeUndefined();
    expect(sanitizeDetails(() => undefined)).toBeUndefined();
    expect(sanitizeDetails({ ok: true })).toEqual({ ok: true });
    expect(sanitizeDetails(undefined)).toBeUndefined();
  });

  it('跨 bundle 的 AppError（isAppHubError 标记）也能识别', () => {
    const alien = { isAppHubError: true, code: 'CONFLICT', message: '版本冲突', details: { version: '1.0.0' } };
    expect(toApiError(alien)).toEqual({ code: 'CONFLICT', message: '版本冲突', details: { version: '1.0.0' } });
  });
});

describe('api-result：runApi', () => {
  it('成功时直接返回 ok:true，不记录错误日志', async () => {
    const logger = createFakeLogger();
    const result = await runApi(logger, 'test.ok', async () => 42);
    expect(result).toEqual({ ok: true, value: 42 });
    expect(logger.entries.filter((entry) => entry.level === 'error')).toHaveLength(0);
  });

  it('失败时记录 error 日志并返回 ok:false（handler 不 reject）', async () => {
    const logger = createFakeLogger();
    const result = await runApi(logger, 'test.fail', () => {
      throw new AppError('AUTH', '无发布权限');
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('AUTH');
    const errors = logger.entries.filter((entry) => entry.level === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain('test.fail');
    // 只记录 code/message，不记录入参、堆栈等敏感/冗长内容
    expect(errors[0]?.meta).toEqual({ code: 'AUTH', message: '无发布权限' });
    expect(JSON.stringify(errors[0]?.meta)).not.toContain('stack');
  });

  it('未知异常也走 onError 回调（便于测试断言）', async () => {
    const logger = createFakeLogger();
    const seen: string[] = [];
    const result = await runApi(
      logger,
      'test.unknown',
      () => {
        throw new TypeError('unexpected');
      },
      (error) => seen.push(error.code),
    );
    expect(result.ok).toBe(false);
    expect(seen).toEqual(['INTERNAL']);
  });
});
