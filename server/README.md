# melete server — 本地伴随服务

chat-demo（melete fork）没有后端：SPA 在浏览器里直接调 DeepSeek API，API key 存 localStorage。
「带本机长期记忆」这件事必须有一个本地进程承接——SPA 拿不了 SQLite，mneme 的 token 也**永远不该进浏览器**。
本目录就是那个进程：静态托管 + API 代理 + 记忆的两头（回合前注入、回合后蒸馏写回）。

```
浏览器 SPA ──(apiOrigin=http://127.0.0.1:8091)──▶ melete server
                                                  │ 1. 回合前：GET mneme /context?q=<本轮提问>
                                                  │    → 渲染成记忆块并进 system（fail-open）
                                                  │ 2. 转发 api.deepseek.com，SSE 字节透传
                                                  │ 3. message_stop 后旁路蒸馏 → POST mneme /memories
                                                  ▼
                                          mneme daemon（dsh-mneme-serve 或 DSH 外部访问）
```

chat-demo 的源码零改动——`rspack.melete.config.ts` 只把构建期的 `__API_ORIGIN__` 指向本服务；
全部记忆契约收在 `server/lib/memory-client.mjs`（日后桌面/手机 APP 换传输方式只换这一层）。

## 快速开始

```bash
# 0) mneme 数据面：二选一（token 与 DSH 面板/CLI 共用同一份）
npm i -g @modusensus/dsh-mneme && dsh-mneme-serve      # daemon：DSH 关着也常驻
#   或在 DSH 面板「设置 → 外部访问 API」开启（二选一，抢同一端口）

# 1) 开发：SPA(rspack:8090) + melete server(8091)
export MELETE_MNEME_TOKEN=<你的token>
pnpm melete          # 伴随服务，stdout 打一行 listening
pnpm melete:dev      # SPA dev server，API 已指向 8091

# 2) 生产（纯静态）：构建后由本服务托管
pnpm melete:build    # dist/ 的 __API_ORIGIN__ = http://127.0.0.1:8091
pnpm melete          # http://127.0:8091 打开即是带记忆的聊天
```

记忆面没配 token 时服务照常工作（纯代理，`/context` 永不调用），只在启动时打一行提示。

## 行为契约

| 面 | 行为 | 故障姿态 |
|---|---|---|
| 注入 | 仅 `POST /anthropic/v1/messages`：取最后一条 user 消息作查询词，`GET /context` 的画像/规则/候选渲染进 `system`（原有 system 保留在前） | fail-open：mneme 不可达/超时(3s) → 本轮按照原样转发 |
| 蒸馏 | `message_stop` 后 fire-and-forget：用 `deepseek-flash`（`MELETE_DISTILL_MODEL` 可换）非流式调一次，输出 JSON 写回 `POST /memories`（去重键 type+title+scope） | 宁缺毋滥：解析失败/skip → 不写库；写回失败只留 stderr |
| 透传 | `/models`、`/anthropic/v1/files*` 等全部路径原样转发；请求头 `accept-encoding` 钉 `identity` | 上游不可达 → 502（Anthropic 错误形状，SPA 能显示） |
| CORS | dev 下 SPA(:8090) 与本服务跨端口：白名单 `http://localhost:8090,http://127.0.0.1:8090`（`MELETE_ALLOW_ORIGIN` 可改，`*` 放开） | 陌生源不回 ACAO 头 |

## 配置（环境变量）

| 变量 | 默认 | 说明 |
|---|---|---|
| `MELETE_PORT` / `MELETE_HOST` | `8091` / `127.0.0.1` | 监听 |
| `MELETE_MNEME_TOKEN` | 空（记忆面关闭） | mneme Bearer token |
| `MELETE_MNEME_URL` | `http://127.0.0.1:8790` | mneme 数据面地址 |
| `MELETE_API_ORIGIN` | `https://api.deepseek.com` | 上游 API |
| `MELETE_DIST` | `<repo>/dist` | 静态目录；不存在则纯代理 |
| `MELETE_DISTILL` | `on` | 蒸馏写回开关（`off` 只注入不写） |
| `MELETE_DISTILL_MODEL` | `deepseek-flash` | 蒸馏模型 |
| `MELETE_CONTEXT_TOPK` | `5` | 注入候选数 |
| `MELETE_SCOPE_AGENT` / `MELETE_SCOPE_WORKSPACE` | `melete` / `chat` | scope 双维（mneme 隔离键） |
| `MELETE_ALLOW_ORIGIN` | dev 两源 | CORS 白名单 |

## 诊断

- `GET /mneme/status`：mneme 可达性、token 是否配置、蒸馏开关——接不上的第一排查点；设置页「记忆」区显示同一份读数。
- `GET /anthropic/v1/messages` 的响应头 `x-melete-injected-count` / `x-melete-injected-tier`：本轮注入读数（0 条也透出），回答下方的「已参考 N 条记忆」徽标读它；dev 跨端口场景经 `Access-Control-Expose-Headers` 放行。
- `GET|POST /mneme/memories`：管理页代理——查询串原样透传（UI 默认 `source=melete`，只看 melete 建立的行），POST 缺省注入 scope 与 source；token 在 server 侧附加，前端永不直连 daemon。编辑/删除待 mneme 数据面补路由。
- daemon 侧 `GET /context` 的 `tier`（full/degraded/unknown）是召回档位信号；降级原因只在 daemon stderr。

## 测试

```bash
pnpm melete:test    # node --test；stub mneme + stub DeepSeek 全链路（注入/透传/蒸馏/fail-open/CORS/穿越）
```

## 批量蒸馏历史会话（ingest）

把官方 App 导出的 `deepseek_data-*.zip`（v3）批量蒸馏进记忆库——**按会话**蒸馏（一次调用提炼该会话 0-3 条稳定事实），不是逐轮，400 会话 ≈ 25 分钟、几块钱：

```bash
pnpm melete:ingest --zip "C:\path\deepseek_data-xxx.zip"                # dry-run：只统计与预估，不联网
pnpm melete:ingest --zip ... --apply --key <DeepSeek key>               # 真跑
# 可选：--limit N --state <path>（断点续跑，默认与 ZIP 同目录）--model --delay --budget
```

- 会话线性化按官方口径只走 `current_message_id` 所在分支；FAILED/超限/空回答轮次不进蒸馏；超长会话头 2 轮 + 尾轮采样、中段折叠（预算 12000 字符）。
- 凭据：mneme token 用 `MELETE_MNEME_TOKEN`，DeepSeek key 用 `DEEPSEEK_API_KEY` 或 `--key`；dry-run 完全不联网。
- 蒸馏 prompt 只提取稳定信息（偏好/决定/摘要/模式/事件，最多 3 条，标题稳定可复用）——与写侧去重三元组（type+title+scope）配合，重跑靠 state 文件跳过已处理会话。

## 已知边界

- 蒸馏 dedupe 靠「type+title+scope」三元组：标题由模型生成，同类对话可能产出相近但不同的标题导致重复行——后续考虑把会话 id 织进 title 归一化。
- 蒸馏只看本轮问答，不看全史——长会话的「慢慢浮现的偏好」依赖多轮各自成文。
- 蒸馏调用假设 Anthropic 兼容端点接受 `stream:false`；若上游不支持，写回静默缺席（stderr 可见），聊天不受影响。
- daemon 无 LLM（dsh-mneme 第一期边界），蒸馏必须由本服务做；melete 自成宿主后这层换 LLM 句柄即可。
