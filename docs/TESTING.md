# AppHub 测试方案（TESTING）

> 本文档是 AppHub 的测试"作战手册"：分层策略、需求覆盖矩阵、运行命令、CI 配置、
> 手工验收清单、实际执行结果、已知限制与故障排查。
> 相关文档：[ARCHITECTURE.md](./ARCHITECTURE.md)（架构与 §8 测试要求）、
> [PROTOCOL.md](./PROTOCOL.md)（协议与发布/更新规则）、[STORAGE.md](./STORAGE.md)（存储后端）。
>
> 维护者：qa-dev。最后实测：2026-10-27（Phase 5「本机 Host」验收，结果见 §12）。

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
本机 Host（local-host）则由 App/测试进程**真实监听 127.0.0.1（可含 LAN IPv4）**，
订阅端通过真实 HTTP 访问，同样不需要任何外部服务。

---

## 2. 测试分层

| 层 | 名称 | 范围 | 位置 | 运行方式 | 当前状态 |
| --- | --- | --- | --- | --- | --- |
| L0 | 协议单元 | zod schema、路径/URL/semver/错误码/序列化 | `packages/protocol/src/*.test.ts` | `pnpm --filter @apphub/protocol test` | ✅ 27 tests |
| L1 | 包单元 | storage 四个适配器 + 工厂；core 频道/发布/安装/Host 引擎；desktop 主进程 IPC/安全/数据目录；renderer React 组件 | `packages/*/src/**/*.test.ts(x)`、`apps/desktop/src/**/*.test.ts(x)` | `pnpm -r test` / 各包 `pnpm --filter <pkg> test` | ✅ storage 56、core 118、desktop 266 |
| L2 | 跨包集成 | `core + storage + testkit` 组合，真实存储适配器 + 进程内 FTP/S3/静态服务器；内存存储 + 内存 fetch 快速链路；**本机 Host 真实监听 HTTP** | `tests/integration/**` | `pnpm --filter @apphub/tests test` | ✅ 37 tests / 10 files |
| L3 | Electron E2E | 真实启动打包后的 Electron 应用，走完整 UI 链路（本机 Host、默认 local-host、端口避让、数据目录三来源/双 env/旧版迁移） | `apps/desktop/e2e/**` | `pnpm build && pnpm test:e2e` | ✅ 17 tests / 7 specs |
| L4 | 手工验收 | 真实 vsftpd/FileZilla + nginx、MinIO、两台设备局域网访问、三平台 GUI、真实启动外部 App、原生文件对话框 | 本文 §11 清单 | 人工 | ⏳ 发布前逐项执行 |

分层原则：

- **越靠下越便宜**：协议/单元测试覆盖边界与错误码；集成测试覆盖真实 IO 语义；
  E2E 只覆盖"用户可见的关键链路"，不重复单测细节（避免慢且脆）。
- **不 mock 被测对象**：集成测试用真实 `createStorageFactory()` 与真实 HTTP；
  E2E 用真实 core/storage 与真实 Electron 进程；只对进程外不可控资源（FTP/S3/静态托管）用进程内模拟。
  本机 Host 链路（Phase 5）连"静态托管"都不模拟：App/测试进程自己就是服务器，用真实端口与 HTTP 访问。
- **失败必须可定位**：错误断言精确到 `AppError.code`（见 §7.4），E2E 失败自动落
  trace/screenshot/主进程日志（见 §8.5）。

---

## 3. 目录与文件地图

```
packages/protocol/src/            L0 协议单测（schema/路径/版本/错误）
packages/storage/src/             L1 storage 适配器单测 + adapters/（local/ftp-http/s3/local-host）
packages/core/src/                L1 core 单测（channels/publish/library/host/zip/http/state…）
packages/testkit/src/             测试基础设施：temp/static-server/ftp-server/s3-server/port/fixtures/fakes
apps/desktop/src/main/**/*.test.ts     L1 主进程（IPC 校验、selection registry、launcher 安全、secret-box）
apps/desktop/src/renderer/**/*.test.tsx L1 渲染进程（RTL + mock api）
apps/desktop/e2e/
├── playwright.config.ts          Playwright 配置（testDir=e2e，workers=1，Electron 无需浏览器）
├── global-setup.ts               构造协议合规的频道仓库 + 启动静态服务器 + 写 fixture 清单
├── global-teardown.ts            关闭静态服务器/清理
├── support/
│   ├── paths.ts                  运行时目录（e2e/.tmp/**）
│   ├── port.ts                   getFreePort（本机 Host 用例挑空闲端口，纯 node:net）
│   ├── app-api.ts                公共 IPC 助手（channels/host/system.info 的 window.evaluate 封装）
│   ├── fixture-repo.ts           手工构造 channel.json / app.meta.json / files.json / 版本文件
│   ├── static-server.ts          进程内静态服务器（模拟 nginx）
│   ├── fixture.ts                测试读取 fixture 清单
│   ├── electron-app.ts           _electron.launch 封装（userData 隔离、ELECTRON_RUN_AS_NODE 清理、日志）
│   ├── app-state.ts              磁盘断言（本地库目录、MD5 校验、等待）
│   ├── ui.ts                     data-testid 契约 + 通用等待
│   └── test-fixtures.ts          每用例独立 Electron 实例的 Playwright fixture
├── smoke.spec.ts                 启动冒烟（标题/外壳/导航/preload/system.info）
├── subscribe-install-uninstall.spec.ts  订阅→安装→检查更新→校验→卸载 + 错误路径
├── create-channel.spec.ts        创建向导校验、默认 local-host、provider 切换
├── create-channel-port.spec.ts   local-host 端口自动避让/手动覆盖/重复端口校验
├── settings-data-dir.spec.ts     设置页数据目录（env（双变量）/ default AppHubData / custom / 旧版迁移 + system.info 契约字段）
├── publish-wizard.spec.ts        发布向导打开与版本号校验
└── local-host.spec.ts            本机 Host：创建/自动启动/本机与局域网 URL/停止重启/私密能力链接
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
├── multi-app.test.ts             D：多 App/多频道隔离/channel.json 合并且不丢 App
└── local-host.test.ts            G：本机 Host 真实 HTTP 全链路/私密能力链接/端口冲突/updateConfig
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
npx playwright test -c apps/desktop/e2e/playwright.config.ts --grep "本机 Host"
npx playwright test -c apps/desktop/e2e/playwright.config.ts --repeat-each=3

# 只跑本机 Host 集成测试（真实 HTTP 启停）
pnpm --filter @apphub/tests test -- local-host

# 覆盖率（可选）
pnpm --filter @apphub/core coverage
```

### 4.3 环境变量

| 变量 | 作用 | 默认 |
| --- | --- | --- |
| `APPHUB_USER_DATA_DIR` | Electron E2E 的独立 userData 目录（每个用例自动生成；产品语义=整体覆盖 Electron userData） | `apps/desktop/e2e/.tmp/user-data/run-*` |
| `APPHUB_DATA_DIR` | 只覆盖 AppHub 数据目录（不动 Electron userData；Phase 7） | 未设置 |
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

> 状态均为 2026-10-27 实测通过。"依据"列指向协议/架构文档章节。

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

### 5.7 本机 Host（local-host，Phase 5）

