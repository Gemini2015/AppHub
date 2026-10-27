# AppHub 协议规范（v1）

> 实现见 `packages/protocol`（zod schema + 校验 + 路径/URL/semver 工具）。
> 协议文件全部是 UTF-8 JSON；字段校验失败时发布/订阅必须拒绝该文件并给出可读错误。

## 1. 文件与角色

| 文件 | 位置 | 可见性 | 作用 |
| --- | --- | --- | --- |
| `channel.json` | 频道存储根目录（私密频道在 `_private/<channelId>/<accessKey>/`） | 公开（私密频道靠能力链接） | 频道公开信息 + App 列表 + 各 App 最新版本 |
| `channel_pri.json` | 仅本地（加密存储）或私下分享给管理员 | 私密 | 存储凭据 + accessKey；持有者拥有发布权限 |
| `app.meta.json` | `<channelRoot>/<appId>/app.meta.json` | 公开（随频道） | App 元信息 + **历史所有版本**信息（含每版本文件 size+MD5） |
| `files.json` | `<channelRoot>/<appId>/<version>/files.json` | 公开 | 某个版本的完整文件清单（与 meta 中该版本 files 一致） |

类型：`ChannelFile` / `ChannelPrivateFile` / `AppMetaFile` / `FilesFile`，定义于 `packages/protocol/src/schemas.ts`。

## 2. 存储布局

```
<channelRoot>/
  channel.json
  <appId>/
    app.meta.json
    <version>/
      files.json
      <version 内文件，按相对路径保存>
      <appId>-<version>.zip        # 仅 zip 发布方式
```

- `<channelRoot>` 由频道存储配置决定：FTP `rootDir`、本地 `rootDir`、S3 `prefix`。
- **版本目录是全局唯一的**：同一个 App 的版本号在不同平台之间也不能重复（目录路径中没有 platform 维度）。需要同时发布 Windows/Linux/mac 版本时，请使用不同版本号（例如 `1.0.0` / `1.0.1`），或为每个平台建立独立 App。
- 私密频道所有对象都放在 `_private/<channelId>/<accessKey>/` 前缀下；`<channelRoot>` 的 HTTP 地址仍为存储配置中的 `publicBaseUrl`，因此私密频道的订阅链接为：
  `http://domain/app_repo/_private/<channelId>/<accessKey>/channel.json`
- 公开频道：`http://domain/app_repo/channel.json`。

### URL 解析规则

协议内所有"地址"字段（`metaUrl`、`filesUrl`、`downloadBaseUrl`、`archive.url`）**优先使用相对于所在 JSON 文件目录的相对路径**，也允许 http(s) 绝对地址：

- `channel.json` 中 App 的 `metaUrl = "<appId>/app.meta.json"`，相对于 `channel.json` 所在目录解析；
- `app.meta.json` 中版本条目：
  - `filesUrl = "<version>/files.json"`，相对于 `app.meta.json` 所在目录；
  - `downloadBaseUrl = "<version>/"`，相对于 `app.meta.json` 所在目录；
  - `archive.url = "<version>/<appId>-<version>.zip"`，相对于 `app.meta.json` 所在目录；
- 文件下载地址 = `resolve(downloadBaseUrl, encodePath(file.path))`；
- 使用 `new URL(relative, base)` 语义解析，发布端始终写入上表格式。

## 3. channel.json

```json
{
  "schemaVersion": 1,
  "kind": "apphub-channel",
  "id": "ch_0123456789abcdef0123",
  "name": "example",
  "description": "示例频道",
  "visibility": "public",
  "owner": { "name": "Alice", "contact": "alice@example.com" },
  "access": { "type": "secret-url" },          // 仅私密频道
  "apps": [
    {
      "appId": "foobar",
      "name": "FooBar",
      "displayName": "FooBar",
      "description": "示例 App",
      "author": "Alice",
      "entry": "foobar.exe",
      "platforms": ["windows"],
      "publishMode": "files",
      "latest": { "windows": "1.0.1" },
      "metaUrl": "foobar/app.meta.json",
      "updatedAt": "2026-01-01T00:00:00.000Z"
    }
  ],
  "createdAt": "2026-01-01T00:00:00.000Z",
  "updatedAt": "2026-01-02T00:00:00.000Z"
}
```

规则：

- `id` 形如 `ch_` + 16~32 位小写十六进制，由 AppHub 生成；
- `apps[].appId` 全局唯一（频道内），同时是存储目录名，必须匹配 `^[a-z0-9](?:[a-z0-9._-]{0,61}[a-z0-9])?$`；
- `apps[].latest` 为 platform → version，记录每个平台最新版本；
- 私密频道必须带 `access: { type: "secret-url" }`，公开频道不得带 `access`；
- `apps[].metaUrl` 必须是安全相对路径或 http(s) 绝对 URL；
- `channel.json` 是频道内唯一"总索引"，订阅者以它发现 App。

## 4. channel_pri.json

