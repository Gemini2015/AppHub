# AppHub 存储后端（Storage）

> 本文档说明 `@apphub/storage` 支持的三种存储后端（`local` / `ftp-http` / `s3`）的配置字段、
> 部署方式、安全建议，以及如何扩展新的 provider。
>
> 相关文档：[ARCHITECTURE.md](./ARCHITECTURE.md)（模块边界）、[PROTOCOL.md](./PROTOCOL.md)（协议与存储布局）。
> 配置结构的权威定义在 `packages/protocol/src/schemas.ts`（`LocalStorageConfigSchema` /
> `FtpHttpStorageConfigSchema` / `S3StorageConfigSchema`），实现位于 `packages/storage/src/adapters/`。

## 1. 总览

AppHub 是去中心化的：**频道所有者自己的存储就是 App 仓库**。发布端（owner/admin）通过存储的
原生协议写入，订阅端只通过公开 HTTP(S) 地址读取。

| provider | 写入方式 | 读取方式 | 典型场景 |
| --- | --- | --- | --- |
| `ftp-http` | FTP / FTPS 上传 | nginx / 任意静态 HTTP 服务 | 有虚拟主机/对象存储之外的自建服务器；需求中的 "FTP + nginx" |
| `local` | 直接写本地目录 | nginx / 静态服务器 | 存储与 AppHub 在同一台机器；内网共享目录 |
| `s3` | S3 API（minio SDK） | 公开桶 HTTP 地址，或预签名 URL | MinIO、AWS S3、阿里云 OSS 等 S3 兼容服务 |
| `memory` | 进程内 Map | 假地址 | **仅测试/演示**，不属于线上协议 |

存储配置保存在 `channel_pri.json.storage`（含凭据，仅本地加密保存或私下分享给管理员），
公开的 `channel.json` / `app.meta.json` 中只出现 HTTP 地址。

### 1.1 通用概念

- **频道根目录**：由 `ftp.rootDir`、`local.rootDir`、`s3.prefix` 决定，所有 key 都相对于它。
  例如 `channel.json`、`foobar/app.meta.json`、`foobar/1.0.1/files.json`。
- **key**：POSIX 相对路径（`/` 分隔）。适配器会校验 key：拒绝 `..`、空字符、Windows 保留名、
  超长路径等；所有错误以 `AppError('SECURITY' | 'VALIDATION')` 抛出。
- **publicBaseUrl / http.baseUrl**：频道根目录对应的公开 HTTP 根地址，必须以 `http(s)://` 开头。
  订阅者用 `appendUrl(base, key)` 拼出下载地址，因此**该地址必须能让任意订阅者匿名读取**
  （私密频道通过 `_private/<channelId>/<accessKey>/` 路径隔离，见 PROTOCOL.md）。
- **列表语义**：`list(prefix)` 递归返回 key 以 `prefix` 开头的对象；不带结尾 `/` 时等价于
  `prefix + '/'`（与内存实现一致）；前缀目录不存在时返回 `[]`。
- **错误码**（统一 `AppError`）：

| 场景 | code |
| --- | --- |
| key/配置非法、路径逃逸 | `VALIDATION` / `SECURITY` |
| 凭据错误、无权限（FTP 530 / S3 403） | `AUTH` |
| 连接拒绝、DNS 失败、超时 | `NETWORK` |
| 对象不存在（读取类方法返回 `null`/`false`，不抛错） | 内部判定，不对外抛 |
| bucket 不存在（probe） | `NOT_FOUND` |
| 其余后端错误 | `STORAGE` |
| 不支持的 provider / 配置能力（如 FTP 主动模式） | `UNSUPPORTED` |

错误信息会包含动作与底层原因，但**不会包含密码/secretKey**。

---

## 2. `local`：本地目录 + 静态服务

### 2.1 配置字段