| # | 需求 | 依据 | 自动化覆盖 | 状态 |
| --- | --- | --- | --- | --- |
| R48 | 创建 local-host 频道：rootDir/port/bindHost/advertiseHost/publicBaseUrl 校验与落盘 | ARCH §3.5 / PROTOCOL §2 | `local-host > 公开频道全链路`、`create-channel`（向导必填） | ✅ |
| R49 | Host 生命周期：start/stop/status/list；真实监听端口；running/port/startedAt 状态正确 | ARCH §3.5 | `local-host > 公开频道全链路`、`端口冲突`、`stop 后端口复用`、E2E `local-host` | ✅ |
| R50 | 订阅地址推导：`publicBaseUrl > advertiseHost > 局域网 IPv4 > 127.0.0.1`，返回 channel/local/lan 三组 URL | STORAGE `resolveLocalHostBaseUrls` | `local-host > 公开频道全链路`、`updateConfig`、E2E 断言三种 URL | ✅ |
| R51 | 订阅者通过 Host 真实 HTTP 订阅→安装→更新→校验→卸载（MD5 复用） | ARCH §3.4 | `local-host > 公开频道全链路` | ✅ |
| R52 | Host 停止后频道不可达、订阅者 refresh 报可读错误；restart 后恢复 | ARCH §3.5 | `local-host > 公开频道全链路`、E2E 停止/重启 | ✅ |
| R53 | 私密 local-host：能力链接（`_private/<id>/<accessKey>`）可访问；公开路径/错误 accessKey 404；权限模型不变 | PROTOCOL §2/§4 | `local-host > 私密频道…`、E2E `私密 local-host` | ✅ |
| R54 | zip 模式通过 Host 安装并校验解压内容 | PROTOCOL §7.2 | `local-host > zip 模式…` | ✅ |
| R55 | 端口冲突返回 CONFLICT 并记录 lastError；stop 后端口立即可复用/同端口重启 | ARCH §3.5 | `local-host > 端口冲突`、`stop 后端口复用` | ✅ |
| R56 | updateConfig：运行中拒绝（STATE）；停止后改端口/advertiseHost 生效并同步订阅 URL；rootDir 不可改 | ARCH §3.5 | `local-host > updateConfig` | ✅ |
| R57 | 非 local-host 频道不托管：list 排除，status/start/stop/updateConfig 抛 UNSUPPORTED；未知频道 NOT_FOUND | ARCH §3.5 | `local-host > 非 local-host 频道不托管` | ✅ |
| R58 | UI：创建向导 local-host 表单/默认 bindHost=0.0.0.0；频道详情 Host 面板（运行状态/URL/启停/编辑入口）；频道列表 Host 徽标 | ARCH §5.4 | E2E `local-host.spec.ts`（3 用例） | ✅ |
| R59 | 局域网访问：`0.0.0.0` 时给出 LAN URL 且可被同机/同网段访问；无网卡时回退 127.0.0.1 | ARCH §3.5 / STORAGE | E2E `local-host`（LAN 可达性用例，无网卡显式 skip 记录原因） | ✅ |

### 5.8 默认本地 Host / 端口避让 / 数据目录（Phase 6）

| # | 需求 | 依据 | 自动化覆盖 | 状态 |
| --- | --- | --- | --- | --- |
| R60 | 创建频道向导默认存储类型 = `local-host`，默认 bindHost=`0.0.0.0`、端口默认 8787 | ARCH §5.4 | E2E `create-channel.spec.ts`（默认值断言） | ✅ |
| R61 | local-host 端口自动避让：从 8787 起选最小未占用；hint 展示已用端口/推荐值；手动修改后不被覆盖；重复端口 inline error；提交前再次校验 | ARCH §5.4 | E2E `create-channel-port.spec.ts`（3 用例） | ✅ |
| R62 | 设置页展示数据目录与来源（默认目录/自定义目录/环境变量固定）、默认目录提示 | ARCH §5.3 | E2E `settings-data-dir.spec.ts`（多来源启动期，Phase 7 扩为 5 用例）+ `system.info` 契约字段 | ✅ |
| R63 | env 模式（`APPHUB_USER_DATA_DIR`）数据目录只读：`dataDirSource='env'`、`dataDirEditable=false`、更改按钮 disabled + 固定说明；default/custom 模式 `editable=true` 且按钮可用 | ARCH §5.3 | E2E `settings-data-dir.spec.ts`（env/default/custom 3 用例） | ✅ |
| R64 | 自定义目录迁移与重启：校验目标（非空 CONFLICT、互相嵌套 VALIDATION）、只迁移 managed 数据、原子写引导配置、Host 停止后重启、恢复默认 | ARCH §5.3 / `data-dir.ts` | `apps/desktop/src/main/data-dir.test.ts` + ipc 单测（迁移/重启交互由手工 M28–M34 覆盖，E2E 不自动化） | ✅ |

### 5.9 默认 AppHubData / 双环境变量 / 旧版迁移（Phase 7）

| # | 需求 | 依据 | 自动化覆盖 | 状态 |
| --- | --- | --- | --- | --- |
| R65 | 默认 AppHub 数据目录 = `<Electron userData>/AppHubData`，与 Chromium 缓存/配置隔离；`source='default'`、`editable=true` | ARCH §5.3 / `data-dir.ts` | E2E `settings-data-dir.spec.ts > default（--user-data-dir）`；单测 `data-dir.test.ts` | ✅ |
| R66 | `APPHUB_DATA_DIR`：只覆盖 AppHub 数据目录、不影响 Electron userData；`source='env'`、`editable=false`；不读 bootstrap | ARCH §5.3 | E2E `settings-data-dir.spec.ts > env（APPHUB_DATA_DIR）`；单测 env 优先级 | ✅ |
| R67 | `APPHUB_USER_DATA_DIR` 保持历史语义：整体覆盖 Electron userData，AppHub 数据位于该目录根；`defaultDataDir` 仍为 `<userData>/AppHubData`；只读 | ARCH §5.3 | E2E `settings-data-dir.spec.ts > env（APPHUB_USER_DATA_DIR）` | ✅ |
| R68 | 旧版数据自动迁移：userData 根的 managed 条目（channels.json/channels/secrets/library/apphub.json）在启动时 move 到 AppHubData（EXDEV 时 copy+rm），不动 tmp/logs/Chromium；目标已有数据则跳过 | ARCH §5.3 / `migrateLegacyAppHubData` | E2E `settings-data-dir.spec.ts > 旧版数据自动迁移`；单测覆盖回滚/跳过/EXDEV | ✅ |
| R69 | 设置页文案区分两个环境变量、说明 AppHubData 隔离；env 模式渲染 `data-dir-env-hint`（含 APPHUB_DATA_DIR 与 APPHUB_USER_DATA_DIR 两段），default 提示含 AppHubData/Electron 缓存分离 | ARCH §5.4 | E2E `settings-data-dir.spec.ts`（5 用例均校验文案） | ✅ |

---

## 6. 单元测试明细（L0/L1）