```json
{
  "schemaVersion": 1,
  "kind": "apphub-channel-private",
  "channelId": "ch_0123456789abcdef0123",
  "channelName": "example",
  "visibility": "private",
  "accessKey": "8f14e45fceea167a5a36dedd4bea2543a1b2c3d4e5f60718",
  "createdAt": "2026-01-01T00:00:00.000Z",
  "updatedAt": "2026-01-01T00:00:00.000Z",
  "storage": {
    "provider": "ftp-http",
    "ftp": {
      "host": "127.0.0.1",
      "port": 21,
      "secure": false,
      "user": "apphub",
      "password": "******",
      "rootDir": "app_repo/",
      "passive": true,
      "timeoutMs": 20000
    },
    "http": {
      "baseUrl": "http://127.0.0.1:8080/app_repo/"
    }
  },
  "owner": { "name": "Alice" },
  "admins": [{ "name": "Bob" }],
  "notes": "可选备注"
}
```

规则：

- **发布权限 = 持有 channel_pri.json**。将其私下发给管理员即可授权发布（AppHub 支持导入/导出）；
- `accessKey`：私密频道必填、公开频道不得存在；它同时用于存储路径与订阅链接；
- `storage` 支持四种 provider（详见 STORAGE.md）：
  - `ftp-http`：FTP 写入 + nginx HTTP 读取；
  - `local`：本地目录写入 + 静态服务器/nginx 读取；
  - `local-host`：本机目录写入 + **AppHub 内置 Host Server** 提供 HTTP 下载（默认监听 `0.0.0.0`，局域网可访问）；
  - `s3`：S3/MinIO 写入；`publicBaseUrl` 用于生成公开下载地址；
- 本地保存时经 Electron `safeStorage` 加密（文件名 `<channelId>.enc`），运行时解密；导出时生成明文 JSON（用户显式操作）；
- 订阅者**不需要** channel_pri.json；私密频道订阅者只需要能力链接（含 accessKey 的 channel.json URL）。

`local-host` 配置示例（channel_pri.json 内）：

```json
{
  "storage": {
    "provider": "local-host",
    "rootDir": "D:/AppHubRepo/example",
    "port": 8787,
    "bindHost": "0.0.0.0",
    "advertiseHost": "192.168.1.20",
    "publicBaseUrl": "https://apps.example.com/example/"
  }
}
```

- `rootDir`：频道仓库根目录，AppHub 直接写入，内置 Host 只读提供该目录；
- `port`：Host 监听端口（默认 `8787`）；
- `bindHost`：默认 `0.0.0.0`（局域网可访问）；`127.0.0.1` 仅本机调试；
- `advertiseHost`：生成订阅 URL 时使用的对外主机名/IPv4（可选；留空自动取本机局域网 IPv4，离线回退 `127.0.0.1`）；
- `publicBaseUrl`：反向代理/自定义域名场景下完整覆盖公开基础 URL（可选，优先级最高）；
- Host 服务生命周期由 App 管理（手动启动/停止，App 退出自动停止）；公开协议文件（channel.json/app.meta.json/files.json）与 `local` 完全一致，不包含 Host 地址。

## 5. app.meta.json

```json
{
  "schemaVersion": 1,
  "kind": "apphub-app-meta",
  "appId": "foobar",
  "channelId": "ch_0123456789abcdef0123",
  "name": "FooBar",
  "displayName": "FooBar",
  "description": "示例 App",
  "author": "Alice",
  "homepage": "https://example.com/foobar",
  "publishMode": "files",
  "entry": "foobar.exe",
  "platforms": ["windows", "linux"],
  "latest": { "windows": "1.0.1", "linux": "1.0.0" },
  "versions": [
    {
      "version": "1.0.1",
      "platform": "windows",
      "publishMode": "files",
      "entry": "foobar.exe",
      "publishedAt": "2026-01-03T00:00:00.000Z",
      "changelog": "修复若干问题",
      "totalSize": 1048576,
      "fileCount": 2,
      "filesUrl": "1.0.1/files.json",
      "downloadBaseUrl": "1.0.1/",
      "files": [
        { "path": "foobar.exe", "size": 1048575, "md5": "d41d8cd98f00b204e9800998ecf8427e", "executable": true },
        { "path": "resources/app.ini", "size": 1, "md5": "0cc175b9c0f1b6a831c399e269772661" }
      ],
      "archive": null
    },
    {
      "version": "1.0.0",
      "platform": "linux",
      "publishMode": "zip",
      "entry": "foobar",
      "publishedAt": "2026-01-02T00:00:00.000Z",
      "changelog": "首个 Linux 版本",
      "totalSize": 2048,
      "fileCount": 2,
      "filesUrl": "1.0.0/files.json",
      "downloadBaseUrl": "1.0.0/",
      "files": [
        { "path": "foobar", "size": 1024, "md5": "..." },
        { "path": "lib/data.bin", "size": 1024, "md5": "..." }
      ],
      "archive": {
        "url": "1.0.0/foobar-1.0.0.zip",
        "size": 900,
        "md5": "d41d8cd98f00b204e9800998ecf8427e",
        "format": "zip"
      }
    }
  ],
  "updatedAt": "2026-01-03T00:00:00.000Z"
}
```

