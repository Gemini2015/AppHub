# 使用指南

[← 返回 README](../README.md)

## 功能一览

| 需求 | 实现 |
| --- | --- |
| 创建、订阅 App 频道 | 频道向导（公开/私密）、URL 订阅、频道刷新、取消订阅 |
| 每个频道包含若干 App | `channel.json` 登记 App 列表；频道详情页卡片列表 |
| 在频道内发布、下载 App | 发布向导（散文件 / zip 两种方式）、进度条、冲突检测、幂等重试 |
| 管理本地已安装的 App | 本地库：安装、更新、校验（MD5）、启动、打开目录、卸载 |
| AppHub 不存储 App 本身 | 只读写频道所有者配置的存储；本地仅保存已安装副本 |
| 公开频道任何人可订阅/查看/下载 | `channel.json` 公开 URL 直接订阅 |
| 私密频道仅授权用户 | 能力链接（含随机 accessKey 的私密 `channel.json` URL），管理员私下分发 |
| 拥有者/管理员可发布 | 发布权限 = 持有 `channel_pri.json`（可导入/导出给管理员） |
| 远程 channel.json 存储频道信息 | 基础信息 + App 列表 + 元信息 + 下载地址 + 更新方式 |
| 独立 exe / zip / 一组文件 | 散文件发布与 zip 发布两种模式，entry 启动入口 |
| 散文件发布更新 app.meta.json | 每个文件 size + MD5；客户端按 MD5 只下载变化文件 |
| zip 发布更新 app.meta.json | 记录 archive size/MD5；客户端下载 zip → 校验 → 解压覆盖 |
| app.meta.json 含历史版本 + files.json | 每版本完整文件清单；`app.meta.json` 保留全部历史 |
| 频道配置 App 存储 | 创建频道时配置 `local` / `local-host` / `ftp-http` / `s3`（可扩展） |
| 本机 Host 一键分享 | 内置 Host Server 直接托管本地目录，默认监听局域网，生成可分享的 `channel.json` URL，可随时启停 |
| 数据目录可迁移 | 设置中可修改 AppHub 数据目录：复制频道记录/本地库/加密配置到新目录并重启（环境变量固定时只读） |
| FTP + nginx 存储发布 | FTP 上传 + nginx 下载；也支持本地目录/MinIO |
| 完整的测试方案 | 单元 + 集成（进程内 FTP/HTTP/S3 模拟）+ Electron E2E + 手工矩阵，见 [TESTING.md](./TESTING.md) |

## 1. 创建频道（以 FTP + nginx 为例）

准备一台带 FTP 与 nginx 的服务器（或本地用 FileZilla Server/nginx 模拟）：

- FTP 提供一个可写账号，可写入目录 `app_repo/`；
- nginx 将 `app_repo/` 设置为静态目录，例如 `http://your.domain/app_repo/`。

在 AppHub 中点击 **创建频道**：

1. 填写频道名称、描述，选择 **公开** 或 **私密**；
2. 选择存储类型 `FTP + HTTP`，填写：
   - `FTP 主机 / 端口 / 用户名 / 密码 / 根目录`（如 `app_repo/`）；
   - `HTTP 基础地址`（如 `http://your.domain/app_repo/`，即 nginx 的访问地址）；
3. 点击创建。AppHub 会：
   - 探测 FTP/HTTP 可用性；
   - 生成 `channel.json`（公开频道直接写到 `app_repo/channel.json`；私密频道写到 `app_repo/_private/<channelId>/<accessKey>/channel.json`）；
   - 生成 `channel_pri.json`（包含 FTP 凭据），用系统安全存储（Windows DPAPI / macOS Keychain / Linux Secret Service）加密保存在本机；
4. 在频道详情页可 **复制订阅链接** 分享给他人。

> 私密频道：只有拿到订阅链接（内含随机 accessKey）的人才能读取 `channel.json` 与下载 App。
> 发布权限由 `channel_pri.json` 授予：**导出管理员配置** 后私下发送给管理员，对方在 AppHub 中 **导入** 即可发布。

## 1.1 更简单：用「本机 Host」分享（无需 FTP/nginx）

如果 App 就在你自己的电脑上，可以直接用 AppHub 内置的 Host Server（创建频道时**默认存储类型就是本机 Host**）：

1. **创建频道** → 存储类型默认 **本机 Host（local-host）**；
2. 选择/填写一个本地文件夹作为频道仓库目录（`rootDir`）；端口默认从 `8787` 起，**会自动避开已有频道已使用的端口**（如 8787 已被占用则推荐 8788）；
3. 访问范围默认 **局域网可访问（0.0.0.0）**；仅本机调试可切 `127.0.0.1`。首次启动如弹出系统防火墙提示，请允许专用网络；
4. 可选填写「对外主机名/IP」或「公开基础地址覆盖」——用于固定分享地址或反向代理；
5. 创建成功后 Host 会尝试自动启动，也可在频道详情页随时 **启动 / 停止**；
6. 复制详情页展示的 `channel.json` 订阅链接发给同事（默认是 `http://<你的局域网IP>:8787/channel.json`），对方在 AppHub 中粘贴订阅即可安装/更新。

