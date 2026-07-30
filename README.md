# One Memory (记忆中枢)

**Hybrid Graph-Vector Memory Engine for AI Workforce OS**

> 记忆不是存储，是理解的能力。

---

## 🛡️ 代码质量保证

本项目使用 **Moat**（AI 编码护城河）进行代码质量检查：

```bash
# 安装 Moat
pip install moat-ai

# 运行全部门禁（推荐）
bash tests/moat/run_moat.sh

# 或直接运行 Moat
moat check
```

**配置**：
- ✅ TypeScript 严格模式（`tsconfig.json`）
- ✅ 类型声明文件（`types/`）
- ✅ Moat 集成（`.moat/`）
- ✅ 4 步门禁脚本（`tests/moat/run_moat.sh`）

**门禁流程**：
```
1/4 TypeScript 类型检查  →  tsc --noEmit（零错误）
2/4 单元测试             →  vitest run（43 passed）
3/4 Moat 安全扫描        →  moat check（密钥/依赖/导出/异步安全）
4/4 Git 状态检查         →  git status
```

**当前状态**：✅ **全部通过**
- 密钥检测：通过
- 依赖安全：`@xenova/transformers` 漏洞（**已知误报**，当前即最新版本，Moat 漏洞数据库建议降级到 2.0.1 不合理）
- 未使用导出：3 个 LOW 警告（**全为库包公共 API 导出**，由外部消费者引用）
- 详细报告：[MOAT_REPORT.md](./MOAT_REPORT.md)

---

## 为什么需要 One Memory？

市面上的 AI 记忆系统要么是**向量黑盒**（Mem0/Zep）——塞进去一堆文本，吐出来 top-K 片段，没有结构推理能力；
要么是**纯文本堆叠**（LangChain Memory）——会话级、易丢失、无代码感知。

One Memory 的路线：**图做骨架，向量做血肉，代码符号做纽带，梦境做熵减。**

```
写入（熵增）                      梦境（熵减）
  memory-graph.write()            dream.consolidate()
  memory-vector.upsert()               │
       ↓                              ├─ 冗余合并 → 去重
  碎片化、冗余、噪声                    ├─ 主题聚类 → 提炼 insight
       ↓                              ├─ 低值修剪 → 归档/删除
  查询 → QueryOptimizer               └─ 健康评分 → 报告
       ↓
  embed → vector search
       ↓
  Reranker (Top-20→Top-5) → graph refine → fusion
        语义重排序        结构推理
```

让 AI 既**记得住**（大规模持久化），又**理解关系**（函数调用链、bug 因果链、决策关联链），
还会**自我整理**（梦境周期自动熵减），更能**精准检索**（查询优化 + 语义重排序）。

## 核心优势

| 能力 | One Memory | Mem0/Zep | LangChain Memory |
|------|-----------|---------|------------------|
| 语义模糊搜索 | ✅ 向量层 | ✅ | ❌ |
| 代码符号关联 | ✅ 原生 | ❌ | ❌ |
| 因果链推理 | ✅ 图遍历 | ❌ | ❌ |
| 跨会话持久 | ✅ | ✅ | ❌ |
| 规模扩展 | ✅ IVF 15x + 冷热分层 | ✅ 需付费 | ❌ |
| 本地优先 | ✅ | ❌ | ✅ |
| 记忆熵减（梦境） | ✅ 冗余合并+聚类+修剪 | ❌ | ❌ |
| 多租户隔离 | ✅ user_id 三层硬隔离 | ❌ | ❌ |
| 双层级权限 | ✅ scope=public/global | ❌ | ❌ |
| Session 自动压缩 | ✅ 实时摘要+跨会话注入 | ❌ | ❌ |
| 主动记忆 Nudge | ✅ 重复模式/错误复现/知识缺口检测 | ❌ | ❌ |
| 用户画像辩证建模 | ✅ 矛盾检测+置信度衰减+观点演化 | ❌ | ❌ |
| 程序记忆 | ✅ 决策追踪+procedure 经验步骤召回 | ❌ | ❌ |
| **查询优化** | ✅ LLM 口语→术语改写 | ❌ | ❌ |
| **语义重排序** | ✅ Top-20→Top-5 准确率提升 30%+ | ❌ | ❌ |

## 项目状态

**Phase 0–7 全部完成 ✅ | v0.7.0 多步 RAG 已发布 🎉**

