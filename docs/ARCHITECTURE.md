# AppHub 架构设计与开发契约

> 本文档是团队协作的"宪法"：模块边界、数据结构、接口契约、安全约束、测试要求。
> 协议字段定义见 [PROTOCOL.md](./PROTOCOL.md)，存储后端见 [STORAGE.md](./STORAGE.md)，测试方案见 [TESTING.md](./TESTING.md)。

## 1. 产品定位

AppHub 是一个**去中心化的 App 分享客户端**：

- 没有中心服务器。频道（Channel）的所有者把自己的存储（FTP+nginx / 本地目录+静态服务 / S3/MinIO）作为 App 仓库；
- 频道公开信息是一个 `channel.json`，任何拿到 URL 的人都能订阅公开频道；
- App 本身不经过 AppHub 服务器，AppHub 只读写频道所有者配置的存储；
- AppHub 负责本地已安装 App 的安装、校验、更新、启动与卸载。

平台：Electron + React + TypeScript，跨 Windows / Linux / macOS。

## 2. 仓库结构（monorepo）

```
AppHub/
├── packages/
│   ├── protocol/        纯 TS 协议层：zod 校验、路径/URL/semver/错误（Lead 维护）
│   ├── storage/         存储适配器：local / ftp-http / s3 + 工厂（storage-dev）
│   ├── core/            领域服务：频道、发布、安装/更新引擎（core-dev）
│   └── testkit/         测试基础设施：临时目录、静态服务器、FTP 服务器、fixtures（storage-dev + Lead）
├── apps/desktop/
│   ├── shared/          IPC 契约与 zod 入参校验（Lead 维护）
│   ├── src/main/        Electron 主进程 + IPC handlers + 本地集成（desktop-dev）
│   ├── src/preload/     contextBridge 暴露 window.apphub（desktop-dev）
│   ├── src/renderer/    React UI（ui-dev）
│   ├── scripts/         dev / build / start / package 脚本（desktop-dev）
│   └── e2e/             Playwright Electron 端到端测试（qa-dev）
├── tests/               跨包集成测试（qa-dev）
├── docs/                设计、协议、存储、测试文档
└── scripts/demo.ts      无需 GUI 的本地演示脚本（Lead）
```

依赖方向（严格单向）：

```
protocol  <-  storage  <-  core  <-  apps/desktop(main)  <-  preload/renderer
     ^                                 
     +-- shared/ipc 只依赖 protocol 的**类型**（type-only）
```

- `protocol` 不得 import Node 内置模块；
- `renderer` 不得 import `core`/`storage`/Node 模块（只允许 `protocol` 的类型 + `shared/ipc` 类型）；
- `packages/*` 通过 workspace 链接直接以 TS 源码被消费（`main/types` 指向 `src/index.ts`），无需先构建包。

## 3. 核心数据流

### 3.1 创建频道（owner）

```
UI(存储配置) -> IPC -> main -> core.channels.create
  1) 生成 channelId（ch_xxx）与私密频道 accessKey
  2) storage probe（FTP 登录 / http GET / S3 bucket）
  3) 写入 channel.json 到存储（私密频道写入 _private/<channelId>/<accessKey>/channel.json）
  4) channel_pri.json 加密保存到 <userData>/secrets/channel_pri/<channelId>.enc
  5) 本地记录 channels.json（role=owner）
```

### 3.2 订阅频道（subscriber）

```
UI(channel.json URL) -> IPC -> core.channels.subscribe
  1) HTTP GET channel.json（私密频道的 URL 自带 accessKey；可附加 headers）
  2) zod 校验 + 校验 channelId/visibility
  3) 保存订阅记录 + 缓存 channel.json
  4) 刷新 App 列表（app.meta.json 由列表/详情按需 GET）
```

### 3.3 发布 App / 新版本（owner/admin）

