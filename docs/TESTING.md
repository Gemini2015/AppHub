# AppHub 测试方案（TESTING）

> 本文档是 AppHub 的测试"作战手册"：分层策略、需求覆盖矩阵、运行命令、CI 配置、
> 手工验收清单、实际执行结果、已知限制与故障排查。
> 相关文档：[ARCHITECTURE.md](./ARCHITECTURE.md)（架构与 §8 测试要求）、
> [PROTOCOL.md](./PROTOCOL.md)（协议与发布/更新规则）、[STORAGE.md](./STORAGE.md)（存储后端）。
>
> 维护者：qa-dev。最后实测：2026-10-21（结果见 §12）。

---

## 1. 快速开始

```bash
# 一次性安装（首次克隆）
pnpm install

# 一键验收：全部包 test + typecheck + desktop build（不含 E2E）
pnpm verify

# 完整验收：加上真实 Electron E2E（会先 build）
pnpm verify:e2e

# 只跑跨包集成测试
pnpm --filter @apphub/tests test

# 只跑 Electron E2E（需先 build）
pnpm build && pnpm test:e2e
```

所有自动化测试**完全离线**：FTP / HTTP(nginx) / S3(MinIO) 都由 `@apphub/testkit` 在
测试进程内启动模拟，不访问外网、不依赖本机已安装的 vsftpd/nginx/MinIO。

---

## 2. 测试分层

| 层 | 名称 | 范围 | 位置 | 运行方式 | 当前状态 |
| --- | --- | --- | --- | --- | --- |
| L0 | 协议单元 | zod schema、路径/URL/semver/错误码/序列化 | `packages/protocol/src/*.test.ts` | `pnpm --filter @apphub/protocol test` | ✅ 24 tests |
| L1 | 包单元 | storage 三个适配器 + 工厂；core 频道/发布/安装引擎；desktop 主进程 IPC/安全；renderer React 组件 | `packages/*/src/**/*.test.ts(x)`、`apps/desktop/src/**/*.test.ts(x)` | `pnpm -r test` / 各包 `pnpm --filter <pkg> test` | ✅ storage 39、core 90、desktop 167 |
| L2 | 跨包集成 | `core + storage + testkit` 组合，真实存储适配器 + 进程内 FTP/S3/静态服务器；内存存储 + 内存 fetch 快速链路 | `tests/integration/**` | `pnpm --filter @apphub/tests test` | ✅ 30 tests / 9 files |
| L3 | Electron E2E | 真实启动打包后的 Electron 应用，走完整 UI 链路 | `apps/desktop/e2e/**` | `pnpm build && pnpm test:e2e` | ✅ 6 tests / 4 specs |
| L4 | 手工验收 | 真实 vsftpd/FileZilla + nginx、MinIO、三平台 GUI、真实启动外部 App、原生文件对话框 | 本文 §11 清单 | 人工 | ⏳ 发布前逐项执行 |

分层原则：

- **越靠下越便宜**：协议/单元测试覆盖边界与错误码；集成测试覆盖真实 IO 语义；
  E2E 只覆盖"用户可见的关键链路"，不重复单测细节（避免慢且脆）。
- **不 mock 被测对象**：集成测试用真实 `createStorageFactory()` 与真实 HTTP；
  E2E 用真实 core/storage 与真实 Electron 进程；只对进程外不可控资源（FTP/S3/静态托管）用进程内模拟。
- **失败必须可定位**：错误断言精确到 `AppError.code`（见 §7.4），E2E 失败自动落
  trace/screenshot/主进程日志（见 §8.5）。

---

## 3. 目录与文件地图

```
packages/protocol/src/            L0 协议单测（schema/路径/版本/错误）
packages/storage/src/             L1 storage 适配器单测 + adapters/
packages/core/src/                L1 core 单测（channels/publish/library/zip/http/state…）
packages/testkit/src/             测试基础设施：temp/static-server/ftp-server/s3-server/fixtures/fakes
apps/desktop/src/main/**/*.test.ts     L1 主进程（IPC 校验、selection registry、launcher 安全、secret-box）
apps/desktop/src/renderer/**/*.test.tsx L1 渲染进程（RTL + mock api）
apps/desktop/e2e/
├── playwright.config.ts          Playwright 配置（testDir=e2e，workers=1，Electron 无需浏览器）
├── global-setup.ts               构造协议合规的频道仓库 + 启动静态服务器 + 写 fixture 清单
├── global-teardown.ts            关闭静态服务器/清理
├── support/
│   ├── paths.ts                  运行时目录（e2e/.tmp/**）
│   ├── fixture-repo.ts           手工构造 channel.json / app.meta.json / files.json / 版本文件
│   ├── static-server.ts          进程内静态服务器（模拟 nginx）
│   ├── fixture.ts                测试读取 fixture 清单
│   ├── electron-app.ts           _electron.launch 封装（userData 隔离、ELECTRON_RUN_AS_NODE 清理、日志）
│   ├── app-state.ts              磁盘断言（本地库目录、MD5 校验、等待）
│   ├── ui.ts                     data-testid 契约 + 通用等待
│   └── test-fixtures.ts          每用例独立 Electron 实例的 Playwright fixture
├── smoke.spec.ts                 启动冒烟（标题/外壳/导航/preload/system.info）
├── subscribe-install-uninstall.spec.ts  订阅→安装→检查更新→校验→卸载 + 错误路径
├── create-channel.spec.ts        创建频道向导校验与 provider 切换
└── publish-wizard.spec.ts        发布向导打开与版本号校验
tests/integration/
├── support/                      内存 harness（harness.ts）、真实 provider 环境（real-env.ts）、断言工具
├── channel-lifecycle.test.ts     公开/私密频道、订阅者、import/export channel_pri
├── publish-files.test.ts         散文件发布：写入顺序/幂等/冲突/overwrite/补发旧版本/updateMeta
├── publish-zip.test.ts           zip 发布：zipPath/zipFromDir/zip-slip/zip 安装
├── install-update.test.ts        安装/校验/篡改检测/修复/MD5 复用更新/启动描述/卸载/损坏回滚
├── error-security.test.ts        坏数据/越权/凭据不泄露/离线约束
├── real-ftp-http.test.ts         A/B：真实 FTP+静态 HTTP 全链路（散文件/zip/损坏 archive）
├── real-local.test.ts            F：local provider + 静态服务器
├── real-s3.test.ts               E：S3（s3rver/MinIO 兼容）全链路
└── multi-app.test.ts             D：多 App/多频道隔离/channel.json 合并且不丢 App
```

