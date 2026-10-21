# AppHub

> 去中心化的 App 分享、订阅与本地管理工具。
>
> 没有中心服务器：频道所有者用自己的存储（FTP + nginx / 本地目录 + 静态服务 / S3 / MinIO）托管 App；
> 任何人拿到 `channel.json` 链接即可订阅公开频道，或凭私密能力链接订阅私密频道。

AppHub 是一个基于 **Electron + React + TypeScript** 的跨平台桌面应用（Windows / Linux / macOS）。

---

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
| 频道配置 App 存储 | 创建频道时配置 `local` / `ftp-http` / `s3`（可扩展） |
| FTP + nginx 存储发布 | FTP 上传 + nginx 下载；也支持本地目录/MinIO |
| 完整的测试方案 | 单元 + 集成（进程内 FTP/HTTP/S3 模拟）+ Electron E2E + 手工矩阵，见 [docs/TESTING.md](./docs/TESTING.md) |

## 界面预览

| 频道列表 | 频道详情 |
| --- | --- |
| ![频道列表](docs/screenshots/01-channels.png) | ![频道详情](docs/screenshots/02-channel-detail.png) |

| 发布向导 | 本地库 |
| --- | --- |
| ![发布向导](docs/screenshots/04-publish-wizard.png) | ![本地库](docs/screenshots/05-library.png) |

> 截图来自真实 Electron 构建产物（960px 窗口，演示数据）。

## 架构

```
┌──────────────────────────── Electron App ────────────────────────────┐
│  Renderer (React UI)  ⇄  preload (contextBridge)  ⇄  Main Process    │
│                                                      │               │
│                        ┌─────────────────────────────┴───────────┐   │
│                        │ @apphub/core                             │   │
│                        │  channels | publishing | library         │   │
│                        └───────┬──────────────────────┬───────────┘   │
│                                │                      │               │
│                     @apphub/storage             本地数据目录            │
│                     local/ftp-http/s3          (安装记录/缓存/密文)      │
└────────────────────────────────┼──────────────────────────────────────┘
                                 │ FTP / S3 / 本地目录写
                                 ▼
              ┌────────── 频道所有者的存储（去中心化）──────────┐
              │  app_repo/                                     │
              │    channel.json                                │
              │    <appId>/app.meta.json                       │
              │    <appId>/<version>/files.json                │
              │    <appId>/<version>/...文件或 zip             │
              └────────────────────────────────────────────────┘
                                 │ nginx / 静态服务 HTTP GET
                                 ▼
                        所有订阅者（下载/更新）
```

详细设计：**[docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)** · 数据格式：**[docs/PROTOCOL.md](./docs/PROTOCOL.md)** · 存储后端：**[docs/STORAGE.md](./docs/STORAGE.md)** · 测试：**[docs/TESTING.md](./docs/TESTING.md)**

## 快速开始

环境要求：Node.js ≥ 20.19、pnpm ≥ 10（仓库用 pnpm 11 开发）、Windows/Linux/macOS。

```bash
pnpm install        # 安装依赖（会下载 Electron）
pnpm dev            # 开发模式：Vite HMR + Electron
pnpm build          # 构建 out/main、out/preload、out/renderer
pnpm start          # 构建并以生产模式启动
pnpm package        # 用 electron-builder 打包（--dir 产物在 apps/desktop/release）
pnpm test           # 全部单元/集成测试（离线，进程内模拟 FTP/nginx/S3）
pnpm typecheck      # 所有包 TypeScript 严格检查
pnpm verify         # 一键验收：全部 test + typecheck + desktop build
pnpm verify:e2e     # 一键验收（含真实 Electron Playwright E2E，14 步）
pnpm demo           # 无需 GUI 的全链路演示：创建频道→发布→订阅→安装→更新
```

> 开发/测试环境使用 `APPHUB_USER_DATA_DIR` 可以指定独立数据目录，便于多实例与 E2E 测试。

## 验收结果（本机实测，2026-10-21）

| 项目 | 结果 |
| --- | --- |
| `pnpm verify:e2e`（6 包 test + 6 包 typecheck + build + E2E） | **14/14 步通过，PASS，49.5s** |
| Vitest 单元/集成测试 | **350 个用例，0 skipped**（protocol 24 / storage 39 / core 90 / 集成 30 / desktop 167） |
| Electron E2E（Playwright + 真实 Electron） | **6/6 通过**（启动、订阅→安装→校验→卸载、错误处理、创建/发布向导） |
| `@apphub/core` 覆盖率（v8） | statements 86.1% / branches 76.6% / functions 91.1% |
| `pnpm demo`（真实进程内 FTP + 静态 HTTP，模拟 ftp+nginx） | 创建频道 → files 发布 1.0.0/1.0.1/1.0.2 → 订阅 → 安装 → 差量更新 → zip App 安装 → 卸载 全部通过 |
| `pnpm package`（electron-builder --dir） | `apps/desktop/release/win-unpacked/AppHub.exe` 生成成功 |
| 环境 | Windows / Node 22.23 / pnpm 11.22 / Electron 38.8 / 完全离线 |

> 测试分层、需求覆盖矩阵（R1–R47）、手工验收清单（M1–M20，需要真实 ftp+nginx/MinIO/三平台实机）与 CI 配置见 [docs/TESTING.md](./docs/TESTING.md)。

## 使用指南

### 1. 创建频道（以 FTP + nginx 为例）

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