```
UI(选择文件/zip、版本、平台、入口、changelog) -> IPC -> main(selection registry) -> core.publishing.publish
  1) 校验输入（协议 schema + 文件路径安全 + entry 必须属于文件列表）
  2) 读取源文件：计算每个文件 size+MD5；zip 模式则生成/校验 zip 并列出内部文件
  3) 读取远端最新 app.meta.json（FTP/S3/本地目录）；不存在则新建
  4) 版本冲突检查（同版本文件不同 -> CONFLICT；overwrite=true 才覆盖；相同文件则幂等成功）
  5) 上传 payload（散文件模式：每个文件；zip 模式：zip），上传 files.json
  6) 写 app.meta.json（含全部历史版本 + 各平台 latest）
  7) 读取远端最新 channel.json，登记/更新 App 引用，写回 channel.json（最后一个写）
```

**写入顺序 = payload → files.json → app.meta.json → channel.json**，保证任何时刻读者不会看到"指向不存在文件"的元信息。

### 3.4 安装 / 更新（subscriber）

```
UI -> core.library.install/update
  1) 获取 channel.json（缓存/HTTP）-> app.meta.json -> 目标版本
  2) 拉取 files.json（或直接使用 meta 内 files）
  3) 下载到 <userData>/tmp/<opId>，校验 size+MD5
  4) 散文件模式：按 MD5 复用当前版本中未变化的文件；仅下载差异文件
     zip 模式：下载 zip 并校验 archive MD5，解压到 staging（zip-slip 防护）
  5) 校验 staging 全部文件 -> 移动到 library/<channelId>/<appId>/versions/<version>/
  6) 原子更新 install.json（current 指针）-> 清理旧版本（keepVersions，默认 2）
  7) 失败：staging 清理，current 指针不动（回滚天然成立）
```

### 3.5 本地管理

- `library.list`：读取本地索引（可从 `install.json` 重建）；
- `library.checkUpdates`：刷新频道后比较各平台 latest 与已装版本；
- `library.verify`：按 install.json 校验本地文件 size/MD5，返回差异（可用于"修复"= 重新 install force）；
- `library.launch`：主进程校验 entry 位于 appRoot 内，`spawn(entryAbs, {detached:true, cwd:versionDir})`；
- `library.uninstall`：删除该 App 根目录并更新索引。

### 3.5 本机 Host（local-host）

```
UI(存储配置 rootDir/port/bindHost) -> IPC -> core.channels.create
  1) 与 local 相同的目录写入流程（channel.json / app.meta.json / files.json 布局不变）
  2) 订阅 URL：publicBaseUrl 覆盖 > advertiseHost > 局域网 IPv4（默认 bindHost=0.0.0.0）> 127.0.0.1
  3) channel_pri.json 记录 local-host 配置；Host 生命周期由 App 管理
UI 启动 Host -> core.host.start(channelId)
  - 本机监听 port（默认 8787，绑定 0.0.0.0 即局域网可访问）
  - 只读静态服务：GET/HEAD，禁止目录列表/隐藏文件/channel_pri.json/路径穿越/符号链接
  - 返回 HostStatus（运行状态、端口、channelUrl/local/lan URL 候选）
UI 停止 Host -> core.host.stop(channelId)：closeAllConnections 后立即释放端口
```

- 每个 local-host 频道对应一个 Host Server 与独立端口；运行状态只存内存，不随 App 启动自动恢复；
- App 退出 / 取消订阅时自动停止对应 Host；
- 私密频道 URL 携带 `_private/<channelId>/<accessKey>/` 前缀，能力链接即读取授权。

## 4. 数据与凭据

### 4.1 远端存储布局（频道根目录）

```
channel.json                                  # 公开频道描述（私密频道在 _private/<channelId>/<accessKey>/ 下）
<appId>/app.meta.json                         # App 元信息 + 历史版本
<appId>/<version>/files.json                  # 该版本完整文件清单
<appId>/<version>/<任意相对路径文件>             # 散文件发布内容
<appId>/<version>/<appId>-<version>.zip       # zip 发布内容（entry 为 zip 内路径）
```

### 4.2 本地数据目录（默认 Electron `app.getPath('userData')`，可配置）

