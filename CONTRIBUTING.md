# 贡献指南（CONTRIBUTING）

感谢关注 EventVerse。提交 PR 前请通读本文件。

## 开发环境

- **Node ≥ 24**（依赖 `node:sqlite` 未加 flag 的稳定版）
- Windows / macOS / Linux 均可（CI 跑 ubuntu）

```bash
npm install
npm run build     # core → adapters → engine → server → web
npm start         # http://127.0.0.1:18700
npm test          # core + engine（49 项）
npm test -w @eventverse/adapters
npm run dev:web   # 前端热更新 :5173
```

## 架构速览

```
packages/core       事件库/重放/可见性 —— 纯 TS、零依赖、全纯函数（Rust 移植边界）
packages/adapters   LLM 双协议 / 切章 / ST 卡 / 平淡检测
packages/engine     漏斗 / 工具面 / 双 agent 回合 / StoryPack / Jobs
apps/server         node:http + SSE
apps/web            Vue 3 SPA
```

设计真源：仓库根《AI 叙事平台设计方案》（分层架构、反模式清单、里程碑）。

## 提交规则

1. **先 issue 后 PR**（除非 typo 级）。
2. 每个功能/修复必须带测试：core 是纯函数单测，engine 走 vitest + mock provider（不要在测试里调真实 LLM）。
3. 改动事实层（core）必须：保持纯函数纪律（不引入 `Date.now()`/框架依赖/隐式全局）；若改事件 schema，**只能加可选字段**，并在 `migrateLegacyEvents` 补迁移与单测。
4. 改动漏斗/抽取相关逻辑，跑一遍 `node scripts/bench-replay.mjs` 确认无性能回退（参照 docs/BENCHMARKS.md）。
5. commit message 中文一句话，格式：`模块：做了什么（为什么）`。

## 许可与 CLA

- 项目 **AGPL-3.0-only**；提交 PR 即视为签署 [docs/CLA.md](./CLA.md)（保留双许可权利）。
- 不接受与 AGPL 不兼容的第三方代码。

## 反模式（PR 会被拒）

- 给 agent 加 bash/通用执行工具（设计裁决见设计方案 §0）
- 引入向量库/RAG 主路径
- 让 AI 直接写世界状态（写必须走 `propose` → 漏斗）
- 在 core 里引入框架或平台特定 API