| 字段 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `provider` | 是 | — | 固定 `local` |
| `rootDir` | 是 | — | 写入的本地目录（相对路径按 AppHub 进程 CWD 解析）；`probe` 时自动创建 |
| `publicBaseUrl` | 是 | — | 该目录对外暴露的 HTTP 根地址，例如 `http://127.0.0.1:8080/app_repo/` |
| `headers` | 否 | — | 订阅端下载时附加的 HTTP 头（不参与发布端写入），例如 Basic Auth |

示例（`channel_pri.json` 片段）：

```json
{
  "storage": {
    "provider": "local",
    "rootDir": "D:/apphub-repo",
    "publicBaseUrl": "https://apps.example.com/app_repo/"
  }
}
```

### 2.2 行为要点

- `probe()`：创建 `rootDir`（递归）并实际写入/删除一个探针文件，验证可写；
- 写入会自动创建父目录；`writeBinary` 的 `executable` 选项在 POSIX 平台会 `chmod 755`，Windows 忽略；
- 读取/删除均在 `rootDir` 内解析并二次校验，符号链接不会跟随（`list` 跳过）；
- `getDownloadUrl(key)` = `publicBaseUrl` + 编码后的 key。

### 2.3 静态服务（nginx）

```nginx
server {
    listen 443 ssl;
    server_name apps.example.com;
    root /srv/apphub-repo;              # 与 storage.rootDir 一致（nginx 侧别名）
    # 或者用 location + alias 映射到 publicBaseUrl 路径：
    # location /app_repo/ { alias /srv/apphub-repo/; }

    # 只读：禁止任何写方法
    limit_except GET HEAD { deny all; }

    # 关闭目录列举：否则会泄露 _private/<channelId>/<accessKey>/（私密频道能力链接）
    autoindex off;

    # 协议文件是 UTF-8 JSON；其他文件默认二进制
    location ~* \.json$ {
        default_type application/json;
        add_header Cache-Control "no-cache";
    }

    # 可选：给私密频道加 Basic Auth（订阅端会带上 storage.headers）
    # auth_basic "AppHub";
    # auth_basic_user_file /etc/nginx/apphub.htpasswd;
}
```

也可以用任意静态文件服务器（`python -m http.server`、Caddy、IIS、对象存储的静态托管）——
只要能把 `rootDir` 映射到 `publicBaseUrl` 且支持只读访问即可。

### 2.4 注意事项

- AppHub 与存储必须能访问同一份文件系统（同机、或可靠网络挂载）；不适合跨机器共享；
- `publicBaseUrl` 的路径要与静态服务暴露的 URL 前缀一致，否则订阅者 404；
- 建议 `rootDir` 独立目录、最小权限运行 AppHub，不要直接指向系统目录或家目录根。

---

## 3. `ftp-http`：FTP 写入 + HTTP 读取

需求中的经典组合：**FTP 负责写，nginx 负责读**。AppHub 用 `basic-ftp` 连接 FTP（单连接 +
内部串行队列），用 HTTP 地址给订阅者下载。

### 3.1 配置字段

`storage.ftp`：

| 字段 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `host` | 是 | — | FTP 主机名/IP |
| `port` | 否 | `21` | 控制端口 |
| `secure` | 否 | `false` | `true` 时使用显式 FTPS（AUTH TLS） |
| `user` | 否 | `anonymous` | 登录用户名 |
| `password` | 否 | `""` | 登录密码（**不要提交到仓库/日志**） |
| `rootDir` | 否 | `""` | FTP 登录目录下的频道根目录，例如 `app_repo/`；空串 = 登录目录本身 |
| `passive` | 否 | `true` | 仅支持被动模式；设为 `false` 会在 `probe` 时抛 `UNSUPPORTED` |
| `timeoutMs` | 否 | `20000` | 控制/数据连接超时（毫秒） |

`storage.http`：

| 字段 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `baseUrl` | 是 | — | `rootDir` 对应的公开 HTTP 根地址，例如 `https://apps.example.com/app_repo/` |
| `headers` | 否 | — | 订阅端下载时附加的 HTTP 头（例如 Basic Auth） |

示例：