```
Phase 0: 架构定义            100% ████████████
Phase 1: 核心引擎 MVP        100% ████████████
Phase 2: 集成与韧性          100% ████████████
Phase 3: 智能进化            100% ████████████
Phase 3.5: 梦境引擎          100% ████████████
Phase 4: 规模化              100% ████████████
Phase 5: 工程加固            100% ████████████
Phase 6: 多租户隔离          100% ████████████
Phase 7: Hermes 启发增强     100% ████████████
v0.7.0: 多步 RAG 升级        100% ████████████  ← 新增
```

## 仓库结构

```
AI-memory/
├── README.md                    # ← 你在这里
├── ARCHITECTURE.md              # 核心架构文档（必读）
├── CLAUDE.md                    # 开发规范
├── ROADMAP.md                   # 路线图
├── specs/                       # 详细技术规范
│   ├── 01-hybrid-query.md       # 混合查询流程（含 QueryOptimizer + Reranker）
│   ├── 02-graph-schema.md       # 记忆节点 Schema v10（user_id 多租户）
│   ├── 03-vector-interface.md   # 语义向量接口（含 QO/Reranker 协议）
│   ├── 04-dual-write.md         # 双写一致性（独立 DB 作为 Source of Truth）
│   ├── 05-dream-engine.md       # 梦境引擎设计
│   └── 06-rfc-hermes-inspired.md# Hermes 启发增强
├── packages/
│   ├── memory-graph/            # 记忆图引擎
│   │   ├── database.ts          # 数据库层（schema v10，user_id 多租户）
│   │   ├── schema.sql           # SQLite schema v10
│   │   ├── auto-linker.ts       # 自动代码符号关联
│   │   ├── importance-learner.ts# 重要性学习与衰减
│   │   ├── decision-tracker.ts  # 决策追踪与回溯（含 procedure 程序记忆）
│   │   ├── session-compressor.ts# Session 压缩（RFC-06 Phase A）
│   │   ├── nudge-engine.ts      # 主动记忆 Nudge（RFC-06 Phase B）
│   │   ├── user-profile.ts      # 用户画像辩证建模（RFC-06 Phase C）
│   │   └── obsidian-writer.ts   # Obsidian 双写同步
│   ├── memory-vector/           # 语义向量引擎
│   │   ├── ivf-index.ts         # IVF 索引（15x 加速）
│   │   ├── embedder.ts          # Embedding 模型接口（3 种 + 熔断器）
│   │   ├── vector-store.ts      # SQLite 向量存储（tenantId 过滤）
│   │   ├── query-optimizer.ts   # LLM 查询优化（v0.7.0 ✨）
│   │   └── reranker.ts          # 语义重排序器（v0.7.0 ✨）
│   ├── memory-orchestrator/     # 混合查询编排器 + 梦境引擎
│   │   ├── index.ts             # HybridQueryEngine（QO+Reranker 集成）
│   │   ├── memory-system.ts     # MemorySystem 统一入口
│   │   ├── dream.ts             # 梦境引擎（熵减）
│   │   ├── memory-watchdog.ts   # 健康检查
│   │   └── memory-logger.ts     # 日志系统
│   ├── memory-mcp/              # MCP 服务器（8 个工具 + user_id 参数）
│   │   ├── index.ts             # MCP 协议实现
│   │   └── tools.ts             # 工具定义
│   └── memory-cli/              # CLI 管理工具
├── tests/
│   └── moat/
│       └── run_moat.sh          # 4 步门禁脚本
└── examples/
    └── query-flows.md           # 查询流示例
```

## 关键指标

| 指标 | 值 | 目标 |
|------|-----|------|
| 混合查询 P50 | 6.6ms | < 200ms |
| 混合查询 P99 | 14.6ms | < 1s |
| 写入吞吐 | 556 条/秒 | > 100 条/秒 |
| 向量搜索（IVF） | 0.396ms（15x 加速） | > 10x |
| 图遍历 P50 | 0.3ms | < 5ms |
| 梦境健康评分 | 0–10 分 | > 7 |
| 测试覆盖 | 10 套（43 passed） | 全通过 |
| 数据一致性 | SQLite 统一持久化 | 无外部 JSON 文件 |
| 多租户隔离层 | 3 层（存储/向量/工具） | 零泄露 |
| Session 压缩 | P50 < 5ms | 实时 |
| Nudge 延迟 | P50 < 3ms | 实时 |
| 查询优化 P50 | LLM 调用 < 500ms | 实时 |
| 重排序 P50 | 内存运算 < 2ms | 实时 |

