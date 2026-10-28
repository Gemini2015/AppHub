# AppHub

[![verify](https://github.com/Gemini2015/AppHub/actions/workflows/verify.yml/badge.svg)](https://github.com/Gemini2015/AppHub/actions/workflows/verify.yml)
[![release](https://github.com/Gemini2015/AppHub/actions/workflows/release.yml/badge.svg)](https://github.com/Gemini2015/AppHub/actions/workflows/release.yml)

> 去中心化的 App 分享、订阅与本地管理工具。

没有中心服务器：频道所有者用自己的存储（FTP + nginx / 本地目录 + 静态服务 / S3 / MinIO / 内置本机 Host）托管 App；
任何人拿到 `channel.json` 链接即可订阅公开频道，或凭私密能力链接订阅私密频道。
AppHub 基于 **Electron + React + TypeScript**，支持 Windows / Linux / macOS。

**[下载安装](docs/INSTALL.md)** · **[使用指南](docs/USAGE.md)** · **[开发文档](docs/DEVELOPMENT.md)** · **[架构](docs/ARCHITECTURE.md)** · **[测试与验收](docs/TESTING.md)**

![AppHub 本机 Host 面板](docs/screenshots/09-host-panel.png)

## 核心亮点

- **去中心化频道**：频道所有者用自己的 FTP+nginx、本地目录、S3/MinIO 或内置本机 Host 托管 App；
- **频道内发布/订阅**：`channel.json` + `app.meta.json` + `files.json`，支持散文件与 zip 两种发布方式；
- **本地库管理**：安装、更新、校验（size + MD5）、启动、打开目录、卸载；失败保留旧版本；
- **本机 Host 一键分享**：内置 HTTP Host Server，默认局域网可访问，频道可随时启停；
- **数据目录隔离**：默认 `<Electron userData>/AppHubData`，可迁移，不影响 Electron 自身缓存；
- **非强制应用内更新**：自动发现新版本，由用户决定是否下载/重启安装。

## 快速开始

环境要求：Node.js ≥ 20.19、pnpm ≥ 10（仓库用 pnpm 11 开发）。

```bash
pnpm install
pnpm dev             # 开发模式（Vite HMR + Electron）
pnpm verify:e2e      # 完整验收（测试 + typecheck + build + Electron E2E）
pnpm demo            # 无需 GUI 的全链路演示
```

更多命令、测试与发布流程见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)。

## 文档导航

| 文档 | 内容 |
| --- | --- |
| [下载安装与自动更新](docs/INSTALL.md) | Windows 安装包、自动更新、首版升级说明 |
| [使用指南](docs/USAGE.md) | 功能一览、创建频道、本机 Host、发布、订阅、安装/更新、数据目录 |
| [开发、测试与发布](docs/DEVELOPMENT.md) | 命令、测试、CI、发布、项目结构、历史数据修复 |
| [架构设计](docs/ARCHITECTURE.md) | 分层、数据流、本地数据目录、IPC、并发、构建发布、自动更新 |
| [协议格式](docs/PROTOCOL.md) | `channel.json` / `app.meta.json` / `files.json` schema 与版本历史 |
| [存储后端](docs/STORAGE.md) | local / local-host / ftp-http / s3 配置与实现 |
| [测试与验收](docs/TESTING.md) | 测试分层、覆盖矩阵、手动验收 M1–M36、CI 说明 |
| [安全说明](docs/SECURITY.md) | 凭据、下载/解压、Host 暴露面、公开仓库注意事项 |
| [界面截图](docs/SCREENSHOTS.md) | 真实 Electron 构建截图 |
| [路线图](docs/ROADMAP.md) | 候选方向（非承诺） |

## 质量状态

- `pnpm verify:e2e`：**14/14 步通过**（Windows + Linux CI）；
- Vitest：**550 个用例，0 skipped**；Electron E2E：**19/19 通过**；
- 测试策略、覆盖矩阵与手工验收清单见 [docs/TESTING.md](docs/TESTING.md)。

## License

MIT，见 [LICENSE](LICENSE)。