```json
{
  "storage": {
    "provider": "ftp-http",
    "ftp": {
      "host": "ftp.example.com",
      "port": 21,
      "secure": true,
      "user": "apphub",
      "password": "******",
      "rootDir": "app_repo/",
      "passive": true,
      "timeoutMs": 20000
    },
    "http": { "baseUrl": "https://apps.example.com/app_repo/" }
  }
}
```

### 3.2 行为要点

- 惰性建立**单个** FTP 连接，所有操作经内部串行队列执行，避免并发命令串台；连接因网络错误
  关闭后，下一次操作自动重连；
- 连接成功后 `cd` 到 `rootDir`（不存在时自动创建，等价于 `probe` 的一部分）；
- `writeBinary` 自动 `ensureDir` 创建父目录；
- `readText/readBinary` 用 `downloadTo` 收集到内存（适合协议 JSON 与 App 文件，超大文件建议
  走 zip 发布以控制单文件大小）；
- `list` 递归遍历目录，返回相对频道根目录的 key；
- `delete` 对不存在的对象幂等（忽略 FTP 错误响应，包括 550）。
- **错误映射**：FTP 530 → `AUTH`；`ECONNREFUSED/ENOTFOUND/ETIMEDOUT/ECONNRESET` 等 → `NETWORK`；
  其余 FTP 响应码 → `STORAGE`。FTP 协议无法区分 "文件不存在" 与 "无权限"（都可能返回 550），
  读取类方法按 "不存在返回 null" 处理，实际使用中若出现"文件明明存在却读不到"，优先排查 FTP 账号
  对 `rootDir` 的读权限。

### 3.3 vsftpd 配置示例（Linux）

```ini
# /etc/vsftpd.conf（节选）
listen=NO
listen_ipv6=YES
anonymous_enable=NO
local_enable=YES
write_enable=YES
local_umask=022
chroot_local_user=YES
allow_writeable_chroot=YES

# 被动模式：公网服务器必须配置可访问的地址与端口范围，并在防火墙放行
pasv_enable=YES
pasv_min_port=40000
pasv_max_port=40100
pasv_address=ftp.example.com

# 可选：FTPS（需要证书）
ssl_enable=YES
rsa_cert_file=/etc/ssl/certs/ftp.crt
rsa_private_key_file=/etc/ssl/private/ftp.key
force_local_logins_ssl=NO
```

- 为 AppHub 建一个专用系统用户（例如 `apphub`），其 home 或 `rootDir` 指向 nginx 的 `root` 目录；
- 确保该用户对 `rootDir` 有**写权限**，而 nginx 只需要读权限；
- `pasv_min_port`/`pasv_max_port` 要在防火墙/安全组放行，否则上传会卡在 "425 Can't open data connection"。

### 3.4 FileZilla Server 配置要点（Windows）

1. 创建用户（如 `apphub`），设置密码并勾选 **Read + Write** 权限；
2. 共享目录选择与 nginx `root` 相同的目录（例如 `D:\apphub-repo`），并在 `channel_pri.json`
   的 `ftp.rootDir` 里填相对登录目录的路径（或留空表示共享目录本身）；
3. 被动模式：`Edit → Settings → FTP over TLS / Passive mode` 中设置自定义端口范围
   （如 40000-40100）并填写服务器公网 IP；
4. 如需 FTPS，启用 TLS 证书并把 `ftp.secure` 设为 `true`；
5. Windows 防火墙放行控制端口 21 与被动端口范围。

### 3.5 nginx 侧（与 FTP 共享同一个 `rootDir`）

```nginx
server {
    listen 443 ssl;
    server_name apps.example.com;
    root /srv/apphub-repo;                       # = FTP 的 rootDir 实际路径
    autoindex off;                               # 必须关闭，避免泄露私密频道前缀
    limit_except GET HEAD { deny all; }          # 只读

    location ~* \.json$ {
        default_type application/json;
        add_header Cache-Control "no-cache";
    }

    # 如果 FTP 的 rootDir 是登录目录下的子目录，而 nginx 根不同，可用：
    # location /app_repo/ { alias /srv/apphub-repo/; }
}
```

