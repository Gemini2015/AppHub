import type { z } from 'zod';
import type {
  AppMetaFileSchema,
  AppVersionEntrySchema,
  ArchiveInfoSchema,
  ChannelAppRefSchema,
  ChannelFileSchema,
  ChannelPrivateFileSchema,
  FileEntrySchema,
  FilesFileSchema,
  LocalStorageConfigSchema,
  FtpHttpStorageConfigSchema,
  S3StorageConfigSchema,
  StorageConfigSchema,
  PlatformSchema,
  PublishModeSchema,
  VisibilitySchema,
} from './schemas';

export type Platform = z.infer<typeof PlatformSchema>;
export type PublishMode = z.infer<typeof PublishModeSchema>;
export type Visibility = z.infer<typeof VisibilitySchema>;

export type FileEntry = z.infer<typeof FileEntrySchema>;
export type ArchiveInfo = z.infer<typeof ArchiveInfoSchema>;
export type AppVersionEntry = z.infer<typeof AppVersionEntrySchema>;
export type AppMetaFile = z.infer<typeof AppMetaFileSchema>;
export type FilesFile = z.infer<typeof FilesFileSchema>;
export type ChannelAppRef = z.infer<typeof ChannelAppRefSchema>;
export type ChannelFile = z.infer<typeof ChannelFileSchema>;
export type ChannelPrivateFile = z.infer<typeof ChannelPrivateFileSchema>;

export type LocalStorageConfig = z.infer<typeof LocalStorageConfigSchema>;
export type FtpHttpStorageConfig = z.infer<typeof FtpHttpStorageConfigSchema>;
export type S3StorageConfig = z.infer<typeof S3StorageConfigSchema>;
export type StorageConfig = z.infer<typeof StorageConfigSchema>;
export type StorageProvider = StorageConfig['provider'];

/** 频道所有者的公开信息。 */
export interface ChannelOwnerInfo {
  name: string;
  contact?: string;
}
