# @modusensus/dsh-chat-mode

Melete 的 DSH 插件形态：把 chat-demo 的聊天体验（无工具、短思考、快流式）做成
DSH 里的「聊天模式」。**记忆松耦合**——装了 mneme 则记忆注入/蒸馏经宿主管线
自动生效；没装则纯聊天照常。本插件不实现任何记忆逻辑。

## 骨架范围（v0.0.1）

- ✅ host 服务：注册「闲聊」agent 预设（`PresetDefinition`：无工具行，persona 行待验证）+ Typert 远端 `status()` 读数
- ✅ client：slots 注册主面板页（`'main'`）+ locale（zh/en）
- ⏳ phase 2：代管 workspace 注册（官方导入对话框自动出现聊天归档目标）、导入会话在聊天页续聊、persona 行 config 验证、消息级撤回（排除轮先例）

## 开发

```bash
pnpm install                     # 仓库根（workspace：web + dsh-plugin）
pnpm --filter @modusensus/dsh-chat-mode typecheck
pnpm --filter @modusensus/dsh-chat-mode build
```

安装到 DSH：`dsh plugin --profile <name> add ./dsh-plugin`（或发布后从插件市场）。

## 参照物

- 官方 `packages/experimental/deepseek-chat-import`（MIT）：插件范式 / Typert / workspaceRegistry
- [DSH-Bot](https://github.com/MJ-CJM/DSH-Bot)（MIT）：slots 主面板 + preset 组合器 + `docs/dsh-api-notes.md`（DSH API 全量笔记）