```
apphub.json                                   # 本地设置（schemaVersion, settings）
channels.json                                 # 频道本地记录 ChannelRecord[]
channels/<channelId>/channel.json             # 最近一次拉取缓存
secrets/channel_pri/<channelId>.enc           # 加密的 channel_pri.json（safeStorage）
library/index.json                            # 已安装 App 索引（可重建）
library/<channelId>/<appId>/install.json      # 当前安装状态（版本/文件清单/入口）
library/<channelId>/<appId>/versions/<version>/**  # 实际文件
tmp/                                          # 下载/解压/打包临时目录（启动时清理）
logs/                                         # 可选日志
```

- 数据目录可配置：引导文件 `<Electron userData>/apphub-bootstrap.json` 记录自定义 `dataDir`；
  启动时解析优先级 **`APPHUB_USER_DATA_DIR` 环境变量 > bootstrap 自定义目录 > Electron 默认 userData**；
- 设置页修改数据目录时：关闭 core（含所有本机 Host）→ 仅复制 AppHub 管理的数据（`channels.json`、
  `channels/`、`secrets/`、`library/`、`apphub.json`，不复制 `tmp/`、日志与 Chromium 文件）→ 写回
  bootstrap 配置 → 自动重启生效；环境变量模式下数据目录只读；
- 启动时若自定义数据目录不可用（移动盘/权限/目录被删），主进程记录错误并提供原生对话框：
  「恢复默认数据目录并重启」或「退出」，避免用户因数据目录故障而无法进入 App；
- 本地所有 JSON 使用"写临时文件 + rename"的原子写入；
- 下载/解压全部先落到 `tmp/` 或 staging 目录，校验通过后才移动到最终位置；
- `channel_pri.json` 明文只在"导出给管理员"时由主进程写盘，其余时间只有密文。

### 4.3 凭据与安全

- `channel_pri.json` 含 FTP/S3 凭据，由 Electron `safeStorage`（Windows DPAPI / macOS Keychain / Linux secret service）加密后落盘；
- 私密频道读取权限 = 能力链接（包含 accessKey 的 `channel.json` URL）；发布权限 = 持有 `channel_pri.json`（可私下分享给管理员）；
- 渲染进程：`contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`；禁止 `window.open` 与任意导航；
- IPC：每个入参重新 zod 校验；文件选择走主进程 selection registry（渲染进程只拿到 token）；
- 路径安全：所有相对路径经 `normalizeRelativePath`（拒绝绝对路径、`..`、空字节、Windows 保留名）；zip 解压执行 zip-slip / 符号链接 / 大小上限校验；
- 下载 URL 只允许 http(s)；记录/错误信息中不输出凭据；
- 完整性使用 size + MD5（与需求一致）；防篡改依赖 HTTPS 与可信频道来源，文档中明确该边界；
- 禁止在渲染进程直接 fetch 远端（所有网络访问在主进程，便于统一超时/重试/进度/凭据管理）。

## 5. 模块契约

### 5.1 `@apphub/storage`（发布端存储适配器）

见 `packages/storage/src/types.ts`：

```ts
interface StorageAdapter {
  provider: 'local' | 'ftp-http' | 's3' | 'memory';
  probe(): Promise<void>;
  readText(key): Promise<string | null>;
  readBinary(key): Promise<Buffer | null>;
  exists(key): Promise<boolean>;
  stat(key): Promise<{size, modifiedAt?} | null>;
  list(prefix): Promise<StorageEntry[]>;
  writeText(key, content): Promise<void>;
  writeBinary(key, data, opts?): Promise<void>;
  delete(key): Promise<void>;
  getDownloadUrl(key): Promise<string>;   // 公开 HTTP 地址
  close(): Promise<void>;
}
```

- key 为相对频道根目录的 POSIX 路径（含私密频道的 `_private/...` 前缀）；
- 工厂 `createStorageFactory(): StorageFactory`，同步创建、惰性连接；
- provider 实现：`local`（本地目录 + publicBaseUrl 静态服务）、`ftp-http`（basic-ftp 写/读 + nginx HTTP 下载）、`s3`（minio SDK，S3 兼容）；
- 扩展新 provider：实现接口 + 在 `factory.ts` 注册 + `docs/STORAGE.md` 补充配置说明 + 集成测试。

