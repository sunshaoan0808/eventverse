# EventVerse HTTP API

Base：`http://127.0.0.1:18700`。所有请求/响应为 JSON（UTF-8）。流式端点使用 SSE（`text/event-stream`），事件形如 `event: <name>\ndata: <json>`。
鉴权：默认无（本地优先，仅绑定 127.0.0.1；远程部署请自行加反代鉴权）。

## 系统

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/health` | 健康检查：`{ok, version, worlds, funnelDemo}` |

## 世界与事件流（事实层）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/worlds` | 世界列表 |
| POST | `/api/worlds` | 建世界 `{id?, title}` |
| GET | `/api/worlds/:id/state?at=<worldTime>` | 当前/任意时刻世界状态（时间轴重放） |
| GET | `/api/worlds/:id/visible-state?viewer=&at=` | 指定角色视角的可见状态（可见性过滤） |
| GET | `/api/worlds/:id/timeline` | 事件时间线（summary 已汉化） |
| GET | `/api/worlds/:id/events?fromSeq=&toSeq=&kind=` | 原始事件流 |
| GET | `/api/worlds/:id/diff?from=&to=` | 两时刻状态差异 |
| POST | `/api/worlds/:id/branch` | 世界线分支 `{title, fromSeq?}` |
| GET | `/api/worlds/:id/usage` | 用量报表（按角色×模型） |
| GET | `/api/worlds/:id/metrics` | 回合指标：千回合 idle 率 / 文风分布 |
| GET | `/api/worlds/:id/redteam` | 红队泄漏扫描（过滤器层） |
| PATCH | `/api/worlds/:id/tier` | 世界内容分级上限 `{maxTier: safe\|standard\|open}` |

## 事件与回滚

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/events` | 作者级直接入库（跳过漏斗）`NewEventInput` |
| POST | `/api/events/:id/rollback` | 回滚（标记 superseded，不删除）`{reason?}` |
| POST | `/api/migrate/legacy-events` | v1→v2 事件迁移（幂等）`{worldId?}` |

## 审核（对抗审漏斗）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/worlds/:id/proposals?status=` | 提案列表（pending/approved/rejected） |
| POST | `/api/proposals/:id/approve` | 批准并落库（含 baseSeq 乐观锁重校验，冲突 409） |
| POST | `/api/proposals/:id/reject` | 拒绝 |

## 作品与章节（写侧）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET/POST | `/api/works?worldId=` | 列表 / 新建 `{worldId, title, ...}` |
| PATCH/DELETE | `/api/works/:id` | 改 / 删（连带正文目录） |
| GET/POST | `/api/works/:id/chapters` | 章节列表 / 新建 `{title, worldTime?, body?}` |
| GET/PUT/DELETE | `/api/chapters/:id` | 读（含 body）/ 改 / 删 |
| POST(SSE) | `/api/works/:id/finalize` | 定稿：锚点入库 + 手改同步提案 `{chapterId, title, index, worldTime, body}` |

## 会话（玩 / 写）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET/POST | `/api/sessions?worldId=` | 列表 / 创建 `{worldId, mode: rp\|write, title, workId?, profile?, packId?, entryRole?, playMode?}`（RP 自动 min() 分级） |
| GET/DELETE | `/api/sessions/:id` | 读全文 / 删 |
| POST(SSE) | `/api/sessions/:id/turn` | RP 回合 `{message, optionIndex?}` → 事件 `beat/content/prose/dice/pack_move/idle/proposal/done/error` |
| POST(SSE) | `/api/sessions/:id/write-draft` | 写作草稿 `{outline, chapterTitle}` → `beat/content/prose/done` |
| POST(SSE) | `/api/sessions/:id/rewrite` | 圈改局部重写 `{draft, selection, instruction}` → `content/full/done` |

## 世界问答（读侧 agent）

| 方法 | 路径 | 说明 |
|------|------|------|
| POST(SSE) | `/api/chat` | `{worldId, workId?, viewerCharId?, message, history?}` → `tool/tool_result/content/done`（读侧 ≤12 次工具） |

## 剧本包（玩侧 StoryPack）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/packs?worldId=` | 列表（含 playable 校验） |
| GET/POST/DELETE | `/api/packs/:id` | 读 / 保存 `{worldId, pack}` / 删 |
| POST | `/api/packs/:id/start` | 开局 `{entryRole, playMode, charId?, contentTier?}` → 新 RP 会话（携带节点进度） |

## 导入 / 导出（生态）

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/import` | 拆书 `{worldId, title, text, baseYear?, llmChapterBudget?}` → 202 `{jobId}`（同世界并发 409；原文持久化供续跑） |
| POST | `/api/import/st-card` | ST 角色卡 `{worldId, card\|pngBase64, worldTime?}` |
| POST | `/api/import/worldbook` | 独立世界书 `{worldId, book, worldTime?}` |
| GET | `/api/worlds/:id/export/worldbook` | 导出 ST 世界书 |
| POST | `/api/wizard` | 开书向导 `{worldTitle?, era?, baseYear?, characters[], relations[](secret?), facts[], guidance?}` |

## Jobs（长任务）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/jobs` / `/api/jobs/:id` | 列表 / 详情（status/progress/cursor/result） |
| POST | `/api/jobs/:id/cancel` | 取消 |
| POST | `/api/jobs/:id/resume` | 断点续跑 `{text?}`（缺省读持久化原文） |
| GET(SSE) | `/api/jobs/:id/stream` | 进度流 |

## 元层自进化

| 方法 | 路径 | 说明 |
|------|------|------|
| POST(SSE) | `/api/worlds/:id/evolve` | `{autoApply?}` → `evolve_proposal/regression_gate/applied/error`（回归门退化自动拒绝） |
| GET | `/api/worlds/:id/evolve/history` | prompt 覆盖历史 |
| POST | `/api/evolve/:overrideId/rollback` | 回滚到上一版覆盖 |

## Guidance 与成本门

| 方法 | 路径 | 说明 |
|------|------|------|
| GET/POST | `/api/worlds/:id/guidance` | 列表 / 新增 `{title, description}` |
| PATCH | `/api/guidance/:id` | `{active}` 启停 |
| GET | `/api/worlds/:id/usage/gate` | 成本门：各角色 vs 基线涨跌（>20% → breached） |
| POST | `/api/worlds/:id/usage/baseline` | 以当前用量设定基线（无用量 400） |

## 设置

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/settings` | 供应商列表（Key 脱敏） |
| PUT | `/api/settings` | 保存供应商（Key 留空保持不变；AES-256-GCM 落盘） |