| 包 | 测试文件数 | 用例数 | 重点内容 |
| --- | --- | --- | --- |
| `@apphub/protocol` | 2 | 27 | schema 严格校验、跨字段 refine、路径/URL/semver、local-host 配置、错误语义 |
| `@apphub/storage` | 5 | 56 | local/ftp-http/s3/local-host CRUD/list/stat/probe、Unicode、二进制、非法 key、工厂 |
| `@apphub/core` | 6 | 118 | 频道生命周期、发布 files/zip（含写入顺序、冲突、幂等、同频道并发串行化）、安装/更新/回滚、Host 服务、HTTP/state/zip 工具 |
| `@apphub/testkit` | 0 | 0 | 纯测试基础设施（`--passWithNoTests`，由集成测试间接覆盖） |
| `@apphub/desktop` | 22 | 266 | 主进程 IPC/校验/selection/launcher/secret-box/host/数据目录（默认 AppHubData/双 env/旧版迁移/启动恢复）+ renderer RTL（视图/组件、HostPanel、向导默认 local-host/端口避让、设置页数据目录文案） |
| `@apphub/tests`（L2） | 10 | 37 | 见 §7 |

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
| （无 env 构造函数）本机 Host | App 内置 Host | `createRealHarness()` + `local-host` 存储配置 + `core.host.start()`（真实监听 127.0.0.1，端口来自 `getFreePort()`） |

owner 端用真实 `createStorageFactory()`；subscriber 端用真实 `global.fetch`（包装后记录请求 URL，
可断言"确实走了 HTTP 下载"）。全部进程内、离线。

> 本机 Host 用例**不能**用内存 harness：`HostServer` 直接读取磁盘 rootDir，而内存适配器不落盘；
> 因此必须用真实 `createStorageFactory()` + 临时目录（见 `local-host.test.ts`）。

### 7.2 场景 → 用例映射（task-6 A–F + Phase 5 G）

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
| G | **本机 Host**：local-host 创建→发布→host.start（真实 HTTP）→订阅→安装→更新（MD5 复用）→verify→stop 后 refresh 失败→restart 恢复→uninstall；私密能力链接/错误 accessKey 404/非管理员发布拒绝；zip 安装；端口冲突 CONFLICT；stop 后端口复用；updateConfig（STATE/改端口/URL 同步） | `local-host.test.ts`（7 用例） |

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
4. 需要等待异步落盘用 `findFilesBySuffix` + 轮询或在 core 调用返回后直接断言（core 是 await 完成的）；
5. **本机 Host 用例**：`local-host` 配置的 `port` 一律用 `@apphub/testkit` 的 `getFreePort()`
   （不要用默认 8787，开发机可能占用）；需要确定性 URL 时设置 `advertiseHost: '127.0.0.1'`；
   停止 Host 后可用 `node:net` 占用同一端口来证明端口已释放。

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
- **关键坑**：某些桌面宿主环境或 CI runner 会在子进程中注入 `ELECTRON_RUN_AS_NODE=1`，
  被 Electron 继承后 `electron.exe` 退化为纯 Node，表现为 `Process failed to launch!`。
  启动 helper 会从子进程 env 中 `delete` 该变量（以及 `ELECTRON_NO_ATTACH_CONSOLE`）；
- 首窗失败时把主进程 stdout/stderr 一起抛出，并提示检查 build 产物/单实例锁；
- Linux root CI 通过 `APPHUB_E2E_ELECTRON_ARGS="--no-sandbox"` 追加参数。

### 8.4 UI `data-testid` 契约

UI 文案可变，但下列 testid 是 E2E 与 UI 之间的稳定接口（ui-dev 已全部实现）：

| 区域 | testid |
| --- | --- |
| 外壳/导航 | `app-root`、`nav-channels`、`nav-library`、`nav-settings` |
| 频道页 | `create-channel-button`、`subscribe-channel-button`、`channel-card`（+`data-channel-id`）、`channel-host-badge` |
| 订阅对话框 | `subscribe-dialog`、`subscribe-url-input`、`subscribe-submit`、`dialog-error` |
| 创建向导 | `create-channel-form`、`create-channel-name`、`create-channel-next`、`storage-provider-select`、`create-channel-submit`、`dialog-error` |
| 创建向导 local-host | `local-host-root-dir`、`local-host-browse-root`（原生目录框，E2E 不点）、`local-host-port`、`local-host-bind-host`（select，默认 `0.0.0.0`） |
| 频道详情 | `channel-detail`、`app-card`（+`data-app-id`）、`publish-open-button` |
| 频道详情 Host 面板 | `host-panel`、`host-status`（运行中/已停止）、`host-url`、`host-start-button`、`host-stop-button`、`host-edit-config`（仅停止时）、`host-config-dialog`、`host-config-port`、`host-config-bind-host`、`host-config-advertise-host`、`host-config-public-base-url`、`host-config-submit`、`dialog-error` |
| App 详情 | `app-detail`、`install-button`、`update-button`、`verify-button`、`uninstall-button`、`install-status`、`verify-result` |
| 本地库 | `library-page`、`library-empty`、`library-check-updates`、`installed-app-card`（+`data-app-id`） |
| 发布向导 | `publish-wizard`、`publish-display-name`、`publish-version`、`publish-entry`、`publish-next`、`publish-submit` |
| 设置页（Phase 6） | `data-dir-source`、`data-dir-default-hint`、`change-data-dir-button`、`data-dir-change-error` |
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
| `create-channel.spec.ts` | 创建向导校验 + provider 切换 | 空/纯空格名称点「下一步」被拦截（`storage-provider-select` 不可见 + 必填提示）；合法名称进入存储步骤；**Phase 6：默认 provider=local-host、bindHost=0.0.0.0、端口 8787**；provider local/ftp-http/s3 切换值正确 |
| `create-channel-port.spec.ts` | 端口自动避让（Phase 6） | IPC 预创建 stopped 频道（configuredPort 8787 / 8787+8788，不启动 Host）→ 向导推荐 8788 / 8789；hint 含已用端口与推荐值；手动改端口后切 provider 不被覆盖；填回被占用端口点「下一步」出现 inline error 并停留第 2 步 |
| `settings-data-dir.spec.ts` | 设置页数据目录（Phase 6/7，5 用例） | ① env `APPHUB_USER_DATA_DIR`：dataDir=该目录根、defaultDataDir=`<userData>/AppHubData`、source=env/editable=false、双变量 env hint；② env `APPHUB_DATA_DIR`：dataDir=指定值、默认目录=AppHubData、不影响 userData；③ default：dataDir=defaultDataDir=`<userData>/AppHubData`、editable=true；④ custom：dataDir=bootstrap 目录、默认目录=AppHubData；⑤ 旧版迁移：userData 根 channels.json+channels 启动后 move 到 AppHubData、频道可见、非 managed 文件保留。均校验 `system.info` 契约字段与设置页文案；不点击更改按钮（原生目录对话框） |
| `publish-wizard.spec.ts` | 发布向导基础交互 | 通过真实 IPC `channels.create` 预置 owned 频道 → 详情出现发布入口 → 向导打开 → `not-semver` 点「下一步」被拦截（role=alert，仍在第 1 步）→ 改 `1.0.1` 后错误消失 |
| `local-host.spec.ts` | 创建 local-host 频道 → Host 自动启动 → 本机地址可订阅 → 停止/重启 | 向导选 provider `local-host`、填临时 rootDir + `getFreePort()` 端口、默认 bindHost `0.0.0.0`；创建后自动跳详情且 Host 面板「运行中」；Node 侧 `fetch(localChannelUrl)` 读到 channel.json（id 匹配）；`host-url` 与 status 一致；频道列表卡片 `channel-host-badge` 运行中；停止后 HTTP 不可达、重启后恢复 |
| `local-host.spec.ts` | 局域网地址可达 | `lanChannelUrls` 形状为 `http://<IPv4>:<port>/channel.json`；逐个 fetch 至少一个 200；**无局域网 IPv4 网卡时 `test.skip` 并写明原因**（Playwright 报告可查） |
| `local-host.spec.ts` | 私密 local-host 能力链接 | 能力链接含 `_private/<channelId>/<accessKey>`；UI `host-url` 展示该链接；fetch 200 且 `visibility=private`；无 `_private` 前缀 404；篡改 accessKey（32 位 a）404 |

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
- **本机 Host 的原生目录选择框**（`local-host-browse-root` → `system.pickDirectory`）：Playwright 无法
  驱动系统对话框，E2E 直接填写 `local-host-root-dir` 文本框（等价路径），原生 dialog 分支由主进程单测覆盖。
