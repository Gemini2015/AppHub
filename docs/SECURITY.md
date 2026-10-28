# 安全说明与边界

[← 返回 README](../README.md)

- 渲染进程开启 `contextIsolation` + `sandbox`，无 Node 集成；所有本地文件路径由主进程文件选择器产生并通过 token 引用；
- 远端凭据（`channel_pri.json`）使用操作系统安全存储加密后落盘；日志与错误信息不输出密码；
- 下载仅允许 http(s)，zip 解压做 zip-slip / 符号链接 / 大小上限防护；安装采用 staging + 校验 + 原子切换；
- 发布/更新完整性按需求使用 **size + MD5** 校验；MD5 用于检测传输损坏/错版本，不提供防篡改能力，生产环境请使用 HTTPS 并只订阅可信频道；
- 私密频道的安全性基于能力链接（可选的 nginx Basic Auth 可进一步加强）；发布权限基于 `channel_pri.json` 的持有；
- 本机 Host（local-host）默认监听 `0.0.0.0`，**同一局域网内的设备可访问**；不需要局域网访问时请切换为「仅本机（127.0.0.1）」。Host 不提供目录列表，拒绝隐藏文件、`channel_pri.json`、路径穿越与符号链接；v1 不内置 TLS/认证，公网暴露请使用反向代理；
- 应用自动更新仅使用构建时配置的 GitHub 官方仓库；更新包完整性依赖 `latest.yml` 的 sha512，但当前发布未做代码签名，不提供发布者签名信任；SmartScreen 相关处理不在项目范围内；
- **公开仓库注意**：`.gitignore` 已忽略 `.env*`、`channel_pri.json`、`.npmrc`、`*.pem/*.key/*.p12` 等敏感文件；请勿把 `channel_pri.json`（含 FTP/S3 凭据）、用户数据目录或本机导出文件提交到公开仓库。若凭据曾误提交，应立即轮换。

## 相关文档

- 使用与数据目录：[USAGE.md](./USAGE.md)
- 架构与安全设计：[ARCHITECTURE.md](./ARCHITECTURE.md)
- 协议与存储：[PROTOCOL.md](./PROTOCOL.md) / [STORAGE.md](./STORAGE.md)
