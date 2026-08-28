# 性能基准（Benchmarks）

> 环境：Windows Server 2016 / Node 24 / node:sqlite WAL。绝对值仅供参考，量级关系是结论。
> 复现：`node scripts/bench-replay.mjs`

## 负载模型

- 300 章合成小说导入（启发式抽取，零 LLM）+ 直灌 3000 条作者级事件
- 事件总量 **3300**（模拟一本中等体量书 + 一段时间游玩的积累）

## 结果（投影缓存引入前后）

| 路径 | 修复前 | 修复后 | 说明 |
|------|-------:|-------:|------|
| stateAt 全量重放（缓存命中） | 627 ms | **0 ms** | append 增量前滚，O(1) 返回 |
| 工具 search_entities | 625 ms | **0.66 ms** | 复用每回合预算一次的 viewerState |
| 最坏回合（12× 工具调用） | 7506 ms | **9 ms** | ≈830× |
| stateVisibleTo（RP 视角，单次预算） | 620 ms | 632 ms | 每回合一次，回合内复用 |
| diff 两时刻 | 389 ms | 360 ms | 按需视图，可接受 |
| 300 章导入 | 2282 ms | 1312 ms | 漏斗自动校验吃到增量缓存 |

## 设计注记

- 缓存失效：`rollback`（该世界全失效）、`migrateLegacyEvents`（全清）；`append` 增量推进事件数组与投影状态。
- `stateAt` 带 `upto` 的历史查询（时间轴滑块）仍走全量重放——低频交互可接受；若将来做高频拖动动画，再对锚点做快照分段。
- 重放瓶颈本质是 reducer 每事件浅拷贝 characters 映射（O(事件×人物)）。投影缓存把代价摊销为每 mutation 一次；事件量再涨一个数量级时启用 MD §12 的投影快照方案。

## 修复记录

- 发现：质量工程基准（300 章导入压测）暴露最坏回合 7.5s，远超 2s 预算 → `EventStore` 双缓存 + `ToolContext.viewerState` 每回合预算（commit 见 git log）。
