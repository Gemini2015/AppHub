import type { z } from 'zod';
import { AppError } from './errors';

/** 输出规范化（2 空格缩进 + 结尾换行）的 JSON 文本。 */
export function stringifyJson(value: unknown): string {
  try {
    return `${JSON.stringify(value, null, 2)}\n`;
  } catch (error) {
    throw new AppError('INTERNAL', `JSON 序列化失败：${AppError.from(error).message}`);
  }
}

/** 解析 JSON 文本并确保顶层是对象。 */
export function parseJsonObject(text: string, label = 'JSON'): Record<string, unknown> {
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new AppError('VALIDATION', `${label}内容为空`);
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new AppError('VALIDATION', `${label}不是合法 JSON：${AppError.from(error).message}`);
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new AppError('VALIDATION', `${label}的顶层必须是对象`);
  }
  return data as Record<string, unknown>;
}

/**
 * 使用 zod schema 解析 JSON 文本。
 * 校验失败时抛出带具体字段路径的 AppError（code = VALIDATION）。
 */
export function parseWithSchema<T extends z.ZodTypeAny>(
  schema: T,
  text: string,
  label = 'JSON',
): z.output<T> {
  const data = parseJsonObject(text, label);
  return validateWithSchema(schema, data, label);
}

/** 使用 zod schema 校验对象。 */
export function validateWithSchema<T extends z.ZodTypeAny>(
  schema: T,
  data: unknown,
  label = '数据',
): z.output<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const first = result.error.issues[0];
    const path = first && first.path.length > 0 ? `（${first.path.join('.')}）` : '';
    const message = first ? `${label}校验失败：${first.message}${path}` : `${label}校验失败`;
    throw new AppError('VALIDATION', message, { issues: result.error.issues });
  }
  return result.data as z.output<T>;
}

/** 使用 zod schema 序列化对象（先校验再输出）。 */
export function serializeWithSchema<T extends z.ZodTypeAny>(schema: T, value: unknown): string {
  validateWithSchema(schema, value);
  return stringifyJson(value);
}
