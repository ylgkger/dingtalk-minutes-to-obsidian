# DingTalk Minutes Sync for Obsidian

将钉钉 AI 听记同步为 Obsidian Markdown 笔记的桌面端插件。

## 功能

- 同步 AI 摘要、关键词、待办和可选逐字稿
- 使用听记实际开始时间命名文件
- 支持 7 天、30 天或一年的首次同步范围
- 通过本机已登录的 `dws` 访问钉钉，不保存密码、Cookie 或 AppSecret
- 逐字稿不可用时仍同步其他内容

## 安装

1. 安装并登录 [DingTalk Workspace CLI](https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli)。
2. 将 `main.js`、`manifest.json` 与 `styles.css` 放入 Obsidian Vault 的 `.obsidian/plugins/dingtalk-minutes-sync/`。
3. 重启 Obsidian，在第三方插件设置中启用 **DingTalk Minutes Sync**。

## 限制

插件依赖本机 CLI，因此仅支持 Obsidian 桌面端。钉钉未返回逐字稿的个别听记会保留摘要、关键词与待办，并在笔记中说明逐字稿不可用。
