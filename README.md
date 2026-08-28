# EventVerse · 叙界

> AI 长篇叙事平台 —— "玩故事"与"写故事"共用同一**事件溯源事实底座**的双门面产品。
> 设计蓝图见《AI 叙事平台设计方案》（事件流 + 可见性谓词 + 对抗审漏斗 + 双 agent 回合引擎）。

## 快速开始（Node ≥ 22.5，零配置离线可用）

```bash
npm install
npm run build
npm start
# → http://127.0.0.1:18700/
```

首次启动自动创建演示世界「双城」与作品《双城记·残卷》。未配置任何 API Key 时内置 **mock 引擎**全程可玩（离线演示模式）；在「模型设置」页配置任意 OpenAI / Anthropic 协议端点（DeepSeek / Kimi / GLM / Ollama…）后即为真实模型驱动。

```bash
# 前端开发模式（热更新）
npm run dev:web   # vite :5173，代理 API 到 :18700

# 测试
npm run test      # core 9 + engine 8 单测
npm run test -w @eventverse/adapters   # 适配器 13 单测
```

## 功能地图（对照设计方案的落地）

| 模块 | 功能 | 位置 |
|------|------|------|
| 🌍 事实层 | 事件流（append-only）、`world/work` 分离、`schema_ver`、回滚（永不物理删除）、世界线分支 | 书架 / 工作台·事件流 |
| 🕒 四视图 | **时间轴**（拖动滑块=重放到任意时刻）、**Diff**（任意两时刻差异）、**回滚**、**分支** | 工作台·时间轴 |
| 👁 可见性 | 每事件携带可见性谓词；RP 扮演角色后 recall 自动过滤（防全知泄漏） | 会话（扮演角色） |
| 🔍 对抗审漏斗 | ①自动校验（确定性）→ ②对抗审（LLM/启发式）→ ③人工批准才落库；轻事实模式分级（<500 事件免对抗审） | 工作台·审核队列 |
| 🔗 引用归一化 | 人名→角色 id 映射；同名 char.create 自动合并为属性更新（不造重复角色） | 漏斗内置 |
| 📥 拆书导入 | 启发式切章（第X章/楔子/Chapter，字数窗降级）→ 时间归位（锚点+相对表达）→ 抽取 → 漏斗；Jobs 断点/取消 | 书架·导入 |
| 🎭 双 agent 回合 | 导演（便宜模型，出 beat+张力）→ 渲染（强模型，零工具沉浸）→ TurnEnd 记账 → **idle 断言**（零状态变化下回合强制破局）；🎲 d20 骰子注入（>15 强制意外） | 会话·玩 |
| 📦 玩侧 StoryPack | 节点图剧本包 + **EntryRole**（穿主角/配角/路人/异世界来客）+ **canon 硬跳/advance/idle 引擎标签白名单** + mainline/free 模式 + 可玩门槛校验；内置演示包「双城·雪夜线」 | 会话·剧本包 |
| 🔞 内容分级 | `min(user, pack, global)` 三方取小，创建时算死；世界级上限可配 | 自进化 tab / 会话创建 |
| 🧬 元层自进化 | LLM 依据 Guidance 提案抽取器 prompt 覆盖，人工批准应用，链式可回滚（只进化元层，禁改剧情/品味） | 工作台·自进化 |
| 🔐 漏斗乐观锁 | 提案带 baseSeq 基线，批准时世界已推进则重校验（冲突 409）；同世界并发导入 409 写锁 | 审核/导入 |
| ✍️ 写作回路 | 大纲 → beat → 草稿 → 圈选局部重写 → 定稿（锚点入库 + 手改同步提案） | 会话·写 |
| 🪤 伏笔压力 | 未回收伏笔（含逾期）注入导演上下文 | 工作台·伏笔 |
| 🎨 文风 | 平淡检测器（词汇多样性/句长方差/AI 腔词典，确定性）+ 平淡自动重写 + 作者旧文范例锚定 | 回合徽章 / 定稿 |
| 🃏 ST 生态 | 角色卡 v2/v3 JSON + PNG tEXt 内嵌卡导入；世界书双向导出 | 书架 |
| 🧭 Guidance | 用户期望锚点，注入导演/渲染 prompt | 工作台·Guidance |
| ⚙️ 模型层 | OpenAI CC + Anthropic Messages 双协议；五角色（渲染/导演/抽取/对抗审/聊天）独立配模型；API Key AES-256-GCM 加密落盘 | 模型设置 |
| 💰 成本透明 | 按角色统计 token 用量报表；**成本基线 + 涨幅 >20% 审批门**（`/usage/baseline` + `/usage/gate`） | 工作台·用量 |
| 🧪 质量工程 | **一致性基准集**（3 部埋雷小说中英，`testdata/`）、**红队泄漏扫描**（秘密×非知情全组合，泄漏率‰）、**回合指标**（千回合 idle 率/文风分布）、**关系矛盾检测器**（亲属/恋人/敌对互斥，中英） | 单测 + 工作台·用量 |
| 🔄 横排重写 | 平淡正文多候选并行（多 provider×温度），确定性检测器选优 | 回合内自动 |
| 🚪 回归门 | 元层自进化覆盖须过固定题库（前/后 A/B），退化自动拒绝 | evolve 流程 |
| 👥 in_scene 同场互见 | 秘密事件标 `inScene:auto` 时对同位置角色临时可见 | 可见性层 |
| 🗄 schema 迁移 | v1→v2 事件迁移器（幂等），`/api/migrate/legacy-events` | 运维 |
| 📱 PWA | manifest + 图标，可安装到手机主屏 | 浏览器 |

## 架构（npm workspaces monorepo）

```
packages/core       事件库+重放+可见性 —— 纯 TS、零依赖（node:sqlite）、Rust 移植边界
packages/adapters   LLM 双协议（含 mock）/ 切章 / 时间归位 / ST 卡 / 平淡检测器
packages/engine     漏斗 / 工具面（story_index·read·grep·search·recall·propose）/ 双 agent 回合 / Jobs
apps/server         零框架 node:http + SSE + 静态托管
apps/web            Vue 3 + Vite SPA（书架/工作台/会话/设置）
```

**工具面纪律（写侧零自由）**：agent 读侧自由（≤12 次调用/回合），写操作唯一入口 `propose` —— 只进漏斗，批准才落库。

## 环境/部署

| 变量 | 默认 | 说明 |
|------|------|------|
| `EVENTVERSE_PORT` | 18700 | 监听端口 |
| `EVENTVERSE_HOST` | 127.0.0.1 | 绑定地址（远程访问改 0.0.0.0 + 自行加反代鉴权） |
| `EVENTVERSE_DATA` | ./data | 数据目录（SQLite + 章节 md + 会话 + master.key） |

Docker：`docker compose up -d --build`（amd64/arm64）。

## 安全说明

- 本地优先：默认只监听 127.0.0.1，数据（正文/事件/密钥）全部在本地数据目录；
- API Key 使用 AES-256-GCM 加密，密钥文件 `master.key` 不离开数据目录；
- `settings.json` 只存密文（vault），接口不回传明文。

## 许可证

AGPL-3.0-only（网络交互需开源；商业双许可请联系作者）。
