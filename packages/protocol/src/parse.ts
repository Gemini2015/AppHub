import {
  AppMetaFileSchema,
  AppMetaFileSchemaStrict,
  ChannelFileSchema,
  ChannelFileSchemaStrict,
  ChannelPrivateFileSchema,
  ChannelPrivateFileSchemaStrict,
  FilesFileSchema,
  FilesFileSchemaStrict,
} from './schemas';
import type { AppMetaFile, ChannelFile, ChannelPrivateFile, FilesFile } from './types';
import { parseWithSchema } from './serialize';

/** 解析并校验 channel.json。 */
export function parseChannelFile(text: string): ChannelFile {
  return parseWithSchema(ChannelFileSchemaStrict, text, 'channel.json');
}

/** 解析并校验 channel_pri.json。 */
export function parseChannelPrivateFile(text: string): ChannelPrivateFile {
  return parseWithSchema(ChannelPrivateFileSchemaStrict, text, 'channel_pri.json');
}

/** 解析并校验 app.meta.json。 */
export function parseAppMetaFile(text: string): AppMetaFile {
  return parseWithSchema(AppMetaFileSchemaStrict, text, 'app.meta.json');
}

/** 解析并校验 files.json。 */
export function parseFilesFile(text: string): FilesFile {
  return parseWithSchema(FilesFileSchemaStrict, text, 'files.json');
}

/** 序列化 channel.json（带默认值填充）。 */
export function serializeChannelFile(channel: ChannelFile): string {
  const validated = ChannelFileSchemaStrict.parse(channel) as ChannelFile;
  return `${JSON.stringify(validated, null, 2)}\n`;
}

/** 序列化 channel_pri.json。 */
export function serializeChannelPrivateFile(priv: ChannelPrivateFile): string {
  const validated = ChannelPrivateFileSchemaStrict.parse(priv) as ChannelPrivateFile;
  return `${JSON.stringify(validated, null, 2)}\n`;
}

/** 序列化 app.meta.json。 */
export function serializeAppMetaFile(meta: AppMetaFile): string {
  const validated = AppMetaFileSchemaStrict.parse(meta) as AppMetaFile;
  return `${JSON.stringify(validated, null, 2)}\n`;
}

/** 序列化 files.json。 */
export function serializeFilesFile(files: FilesFile): string {
  const validated = FilesFileSchemaStrict.parse(files) as FilesFile;
  return `${JSON.stringify(validated, null, 2)}\n`;
}

/** 宽松 schema（不做跨字段校验），用于增量修复/展示历史坏数据。 */
export const LOOSE_SCHEMAS = {
  channel: ChannelFileSchema,
  channelPrivate: ChannelPrivateFileSchema,
  appMeta: AppMetaFileSchema,
  files: FilesFileSchema,
} as const;

export type SchemaName = keyof typeof LOOSE_SCHEMAS;

/** 宽松解析（仍校验字段类型，但不做跨字段一致性校验）。 */
export function looseParse(name: SchemaName, text: string): unknown {
  return parseWithSchema(LOOSE_SCHEMAS[name], text, name);
}
