import { z } from 'zod';
import {
  AppIdSchema,
  ChannelIdSchema,
  PlatformSchema,
  PublishModeSchema,
  StorageConfigSchema,
  VersionSchema,
  VisibilitySchema,
} from '@apphub/protocol';
import type {
  PickKind,
  PublishRequestDTO,
  UpdateAppMetaRequestDTO,
} from './ipc';

/**
 * 主进程侧 IPC 入参校验（不信任渲染进程）。
 * 与 shared/ipc.ts 中的 DTO 一一对应。
 */

const OptionalHttpUrl = z
  .string()
  .url()
  .refine((value) => value.startsWith('http://') || value.startsWith('https://'), '必须是 http(s) 地址');

const HeadersSchema = z.record(z.string().max(1024)).optional();

export const EmptySchema = z.undefined().or(z.object({}).strict()).optional();

/** 修改 AppHub 数据目录（绝对路径由主进程再校验/规范化）。 */
export const ChangeDataDirRequestSchema = z
  .object({
    path: z.string().trim().min(1).max(4096),
  })
  .strict();

export const ChannelIdRequestSchema = z.object({ channelId: ChannelIdSchema }).strict();

export const CreateChannelRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(64),
    description: z.string().max(2048).optional(),
    visibility: VisibilitySchema,
    owner: z
      .object({
        name: z.string().max(128).optional(),
        contact: z.string().max(256).optional(),
      })
      .optional(),
    storage: StorageConfigSchema,
  })
  .strict();

export const UpdateChannelRequestSchema = z
  .object({
    channelId: ChannelIdSchema,
    patch: z
      .object({
        name: z.string().trim().min(1).max(64).optional(),
        description: z.string().max(2048).optional(),
        owner: z
          .object({
            name: z.string().max(128).optional(),
            contact: z.string().max(256).optional(),
          })
          .optional(),
      })
      .strict(),
  })
  .strict();

export const SubscribeRequestSchema = z
  .object({
    url: OptionalHttpUrl,
    headers: HeadersSchema,
  })
  .strict();

export const ExportPrivateConfigRequestSchema = z.object({ channelId: ChannelIdSchema }).strict();

export const PickRequestSchema = z.object({
  kind: z.enum(['files', 'folder', 'zip']).default('files'),
});

export const InspectSelectionRequestSchema = z.object({
  selectionId: z.string().min(1).max(128),
});

export const PublishRequestSchema = z
  .object({
    channelId: ChannelIdSchema,
    appId: AppIdSchema.optional(),
    displayName: z.string().trim().min(1).max(128),
    description: z.string().max(4096).optional(),
    author: z.string().max(256).optional(),
    homepage: OptionalHttpUrl.optional().or(z.literal('')),
    version: VersionSchema,
    platform: PlatformSchema,
    publishMode: PublishModeSchema,
    entry: z.string().min(1).max(1024),
    changelog: z.string().max(10000).optional(),
    overwrite: z.boolean().optional(),
    selectionId: z.string().min(1).max(128),
  })
  .strict();

export const UpdateAppMetaRequestSchema = z
  .object({
    channelId: ChannelIdSchema,
    appId: AppIdSchema,
    patch: z
      .object({
        displayName: z.string().trim().min(1).max(128).optional(),
        description: z.string().max(4096).optional(),
        author: z.string().max(256).optional(),
        homepage: OptionalHttpUrl.optional().or(z.literal('')),
        entry: z.string().min(1).max(1024).optional(),
      })
      .strict(),
  })
  .strict();

export const AppRefRequestSchema = z.object({
  channelId: ChannelIdSchema,
  appId: AppIdSchema,
});

export const InstallRequestSchema = z
  .object({
    channelId: ChannelIdSchema,
    appId: AppIdSchema,
    version: VersionSchema.optional(),
    platform: PlatformSchema.optional(),
    force: z.boolean().optional(),
  })
  .strict();

export const UpdateCheckRequestSchema = z.object({}).strict().optional();

export const VerifyRequestSchema = AppRefRequestSchema;

// ---------------------------------------------------------------------------
// 本机 Host 配置
// ---------------------------------------------------------------------------

const HostAdvertiseHostSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .regex(
    /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/,
    'advertiseHost 只能是主机名或 IPv4（不含协议、端口、路径）',
  );

export const HostUpdateConfigRequestSchema = z
  .object({
    channelId: ChannelIdSchema,
    patch: z
      .object({
        port: z.number().int().min(1).max(65535).optional(),
        bindHost: z.enum(['0.0.0.0', '127.0.0.1']).optional(),
        // 传空字符串表示"清除该可选配置"（core 会把 '' 视为清除 advertiseHost / publicBaseUrl）
        advertiseHost: HostAdvertiseHostSchema.or(z.literal('')).optional(),
        publicBaseUrl: OptionalHttpUrl.or(z.literal('')).optional(),
      })
      .strict(),
  })
  .strict();

export type PublishRequestParsed = z.infer<typeof PublishRequestSchema>;
export type UpdateAppMetaRequestParsed = z.infer<typeof UpdateAppMetaRequestSchema>;
export type PickKindSchema = PickKind;

// 编译期校验：zod schema 解析结果与 DTO 结构兼容
const _publishCompatibility: PublishRequestParsed extends PublishRequestDTO ? true : never = true;
const _updateMetaCompatibility: UpdateAppMetaRequestParsed extends UpdateAppMetaRequestDTO ? true : never = true;
void _publishCompatibility;
void _updateMetaCompatibility;