- **设置页「更改数据目录」**（Phase 6/7）：点击后先弹原生目录选择框，确认后还会**重启 Electron**。
  自动化既无法操作系统对话框，也不适合在 E2E 中重启进程（会破坏用例隔离与报告归属），因此
  E2E 只覆盖"启动期来源识别 / 旧版自动迁移 / UI 状态"（env 双变量、default、custom、legacy）；
  真实"点击迁移"动作由 `apps/desktop/src/main/data-dir.test.ts` 单测（39 用例）+
  手工清单 M28–M34 覆盖。详见 §8.9/§8.10。
- 不覆盖 OS 级权限/安装包（`pnpm package` 产物）行为。

### 8.8 本机 Host E2E 专项说明

- **用例顺序**：`local-host.spec.ts` 的 3 个用例各自启动独立 Electron（独立 `APPHUB_USER_DATA_DIR`）；
  本机 Host 的端口全部来自 `support/port.ts::getFreePort()`，不使用默认 8787，也不复用 global-setup
  的静态服务器（本机 Host 是"App 自己当服务器"，与 fixture 的 nginx 模拟是两条正交链路）。
- **创建向导路径**：填写 `create-channel-name` → 下一步 → `storage-provider-select` 选 `local-host`
  → 填 `local-host-root-dir`（`e2e/.tmp/local-host-*/` 临时目录）与 `local-host-port`
  → 断言 `local-host-bind-host` 默认 `0.0.0.0` → 下一步 → `create-channel-submit`。
  创建成功后向导会尽力 `host.start`（失败只 warning toast），正常情况下详情页 `host-status` 即为「运行中」。
- **HTTP 断言在 Node 侧**：用测试进程的 `fetch` 访问 UI/IPC 返回的 URL，等价于"另一台设备/浏览器"，
  不经过应用内代码，能真实暴露端口/绑定地址/防火墙问题。
- **停止/重启**：`host-stop-button` → `host-status`「已停止」→ 轮询 fetch 变 error；`host-start-button`
  →「运行中」→ fetch 200。stop 使用 `closeAllConnections`，端口可立即复用。
- **局域网与无网卡**：绑定 `0.0.0.0` 时 `lanChannelUrls` 由网卡推导；无网卡环境（隔离容器）该用例
  **显式 skip 并记录原因**，不会静默通过。首选地址在无 LAN 时会回退到 `127.0.0.1`（用例有断言）。
- **私密频道确定性**：IPC 创建时设置 `advertiseHost: '127.0.0.1'`，使首选地址落在回环，便于测试进程
  直接 fetch 能力链接；绑定范围仍为 `0.0.0.0`。篡改 accessKey 用 32 位 `a`（满足 ACCESS_KEY_PATTERN
  但不存在），断言 404。

### 8.9 Phase 6 E2E 说明（默认 local-host / 端口避让 / 数据目录）

- **默认 provider**：向导初始 `storage-provider-select='local-host'`、`local-host-bind-host='0.0.0.0'`、
  无已用端口时 `local-host-port='8787'`；`create-channel.spec.ts` 直接断言，不再需要 selectOptions。
- **端口自动避让**：`create-channel-port.spec.ts` 通过真实 IPC 预创建 **stopped** 的 local-host 频道
  （`configuredPort` 8787 / 8788，`rootDir` 用 `e2e/.tmp/port-*` 临时目录，不启动 Host、不占系统端口）。
  向导挂载后异步 `host.list()`，推荐值从初始 8787 更新为 8788 / 8789；断言用 `toHaveValue` 等待。
  hint 文案需**限定在 `create-channel-form` 内**（频道卡片标题也含"已用端口"字样）。
  手动 `fill` 后标记 touched，切换 provider 再切回不被覆盖；填回被占用端口点「下一步」出现
  「端口 X 已被现有 local-host 频道使用，推荐 Y」并停留第 2 步。
- **数据目录来源（启动期 E2E）**：`settings-data-dir.spec.ts` 用三种启动方式覆盖（Phase 7 语义见 §8.10）：
  1) `APPHUB_USER_DATA_DIR`（E2E 默认隔离）⇒ `source='env'`、`editable=false`，Electron userData 被
     整体覆盖，AppHub `dataDir`=该目录根，`defaultDataDir`=`<该目录>/AppHubData`；
  2) Chromium `--user-data-dir=<临时目录>`（不设 env）⇒ `source='default'`、`editable=true`、
     `dataDir=defaultDataDir=<临时目录>/AppHubData`；
  3) 同 2 下预置 `apphub-bootstrap.json` 指向另一临时目录 ⇒ `source='custom'`、
     `dataDir=自定义目录`、`defaultDataDir=<userData>/AppHubData`。
  三种来源均断言 `system.info` 契约字段 + 设置页展示 + 按钮可用性；env 模式额外断言
  `data-dir-env-hint` 同时包含 `APPHUB_DATA_DIR` 与 `APPHUB_USER_DATA_DIR` 说明。
  该技巧来自 desktop-dev，既能验证 default/custom 可编辑分支，又保持 E2E 隔离。
- **迁移动作不自动化**：点击「更改数据目录」需要原生目录选择框 + App 重启 + 断开会话，
  E2E 只验证"来源识别与 UI 状态"；迁移/校验/重启逻辑由
  `data-dir.test.ts`（resolve 优先级/validate 边界/migrate 白名单/原子写/恢复决策）与手工 M28–M34 覆盖。
- **公共 IPC 助手**：`support/app-api.ts` 统一封装 `channels.create/list`、`host.start/stop/status`、
  `system.info` 的 `window.evaluate` 调用（回调内只引用浏览器全局，避免序列化捕获 Node 变量）。

### 8.10 Phase 7 E2E 说明（默认 AppHubData / 双环境变量 / 旧版迁移）

- **三种启动隔离方式**（`support/electron-app.ts`）：
  1) `APPHUB_USER_DATA_DIR`（E2E 默认）：source=env，Electron userData=该目录，AppHub dataDir=该目录根；
  2) `--user-data-dir=<temp>`（不设 env）：Electron userData=temp，source=default（或 bootstrap 后 custom）；
  3) `--user-data-dir=<temp>` + `APPHUB_DATA_DIR=<temp2>`：source=env，但只改 AppHub 数据目录。
- **default/AppHubData**：`dataDir === defaultDataDir === <userData>/AppHubData`，且不等于 userData 根；
  启动后 AppHubData 目录实际存在（core 已初始化）。
- **env 双变量**：`APPHUB_USER_DATA_DIR` 用例断言 `dataDir=env 根`、`defaultDataDir=<env>/AppHubData`；
  `APPHUB_DATA_DIR` 用例断言 `dataDir=DATA_DIR`、`defaultDataDir=<userData>/AppHubData`、
  且 dataDir ≠ Electron userData。两者均 `editable=false`、渲染 `data-dir-env-hint`
  （同时包含两个环境变量说明）。