---

## 4. 运行命令速查

### 4.1 一键验收（推荐）

```bash
pnpm verify                    # 13 步：6 个包 test + 6 个包 typecheck + desktop build
pnpm verify:e2e                # 14 步：额外执行 Electron E2E（自动包含 build）
node scripts/verify.mjs --list # 只列出将执行的步骤
node scripts/verify.mjs --only=test,typecheck   # 按类别过滤
node scripts/verify.mjs --bail # 首个失败即停（CI=1 时默认开启）
node scripts/verify.mjs --no-build              # 跳过 desktop build
```

退出码：`0` 全部通过；`1` 存在失败步骤；`2` 参数错误。汇总表包含每步状态与耗时。

### 4.2 按层运行

```bash
# L0/L1
pnpm test                                  # pnpm -r --no-bail run test（全部包）
pnpm --filter @apphub/core test            # 单包
pnpm --filter @apphub/protocol test
pnpm --filter @apphub/storage test
pnpm --filter @apphub/tests test           # L2 集成
pnpm --filter @apphub/desktop test         # L1 主进程 + renderer

# 类型检查（全部包）
pnpm typecheck

# L3 E2E（必须先 build）
pnpm build
pnpm test:e2e
# 等价直接调用：
npx playwright test -c apps/desktop/e2e/playwright.config.ts

# E2E 只跑某个 spec / 重复跑以检查稳定性
npx playwright test -c apps/desktop/e2e/playwright.config.ts --grep "订阅"
npx playwright test -c apps/desktop/e2e/playwright.config.ts --repeat-each=3

# 覆盖率（可选）
pnpm --filter @apphub/core coverage
```

### 4.3 环境变量

| 变量 | 作用 | 默认 |
| --- | --- | --- |
| `APPHUB_USER_DATA_DIR` | Electron E2E 的独立 userData 目录（每个用例自动生成） | `apps/desktop/e2e/.tmp/user-data/run-*` |
| `APPHUB_E2E_DEBUG=1` | 实时打印 Electron 主进程 stdout/stderr | 关闭 |
| `APPHUB_E2E_KEEP_USER_DATA=1` | 用例结束后保留 userData 目录便于排查 | 清理 |
| `APPHUB_E2E_KEEP_TMP=0` | E2E 结束后删除整个 `e2e/.tmp` | 保留（下次 setup 清空） |
| `APPHUB_E2E_ELECTRON_ARGS` | 追加 Electron 启动参数，如 Linux CI 的 `--no-sandbox` | 空 |
| `APPHUB_VERIFY_NO_COLOR=1` / `NO_COLOR` | 关闭 verify.mjs 彩色输出 | 自动检测 TTY |

### 4.4 Linux CI（无显示器）

```bash
# 安装 Electron 运行所需系统库（Ubuntu）
sudo apt-get update && sudo apt-get install -y xvfb libnss3 libatk-bridge2.0-0 libgtk-3-0 libgbm1 libasound2
# 无头运行 E2E
xvfb-run -a pnpm verify:e2e
# root 用户/无 user namespace 时追加：
APPHUB_E2E_ELECTRON_ARGS="--no-sandbox" xvfb-run -a pnpm verify:e2e
```

Playwright **不需要**执行 `playwright install`：E2E 使用 Electron 自带 Chromium。

---

## 5. 需求覆盖矩阵（需求 → 测试用例）

> 状态均为 2026-10-21 实测通过。"依据"列指向协议/架构文档章节。

### 5.1 频道与权限

| # | 需求 | 依据 | 自动化覆盖 | 状态 |
| --- | --- | --- | --- | --- |
| R1 | 创建公开频道：生成 `ch_` ID、写远端 `channel.json`、本地 owner 记录 | ARCH §3.1 / PROTOCOL §3 | `channel-lifecycle > 创建公开频道…`、`publish-files > 发布 v1.0.0` | ✅ |
| R2 | 创建私密频道：随机 accessKey、对象写入 `_private/<id>/<key>/` | ARCH §3.1 / PROTOCOL §2 | `channel-lifecycle > 私密频道…` | ✅ |
| R3 | 公开频道可被任意人按 URL 订阅；本地缓存 channel.json | ARCH §3.2 | 上述 + E2E `subscribe-install-uninstall` | ✅ |
| R4 | 私密频道仅能力链接可订阅；缺 accessKey 的 URL 失败 | PROTOCOL §2/§9 | `channel-lifecycle > 私密频道…` | ✅ |
| R5 | 发布权限：owner/admin 可发布，subscriber 不可发布 | ARCH §4.3 / PROTOCOL §4 | `channel-lifecycle > 创建公开频道…`（订阅者 publish 拒绝）、`error-security > 发布与安装的越权…` | ✅ |
| R6 | `channel_pri.json` 导入=授权发布；导出仅 owner/admin | PROTOCOL §4 | `channel-lifecycle > 导入 channel_pri.json 后成为管理员并可发布` | ✅ |
| R7 | 凭据安全：明文不落盘、不进日志/错误/返回值 | ARCH §4.3 | `error-security > 凭据安全…` | ✅ |
| R8 | 取消订阅只删本地记录，远端不动；刷新更新 lastFetchedAt | ARCH §3.5 | `channel-lifecycle > 创建公开频道…` | ✅ |

### 5.2 发布（散文件 / zip）