> Host 只在 AppHub 运行期间有效；停止后订阅链接不可访问，已安装的 App 不受影响。
> 私密频道的链接包含 `_private/<channelId>/<accessKey>/`，拿到链接即拥有读取权限，请谨慎分享。
> 需要公网分享时，建议用 nginx 等反向代理加 HTTPS，并把「公开基础地址覆盖」配置为对外域名。

## 2. 发布 App

在频道详情页点击 **发布 App**（首次）或 App 详情页 **发布新版本**：

1. 填写 App 名称（`foobar`）、简介、作者；
2. 选择发布方式：
   - **散文件**：选择文件或整个文件夹，自动保留目录结构；每个文件计算 size/MD5；
   - **zip**：选择已有 zip 包，或选择文件夹由 AppHub 打包；
3. 填写版本号（semver，如 `1.0.0`）、平台（Windows/Linux/macOS）、启动入口（如 `foobar.exe`）、更新说明；
   - 版本号会**自动预填**：新 App 默认 `1.0.0`；已有 App 取历史最高版本递增 minor（`1.0.x → 1.1.0`、`1.1.0 → 1.2.0`），仍可手工修改；
4. 发布。AppHub 会将文件上传到频道的存储：
   ```
   app_repo/foobar/app.meta.json
   app_repo/foobar/1.0.0/files.json
   app_repo/foobar/1.0.0/foobar.exe
   app_repo/foobar/1.0.0/resources/...
   ```
   并更新 `app.meta.json`（历史版本、各平台 latest、每个文件的 size/MD5）和 `channel.json`（登记 App）。
   订阅者刷新频道后即可看到并安装。

## 3. 订阅频道

点击 **订阅频道**，粘贴 `channel.json` 的 HTTP 地址（公开频道形如 `http://domain/app_repo/channel.json`；私密频道形如 `http://domain/app_repo/_private/<channelId>/<accessKey>/channel.json`）。
若 nginx 启用了 HTTP Basic Auth，可在订阅对话框的「高级」中填写请求头。

## 4. 安装与更新

- 订阅者在频道页点击 App → **安装**：AppHub 会下载 `app.meta.json`/`files.json`，按文件 size/MD5 校验下载内容，安装到本地库；
- 已安装的 App 在 **本地库** 中统一管理：
  - **检查更新**：比较各平台 latest 与本地版本；
  - **更新**：散文件模式只下载 MD5 变化的文件；zip 模式下载新 zip 后解压覆盖；失败自动保留旧版本；
  - **校验**：按安装记录逐文件校验 MD5，发现损坏可重新安装修复；
  - **启动 / 打开目录 / 卸载**。

## 5. 存储后端

| provider | 写入 | 读取 | 典型场景 |
| --- | --- | --- | --- |
| `local-host` | 本机目录 | **AppHub 内置 Host Server**（默认局域网可访问） | 无需任何外部服务器，直接分享给同事/局域网 |
| `ftp-http` | FTP | nginx/静态服务 HTTP | 需求中的 FTP + nginx 组合 |
| `local` | 本地目录 | 静态服务 HTTP | 已有 nginx / 静态服务器的场景 |
| `s3` | S3 API（minio SDK） | 公开桶 HTTP / 预签名 URL | MinIO、AWS S3、兼容对象存储 |

详见 [STORAGE.md](./STORAGE.md)。新增存储后端只需实现 `StorageAdapter` 接口并在 `packages/storage/src/factory.ts` 注册。

## 6. 数据目录与设置

AppHub 的**默认数据目录**是 `<Electron userData>/AppHubData`（Windows 下通常是 `%APPDATA%\AppHub\AppHubData`），与 Electron/Chromium 的缓存、Local Storage、Preferences 等文件**完全分离**。频道记录、加密的 `channel_pri.json`、本地库与安装文件都在这里。

在 **设置 / 关于** 页可以查看来源并修改：

1. 点击「更改数据目录」→ 选择一个**空目录**（或尚不存在的目录）；
2. 确认后 AppHub 会：关闭本机 Host → 把频道记录/本地库/加密配置复制到新目录 → 写入引导配置 → 自动重启 App；
3. 旧目录不会自动删除，请确认新目录工作正常后自行清理。

> **修改 AppHub 数据目录不会改变 Electron 自身的缓存/配置路径**（不会调用 `app.setPath`），只影响 AppHub 功能数据。
> 环境变量可覆盖数据目录：
> - `APPHUB_DATA_DIR`：**只改 AppHub 数据目录**，不影响 Electron；
> - `APPHUB_USER_DATA_DIR`：整体覆盖 Electron userData（测试/多实例隔离用），此时 AppHub 数据也位于该目录、设置页只读。
> 旧版本的数据（直接位于 userData 根目录）会在首次启动时**自动迁移**到 `AppHubData` 子目录。
> 数据目录中包含加密后的存储凭据，请选择可信位置；迁移/恢复默认目录均需重启 App 生效。
> 若自定义数据目录在启动时不可用（移动盘拔出/权限变化），App 会提示「恢复默认数据目录并重启 / 退出」，不会静默退出。

## 后续阅读

- 下载安装与自动更新：[INSTALL.md](./INSTALL.md)
- 协议与数据格式：[PROTOCOL.md](./PROTOCOL.md)
- 存储后端：[STORAGE.md](./STORAGE.md)
- 安全边界：[SECURITY.md](./SECURITY.md)
