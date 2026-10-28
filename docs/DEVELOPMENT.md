# 开发、测试与发布

[← 返回 README](../README.md)

## 环境要求

Node.js ≥ 20.19、pnpm ≥ 10（仓库用 pnpm 11 开发）、Windows/Linux/macOS。

## 常用命令

```bash
pnpm install        # 安装依赖（会下载 Electron）
pnpm dev            # 开发模式：Vite HMR + Electron
pnpm build          # 构建 out/main、out/preload、out/renderer
pnpm start          # 构建并以生产模式启动
pnpm package        # electron-builder 打包（--dir 产物在 apps/desktop/release）
pnpm dist:win       # 生成 Windows 安装器 AppHub-Setup-*.exe、zip、latest.yml/blockmap（x64）
pnpm test           # 全部单元/集成测试（离线，进程内模拟 FTP/nginx/S3）
pnpm typecheck      # 所有包 TypeScript 严格检查
pnpm verify         # 一键验收：全部 test + typecheck + desktop build
pnpm verify:e2e     # 一键验收（含真实 Electron Playwright E2E，14 步）
pnpm demo           # 无需 GUI 的全链路演示：FTP+nginx 频道 + 本机 Host 频道
```

开发/测试环境可使用 `APPHUB_USER_DATA_DIR` 整体隔离 Electron userData 与 AppHub 数据（便于多实例与 E2E）；`APPHUB_DATA_DIR` 只隔离 AppHub 数据目录、不影响 Electron 缓存。

## 测试

```bash
pnpm test
pnpm --filter @apphub/core test
pnpm --filter @apphub/storage coverage
pnpm test:e2e
```

测试完全离线：集成测试在进程内启动 FTP 服务器（ftp-srv）、静态 HTTP 服务器、S3 服务器（s3rver），真实地走存储协议，不依赖外网或真实服务器。测试策略与手工验收清单见 [TESTING.md](./TESTING.md)。

## CI

- **verify**：GitHub Actions（Windows + Linux/xvfb）配置在 [`.github/workflows/verify.yml`](../.github/workflows/verify.yml)，执行 `pnpm verify:e2e` 并上传 E2E 报告。
- **release**：[`.github/workflows/release.yml`](../.github/workflows/release.yml) 在推送 `v*` 标签后自动验证、打包并创建 GitHub Release；手动触发只构建 artifact，不发布。

## 发布新版本

1. 同步根 `package.json` 与 `apps/desktop/package.json` 的 `version`（例如 `0.1.2`）；
2. 提交后打标签并推送：

```bash
git commit -am "chore: release v0.1.2"
git tag v0.1.2
git push origin master v0.1.2
```

`release.yml` 会校验标签与版本号一致（`v<version>`），执行 `pnpm verify:e2e`、`pnpm dist:win`，并把 `AppHub-Setup-<version>.exe`、`AppHub-<version>-win-x64.zip`、`latest.yml`、`AppHub-Setup-<version>.exe.blockmap`、`SHA256SUMS.txt` 上传到 GitHub Release。

> 自动更新依赖 Release 中的 `latest.yml` 与 blockmap；缺少这两个资产时旧版本无法自动更新。首个带更新器的版本仍需用户手动安装一次；之后的正式版本可由用户在 App 内自行更新。

发布流程与资产校验细节见 [ARCHITECTURE.md §10](./ARCHITECTURE.md)。

## 修复历史重复 App

v0.1.0 的“发布新版本”没有把原 App 的 `appId` 传给主进程；当 `displayName` 与 `appId` 不一致时（例如 `appId=cpu_z`、`displayName=CPU-Z`），会按名称重新生成 `cpu-z`，导致 `channel.json` 出现两个 App。**该问题已修复**：新版本发布会始终携带原 `appId`（并有回归测试覆盖）。

如果旧频道已经产生重复 App，可先停止该频道的 Host，再对**频道仓库目录**执行修复脚本（脚本会移动版本目录、合并元信息、更新 `channel.json`，并保留 `.repair-backup-*` 备份）：

```bash
# 先 dry-run 确认；<频道仓库目录> 为创建 local-host 频道时选择的目录
pnpm repair:duplicate-app -- --root "<频道仓库目录>" --keep cpu_z --merge cpu-z --dry-run
pnpm repair:duplicate-app -- --root "<频道仓库目录>" --keep cpu_z --merge cpu-z
```

修复后重启 Host，并在 AppHub 中刷新频道即可。建议保留 `--keep` 为最初创建 App 时使用的 appId（已安装 App 的更新连续性依赖它）。

## 项目结构

```
AppHub/
├── packages/
│   ├── protocol/   协议层：channel.json / app.meta.json / files.json schema、路径/URL/semver、错误
│   ├── storage/    存储适配器：local / local-host / ftp-http / s3 + 工厂
│   ├── core/       领域服务：频道、发布（散文件/zip）、订阅、安装/更新/校验/本地库、Host
│   └── testkit/    测试基础设施：临时目录、静态服务器、FTP/S3 模拟服务器、fixtures
├── apps/desktop/
│   ├── shared/     IPC 契约 + zod 入参校验
│   ├── src/main/   Electron 主进程（IPC、文件选择、安全、启动本地 App、加密凭据、自动更新）
│   ├── src/preload/ contextBridge API
│   ├── src/renderer/ React UI
│   ├── build/      应用图标（png/ico/icns，由 scripts/generate-icons.py 生成）
│   └── e2e/        Playwright Electron E2E
├── tests/          跨包集成测试
├── docs/           架构/协议/存储/测试/使用文档
├── scripts/        demo / 图标生成 / 一键验收 / 数据修复脚本
├── .github/workflows/ CI（verify）与自动发布（release）
└── LICENSE         MIT
```

## 应用图标

应用图标由 `scripts/generate-icons.py` 生成（Pillow），产物（`icon.png` / `icon.ico` / `icon.icns`）位于 `apps/desktop/build/`，electron-builder 打包时自动使用。
