# 下载安装与自动更新（Windows）

[← 返回 README](../README.md)

## 系统要求

- Windows 10/11 x64
- 安装版与免安装版使用同一个 AppHub 数据目录（默认 `<Electron userData>/AppHubData`）

## 从 GitHub Releases 下载

从 [GitHub Releases](https://github.com/Gemini2015/AppHub/releases/latest) 下载：

| 资产 | 说明 |
| --- | --- |
| `AppHub-Setup-<版本>.exe` | NSIS 安装器（x64）；可选择安装目录，安装后创建开始菜单/桌面快捷方式和卸载项 |
| `AppHub-<版本>-win-x64.zip` | 免安装版；解压到任意目录后运行 `AppHub.exe` |
| `latest.yml` / `*.blockmap` | electron-updater 自动更新元数据（仅安装版使用；不要手动修改） |
| `SHA256SUMS.txt` | 上述产物的 SHA-256 校验值 |

## 应用内更新

从**首个带自动更新能力的版本**开始，Windows 安装版会在启动后自动检查 GitHub Releases 的最新正式版（已发布的 v0.1.1 还不包含更新器，需先手动安装一次带更新器的版本）：

- 发现新版本时显示非阻塞提示条，不会强制更新；
- 可点「查看更新」查看版本与 Release notes，选择「下载更新」或「稍后」；
- 下载完成后由用户选择「重启并安装」，App 重启后生效；
- 设置 / 关于 →「软件更新」提供手动检查、状态、进度和重试；
- 启动后自动检查失败只写日志，不弹出错误；离线时 App 正常使用；
- 自动更新只支持 Windows NSIS 安装版；zip 免安装版和开发模式不检查更新。

> 更新包完整性由 `latest.yml` 中的 sha512 校验；当前发布未做代码签名（与「不处理 SmartScreen」的既定策略一致）。

## 安装版与免安装版

- **安装版**：通过 NSIS 安装器安装，支持自动更新、开始菜单/桌面快捷方式和卸载项；
- **免安装版（zip）**：解压即用，不保证自动更新；升级时替换程序文件即可，AppHub 数据目录不受影响。

## 后续阅读

- 使用指南：[USAGE.md](./USAGE.md)
- 开发、测试与发布：[DEVELOPMENT.md](./DEVELOPMENT.md)
- 安全边界：[SECURITY.md](./SECURITY.md)