> AppHub 自身的测试用 `@apphub/testkit` 的 `startFtpTestServer()` + `startStaticServer()`
> 在**进程内**模拟同样的组合（真实 FTP 协议 + 真实 HTTP 下载），无需安装 vsftpd/nginx。

---

## 4. `s3`：S3 / MinIO

### 4.1 配置字段

| 字段 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `provider` | 是 | — | 固定 `s3` |
| `endpoint` | 否 | AWS S3 | S3 兼容服务地址，例如 `http://127.0.0.1:9000`；**不能带子路径**；`http://` 即明文、`https://` 即 TLS |
| `region` | 否 | `us-east-1` | 区域；MinIO 一般用 `us-east-1` |
| `bucket` | 是 | — | 桶名（需提前创建，`probe` 只检查存在性，不会自动建桶） |
| `accessKey` | 是 | — | Access Key |
| `secretKey` | 是 | — | Secret Key |
| `pathStyle` | 否 | `true` | 路径风格（`host/bucket/key`）；MinIO/自建服务用 `true`，AWS S3 通常 `false` |
| `secure` | 否 | `true` | 无 `endpoint`（AWS）时是否使用 HTTPS；有 `endpoint` 时以 endpoint 的 scheme 为准 |
| `prefix` | 否 | `""` | 频道根目录对应的对象前缀，例如 `apphub/`；空串 = 桶根目录 |
| `publicBaseUrl` | 否 | — | 公开访问基地址（公开桶/静态域名）。存在时 `getDownloadUrl = appendUrl(publicBaseUrl, prefix + key)`；为空时用 7 天预签名 URL |
| `headers` | 否 | — | 订阅端下载时附加的 HTTP 头 |

示例（MinIO，公开桶）：

```json
{
  "storage": {
    "provider": "s3",
    "endpoint": "http://127.0.0.1:9000",
    "region": "us-east-1",
    "bucket": "apphub",
    "accessKey": "apphub-writer",
    "secretKey": "******",
    "pathStyle": true,
    "secure": false,
    "prefix": "channels/example/",
    "publicBaseUrl": "http://127.0.0.1:9000/apphub/channels/example/"
  }
}
```

### 4.2 行为要点

- `writeText/writeBinary` = `putObject`（文本写 `application/json; charset=utf-8`）；
- `readText/readBinary` = `getObject` 收集为 Buffer，缺失对象返回 `null`；
- `stat` = `statObject`；`exists` = stat 非空；`list` = `listObjectsV2` 递归；
- `delete` = `removeObject`（S3 对不存在的 key 也返回成功，天然幂等）；
- `getDownloadUrl`：有 `publicBaseUrl` → 直接拼接（`publicBaseUrl` 需指向桶或桶内前缀的公开地址）；
  否则生成 **7 天有效**的 `presignedGetObject` URL；
- `probe`：`bucketExists`；桶不存在 → `NOT_FOUND`，凭据错误 → `AUTH`，连不上 → `NETWORK`。

### 4.3 MinIO 部署与匿名读

```bash
# 1) 启动 MinIO（示例，生产请使用 systemd/docker compose + 持久卷 + TLS）
docker run -d --name minio \
  -p 9000:9000 -p 9001:9001 \
  -e MINIO_ROOT_USER=admin -e MINIO_ROOT_PASSWORD='ChangeMe_123' \
  -v /srv/minio:/data \
  minio/minio:latest server /data --console-address ":9001"

# 2) 创建桶与发布账号（mc = MinIO Client）
mc alias set local http://127.0.0.1:9000 admin 'ChangeMe_123'
mc mb local/apphub
mc admin user add local apphub-writer 'WriterPassword_123'
mc admin policy attach local readwrite --user apphub-writer

# 3) 允许匿名读取（订阅者/AppHub 客户端需要 GET channel.json 等）
#    MinIO 的 `anonymous set` 只能按桶设置；若要精确到前缀，使用下面的桶策略 JSON。
mc anonymous set download local/apphub
```