| # | 需求 | 依据 | 自动化覆盖 | 状态 |
| --- | --- | --- | --- | --- |
| R9 | 散文件发布：size+MD5、嵌套目录、Unicode 文件名 | PROTOCOL §7.1 | `publish-files`、`real-ftp-http A`（Unicode+大文件） | ✅ |
| R10 | 写入顺序 payload → files.json → app.meta.json → channel.json | ARCH §3.3 | `publish-files > 写入顺序正确…` | ✅ |
| R11 | 版本历史合并、`latest` 按 semver 取最大、支持补发旧版本 | PROTOCOL §5/§7.3 | `publish-files > 发布 v1.1.0…` | ✅ |
| R12 | 同版本同内容幂等成功；不同内容 CONFLICT；`overwrite` 覆盖 | PROTOCOL §7.3 | `publish-files > 幂等重试与冲突…`、`multi-app > 冲突/幂等…` | ✅ |
| R13 | `publishMode` 创建后不可切换（files↔zip 报 CONFLICT） | PROTOCOL §5 | `publish-files > 幂等重试与冲突…` | ✅ |
| R14 | `entry` 必须属于文件列表；targetPath 必须安全相对路径 | PROTOCOL §5/§6 | `publish-files > 发布输入校验…` | ✅ |
| R15 | zip 发布（zipPath）：archive size/MD5、files=包内清单 | PROTOCOL §7.2 | `publish-zip > 发布 zip…`、`real-ftp-http B` | ✅ |
| R16 | zip 发布（zipFromDir）：目录自动打包 | PROTOCOL §7.2 | `publish-zip > zipFromDir…` | ✅ |
| R17 | zip-slip / 异常路径拒绝，且不产生坏元信息 | ARCH §4.3 | `publish-zip > 拒绝 zip-slip…` | ✅ |
| R18 | `channel.json` 合并写回：多 App 不互相覆盖 | ARCH §7 | `multi-app > 交替发布/并发发布…` | ✅ |
| R19 | `updateMeta` 同步写 app.meta.json + channel.json | ARCH §3.5 | `publish-files > updateMeta…` | ✅ |

### 5.3 本地库（安装/更新/校验/卸载）

| # | 需求 | 依据 | 自动化覆盖 | 状态 |
| --- | --- | --- | --- | --- |
| R20 | 安装：下载→校验→staging→移动到 `library/<channel>/<app>/versions/<v>` | ARCH §3.4/§4.2 | `install-update > 安装 v1…`、E2E 全链路 | ✅ |
| R21 | 更新：files 模式按 MD5 复用未变化文件（reusedBytes/downloadedBytes 可观测） | PROTOCOL §8 | `install-update`、`real-ftp-http A`、`real-s3` | ✅ |
| R22 | zip 安装：解压 + 逐文件 size/MD5 校验 | PROTOCOL §8 | `publish-zip > 订阅者安装 zip…`、`real-ftp-http B` | ✅ |
| R23 | 校验：返回 mismatch（md5/size/missing/extra）；可 force 修复 | ARCH §3.5 | `install-update > …篡改检测→修复` | ✅ |
| R24 | 更新检查：checkUpdates 基于最新 channel/meta，默认容忍网络失败 | ARCH §3.5 | `install-update`、`real-ftp-http A`、E2E 本地库「检查更新」 | ✅ |
| R25 | 卸载：删 App 根目录 + 更新索引；不影响其他频道/App | ARCH §3.5 | `install-update`、`multi-app > 多频道隔离`、E2E | ✅ |
| R26 | 启动描述：entry 位于版本目录内且存在（路径逃逸拒绝） | ARCH §3.5 | `install-update > 启动描述`（core 单测覆盖逃逸细节） | ✅ |
| R27 | 安装失败回滚：不留半成品、旧版本仍可用 | ARCH §3.4/§7 | `install-update > 损坏 payload 回滚`、`real-ftp-http B 损坏 archive` | ✅ |
| R28 | keepVersions 默认 2，更新后旧版本保留 | ARCH §3.4 | `install-update` | ✅ |

### 5.4 存储后端

| # | 需求 | 依据 | 自动化覆盖 | 状态 |
| --- | --- | --- | --- | --- |
| R29 | `local`：目录写 + 公开 HTTP 读 | STORAGE §local | `real-local`（2 用例）、storage 单测 12 | ✅ |
| R30 | `ftp-http`：FTP 写（自动建目录/Unicode）+ HTTP 读 | STORAGE §ftp-http | `real-ftp-http A/B`、storage 单测 | ✅ |
| R31 | `s3`：MinIO 兼容写 + 公开桶/预签名读 | STORAGE §s3 | `real-s3`、storage 单测 | ✅ |
| R32 | 存储探测失败给出可读错误（错误凭据/桶不存在/目录不可写） | ARCH §5.1 | `real-ftp-http > 错误凭据`、storage 单测 | ✅ |
| R33 | 非法 key / 路径逃逸被拒绝 | ARCH §4.3 | storage 单测（local/ftp/s3 各自覆盖） | ✅ |

### 5.5 错误处理与安全

| # | 需求 | 依据 | 自动化覆盖 | 状态 |
| --- | --- | --- | --- | --- |
| R34 | 坏 JSON / 缺字段 / 重复 App / 非法 metaUrl 被拒绝（VALIDATION） | PROTOCOL §1 | `error-security > 坏 JSON…` | ✅ |
| R35 | 订阅不可达/错误协议 URL 报可读错误；测试不外联 | ARCH §4.3 | `error-security > 不可达/非 http(s)`、E2E 错误路径 | ✅ |
| R36 | 路径穿越（metaUrl/targetPath/entry/存储 key）拒绝 | ARCH §4.3 | `publish-files`、`error-security`、storage 单测 | ✅ |
| R37 | 下载完整性：size+MD5 不符必须失败（不静默接受坏文件） | PROTOCOL §9 | `install-update > 损坏 payload`、`real-ftp-http B` | ✅ |
| R38 | 错误对象可序列化（code/message/details），IPC 层 ApiResult 包装 | ARCH §6 | desktop 单测（api-result）、renderer toast 测试 | ✅ |

### 5.6 桌面端 / E2E

| # | 需求 | 自动化覆盖（apps/desktop/e2e） | 状态 |
| --- | --- | --- | --- |
| R39 | 应用可启动、窗口标题 AppHub、外壳/导航渲染 | `smoke.spec.ts`（2 用例） | ✅ |
| R40 | preload 注入 `window.apphub`，system.info 可用 | `smoke.spec.ts` | ✅ |
| R41 | 订阅频道 → 频道详情出现 App 卡片 | `subscribe-install-uninstall.spec.ts` | ✅ |
| R42 | 安装 App → 本地库出现且磁盘文件 MD5 正确 | 同上（含磁盘断言） | ✅ |
| R43 | 本地库检查更新（已是最新提示） | 同上 | ✅ |
| R44 | 校验通过 → 卸载清理磁盘 | 同上 | ✅ |
| R45 | 订阅失败显示可读错误而非白屏 | 同上（端口 1 连接拒绝） | ✅ |
| R46 | 创建频道表单：必填拦截 + provider 切换 | `create-channel.spec.ts` | ✅ |
| R47 | 发布向导：入口可见、版本号校验拦截与恢复 | `publish-wizard.spec.ts` | ✅ |