### 5.2 `@apphub/core`（领域服务）

公共 API 见 `packages/core/src/types.ts`：`createAppHubCore(context): AppHubCore`，含 `channels` / `publishing` / `library` / `host` 四个服务。

- `host: HostService`：管理本机 Host（`start/stop/status/list/updateConfig/stopAll`）；HostServer 静态服务实现于 `packages/core/src/host.ts`，URL 推导复用 `@apphub/storage` 的 `resolveLocalHostBaseUrls`；
- 所有方法失败抛 `AppError`；不向调用方暴露存储适配器实例；
- 进度通过 `ProgressListener` 回调（IPC 层转换为事件推送）；
- core 不依赖 Electron：`SecretBox`、`dataDir`、`fetchImpl`、`Clock` 全部注入，保证可在纯 Node 测试。

### 5.3 Electron 主进程（apps/desktop/src/main）

职责：窗口管理、生命周期、安全策略、IPC handler、文件对话框（selection registry）、凭据加密（safeStorage）、启动已安装 App、打开目录、日志。

关键模块（desktop-dev 实现）：

```
src/main/index.ts            app 生命周期、单实例、安全策略、加载窗口
src/main/window.ts           BrowserWindow 创建（sandbox/contextIsolation/CSP/导航拦截）
src/main/core-manager.ts     createAppHubCore 注入 dataDir/secretBox/storageFactory/fetch
src/main/data-dir.ts         数据目录引导配置（bootstrap）、来源解析、目标校验与迁移
src/main/secret-box.ts       Electron safeStorage 实现 core.SecretBox
src/main/selection-registry.ts  文件/文件夹/zip 选择 + token 映射 + zip 检查
src/main/ipc.ts              IPC handlers：zod 校验 + ApiResult 包装 + 事件推送（含 host start/stop/status/list/updateConfig、system.pickDirectory）
src/main/app-launcher.ts     校验 entry 后 spawn + reveal
src/main/logger.ts           文件日志（主进程）
src/preload/index.ts         contextBridge 暴露 AppHubApi
```

约定：

- IPC handler 统一用 `wrap(handler)` 捕获错误转 `{ok:false,error}`；
- 每次操作 push `progress` 事件（带 operationId）与 `data-changed` 事件（host 启停使用 `domain:'host'`）；
- Host 服务运行在主进程内，随 App 退出自动停止（core.close → host.stopAll）；
- 环境变量：`APPHUB_USER_DATA_DIR`（测试/多实例；此时设置页数据目录只读）、`APPHUB_DEV_SERVER_URL`（开发模式）；
- 数据目录修改：设置页调用 `system.changeDataDir` → 主进程关闭 core/Host → 迁移 AppHub 管理数据 → 写 bootstrap → 重启 App；
- 构建产物：`out/main/index.cjs`、`out/preload/index.cjs`、`out/renderer/`（Vite 构建）。

### 5.4 渲染进程（React UI）

页面/视图（ui-dev 实现）：

1. **频道页**：列表（已订阅/我拥有的）、创建频道向导（基础信息 + 可见性 + 存储配置）、订阅对话框（URL + 可选 headers）；
2. **频道详情**：频道信息、订阅链接复制、App 卡片列表、刷新、发布 App 入口、管理员导入/导出 channel_pri.json；local-host 频道额外显示 **Host 面板**（启动/停止/编辑配置/复制本机与局域网 URL）；
3. **App 详情**：简介、各平台最新版本、版本历史（changelog）、安装/更新/已安装状态、发布新版本；
4. **发布向导**：选择发布方式（散文件/zip）、选文件/文件夹/zip、版本号、平台、入口、changelog、进度/错误展示；
5. **本地库**：已安装 App 列表、更新检测、安装/更新/校验/启动/打开目录/卸载；
6. **设置/关于**：数据目录（来源/默认目录/打开/复制/迁移重启）、版本信息、日志位置。