如果需要更细的权限（例如只允许匿名读 `channels/` 前缀），使用桶策略：

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "AWS": ["*"] },
      "Action": ["s3:GetObject"],
      "Resource": ["arn:aws:s3:::apphub/channels/*"]
    }
  ]
}
```

```bash
mc anonymous set-json /tmp/public-read.json local/apphub
```

然后配置 `publicBaseUrl = http(s)://<minio 域名>/<bucket>/<prefix>/`（MinIO 路径风格）或
`https://<bucket>.s3.<region>.amazonaws.com/<prefix>/`（AWS 虚拟主机风格），并确保 `pathStyle`
与 URL 风格一致。

### 4.4 公开桶 vs 私有桶（预签名 URL）

- **公开桶 + publicBaseUrl**（推荐用于频道订阅）：订阅者用普通 HTTP 读取 `channel.json` /
  `app.meta.json` / 文件，行为与 nginx 一致；`getDownloadUrl` 返回稳定地址。
- **私有桶（不配 publicBaseUrl）**：`getDownloadUrl` 返回预签名 URL，适合"发布端生成分享链接"。
  注意：**频道订阅依赖公开可读的 HTTP 地址**（订阅者只拿到 `channel.json` 的 URL 并自行推导相对
  路径），因此私有桶场景要么配 `publicBaseUrl` 走带鉴权的反向代理，要么保持桶的匿名读；
  预签名 URL 主要作为辅助/直链能力。
- 预签名 URL 依赖发布端与对象存储的**时钟同步**（偏差通常 >15 分钟会失效）。

### 4.5 AWS S3 差异

- 不填 `endpoint`（或填 `https://s3.amazonaws.com` 亦可），`secure: true`，`pathStyle: false`；
- 桶需要开启 **Block Public Access 例外 + 桶策略** 才能匿名读；否则只能走预签名；
- 生产建议搭配 CloudFront/CDN 作为 `publicBaseUrl`，并给 App 文件设置较长的 `Cache-Control`；
- CORS 一般不需要（Electron 主进程/Node 侧下载不受浏览器 CORS 限制）。

---

## 5. 选择建议

| 场景 | 推荐 |
| --- | --- |
| 已有机房/虚拟主机，习惯 FTP 上传 | `ftp-http`（FTP 写 + nginx 读） |
| AppHub 与发布目录在同一台机器，追求最简单 | `local` + nginx/静态服务 |
| 希望免运维、可扩展、支持私有桶/预签名 | `s3`（MinIO 自建或云对象存储） |
| 单元/集成测试 | `memory` 或 testkit 的进程内 FTP/S3 服务器 |

---

## 6. 如何新增一个 provider

以新增 `webdav` 为例：

1. **协议层**（需 Lead 协调）：在 `packages/protocol/src/schemas.ts` 增加
   `WebdavStorageConfigSchema`，加入 `StorageConfigSchema` 的 discriminated union；
2. **实现适配器**：新建 `packages/storage/src/adapters/webdav.ts`，实现
   `StorageAdapter`（`probe/readText/readBinary/exists/stat/list/writeText/writeBinary/delete/getDownloadUrl/close`）；
   - key 一律先经 `assertStorageKey`；
   - 所有失败包成 `AppError`（错误映射可复用 `adapters/common.ts`）；
   - 错误信息不包含凭据；
3. **注册工厂**：在 `packages/storage/src/factory.ts` 的 `switch` 中增加分支；
4. **测试基础设施**：在 `packages/testkit` 增加进程内测试服务器（或复用现有 HTTP 服务器），
   并导出到 `testkit/src/index.ts`；
5. **测试**：新增 `packages/storage/src/adapters/webdav.test.ts`，必须覆盖 CRUD、list 前缀、
   缺失对象、错误凭据、连接失败、非法 key、并发/Unicode 等路径，且使用真实进程内服务器；
6. **文档**：更新本文档（配置字段、部署示例、安全建议）；
7. 运行 `pnpm --filter @apphub/storage test` 与 `pnpm typecheck` 全绿。

---

## 7. 测试基础设施（`@apphub/testkit`）

存储适配器的测试全部离线、使用**真实进程内服务器**（不 mock 协议层）：