---

## 6. 单元测试明细（L0/L1）

| 包 | 测试文件数 | 用例数 | 重点内容 |
| --- | --- | --- | --- |
| `@apphub/protocol` | 2 | 24 | schema 严格校验、跨字段 refine、路径/URL/semver、错误语义 |
| `@apphub/storage` | 4+ | 39 | local/ftp-http/s3 CRUD/list/stat/probe、Unicode、二进制、非法 key、工厂 |
| `@apphub/core` | 5 | 90 | 频道生命周期、发布 files/zip（含写入顺序、冲突、幂等）、安装/更新/回滚、HTTP/state/zip 工具 |
| `@apphub/testkit` | 0 | 0 | 纯测试基础设施（`--passWithNoTests`，由集成测试间接覆盖） |
| `@apphub/desktop` | 19 | 167 | 主进程 IPC/校验/selection/launcher/secret-box + renderer RTL（8 个视图/组件） |
| `@apphub/tests`（L2） | 9 | 30 | 见 §7 |

---

## 7. 集成测试设计（L2）

### 7.1 两种 harness

**A. 内存 harness（`tests/integration/support/harness.ts`）** —— 快速、可注入：

- `createMemoryStorageBacking()` 提供共享对象 Map 的真实 `StorageAdapter`；
- 注入 `fetchImpl` 把 `http://memory.local/*` 映射到同一份对象，走真实 URL 解析/下载逻辑；
- 包装 `storageFactory` 记录每次写 key，用于断言上传顺序；
- 可 `unsafeSet` 任意坏数据（坏 JSON、错误 MD5、路径穿越元信息）；
- 多个 `newCore(label)` 拥有独立 dataDir，模拟多台机器/多个用户。

**B. 真实 provider harness（`tests/integration/support/real-env.ts`）** —— 贴近生产：

| 环境构造函数 | 模拟对象 | 组成 |
| --- | --- | --- |
| `startFtpHttpEnv(rootDir)` | 用户自建 vsftpd + nginx | `startFtpTestServer`（ftp-srv）+ `startStaticServer`（同一 rootDir） |
| `startLocalEnv(rootDir)` | 本地目录 + nginx | `LocalStorageAdapter` 写入 + `startStaticServer` 读取 |
| `startS3Env(rootDir)` | MinIO / S3 | `startS3TestServer`（s3rver）+ path-style 匿名 `publicBaseUrl` |

owner 端用真实 `createStorageFactory()`；subscriber 端用真实 `global.fetch`（包装后记录请求 URL，
可断言"确实走了 HTTP 下载"）。全部进程内、离线。

### 7.2 场景 → 用例映射（task-6 A–F）

| 场景 | 要求 | 用例 |
| --- | --- | --- |
| A | 公开频道全链路（ftp-http；嵌套/Unicode/大文件；订阅→安装→v2→checkUpdates→update 断言 MD5 复用→verify→uninstall） | `real-ftp-http.test.ts > A: 散文件…` |
| B | zip 全链路（发布→订阅→安装→更新→损坏 archive→更新失败且旧版本可用→新版本恢复） | `real-ftp-http.test.ts > B: zip 全链路…` |
| C | 私密频道：能力链接/错误 URL/非管理员 publish 拒绝/import pri 后发布成功 | `channel-lifecycle.test.ts > 私密频道…`（2 用例） |
| D | 多 App、多频道、channel.json 合并、幂等/冲突 | `multi-app.test.ts`（4 用例）、`publish-files.test.ts` |
| E | S3（s3rver）create/publish/subscribe/install/update | `real-s3.test.ts` |
| F | local + StaticServer create/publish/subscribe/install/update/verify/uninstall | `real-local.test.ts`（2 用例） |
| 错误/安全 | 坏数据、越权、凭据泄露、离线、网络错误 | `error-security.test.ts`（4 用例）、`install-update > 损坏回滚` |
| 安装/更新引擎 | 校验、篡改检测、force 修复、keepVersions、启动描述、卸载 | `install-update.test.ts`（3 用例） |

### 7.3 断言策略

- **协议文件用协议解析**：关键产物 `channel.json`/`app.meta.json`/`files.json` 用
  `parseChannelFile` 等严格 schema 解析后断言，避免"测试自己也按错误格式断言"；
- **写入顺序**：通过 recording storageFactory 的写 key 序列断言
  `payload < files.json < app.meta.json < channel.json`；
- **磁盘断言**：安装后逐个文件比对 size + MD5，而不是只看 `install.json`；
- **HTTP 证据**：subscriber harness 记录请求 URL，断言 `app.meta.json`/payload 确实通过 HTTP 拉取；
- **回滚断言**：失败后 `library.list()` 为空且版本目录不存在，旧版本 verify 仍 ok。

### 7.4 错误断言

统一使用 `expectAppError(fn, allowedCodes)`（`tests/integration/support/assertions.ts`）：

- 必须抛出 `AppError`（不是普通 Error）；
- 错误码在允许集合内；集合按文档语义收窄（例如版本冲突只允许 `CONFLICT`），
  但避免把实现细节（具体错误文案）写死。

### 7.5 新增集成用例

1. 简单链路用 `withHarness(t, async (h) => { ... })`；需要真实 provider 时用
   `createRealHarness()` + `startXxxEnv()`，`finally` 中 `env.close()` / `h.dispose()`；
2. 配置 `storage` 时 `publicBaseUrl` 必须是订阅者可达的 HTTP 地址（内存 harness 用
   `http://memory.local/`）；发布已存在 App 的新版本时 `app.appId` 必填；
3. 断言优先走 core 公共 API + 磁盘/存储状态，不依赖内部文件字段；
4. 需要等待异步落盘用 `findFilesBySuffix` + 轮询或在 core 调用返回后直接断言（core 是 await 完成的）。

---

## 8. Electron E2E 设计（L3）

### 8.1 运行前置

- 必须先构建：`pnpm build`（`apps/desktop/out/main/index.cjs`、`out/renderer/index.html`）；
- 不需要 Playwright 浏览器；不需要外网；不建议在无显示器环境直接跑（用 xvfb，见 §4.4）。