- **旧版迁移 E2E**：`--user-data-dir` 隔离 userData，在根下预置合法 `channels.json`（subscriber 记录）+
  `channels/<id>/channel.json` 缓存 + 一个非 managed 文件（`keep-me.txt`）。启动后断言：
  `dataDir=<userData>/AppHubData`；AppHubData 下出现 channels.json/channels；
  userData 根不再有 channels.json/channels；`keep-me.txt` 仍在；`channels.list()` 能看到
  「Legacy Channel」。无需先跑一次 App，纯文件准备即可（比 desktop-dev 的"先跑再挪"更简单）。
- **仍不自动化**：点击「更改数据目录」→ 原生目录对话框 → 迁移 → 重启；迁移/校验/恢复默认由
  `data-dir.test.ts` 39 单测 + 手工 M28–M34 覆盖。

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
      - uses: actions/checkout@v7
      # 不传 version：使用 package.json 的 packageManager（pnpm@11.22.0），
      # 避免 "Multiple versions of pnpm specified" 错误。
      - uses: pnpm/action-setup@v6
      - uses: actions/setup-node@v7
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm verify:e2e
      - if: always()
        uses: actions/upload-artifact@v7
        with:
          name: e2e-report-windows
          path: apps/desktop/e2e/.tmp
  linux:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v7
      - uses: pnpm/action-setup@v6
      - uses: actions/setup-node@v7
        with: { node-version: 22, cache: pnpm }
      - run: |
          sudo apt-get update
          if apt-cache show libasound2t64 >/dev/null 2>&1; then
            EXTRA="libasound2t64 libatk-bridge2.0-0t64 libgtk-3-0t64"
          else
            EXTRA="libasound2 libatk-bridge2.0-0 libgtk-3-0"
          fi
          sudo apt-get install -y xvfb libnss3 libgbm1 libxss1 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libxkbcommon0 libpango-1.0-0 libcairo2 $EXTRA
      - run: pnpm install --frozen-lockfile
      - run: xvfb-run -a pnpm verify:e2e
        env:
          APPHUB_E2E_ELECTRON_ARGS: --no-sandbox --disable-gpu
      - if: always()
        uses: actions/upload-artifact@v7
        with:
          name: e2e-report-linux
          path: apps/desktop/e2e/.tmp