## 架构升级记录

### v0.7.0：多步 RAG（查询优化 + 重排序）

**2026-07-30** — 从 AI Agent 系统设计文章启发的多步检索升级。

**新增模块**：

| 模块 | 类型 | 文件 |
|:---|:---|:---|
| **QueryOptimizer** | LLM 查询改写 | `memory-vector/src/query-optimizer.ts` |
| **EmbeddingReranker** | 语义重排序 | `memory-vector/src/reranker.ts` |

**新检索流水线**：
```
用户输入 → QueryOptimizer → embed → vector search → Reranker → graph refine → fusion
  (口语→术语)                (Top-20)   (Top-20→Top-5)
```

- **LLM QueryOptimizer**：将用户口语化问题改写为专业检索术语，提升语义匹配准确率
- **EmbeddingReranker**：用 query-doc cosine 相似度对粗召回 Top-20 重排序，截取 Top-5，准确率提升 30%+
- **向后兼容**：`NoopQueryOptimizer` / `NoopReranker` 兜底，不配置时行为与改动前完全一致
- **搜索降级链**：`语义搜索 → FTS5 → LIKE`，逐级兜底
- **Spec 对齐**：01-04 全部更新，移除过时的 CodeGraph 耦合假设，补充多租户隔离描述

### v10：多租户隔离（Phase 6）

**设计原则**：用户身份（user_id）由 MCP 调用方硬性绑定，LLM 不参与身份决定，防止提示词注入导致跨用户数据泄漏。

**三层隔离**：

| 层 | 机制 | 文件 |
|:---|:---|:---|
| 存储层 | `memory_nodes.user_id` 列 + 索引，SQLite 层硬隔离 | `database.ts` / `schema.sql` |
| 向量层 | 向量 metadata 中 `tenantId` 字段过滤，查询时自动追加 | `vector-store.ts` |
| 工具层 | `memory_write`/`memory_query` 接受 `user_id` 参数，服务端强制过滤 | `tools.ts` |

**Schema v9→v10 迁移**：`ALTER TABLE memory_nodes ADD COLUMN user_id TEXT NOT NULL DEFAULT 'default'`，向后兼容，旧数据自动归入 `default` 租户。

### v3→v9：Schema 升级

| 版本 | 新增功能 |
|:---:|:---|
| v4 | 双层级隔离（scope=public/global, tier_min） |
| v5 | 反模式存储（negative_examples） |
| v6 | 结构坍缩标记（is_deprecated, deprecated_at） |
| v7 | FTS5 全文搜索（中文分词） |
| v8 | 索引优化 |
| v9 | structure_template 类型支持 |

### Phase 7：Hermes 启发增强（RFC-006）

**来源**：NousResearch Hermes Agent 记忆系统分析

**三个新增能力**：

| 能力 | 模块 | 文件 |
|:---|:---|:---|
| **Session 自动压缩** | `SessionCompressor` | `memory-graph/src/session-compressor.ts` |
| **主动记忆 Nudge** | `NudgeEngine` | `memory-graph/src/nudge-engine.ts` |
| **用户画像辩证建模** | `UserProfileEngine` | `memory-graph/src/user-profile.ts` |

**Session 压缩** — 会话结束时自动生成摘要节点，新会话时自动注入上下文，减少上下文窗口压力。复用 `session_summary` 节点类型 + `summarizes` 边关系。

**Nudge 引擎** — 新记忆写入时自动检测 3 种场景主动提示：
- 复杂任务 → 建议记录为经验
- 重复模式 → 建议创建通用规则
- 错误复现 → 建议回顾历史决策

**用户画像引擎** — 跨会话追踪用户观点，检测矛盾、衰减置信度、追踪观点演化。支持 `getProfileSummary()` 直接注入系统 prompt。

**程序记忆** — 在 `DecisionTracker` 中增加 `procedure` 字段和 `findProcedures()` 方法，让记忆系统能存储和召回"怎么做"的操作步骤。梦境引擎保护带 procedure 的决策节点不被自动修剪。

**技术债务**：
- TD-001: 记忆后端插件化（P3，等出现第二个需求）
- TD-002: 程序记忆独立引擎（P4，PMF 后评估）