### 8.2 预置频道仓库（fixture）方案

`global-setup.ts` 在 `apps/desktop/e2e/.tmp/repo/` **手工构造**一个符合 PROTOCOL 的仓库：

```
repo/
├── channel.json                       # 公开频道（固定 ch_0123456789abcdef0123，App 列表 1 项）
├── hello-app/
│   ├── app.meta.json                  # v1.0.0，含 files（path/size/md5）
│   └── 1.0.0/
│       ├── files.json                 # 与 meta 内 files 一致
│       ├── hello-app.cmd|hello-app.sh # 平台自适应入口（Windows→.cmd，Linux/mac→.sh）
│       ├── hello.txt
│       └── resources/{config.ini, 数据/说明.txt}   # 嵌套目录 + Unicode 路径
└── _e2e_owned/                        # 供"创建自有频道"用例写入的目录（publish 向导测试用）
```

- **size/MD5 在构造时真实计算**（`node:crypto`），客户端安装/校验走真实数据；
- 时间戳固定，产物确定；每次 setup 先清空 `.tmp/`；
- 由**进程内静态服务器**（`support/static-server.ts`，模拟 nginx）暴露为 `http://127.0.0.1:<port>/`，
  启动后 self-check `GET channel.json`、`GET hello-app/app.meta.json` 均 200；
- 通过 `.tmp/fixture.json`（而非环境变量）把 `channelUrl`/`baseUrl`/`appId`/`version`/`files` 传给测试
  （Playwright globalSetup 与 worker 跨进程最稳的传递方式）；
- 刻意**不依赖 `@apphub/core` 生成 fixture**：E2E 验证的是"客户端能消费标准频道仓库"，
  发布端正确性由集成测试覆盖；这样 E2E 也不受 core 实现进度/重构影响。

### 8.3 启动 Electron

`support/electron-app.ts`：

- `_electron.launch({ executablePath: require('electron'), args: [apps/desktop] })`；
- 每个用例独立 `APPHUB_USER_DATA_DIR`（`e2e/.tmp/user-data/run-*`），结束后删除；
- **关键坑**：宿主环境可能注入 `ELECTRON_RUN_AS_NODE=1`（本仓库的 DSH Desktop 宿主就会），
  被 Electron 继承后 `electron.exe` 退化为纯 Node，表现为 `Process failed to launch!`。
  启动 helper 会从子进程 env 中 `delete` 该变量（以及 `ELECTRON_NO_ATTACH_CONSOLE`）；
- 首窗失败时把主进程 stdout/stderr 一起抛出，并提示检查 build 产物/单实例锁；
- Linux root CI 通过 `APPHUB_E2E_ELECTRON_ARGS="--no-sandbox"` 追加参数。

### 8.4 UI `data-testid` 契约

UI 文案可变，但下列 testid 是 E2E 与 UI 之间的稳定接口（ui-dev 已全部实现）：

| 区域 | testid |
| --- | --- |
| 外壳/导航 | `app-root`、`nav-channels`、`nav-library`、`nav-settings` |
| 频道页 | `create-channel-button`、`subscribe-channel-button`、`channel-card`（+`data-channel-id`） |
| 订阅对话框 | `subscribe-dialog`、`subscribe-url-input`、`subscribe-submit`、`dialog-error` |
| 创建向导 | `create-channel-form`、`create-channel-name`、`create-channel-next`、`storage-provider-select`、`create-channel-submit`、`dialog-error` |
| 频道详情 | `channel-detail`、`app-card`（+`data-app-id`）、`publish-open-button` |
| App 详情 | `app-detail`、`install-button`、`update-button`、`verify-button`、`uninstall-button`、`install-status`、`verify-result` |
| 本地库 | `library-page`、`library-empty`、`library-check-updates`、`installed-app-card`（+`data-app-id`） |
| 发布向导 | `publish-wizard`、`publish-display-name`、`publish-version`、`publish-entry`、`publish-next`、`publish-submit` |
| 通用 | `confirm-ok`、`uninstall-confirm-ok` |

断言策略：优先 testid；`data-*` 用于精确匹配卡片；表单字段错误用 `role="alert"`（避免误匹配
静态标签「版本号（semver）」）；少量按钮（本地库卡片内「校验/卸载」）用可访问名定位。

### 8.5 E2E 用例清单

| spec | 用例 | 断言要点 |
| --- | --- | --- |
| `smoke.spec.ts` | 窗口标题/外壳/导航可见 | `_electron` 真实启动、标题含 AppHub、三个导航按钮可见 |
| `smoke.spec.ts` | preload 注入 + system.info | `window.apphub.system.info()` 返回 appName/dataDir；dataDir 隔离 |
| `subscribe-install-uninstall.spec.ts` | 订阅→安装→检查更新→校验→卸载 | 订阅后自动进详情；安装后按 ARCH §4.2 目录断言入口文件 MD5；检查更新提示「已是最新」；校验通过；卸载后 UI 空状态 + 版本目录消失 |
| `subscribe-install-uninstall.spec.ts` | 订阅不可达地址 | 端口 1 连接拒绝 → `dialog-error` 含 NETWORK/失败，外壳仍在（不白屏） |
| `create-channel.spec.ts` | 创建向导校验 + provider 切换 | 空/纯空格名称点「下一步」被拦截（`storage-provider-select` 不可见 + 必填提示）；合法名称进入存储步骤；provider local/ftp-http/s3 切换值正确 |
| `publish-wizard.spec.ts` | 发布向导基础交互 | 通过真实 IPC `channels.create` 预置 owned 频道 → 详情出现发布入口 → 向导打开 → `not-semver` 点「下一步」被拦截（role=alert，仍在第 1 步）→ 改 `1.0.1` 后错误消失 |

### 8.6 E2E 失败产物

- `apps/desktop/e2e/.tmp/test-results/`：失败用例的 screenshot / trace / `error-context.md`（页面快照）；
- `apps/desktop/e2e/.tmp/playwright-report/index.html`：HTML 报告；
- 控制台会输出失败用例的 `userDataDir` 与 Electron 主进程日志（`[E2E] 主进程日志`）；
- 打开 trace：`npx playwright show-trace <path/to/trace.zip>`。

### 8.7 已知边界（E2E 不覆盖）