要求：TypeScript 严格模式；不直接使用 Node/Electron API，只通过 `window.apphub`；错误以 toast/inline 形式呈现；关键交互有 loading/disabled 状态；所有主要视图有 React Testing Library 测试。

## 6. IPC 契约

见 `apps/desktop/shared/ipc.ts`（类型）与 `apps/desktop/shared/ipc-schemas.ts`（主进程入参校验）。原则：

- 每个方法返回 `ApiResult<T>`；
- `AppHubApi` 是 `window.apphub` 的类型；
- 渲染进程只能传 selectionId（发布文件路径不进入渲染进程）；**唯一例外**：local-host 的频道仓库目录通过 `system.pickDirectory` 让用户选择后返回路径字符串（用户显式选择，不用于其他文件读写）；
- 新增 `host` 命名空间（start/stop/status/list/updateConfig）；host 变更广播 `data-changed {domain:'host'}`；
- 新增 `system.changeDataDir`（路径由目录选择器产生，主进程校验/迁移/重启）；环境变量模式下返回 `UNSUPPORTED`；
- 主进程必须校验 sender frame（只接受自家窗口）。

## 7. 并发与一致性

- 同一进程内对同一频道/App 的发布串行化（core 内部 keyed mutex）；
- Host 的 start/stop/updateConfig 按 `host:<channelId>` 串行；运行中禁止 updateConfig（先停止），避免端口/URL 状态错乱；
- 远端更新采用"读取-合并-写回"：发布前重新读取 app.meta.json / channel.json；
- FTP 无 CAS：最后写入者胜出。文档建议同一频道发布操作集中在一台机器，或使用 S3（支持条件写扩展）；
- 幂等重试：若同版本同平台已存在且文件清单（path+size+md5）完全一致，视为成功并确保 channel.json 登记；
- 本地安装：staging + 校验 + rename/指针切换，任何失败不影响当前可用版本。

## 8. 测试要求（详见 TESTING.md）

- **单元**：protocol（已由 Lead 覆盖）、storage 每个适配器、core 的发布/安装引擎、IPC 校验、React 组件；
- **集成**：内存存储、本地目录+静态服务器、**FTP 服务器 + 静态服务器（模拟 ftp+nginx）**、S3 mock、**local-host 内置 Host（真实 HTTP 启停/订阅/安装）**；完整链路：创建→发布（散文件/zip）→订阅→安装→更新→校验→卸载；私密频道鉴权；冲突/失败注入/回滚；
- **E2E**：Playwright 启动 Electron，订阅+安装+启动失败提示、local-host 创建/启停/URL 可访问等关键链路；
- 所有测试必须 `pnpm test` 一条命令可跑，不依赖外网/真实 FTP 服务；
- 禁止跳过测试（skip）来"变绿"；不允许只测 happy path。

## 9. 交付验收清单

- [x] `pnpm install && pnpm typecheck && pnpm test` 全部通过（493 个 Vitest 用例，0 skipped）；
- [x] `pnpm build` 产出 `out/`，`pnpm dev` 可启动应用；`pnpm package` 产出 `apps/desktop/release/win-unpacked/AppHub.exe`；
- [x] 演示脚本 `pnpm demo` 在 FTP+nginx 模拟环境与本机 Host 环境下完成创建/发布/订阅/安装/更新/启停验证；
- [x] README 的 Quickstart 与截图一致；
- [x] 需求中的每一条功能都能在 UI 或 API 中找到对应实现（覆盖矩阵见 TESTING.md §5；Phase 5 本机 Host R48–R59、Phase 6 默认 local-host/端口避让/数据目录 R60–R64）；
- [x] docs/PROTOCOL.md、STORAGE.md、TESTING.md 完整；
- [x] `pnpm verify:e2e` 一键验收 14/14 步通过（含真实 Electron E2E 15/15，覆盖本机 Host 启停与 URL 可达、端口避让、数据目录来源展示）。