```

说明：

- 仓库已提交实际工作流 [`.github/workflows/verify.yml`](../.github/workflows/verify.yml)，内容与上例一致（Windows + Linux/xvfb 两个 job，跑 `pnpm verify:e2e` 并上传 E2E 报告）；
- **pnpm 版本只由 `package.json` 的 `packageManager`（`pnpm@11.22.0`）决定**：`pnpm/action-setup` 不要同时配置 `version` 输入，否则会出现 `Multiple versions of pnpm specified` / `ERR_PNPM_BAD_PM_VERSION`；
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

### 11.4 本机 Host / 局域网（Phase 5，自动化无法覆盖）

| ID | 场景 | 步骤摘要 | 预期 |
| --- | --- | --- | --- |
| M21 | 两台设备同一局域网订阅安装 | A 机创建 local-host 频道并启动 Host；把「局域网地址」发给 B 机（另一台电脑），B 机 AppHub 订阅→安装→启动 | B 机能持续下载/更新；A 机 Host 停止后 B 机刷新报可读网络错误；A 机重启 Host 后 B 机恢复 |
| M22 | Windows 防火墙放行 | 首次启动 Host 时 Windows 弹出防火墙授权（专用网络）；另一台设备访问局域网地址 | 允许后另一台设备可访问；拒绝后本机回环仍可访问、局域网不可达（文档/提示与行为一致） |
| M23 | 路由器端口转发 / 域名 + publicBaseUrl 反代 | 在路由器把公网端口转到 A 机 Host 端口；或用 nginx 反代并通过「编辑配置 → publicBaseUrl」填写对外地址 | Host 面板首选地址变为 publicBaseUrl；外网/域名可下载；停/启后地址保持正确 |
| M24 | App 重启后 Host 需手动重启 | A 机关闭 AppHub 再打开；观察频道 Host 面板与订阅者访问 | Host 不会自动恢复运行（按设计只在 App 运行期有效）；需手动点「启动 Host」；面板提示清晰 |
| M25 | 大文件局域网下载 | Host 频道发布 ≥100MB 大文件；B 机安装/更新 | 下载完成、MD5 校验通过；进度可观测；Host 日志无异常；A 机 CPU/内存可接受 |
| M26 | 端口被占用/修改端口 | 用其他程序占用 Host 配置端口后启动；或用「编辑配置」改端口 | 启动失败提示 CONFLICT 且面板显示 lastError；改端口后启动成功、URL 端口同步；运行中点编辑被阻止（需先停止） |
| M27 | Host 停止/退出清理 | 运行中直接关闭 AppHub；再观察端口占用 | 进程退出后端口释放（`netstat` 验证）；再次启动 App 可重新使用原端口；无孤儿进程 |

### 11.5 数据目录迁移 / 旧版升级（Phase 6/7，自动化无法覆盖）

> 为什么不自动化：入口会弹**原生目录选择框**（Playwright 无法驱动），确认后 App **重启**并执行文件迁移；
> E2E 用 `APPHUB_USER_DATA_DIR` / `--user-data-dir` 隔离，覆盖启动期来源与旧版自动迁移，
> 但"点击迁移"动作仍保持手工。迁移核心逻辑（优先级/校验/迁移/原子写/旧版检测/回滚）由
> `apps/desktop/src/main/data-dir.test.ts`（39 用例）与 ipc 单测覆盖。

| ID | 场景 | 步骤摘要 | 预期 |
| --- | --- | --- | --- |
| M28 | 真实迁移 + 重启 + 数据完整性 | 默认目录模式启动 App，创建频道/发布 App/安装到本地库；设置页「更改数据目录」→ 选空目录 → 确认重启 | App 自动重启并指向新目录；频道、本地库（含已安装文件）、加密 channel_pri 均可用（private 频道可发布）；`system.info.dataDirSource='custom'`；旧目录不被删除 |
| M29 | 迁移目标校验边界 | 分别选择：非空目录（CONFLICT）、当前目录的子目录/父目录（VALIDATION）、与当前相同的目录（VALIDATION）、已存在文件（VALIDATION） | UI 展示对应错误码与可读文案；不重启、不破坏当前数据；`data-dir-change-error` 可见 |
| M30 | env 固定与恢复默认 | 用 `APPHUB_USER_DATA_DIR` / `APPHUB_DATA_DIR` 启动（按钮 disabled + 固定说明）；移除 env 后以 custom 目录启动，再「恢复默认数据目录」 | env 模式无法修改（UNSUPPORTED）；custom→默认执行迁移且重启后 `source='default'`、`dataDir=<userData>/AppHubData`；`apphub-bootstrap.json` 被正确删除 |
| M31 | 迁移时 Host 停止与端口释放 | local-host 频道 Host 运行中执行迁移 | 迁移前 Host 停止、端口释放（`netstat` 验证）；重启后 Host 不自动恢复（需手动启动）；迁移过程无残留临时文件 |
| M32 | 旧版真实用户升级迁移 | 用 Phase 6（或更早）版本在真实 userData 根产生数据（频道/本地库/加密配置），再用 Phase 7 启动 | 启动日志出现「已将旧版数据目录迁移到 AppHubData」；数据整体 move 到 `<userData>/AppHubData`；频道/本地库/私密频道可用；userData 根不再有 channels.json/channels/secrets/library；Chromium `Local State` 等仍在根；tmp/logs 不迁移 |
| M33 | 两个环境变量同时设置 | 同时设置 `APPHUB_DATA_DIR=E` 与 `APPHUB_USER_DATA_DIR=U` 启动，观察 `system.info` 与设置页 | 优先级：`APPHUB_DATA_DIR` 胜出（dataDir=E，source=env，editable=false）；Electron userData 仍为 U；设置页 env hint 同时展示两个变量说明；修改数据目录按钮 disabled |
| M34 | 迁移失败 / 只读磁盘回退 | 旧版数据在只读目录/权限不足、或迁移中途目标不可写；以及旧版迁移时 AppHubData 已有数据 | 迁移失败时本次启动回退旧目录（数据仍可用）并记录可读错误，下次启动重试；目标已有数据时跳过迁移不覆盖；不产生半迁移数据（move 回滚） |

> 说明：旧版自动迁移本身已有 E2E（`settings-data-dir.spec.ts > 旧版数据自动迁移`），
> M32 面向真实历史用户数据（含 secrets/library/Chromium 共存、大数据量）的人工升级验证；
> M33/M34 覆盖优先级与失败回退等难以在 E2E 安全注入的场景。

---

## 12. 实际执行结果（2026-10-27，Phase 7：默认 AppHubData / 双环境变量 / 旧版迁移）

### 12.1 环境

| 项 | 值 |
| --- | --- |
| OS | Windows（win32 / x64） |
| Node | v22.23.2 |
| pnpm | 11.22.0 |
| Electron | 38.8.6（apps/desktop devDependency） |
| Playwright | @playwright/test 1.64.1（`_electron`，无浏览器安装） |
| 网络 | 完全离线（FTP/HTTP/S3 均为进程内模拟；本机 Host 为 127.0.0.1 回环 + 本机 LAN IPv4） |
| 数据目录隔离 | 默认 `APPHUB_USER_DATA_DIR`；Phase 6/7 另用 `--user-data-dir`（default/custom、旧版迁移）与 `--user-data-dir + APPHUB_DATA_DIR`（双 env） |

### 12.2 一键验收 `pnpm verify:e2e`

```
合计 14 步：14 通过，0 失败，0 未运行；总耗时 78.3s
结果：PASS
```

| 步骤 | 结果 | 耗时 |
| --- | --- | --- |
| test @apphub/protocol | ✅ 27 tests | 1.9s |
| test @apphub/storage | ✅ 56 tests | 2.7s |
| test @apphub/core | ✅ 118 tests | 4.2s |
| test @apphub/testkit | ✅ 无测试文件（`--passWithNoTests`，设计如此） | 1.0s |
| test @apphub/tests（集成） | ✅ 37 tests / 10 files | 4.8s |
| test @apphub/desktop | ✅ 266 tests / 22 files | 11.4s |
| typecheck × 6 包 | ✅ 全部通过 | 1.1~4.0s |
| build @apphub/desktop | ✅ 产出 `out/main`、`out/preload`、`out/renderer` | 1.6s |
| e2e @apphub/desktop | ✅ 17 tests / 7 specs | 38.7s |

**自动化用例合计：504 个 Vitest 用例 + 17 个 Electron E2E 用例，0 skipped。**
（Phase 7 变更：`settings-data-dir.spec.ts` 由 3 → 5 用例（新增 APPHUB_DATA_DIR、旧版自动迁移；
env/default/custom 断言按 AppHubData 新语义更新）；desktop 单测由 255 → 266（data-dir 39 用例，
新增默认子目录/双 env 优先级/旧版检测/目标非空跳过/move 迁移/回滚/EXDEV 等）。另：
`pnpm test:e2e` 单独执行 17/17 通过（41.2s）。）

### 12.3 覆盖率（可选）

`pnpm --filter @apphub/core coverage`（Phase 5 数据；Phase 6/7 未改 core，数值不变）：

| 指标 | 数值 |
| --- | --- |
| Statements | 85.87% |
| Branches | 77.41% |
| Functions | 92.28% |
| Lines | 85.87% |

（core 共 118 单测 + 37 集成测试共同覆盖；`host.ts` 85.16%、`publish.ts` 92.12%；`mutex.ts`/`progress.ts` 100%。）

### 12.4 E2E 稳定性

- Phase 7 全量 E2E：17/17 通过（`pnpm test:e2e` 41.2s；`verify:e2e` 内 37.8~50.0s，两次运行均 PASS）。
- 新增/更新的设置页数据目录 5 用例首次接入即通过（env 双变量/default/custom/旧版迁移）；
  旧版迁移用例真实执行 move 迁移并校验 `channels.list` 可见旧频道。
- Phase 6 收尾修复的测试侧问题（#10 选择器作用域、#11 集成端口竞争）本轮未复现；
  集成测试仍保持 37/37、E2E 无 flaky。
- 说明：旧版迁移 E2E 采用"纯文件预置 + 一次启动"（不先跑旧版 App），比"先跑再挪"更稳定；
  Chromium 缓存/日志与 AppHubData 的隔离由 `keep-me.txt` 保留 + 路径断言间接验证。

### 12.5 跳过/未执行项

| 项 | 原因 | 处理 |
| --- | --- | --- |
| 真实 FTP/nginx/MinIO 服务 | 自动化必须离线，CI 不部署外部服务 | 列入 §11 手工清单 M1–M4 |
| 原生文件/目录对话框、真实启动外部 App、打包安装 | Playwright 无法驱动系统对话框、外部进程副作用大 | §11 M5–M7、M10–M14、M22–M23 |
| **点击「更改数据目录」→ 迁移 → 重启** | 先弹原生目录选择框，确认后 App 重启并断开会话；E2E 已覆盖启动期 env/default/custom 与旧版自动迁移，但不覆盖"点击迁移"动作 | 迁移逻辑由 `data-dir.test.ts` 39 单测 + 手工 M28–M34 覆盖（原因见 §8.9/§8.10/§11.5） |
| 两台真实设备同局域网/防火墙/端口转发 | 需要真实第二台设备与网络配置 | §11 M21–M25 |
| macOS/Linux 实机 GUI | 当前环境仅 Windows；命令与 CI 配置已就绪 | 发布前手工 M5–M7 |
| 无网卡环境的 LAN URL 可达性 | 隔离 CI 容器可能没有非 internal IPv4 | E2E 用例显式 `test.skip` 并写明原因（不静默）；首选地址回退回环有断言 |

> 没有为了"变绿"而 skip 任何计划内用例；Phase 7 的 5 个数据目录 E2E 均真实执行（含旧版 move 迁移）。
> "点击更改数据目录"的对话框/重启部分明确列为手工（M28–M34），不是静默跳过。

---

## 13. 已知限制与边界

1. **完整性 = size + MD5，不是防篡改签名**：安全性依赖 HTTPS 与可信订阅来源（PROTOCOL §9）。
   已安装文件被本地篡改时 `verify` 能发现，但无法证明远端来源可信。
2. **远端被外部篡改无法通过"幂等发布"修复**：若有人直接改动存储里的对象字节，重新发布同版本同内容
   会被幂等逻辑判为"已存在且一致"而跳过上传；需发布新版本或手动删除后重发。
3. **FTP 无 CAS / 跨进程并发**：同一 App 进程内，Phase 5 起同频道发布已通过频道级互斥
   （`channel-write:<channelId>`）串行化，同频道不同 App 并发不再丢 `channel.json`；但**跨机器/跨进程**
   同时写同一频道仍是"读-合并-写回、最后写入者胜出"，建议同一频道发布集中在一台机器或使用 S3
   （ARCH §7）。
4. **E2E 不触发原生对话框与外部进程**（§8.7），这些路径靠主进程单测 + 手工清单保障。
5. **E2E fixture 是手工构造的协议仓库**，不经过 core 发布端；发布端正确性由 L1/L2 覆盖。
6. **本机 E2E 依赖桌面会话**：无头 Linux 必须 `xvfb-run`；root 用户可能需要 `--no-sandbox`
   （测试专用，不作为产品默认）。
7. **大文件/超大文件数上限**按协议 `LIMITS`（相对路径 1024、文件数 100000、总大小 1TiB）；
   极端规模需要手工 M17 验证，不作为 CI 常规项。
8. **Playwright 报告目录**位于 `apps/desktop/e2e/.tmp/`（已被根 `.gitignore` 的 `.tmp/` 忽略）。
9. **本机 Host 只在 AppHub 运行期间有效**：Host 运行状态只存内存，App 退出/取消订阅会停止 Host，
   重启 App 后不会自动恢复（需手动「启动 Host」）。这是产品既定行为，非缺陷。
10. **本机 Host 无 HTTPS/鉴权**：任何能访问 Host 端口的人都能读取公开频道；私密频道依赖能力链接
    （与 PROTOCOL §9 的安全边界一致）。公网使用需反代 + `publicBaseUrl`，并自行保证 TLS。
11. **Host 端口可达性依赖系统防火墙/网络策略**：绑定 `0.0.0.0` 只是"愿意监听所有网卡"，是否可被
    其他设备访问取决于防火墙放行、是否同网段、路由器是否转发。E2E 只验证本机侧可达性。
12. **E2E 的 LAN 用例可能 skip**：隔离 CI 容器没有非 internal IPv4 时会显式 skip 并记录原因；
    这不代表 Host 功能未验证——本机回环链路仍有完整断言。
13. **本机 Host 端口可能被占用**：默认 8787 会被其他程序占用；测试与生产 UI 都应允许改端口
    （端口冲突错误码 `CONFLICT`，面板展示 lastError）。
14. **默认 AppHub 数据目录是 `<Electron userData>/AppHubData`**（Phase 7）：与 Electron/Chromium
    的缓存、`Local State` 等隔离；设置里的「更改数据目录」只影响 AppHub 数据，不改变 Electron 自身路径。
15. **两个环境变量语义不同**：`APPHUB_DATA_DIR` 只改 AppHub 数据目录（Electron userData 不变）；
    `APPHUB_USER_DATA_DIR` 是历史语义，整体覆盖 Electron userData（AppHub 数据位于该目录根）。
    两者同时设置时 `APPHUB_DATA_DIR` 优先。两者都会让设置页只读（`editable=false`）。
16. **迁移目标必须为空目录**（`CONFLICT`），也不能与当前目录互相嵌套（`VALIDATION`）；
    「恢复默认」是唯一允许目标非空的场景（目标固定为 `<userData>/AppHubData`，覆盖同名 managed entries）。
17. **点击迁移 = 复制 + 重启**：旧目录不会自动删除（便于回滚）；只复制 AppHub managed entries
    （`channels.json`/`channels`/`secrets`/`library`/`apphub.json`），不复制 `tmp/`、`logs/`、Chromium 缓存。
18. **迁移会重启 App**：Host 随 core 关闭而停止；重启后不会自动恢复 Host，需要手动启动（与 §13.9 一致）。
19. **旧版数据自动迁移**（Phase 7）：userData 根存在 managed 条目且 AppHubData 尚无数据时，启动阶段
    **move**（EXDEV 时 copy+rm）到 AppHubData；目标已有数据则跳过不覆盖；迁移失败会回滚已移动条目、
    本次回退旧目录并记录错误，下次启动重试。tmp/logs/Chromium 文件不动。
20. **自动化边界**：旧版自动迁移已有 E2E；"点击更改数据目录 → 迁移 → 重启"未做 E2E（原生对话框 +
    进程重启），由 `data-dir.test.ts` 39 单测 + 手工 M28–M34 覆盖（见 §8.7/§8.10/§11.5）。
21. **启动期数据目录不可用**：`source='custom'` 时弹原生模态对话框提供「恢复默认数据目录并重启 / 退出」，
    App 不退出但不创建窗口（CDP 无 page target）；`source='default'/'env'` 时直接 `exit(1)`，
    main.log 先落盘 `[ERROR] 数据目录不可用…`。由 `data-dir.test.ts` 单测覆盖，E2E 不注入。

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
| 本机 Host 启动报 `CONFLICT 端口被占用` | 默认 8787 或其他程序占用了配置端口 | 在 Host 面板「编辑配置」改端口（需先停止）；测试一律 `getFreePort()` |
| 本机 Host 启动后本机 fetch 正常、其他设备打不开 | Windows 防火墙未放行 / 不同网段 / 路由器未转发 | 放行 TCP 端口（专用网络）；确认同一局域网；公网用端口转发或反代 + `publicBaseUrl` |
| Host 面板不出现 | 频道是订阅者身份，或频道 `storage.provider` 不是 `local-host` | 订阅者不显示 Host；非 local-host 频道 `host.status` 返回 UNSUPPORTED（UI 静默隐藏） |
| Host 运行中无法保存配置 | 设计如此：运行中 `updateConfig` 返回 STATE | 先「停止 Host」再编辑配置 |
| Host 停止后端口仍被占用 | 有残留 Electron 进程 / 外部程序占用 | 关掉残留进程；`netstat -ano | findstr :<port>` 定位占用者 |
| E2E `local-host` LAN 用例显示 skipped | 当前机器没有非 internal IPv4（隔离容器常见） | 属预期；报告中标注原因，换有网卡环境可实跑 |
| E2E 订阅用例偶发 `订阅地址必须指向 channel.json` | Phase 5 曾出现的 fill→click 竞态（已修测试） | fill 后用 `toHaveValue` 确认；用 poll 等终态；若复现看失败信息里的 inputValue |
| 创建向导端口推荐值不是预期 | 页面已有 local-host 频道占用了 8787/8788，或 `host.list` 尚未返回 | 等 `toHaveValue` 稳定值；确认预置频道的 `configuredPort`；没有已用端口时默认 8787 |
| 设置页「更改数据目录」按钮灰色 | 当前以 `APPHUB_DATA_DIR` 或 `APPHUB_USER_DATA_DIR` 启动（env 模式只读）或正在迁移 | 移除环境变量后重启；env 固定属预期行为 |
| 数据目录显示为 `<userData>/AppHubData` 而不是 userData 根 | Phase 7 默认行为（AppHubData 子目录隔离） | 属预期；Chromium 缓存仍在 userData 根 |
| 数据目录显示为某个 userData 根目录 | 设置了 `APPHUB_USER_DATA_DIR`（历史语义：整体覆盖 userData） | 确认是否要改用 `APPHUB_DATA_DIR`（只改 AppHub 数据） |
| 两个环境变量同时设置时以哪个为准 | 优先级：`APPHUB_DATA_DIR` > `APPHUB_USER_DATA_DIR` | 看系统信息数据目录与设置页 env hint；去掉 `APPHUB_DATA_DIR` 后回落到 userData 语义 |
| 旧版数据升级后「数据不见了」/ 仍是空库 | 旧版数据已 move 到 `<userData>/AppHubData` | 检查该目录下 channels.json/channels；旧根目录不再有这些条目；查看 main.log「已将旧版数据目录迁移到 AppHubData」 |
| 旧版迁移未发生 | AppHubData 下已有 managed 数据（跳过不覆盖），或 userData 根没有 managed 条目 | 查看 main.log「跳过旧版迁移」；如需强制迁移，先备份并清空 AppHubData 后再启动 |
| 旧版迁移失败后仍可用旧数据 | 设计如此：迁移失败回滚并本次回退旧目录，下次启动重试 | 查看 main.log 的迁移错误；修复权限/磁盘后重启；数据不会半迁移 |
| 更改数据目录报 `CONFLICT 目标目录非空` | 目标目录已有任何文件（含系统隐藏文件） | 选择空目录，或用「恢复默认数据目录」 |
| 更改数据目录报 `VALIDATION 目标目录不能位于当前数据目录内` | 选到当前数据目录的子/父目录（避免递归迁移） | 选择与当前目录无嵌套关系的路径 |
| 迁移重启后 App 打不开/数据不见 | 引导配置 `apphub-bootstrap.json` 指向的目录被删除或不可写 | 手工删除 Electron userData 下的 `apphub-bootstrap.json` 恢复默认目录后重启；见 M28–M30 |
| 启动后无窗口、进程存活（custom 数据目录不可用） | 主进程弹原生「恢复默认数据目录并重启 / 退出」对话框（设计如此） | 在对话框选择恢复默认；或删除 userData 下 `apphub-bootstrap.json` 后重启 |
| App 启动即退出（default/env 数据目录不可用） | core 初始化失败，主进程 `exit(1)` | 查看 userData/logs/main.log 的 `[ERROR] 数据目录不可用`（含 source/dataDir/reason）；修复目录权限或移除 env 后重启 |

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
| 7 | E2E 订阅用例偶发把非法 URL 传给主进程（约 2/5 次），表现为 `订阅地址必须指向 channel.json`（VALIDATION） | 全量 E2E 偶发失败 | 测试侧竞态：`fill` 后立即点提交。修复：fill 后用 `toHaveValue` 确认受控输入、用 `expect.poll` 等「详情/错误」终态并在失败时打印 inputValue/error；修复后连续 13 次全量 E2E 全绿 |
| 8 | **core 并发缺陷**：同频道、不同 App 的 publish 真并发（互斥 key 仅 App 级 `publish:<channelId>:<appId>`），并发写本地 `channels/<id>/channel.json` 缓存，Windows 上 `rename` 替换偶发 `EPERM`（集成测试约 1/6 概率失败）；且与 ARCH §7「同一频道/App 的发布串行化」不一致 | 集成测试偶发失败；并发发布可能报错 | 已上报 core-dev 并修复：① 新增频道级互斥 `channel-write:<channelId>`，publish/updateMeta/channels.update 共用；② `fs.writeFileAtomic` 的 rename 对 EPERM/EBUSY/EACCES/ENOTEMPTY 重试 5 次（10~40ms 退避）；③ `writeChannelCache`/`writeAppMetaCache` 按 channel/app 串行化。core 新增 3 个回归测试（118 tests），修复后集成测试连跑 3 次 37/37、`verify:e2e` 14/14 |
| 9 | 并发发布用例本身（QA 编写）在 Phase 4 未被充分压测：单次执行通过，但在 Phase 5 更高并行负载下暴露上述缺陷 | 说明"并发用例只跑一次"不足以保证并发正确性 | 保留该用例作为频道级串行化回归；后续同类并发场景建议连续多轮执行（core 回归已覆盖 5 轮） |
| 10 | Phase 6 E2E 首次编写端口避让用例时，`getByText(/已用端口/)` 命中了底层频道卡片标题（预置频道名含"已用端口"），而非向导 hint | 2 个新 E2E 失败（测试定位问题） | 把 hint 定位限定在 `create-channel-form` 内，并断言更具体的「已自动避开已使用端口」文案；修复后 3/3 通过 |
| 11 | Phase 6 收尾 `verify:e2e` 偶发失败：`local-host.test.ts` 公开全链路在 `host.start` 报 `CONFLICT 端口已被占用`（约 1/8 概率） | 集成测试偶发失败（测试基础设施竞争窗口，非产品缺陷） | 根因是 `getFreePort()` 关闭探测端口到 Host 真正 listen 之间的竞争窗口（并行跑 10 个集成文件时更易碰）。测试侧加 `startHostResilient`：仅对 CONFLICT 用 `updateConfig({port: 新 getFreePort()})` 重试（最多 3 次）；端口冲突用例仍显式断言 CONFLICT 不走 helper。修复后集成连跑 5 次 37/37、`verify:e2e` 连跑 3 次 PASS |

> Phase 5（本机 Host）Host 功能本身**未发现源码缺陷**；7 个集成用例与 3 个 E2E 用例首次接入即通过。
> 本轮发现的 2 个问题分别属于 E2E 测试侧竞态（#7）与 core 并发写（#8，已由 core-dev 修复）。
>
> Phase 6（默认 local-host / 端口避让 / 数据目录）**未发现源码缺陷**；新增/修改用例的功能性断言
> 均一次通过，收尾的 2 个失败均为测试侧问题（#10 选择器作用域、#11 端口竞争窗口，均已修复并复跑验证）。
> 数据目录迁移的复杂边界由 `data-dir.test.ts` 单测 + 手工 M28–M34 覆盖。
>
> Phase 7（默认 AppHubData / 双环境变量 / 旧版迁移）**未发现源码缺陷**；5 个数据目录 E2E（含旧版
> move 迁移、APPHUB_DATA_DIR、双 env 语义）首次接入即全部通过，无测试侧问题需要记录。
> 迁移/重启动作仍由 `data-dir.test.ts` 39 单测 + 手工 M28–M34 覆盖。

---

## 16. 附录：自动化用例索引

### 16.1 集成测试（`tests/integration`，37 用例）

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
| `local-host.test.ts` | 7 | 公开全链路（start→订阅→安装→更新 MD5 复用→stop 失败→restart→卸载）；私密能力链接/错误 accessKey 404/非管理员 publish；zip 安装；端口冲突 CONFLICT；stop 后端口复用；updateConfig（STATE/端口/advertiseHost/rootDir 不可改）；非 local-host UNSUPPORTED/NOT_FOUND |

### 16.2 E2E（`apps/desktop/e2e`，17 用例）

| spec | 用例数 |
| --- | --- |
| `smoke.spec.ts` | 2 |
| `subscribe-install-uninstall.spec.ts` | 2 |
| `create-channel.spec.ts` | 1（含默认 local-host/端口 8787 断言） |
| `create-channel-port.spec.ts` | 3（规则避让/两端口避让/手动覆盖+重复端口校验） |
| `settings-data-dir.spec.ts` | 5（env-USER_DATA_DIR / env-DATA_DIR / default AppHubData / custom / 旧版自动迁移） |
| `publish-wizard.spec.ts` | 1 |
| `local-host.spec.ts` | 3（创建/自动启动/停止重启、LAN 可达性、私密能力链接） |

详见 §8.5 表格。

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