- **原生文件选择对话框**（`publish.pick`、导入/导出 channel_pri）：Playwright 无法驱动系统对话框，
  E2E 不点击这些按钮；发布向导只验证到第 1 步。真实"选择文件→发布"由集成测试覆盖（core 层无 UI），
  原生对话框本身列入 §11 手工清单。
- **真实启动外部 App**：`library.launch` 会 spawn 用户程序（可能弹窗/常驻），E2E 不断言；
  launcher 路径安全由主进程单测覆盖，真实启动列入手工清单。
- 不覆盖 OS 级权限/安装包（`pnpm package` 产物）行为。

---

## 9. 一键验收脚本（`scripts/verify.mjs`）

步骤（按顺序）：

| 类别 | 步骤 | 命令 |
| --- | --- | --- |
| test | protocol / storage / core / testkit / tests / desktop | `pnpm --filter <pkg> test` |
| typecheck | 同上 6 个包 | `pnpm --filter <pkg> typecheck` |
| build | desktop | `pnpm --filter @apphub/desktop build` |
| e2e（可选） | desktop | `pnpm --filter @apphub/desktop test:e2e` |

特性：

- 每次执行都是全新子进程（干净环境），并从子进程 env 中删除 `ELECTRON_RUN_AS_NODE`；
- 失败不中断（除非 `--bail`/CI），最后统一汇总，便于一次看到全部问题；
- 非零退出码；`--list` 可在 CI 中先检查步骤；
- `pnpm verify` / `pnpm verify:e2e` 已由根 package.json 暴露。

---

## 10. CI 示例

```yaml
name: verify
on: [push, pull_request]
jobs:
  windows:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 11 }
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm verify:e2e
      - if: always()
        uses: actions/upload-artifact@v4
        with:
          name: e2e-report-windows
          path: apps/desktop/e2e/.tmp
  linux:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 11 }
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: sudo apt-get update && sudo apt-get install -y xvfb libnss3 libatk-bridge2.0-0 libgtk-3-0 libgbm1 libasound2
      - run: pnpm install --frozen-lockfile
      - run: xvfb-run -a pnpm verify:e2e
        env:
          APPHUB_E2E_ELECTRON_ARGS: --no-sandbox
      - if: always()
        uses: actions/upload-artifact@v4
        with:
          name: e2e-report-linux
          path: apps/desktop/e2e/.tmp
```

说明：

- 仓库已提交实际工作流 [`.github/workflows/verify.yml`](../.github/workflows/verify.yml)，内容与上例一致（Windows + Linux/xvfb 两个 job，跑 `pnpm verify:e2e` 并上传 E2E 报告）；
- 不需要 `playwright install`（Electron 自带 Chromium）；
- 若 CI 环境预置了 `ELECTRON_RUN_AS_NODE`，verify.mjs / E2E helper 会自动清理；
- macOS runner 可跑同一套命令（`pnpm verify:e2e`，无需 xvfb）。

---

## 11. 手工测试清单（L4）

> 自动化无法覆盖的部分（真实服务/三平台 GUI/原生对话框/外部程序启动），发布前逐项人工执行。
> 记录方式：在 PR/发布检查单中勾选并附截图或日志。

### 11.1 真实存储后端

| ID | 场景 | 步骤摘要 | 预期 |
| --- | --- | --- | --- |
| M1 | 真实 vsftpd/FileZilla Server + nginx | 按 STORAGE.md §ftp-http 配置频道；创建频道→发布 files/zip；用另一台机器（不同 userData）订阅→安装→更新 | 全链路成功；nginx 目录可见通道文件；错误密码时给出可读错误 |
| M2 | 真实 MinIO | 建桶、配置匿名读/公开前缀；按 STORAGE.md §s3 创建频道并发布 | 订阅 URL 可匿名下载；预算/MD5 校验通过；私有桶时可订阅（预签名） |
| M3 | local + nginx 反向代理子路径 | 频道根目录 = nginx location；`publicBaseUrl` 带子路径 | 订阅/安装正常；路径编码（Unicode/空格）正确 |
| M4 | Basic Auth 保护 | nginx `auth_basic`，`channel.json` headers 配置 | 订阅/下载携带 headers 成功；无凭据时 401 被转成可读错误 |

### 11.2 平台与 GUI

| ID | 场景 | 预期 |
| --- | --- | --- |
| M5 | Windows 10/11：`pnpm dev`、`pnpm start`、`pnpm package`（NSIS/portable） | 窗口正常、中文界面无乱码、安装包可安装启动 |
| M6 | Linux（桌面环境）：dev/build/package(AppImage) | 正常启动；safeStorage 走系统 keyring（失败时降级 `plain:v1:` 并 warn）；POSIX 可执行位设置 |
| M7 | macOS：dev/build/package(dmg) | 正常启动；Keychain 加密 channel_pri；Gatekeeper 提示可接受 |
| M8 | 多实例/数据目录：设置 `APPHUB_USER_DATA_DIR` | 两实例互不干扰；单实例锁行为符合预期 |
| M9 | 窗口尺寸 960×640 ~ 全屏、深浅色系统主题 | 布局不破；长文案/长路径可读 |

### 11.3 关键业务交互（含自动化未覆盖部分）

| ID | 场景 | 预期 |
| --- | --- | --- |
| M10 | 发布向导真实选择文件（files / folder / zip 三种 pick） | 原生对话框正常；文件清单/大小/建议 entry 正确；进度条推进；成功后频道详情出现新版本 |
| M11 | 导入/导出 `channel_pri.json`（原生保存对话框） | 导出内容可被另一台机器导入并获得发布权限；取消对话框不报错 |
| M12 | 订阅链接复制 → 浏览器打开 | 公开频道直接看到 channel.json；私密频道无 key 时 404/403 |
| M13 | 安装后「启动」真实 App（entry 为 .exe/.sh） | 程序启动、工作目录为版本目录；entry 被篡改为目录外路径时拒绝（安全提示） |
| M14 | 「打开目录」/「在文件夹中显示」 | 资源管理器/Finder 定位正确 |
| M15 | 卸载确认、二次卸载/不存在 App 的操作 | 确认框文案清晰；幂等/可读错误；无残留目录 |
| M16 | 更新检测并发点击、安装中再次点击 | 按钮禁用/串行；无重复安装/竞态 |
| M17 | 大文件（≥100MB）与大量文件（≥1000）发布/安装 | 进度可观测、内存稳定、无超时；取消/关闭窗口后的临时目录清理 |
| M18 | 网络中断（断开 nginx/FTP）后订阅/刷新/安装 | 可读 NETWORK/STORAGE 错误；已安装版本仍可启动；重试可恢复 |
| M19 | 私密频道：把能力链接发给他人；把 channel_pri 发给管理员 | 前者只读可订阅；后者可发布（owner/admin 权限展示正确） |
| M20 | 版本冲突/覆盖发布（同版本不同内容） | UI 明确提示冲突；勾选覆盖后成功；其余 App 不受影响 |