规则：

- **版本号 = semver**（`1.0.0`、`1.2.3-beta.1`…），同一 App 内唯一（跨平台也不可重复，原因见存储布局）；
- `publishMode` 是 App 级别配置，创建后不可切换（files ↔ zip 混用会报 `CONFLICT`）；
- `versions[]` 保存**所有历史版本**；每个版本都带完整 `files` 清单（与 files.json 内容相同）；
- `files[].executable` 可选，zip 解压后在 POSIX 平台会设置可执行位；
- `entry` 必须出现在该版本 files 清单中；
- `latest` 每个平台指向一个存在的版本；发布新版本时按 semver 取最大；
- `archive`：zip 发布方式必填、files 方式必须为 null/缺省；
- 客户端更新时以 `app.meta.json` 为唯一权威（zip 模式先校验 `archive.size/md5`，再解压）。

## 6. files.json

```json
{
  "schemaVersion": 1,
  "kind": "apphub-files",
  "appId": "foobar",
  "channelId": "ch_0123456789abcdef0123",
  "version": "1.0.1",
  "platform": "windows",
  "publishMode": "files",
  "entry": "foobar.exe",
  "totalSize": 1048576,
  "fileCount": 2,
  "files": [
    { "path": "foobar.exe", "size": 1048575, "md5": "d41d8cd98f00b204e9800998ecf8427e", "executable": true },
    { "path": "resources/app.ini", "size": 1, "md5": "0cc175b9c0f1b6a831c399e269772661" }
  ],
  "archive": null,
  "generatedAt": "2026-01-03T00:00:00.000Z"
}
```

- `fileCount` 必须等于 `files.length`，`totalSize` 必须等于 size 之和；
- zip 模式下 `files` 是压缩包**内部文件**列表（用于解压后校验），`archive` 记录压缩包自身的 size/MD5/URL；
- 文件路径一律为安全相对路径（`/` 分隔，禁止 `..`、绝对路径、盘符、Windows 保留名与空字符）。

## 7. 发布判定规则（publish）

### 7.1 files（散文件）

1. 输入：`version`、`platform`、`entry`、文件列表 `{sourcePath, targetPath}`、`changelog`；
2. 计算每个文件的 size+MD5，`totalSize = Σsize`；
3. 上传文件到 `<appId>/<version>/<targetPath>`；
4. 上传 `<appId>/<version>/files.json`；
5. 更新 `app.meta.json`（合并历史版本、更新 latest / platforms / updatedAt）；
6. 更新 `channel.json`（登记 App 或更新其 latest/metaUrl/updatedAt）。

### 7.2 zip（压缩包）

1. 输入 zip 文件（或由选中目录自动打包为 zip）、`version`、`platform`、`entry`（zip 内路径）；
2. 解压列出内部文件（安全校验：zip-slip、符号链接、文件数/大小上限），计算每个内部文件 size+MD5 与压缩包 size+MD5；
3. 上传 zip 到 `<appId>/<version>/<appId>-<version>.zip`（可自定义 archiveName）；
4. 上传 files.json（`files` = zip 内部文件清单，`archive` = zip 信息）；
5. 更新 app.meta.json 与 channel.json。

### 7.3 冲突与幂等

- 若 `version` 已存在且平台/文件清单（path+size+md5 集合）与本次完全一致：视为幂等成功，补写 channel.json 登记后返回成功；
- 若 `version` 已存在但内容不同：抛 `CONFLICT`，除非 `overwrite: true`（整版本替换，历史被覆盖）；
- `publishMode` 与已存在 App 不一致：抛 `CONFLICT`；
- 版本号必须大于该 App 当前 latest（同平台）才更新 latest，否则仅登记历史版本（允许补发旧版本）。

## 8. 更新判定规则（install/update）

1. 从 `channel.json` 找到 App → `app.meta.json` → 选目标版本（指定版本或该平台 latest）；
2. 取 `files.json`（或用 meta 中 `files`）；
3. files 模式：
   - 逐文件比较本地当前版本清单：相同 MD5 且存在 → 复用，不下载；否则下载并校验 size+MD5；
   - 全部文件校验通过后切换到新版本目录；
4. zip 模式：
   - 下载 archive → 校验 size+MD5 → 解压到 staging（zip-slip 防护，校验内部文件 size+MD5）；
5. 写入 install.json 并切换 current；清理旧版本（默认保留 2 个）；
6. 任一步失败：保留旧版本与旧指针，清理 staging。

## 9. 安全边界

- `size + MD5` 用于完整性校验（检测传输损坏/错版本），**不是**防篡改签名；安全性依赖 HTTPS 与可信订阅来源；
- 私密频道依靠"能力链接"（含随机 accessKey）+ 可选 HTTP Basic Auth；链接泄露等同于读取权限泄露；
- 发布权限依靠 channel_pri.json 的持有；建议只在可信渠道分享；
- 后续可扩展：channel.json/app.meta.json 数字签名（ed25519，预留 `signature` 字段扩展位）、内容寻址存储、断点续传、差分更新。