| 工具 | 说明 |
| --- | --- |
| `startFtpTestServer(options?)` | 基于 `ftp-srv` 的进程内 FTP 服务器：临时 rootDir、自定义账号、自动选空闲控制端口与随机被动端口段、`close()` 清理；自动移除 ftp-srv 注册的进程退出信号处理器 |
| `startS3TestServer(options?)` | 基于 `s3rver` 的进程内 S3 服务器：临时数据目录、预创建桶、随机端口、`close()` 清理；默认凭据 `S3RVER/S3RVER`；支持匿名 GET 与预签名 URL |
| `startStaticServer(dir)` | 极简只读静态服务器（模拟 nginx），`close()` 会主动断开 keep-alive 连接 |
| `createTempDir/withTempDir/safeRemove` | 临时目录管理 |
| `waitFor/sleep` | 轮询等待 |

典型组合：

```ts
const ftp = await startFtpTestServer({ rootDir: homeDir });       // FTP 写入端
const http = await startStaticServer(path.join(homeDir, 'app_repo')); // nginx 读取端
const adapter = new FtpHttpStorageAdapter(config);                // rootDir: 'app_repo/'
try {
  await adapter.probe();
  /* ... CRUD 断言 ... */
} finally {
  await adapter.close();
  await ftp.close();
  await http.close();
}
```

---

## 8. 安全建议

1. **凭据只存在于 `channel_pri.json`**：本地用 Electron `safeStorage` 加密保存；导出/分享给管理员时
   走显式操作；不要把密文/明文提交到仓库或写进日志。
2. **错误与日志不含凭据**：适配器错误只包含动作、主机、对象 key 与底层原因；`password` /
   `secretKey` 永远不拼接进错误信息。
3. **优先 HTTPS / FTPS**：
   - nginx 使用 HTTPS，并禁止目录列举（`autoindex off`）；
   - FTP 若无 FTPS（`secure: true`），凭据与内容为明文传输，仅适合可信内网；
   - S3 使用 HTTPS endpoint；MinIO 生产部署务必启用 TLS。
4. **只读下载面**：静态服务只允许 `GET/HEAD`；不要把 FTP 账号的写权限给订阅者；`rootDir`
   独立目录、最小权限运行。
5. **私密频道**：安全性依赖 `_private/<channelId>/<accessKey>/` 路径的不可猜测性（能力链接）。
   一旦 `accessKey` 泄露等同于读取权限泄露；关闭目录列举、避免把访问日志公开。
6. **路径安全**：适配器拒绝 `..`、绝对路径、空字符、Windows 保留名等非法 key，并在本地目录
   实现里二次校验解析结果仍在 `rootDir` 内；不要绕过 `StorageAdapter` 直接按 key 拼路径。
7. **并发写入**：FTP 无 CAS/原子锁，`channel.json` 采用"最后写入者胜出"；同一频道的发布操作
   建议集中在一台机器（AppHub core 内部也会对同频道发布串行化）。S3 可在未来利用条件写扩展。
8. **大小限制**：订阅端应限制单文件/总大小与文件数（协议 `LIMITS`），避免恶意频道撑爆磁盘。

---

## 9. 已知限制

- **FTP 仅支持被动模式**：`passive: false` 会返回 `UNSUPPORTED`；公网部署务必配置被动端口范围。
- **FTP 错误语义模糊**：550 同时表示"不存在/无权限"；读取类方法按"不存在"处理（契约要求），
  排障时请结合服务器日志。
- **FTP 无原子写/无 CAS**：发布顺序由 core 保证（payload → files.json → app.meta.json →
  channel.json），但并发发布同一频道仍可能互相覆盖。
- **S3 预签名 URL 有效期 7 天**：过期后需重新生成；订阅端不应长期缓存归档地址。
- **minio SDK 不支持 endpoint 子路径**：反向代理若挂在 `/minio/` 子路径下，请改为独立域名/端口，
  或把前缀配置到 `prefix`。
- **`memory` 与 testkit 的进程内服务器仅用于测试**，不是生产后端。