---

## 12. 实际执行结果（2026-10-21）

### 12.1 环境

| 项 | 值 |
| --- | --- |
| OS | Windows（win32 / x64） |
| Node | v22.23.2 |
| pnpm | 11.22.0 |
| Electron | 38.8.6（apps/desktop devDependency） |
| Playwright | @playwright/test 1.64.1（`_electron`，无浏览器安装） |
| 网络 | 完全离线（FTP/HTTP/S3 均为进程内模拟） |

### 12.2 一键验收 `pnpm verify:e2e`

```
合计 14 步：14 通过，0 失败，0 未运行；总耗时 52.3s
结果：PASS
```

| 步骤 | 结果 | 耗时 |
| --- | --- | --- |
| test @apphub/protocol | ✅ 24 tests | 2.0s |
| test @apphub/storage | ✅ 39 tests | 3.0s |
| test @apphub/core | ✅ 90 tests | 4.6s |
| test @apphub/testkit | ✅ 无测试文件（`--passWithNoTests`，设计如此） | 1.2s |
| test @apphub/tests（集成） | ✅ 30 tests / 9 files | 5.1s |
| test @apphub/desktop | ✅ 167 tests / 19 files | 7.3s |
| typecheck × 6 包 | ✅ 全部通过 | 1.2~4.2s |
| build @apphub/desktop | ✅ 产出 `out/main`、`out/preload`、`out/renderer` | 1.8s |
| e2e @apphub/desktop | ✅ 6 tests / 4 specs | 14.0s |

**自动化用例合计：350 个 Vitest 用例 + 6 个 Electron E2E 用例，0 skipped。**

### 12.3 覆盖率（可选）

`pnpm --filter @apphub/core coverage`：

| 指标 | 数值 |
| --- | --- |
| Statements | 86.09% |
| Branches | 76.57% |
| Functions | 91.11% |
| Lines | 86.09% |

（core 共 90 单测 + 30 集成测试共同覆盖；`mutex.ts`/`progress.ts` 100%。）

### 12.4 E2E 稳定性

- 全量 E2E 连续多次运行均 6/6 通过（最终验收 14.0s；含冷启动场景 18~28s）；
- `smoke.spec.ts --repeat-each=3` → 6/6 通过（无 flaky）；
- 开发过程中曾出现两次偶发失败，均已定位为**测试自身问题**并修复：
  1. 旧构建不含 `app-root` testid → 重新 build 后稳定（fail-fast 已加入 `requireDesktopBuild`）；
  2. 订阅成功后 UI 自动跳转频道详情，旧用例仍等待频道卡片 → 改为等待 `channel-detail`。

### 12.5 跳过/未执行项

| 项 | 原因 | 处理 |
| --- | --- | --- |
| 真实 FTP/nginx/MinIO 服务 | 自动化必须离线，CI 不部署外部服务 | 列入 §11 手工清单 M1–M4 |
| 原生文件对话框/真实启动外部 App/打包安装 | Playwright 无法驱动系统对话框、外部进程副作用大 | §11 M5–M7、M10–M14 |
| macOS/Linux 实机 GUI | 当前环境仅 Windows；命令与 CI 配置已就绪 | 发布前手工 M5–M7 |

> 没有为了"变绿"而 skip 任何计划内用例；集成测试中"core 尚未实现时动态 skip"的兼容逻辑保留，
> 但当前 core 已实现，30 个用例全部真实执行（残留在 `support/harness.ts`，若 core 回归为 stub 会以
> 可读原因标记 skipped，而不是静默通过）。

---

## 13. 已知限制与边界

1. **完整性 = size + MD5，不是防篡改签名**：安全性依赖 HTTPS 与可信订阅来源（PROTOCOL §9）。
   已安装文件被本地篡改时 `verify` 能发现，但无法证明远端来源可信。
2. **远端被外部篡改无法通过"幂等发布"修复**：若有人直接改动存储里的对象字节，重新发布同版本同内容
   会被幂等逻辑判为"已存在且一致"而跳过上传；需发布新版本或手动删除后重发。
3. **FTP 无 CAS**：并发发布是"读-合并-写回"，最后写入者胜出；同一频道建议单机发布或使用 S3
   （ARCH §7）。集成测试覆盖了"并发发布不同 App"的合并场景，但极端并发仍可能丢失更新。
4. **E2E 不触发原生对话框与外部进程**（§8.7），这些路径靠主进程单测 + 手工清单保障。
5. **E2E fixture 是手工构造的协议仓库**，不经过 core 发布端；发布端正确性由 L1/L2 覆盖。
6. **本机 E2E 依赖桌面会话**：无头 Linux 必须 `xvfb-run`；root 用户可能需要 `--no-sandbox`
   （测试专用，不作为产品默认）。
7. **大文件/超大文件数上限**按协议 `LIMITS`（相对路径 1024、文件数 100000、总大小 1TiB）；
   极端规模需要手工 M17 验证，不作为 CI 常规项。
8. **Playwright 报告目录**位于 `apps/desktop/e2e/.tmp/`（已被根 `.gitignore` 的 `.tmp/` 忽略）。

---

## 14. 故障排查