### 2. 发布 App

在频道详情页点击 **发布 App**（首次）或 App 详情页 **发布新版本**：

1. 填写 App 名称（`foobar`）、简介、作者；
2. 选择发布方式：
   - **散文件**：选择文件或整个文件夹，自动保留目录结构；每个文件计算 size/MD5；
   - **zip**：选择已有 zip 包，或选择文件夹由 AppHub 打包；
3. 填写版本号（semver，如 `1.0.0`）、平台（Windows/Linux/macOS）、启动入口（如 `foobar.exe`）、更新说明；
4. 发布。AppHub 会将文件上传到频道的存储：
   ```
   app_repo/foobar/app.meta.json
   app_repo/foobar/1.0.0/files.json
   app_repo/foobar/1.0.0/foobar.exe
   app_repo/foobar/1.0.0/resources/...
   ```
   并更新 `app.meta.json`（历史版本、各平台 latest、每个文件的 size/MD5）和 `channel.json`（登记 App）。
   订阅者刷新频道后即可看到并安装。

### 3. 订阅频道

点击 **订阅频道**，粘贴 `channel.json` 的 HTTP 地址（公开频道形如 `http://domain/app_repo/channel.json`；私密频道形如 `http://domain/app_repo/_private/<channelId>/<accessKey>/channel.json`）。
若 nginx 启用了 HTTP Basic Auth，可在订阅对话框的「高级」中填写请求头。

### 4. 安装与更新

- 订阅者在频道页点击 App → **安装**：AppHub 会下载 `app.meta.json`/`files.json`，按文件 size/MD5 校验下载内容，安装到本地库；
- 已安装的 App 在 **本地库** 中统一管理：
  - **检查更新**：比较各平台 latest 与本地版本；
  - **更新**：散文件模式只下载 MD5 变化的文件；zip 模式下载新 zip 后解压覆盖；失败自动保留旧版本；
  - **校验**：按安装记录逐文件校验 MD5，发现损坏可重新安装修复；
  - **启动 / 打开目录 / 卸载**。

### 5. 存储后端

| provider | 写入 | 读取 | 典型场景 |
| --- | --- | --- | --- |
| `ftp-http` | FTP | nginx/静态服务 HTTP | 需求中的 FTP + nginx 组合 |
| `local` | 本地目录 | 静态服务 HTTP | 局域网共享目录、本机 nginx |
| `s3` | S3 API（minio SDK） | 公开桶 HTTP / 预签名 URL | MinIO、AWS S3、兼容对象存储 |

详见 [docs/STORAGE.md](./docs/STORAGE.md)。新增存储后端只需实现 `StorageAdapter` 接口并在 `packages/storage/src/factory.ts` 注册。

## 开发与测试

```bash
pnpm test                     # 所有包的测试
pnpm --filter @apphub/core test          # 单包测试
pnpm --filter @apphub/storage coverage   # 覆盖率
pnpm test:e2e                 # Electron E2E（需先 build）
```

测试完全离线：集成测试在进程内启动 FTP 服务器（ftp-srv）、静态 HTTP 服务器、S3 服务器（s3rver），真实地走存储协议，不依赖外网或真实服务器。测试策略与手工验收清单见 [docs/TESTING.md](./docs/TESTING.md)。

## 项目结构

```
AppHub/
├── packages/
│   ├── protocol/   协议层：channel.json / app.meta.json / files.json schema、路径/URL/semver、错误
│   ├── storage/    存储适配器：local / ftp-http / s3 + 工厂
│   ├── core/       领域服务：频道、发布（散文件/zip）、订阅、安装/更新/校验/本地库
│   └── testkit/    测试基础设施：临时目录、静态服务器、FTP/S3 模拟服务器、fixtures
├── apps/desktop/
│   ├── shared/     IPC 契约 + zod 入参校验
│   ├── src/main/   Electron 主进程（IPC、文件选择、安全、启动本地 App、加密凭据）
│   ├── src/preload/ contextBridge API
│   ├── src/renderer/ React UI
│   └── e2e/        Playwright Electron E2E
├── tests/          跨包集成测试
├── docs/           架构/协议/存储/测试文档
└── scripts/        demo 与验收脚本
```

## 安全说明

- 渲染进程开启 `contextIsolation` + `sandbox`，无 Node 集成；所有本地文件路径由主进程文件选择器产生并通过 token 引用；
- 远端凭据（`channel_pri.json`）使用操作系统安全存储加密后落盘；日志与错误信息不输出密码；
- 下载仅允许 http(s)，zip 解压做 zip-slip / 符号链接 / 大小上限防护；安装采用 staging + 校验 + 原子切换；
- 发布/更新完整性按需求使用 **size + MD5** 校验；MD5 用于检测传输损坏/错版本，不提供防篡改能力，生产环境请使用 HTTPS 并只订阅可信频道；
- 私密频道的安全性基于能力链接（可选的 nginx Basic Auth 可进一步加强）；发布权限基于 `channel_pri.json` 的持有。

## 路线图

- channel.json / app.meta.json 数字签名（ed25519）与可信来源校验
- 断点续传与差分更新（bsdiff）
- 频道发现目录（可选中心索引，但 App 存储仍去中心化）
- 更多存储后端（WebDAV / 阿里云 OSS / 腾讯云 COS）
- 自动更新策略（后台检查、静默更新）与代理设置

## License

MIT