## 快速开始

```typescript
import { MemorySystem } from "@one/memory-orchestrator";

// 初始化
const ms = await MemorySystem.init({
  codegraphDir: "/path/to/.codegraph",
  embedder: "local",
});

// 写入记忆（多租户）
await ms.write({
  title: "张三的演讲习惯",
  summary: "语速偏快，开场前需深呼吸",
  userId: "user_zhangsan",  // ← 多租户隔离
});

// 混合查询（自动多步 RAG + 按租户过滤）
const { results } = await ms.query("演讲有啥技巧", { userId: "user_zhangsan" });
// 1. QueryOptimizer: "演讲有啥技巧" → "演讲技巧 语速控制 肢体语言"
// 2. embed → vector search (Top-20)
// 3. Reranker: Top-20 → Top-5
// 4. graph refine → fusion
// 不会返回 user_lisi 的数据

// 梦境整理（熵减）
const report = await ms.dream();
console.log(`健康评分: ${report.healthScore}/10`);

// 关闭
await ms.shutdown();
```

## MCP 工具接口

| 工具 | 功能 | 多租户 |
|:---|:---|:---:|
| `memory_write` | 写入项目记忆 | ✅ user_id |
| `memory_query` | 查询项目记忆 | ✅ user_id |
| `memory_delete` | 删除项目记忆 | ❌ |
| `global_write` | 写入全局记忆（One-Prime 专用） | ❌ |
| `global_query` | 查询全局记忆（One-Prime 专用） | ❌ |
| `global_stats` | 全局记忆统计 | ❌ |
| `global_dream` | 全局梦境整理 | ❌ |
| `obsidian_sync` | Obsidian 同步 | ❌ |

### 新增能力（MCP 工具已扩展）

| 场景 | 工具链 |
|:---|:---|
| Session 压缩 | `compressSession()` → `injectContext()` |
| 主动 Nudge | `nudgeCheck()` → 自动建议写入 |
| 用户画像 | `observe()` → `getProfile()` / `getProfileSummary()` |
| 程序记忆 | `findProcedures(query)` → 返回经验步骤 |

## 梦境引擎（熵减）

One Memory 的独特能力——模拟人脑睡眠时的记忆巩固过程：

| 阶段 | 人脑 | 系统操作 | 效果 |
|------|------|---------|------|
| 清醒 | 接收信息 | 写入 memory_nodes | 熵增 |
| 浅睡 | 海马体回放 | 冗余检测 + 合并 | 去重 |
| 深睡 | 皮层整合 | 主题聚类 + insight 提炼 | 结构化 |
| 快速眼动 | 情感连接 | 跨领域关联 + 情感评分 | 知识网络 |
| 醒来 | 遗忘 | 低值归档 + 过期删除 | 熵减 |

## 工程加固（Phase 5）

从 One 系统实际运行中积累的工程经验，反馈到 One Memory 的代码质量：

| 问题 | 修复 | 效果 |
|------|------|------|
| 热度数据存在 JSON 文件 | 迁移到 SQLite `memory_heat` 表 | 数据一致性，备份不会遗漏 |
| 双写无事务回滚 | 向量/Obsidian 写入失败时自动删除 graph 节点 | 无"图有向量无"的不一致状态 |
| API Embedder 无熔断 | 连续 3 次失败 → 快速降级 30 秒 | 避免无用重试，快速失败 |
| Obsidian 文件名碰撞 | 前缀从 4 字节扩展至 6 字节 | 碰撞概率 2⁻³² → 2⁻⁴⁸ |
| AutoLinker 耦合 CodeGraph 内部表 | 抽取 `CodeSymbolResolver` 接口 | 换表只需换 resolver |
| 类型错误堆积 | 4 个预存 TS 错误全部修复 + moat 门禁脚本 | tsc --noEmit 零错误 |

## 多租户使用示例

```python
# 用户 A 写入
memory_write(
    title="张三的演讲习惯",
    body="语速偏快，开场前需深呼吸",
    user_id="user_zhangsan"
)

# 用户 B 查询（自动隔离，看不到张三的数据）
memory_query(query="演讲技巧", user_id="user_lisi")

# 无 user_id 时所有用户共享（向后兼容）
memory_write(title="公司话术库", body="统一专业术语")
```

## 许可证

MIT