| 症状 | 可能原因 | 解决 |
| --- | --- | --- |
| E2E `Process failed to launch!` / 窗口不出现 | 宿主注入了 `ELECTRON_RUN_AS_NODE=1`，Electron 退化为 Node | 已由 `support/electron-app.ts` 清理；若自写脚本需 `delete env.ELECTRON_RUN_AS_NODE` |
| `Electron E2E 无法启动：桌面端构建产物不存在` | 未 build / build 失败 | `pnpm build`；确认 `out/main/index.cjs`、`out/renderer/index.html` 存在且为最新 |
| E2E 等待 `app-root` 超时 | 旧构建（renderer 未更新）/ renderer 白屏 | 重新 build；看 `[E2E] 主进程日志`、`.tmp/test-results/**/error-context.md` |
| Linux 启动报 sandbox/namespace 错误 | root 用户或缺少 user namespace | `APPHUB_E2E_ELECTRON_ARGS="--no-sandbox"` + `xvfb-run -a` |
| `Missing X server or $DISPLAY` | 无头环境直接运行 | 使用 `xvfb-run -a` |
| 静态服务器端口冲突/复用 | 上次运行残留进程 | setup 每次随机端口；结束进程/重跑即可；`.tmp` 会自动清空 |
| `pnpm --filter ... test` 报无脚本 | 包名拼错或 package.json 无该 script | 用 `node scripts/verify.mjs --list` 查看真实步骤 |
| `@apphub/tests` 找不到 workspace 包 | 未 `pnpm install` / 用 npm 运行 | 统一用 pnpm，`pnpm install` |
| 集成测试访问外网失败 | 测试意外指向外部 URL | harness 的 fetchImpl 会拒绝非 `memory.local`；检查构造的 URL |
| Windows Defender/杀软拖慢或拦截 E2E 启动 | 首次运行扫描 Electron | 加入信任目录；CI 关闭实时扫描 |
| 时间戳相关断言失败 | 系统时钟/时区差异 | 测试用注入 Clock（integration）与固定 fixture 时间戳（E2E），不依赖真实时间 |
| `ENOENT ... sources/xxx` | 测试里未先创建目录 | 用 `writeFileTree`/`writeZip`（自动建目录）或先 mkdir（见 zip-slip 用例） |
| E2E 单个用例偶发超时 | 机器负载/首次冷启动 | 重跑；`--repeat-each=3` 验证；看 trace 定位具体等待点 |
| `verify.mjs` 颜色乱码 | 终端不支持 ANSI | `--no-color` 或 `APPHUB_VERIFY_NO_COLOR=1` |

---

## 15. 本轮测试发现的实现问题/契约偏差记录

> 按"发现 → 处理"记录，便于回溯。源码均未由 QA 修改（遵守写作用域）。

| # | 问题 | 影响 | 处理 |
| --- | --- | --- | --- |
| 1 | `packages/protocol/src/schemas.test.ts` 的 fixture `makeChannel({ owner: {} })` 类型不满足 `owner.name` 必填 → 根 `pnpm typecheck` 红 | 阻断一键验收 | 已上报 Lead；Lead 将 fixture 改为 DeepPartial 并修复，现 verify 全绿 |
| 2 | `PublishAppInput.app` 注释为"已存在时忽略"，但实现对"已存在 App 的新版本"要求必须提供 `app.appId`（否则 VALIDATION） | 集成测试初版按注释编写导致 5 个用例失败；UI/desktop 已按实现行为处理 | 测试改为显式传 `app.appId`；建议后续澄清 types.ts 注释（已同步 Lead/core-dev） |
| 3 | E2E：订阅成功后 UI 自动跳转频道详情，原用例仍等频道卡片 | E2E 失败（测试问题） | 调整为等待 `channel-detail`，并保留"频道名可见"断言 |
| 4 | E2E：`/版本|semver/i` 文本选择器误匹配静态标签「版本号（semver）」 | E2E 误报（测试问题） | 改用表单字段错误的 `role="alert"` 定位（Form.tsx 约定） |
| 5 | 订阅者安装不请求 `files.json`（直接使用 meta 内嵌 files，协议允许） | E2E/集成断言曾误判"必须请求 files.json" | 改为断言 meta + payload 的 HTTP 请求；文档已说明该设计 |
| 6 | 同一测试装置内连续创建两个频道会命中"存储位置已存在 channel.json"（内存 harness 共享对象空间） | 多频道用例失败（测试装置问题） | 该用例改用 local provider + 独立子目录的静态服务器环境 |

---

## 16. 附录：自动化用例索引

### 16.1 集成测试（`tests/integration`，30 用例）

| 文件 | 用例数 | 内容摘要 |
| --- | --- | --- |
| `channel-lifecycle.test.ts` | 3 | 公开频道创建+订阅者+取消订阅；私密频道能力链接/错误 URL/export pri；import pri 后管理员发布 |
| `publish-files.test.ts` | 6 | v1 写入顺序与协议产物；v1.1 版本历史/latest/补发旧版本；幂等/冲突/overwrite/publishMode；输入校验（entry/targetPath/semver/频道不存在）；updateMeta；getApp NOT_FOUND |
| `publish-zip.test.ts` | 4 | zipPath 元信息；zipFromDir；zip-slip 拒绝；zip 安装与校验 |
| `install-update.test.ts` | 3 | 安装/校验/篡改/修复/更新 MD5 复用/启动描述/卸载；损坏 payload 回滚与恢复；平台不匹配/未安装错误 |
| `error-security.test.ts` | 4 | 坏 channel.json 五类；不可达/非 http(s)/404；凭据不泄露（日志/密文/本地记录/错误）；越权发布不污染元信息 |
| `real-ftp-http.test.ts` | 3 | A 散文件全链路（Unicode/大文件/MD5 复用）；FTP 错误凭据；B zip 全链路+损坏 archive 回滚 |
| `real-local.test.ts` | 2 | local 全链路；publicBaseUrl 错误路径 |
| `real-s3.test.ts` | 1 | S3 全链路（含匿名公开读） |
| `multi-app.test.ts` | 4 | 交替发布合并；并发发布不丢 App；多频道隔离；多 App 下幂等/冲突 |

### 16.2 E2E（`apps/desktop/e2e`，6 用例）

见 §8.5 表格。

### 16.3 常用调试命令

```bash
# 查看/重放 E2E trace
npx playwright show-trace apps/desktop/e2e/.tmp/test-results/<case>/trace.zip

# 只跑失败过的用例
npx playwright test -c apps/desktop/e2e/playwright.config.ts --last-failed

# 打开 HTML 报告
npx playwright show-report apps/desktop/e2e/.tmp/playwright-report

# 保留 E2E 用户目录排查
APPHUB_E2E_KEEP_USER_DATA=1 pnpm test:e2e

# 只跑集成测试中的真实 FTP 场景
pnpm --filter @apphub/tests test -- real-ftp-http
```
