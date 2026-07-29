# RFC-006: Hermes 启发式记忆系统增强

**状态**: Implemented ✅ | **优先级**: P1 | **最后更新**: 2026-07-30
**来源**: Hermes Agent (NousResearch) 架构分析
**关联**: specs/01-hybrid-query.md, specs/05-dream-engine.md, ROADMAP.md Phase 3

---

## 7. 实现报告

**实施时间**: 2026-07-30 | **实施者**: One-Prime | **状态**: 全部完成 ✅

### 7.1 新增文件

| 文件 | 行数 | 说明 |
|------|------|------|
| `packages/memory-graph/src/session-compressor.ts` | 477 | SessionCompressor 类 |
| `packages/memory-graph/src/nudge-engine.ts` | 436 | NudgeEngine 类 |
| `packages/memory-graph/src/user-profile.ts` | 554 | UserProfileEngine 类 |

### 7.2 修改文件

| 文件 | 变更 |
|------|------|
| `packages/memory-graph/src/index.ts` | 导出 3 个新模块 + 类型 |

### 7.3 实现摘要

**Phase A — Session Compressor** ✅
- `compress(sessionId, memories, options?)` — 将会话记忆压缩为摘要节点，自动创建 `summarizes` 边
- `getSessionSummaries(sessionId)` — 按 `sourceSession` 查询某会话的所有摘要
- `getRecentSummaries(limit, options?)` — 按重要性×时效性加权排序，取 top N
- `injectContext(options?)` — 为新会话准备注入上下文，排除自引用
- `refreshExpired(dryRun?)` — 清理超过 TTL 的过期摘要
- 复用 schema：`session_summary` 节点类型 + `summarizes` 边关系
- 与梦境引擎的关系：session-compressor 负责实时轻量压缩，梦境引擎负责深度归纳

**Phase B — Nudge Engine** ✅
- `onMemoryWritten(memories, options?)` — 新记忆写入时触发，检测 3 种场景
- `analyzeRecent(hours?)` — 批量扫描近期记忆，发现跨会话模式
- 场景 1: **复杂任务检测** — 高重要性记忆自动建议记录为经验
- 场景 2: **重复模式检测** — 同标签在时间窗口内出现多次，建议创建通用规则
- 场景 3: **错误复现检测** — 新记忆与已有 decision 节点语义重叠，建议回顾
- 知识缺口检测 — 内容有 body 无 summary，或高重要性未关联代码符号
- 纯规则匹配，零 LLM 依赖，去重防重复提示

**Phase C — User Profile Engine** ✅
- `observe(type, domain, content, options?)` — 记录观察，自动检测矛盾
- `getProfile(userId)` — 聚合所有观察，按 domain 分组，返回核心观点和矛盾历史
- `getProfileSummary(userId, maxTraits?)` — 格式化摘要，直接注入系统 prompt
- 矛盾检测：同 domain 内 Jaccard 相似度 < 0.3 且置信度 >= 0.5 时触发
- 置信度衰减：每天 2%，90 天未更新自动归档
- 复用 `insight` 节点类型 + `contradicts` 边关系，不增加新类型

## 0. 事前剖检

**如果这个 RFC 失败了，最可能的原因：**

1. **范围膨胀** — 5 个特性同时攒，超过可交付的 MVP 节奏
2. **与现有架构冲突** — 插件接口层可能破坏现有 MemorySystem 的强类型保证
3. **投入产出不匹配** — 当前 MVP 阶段，PMF 验证比加功能优先级更高
4. **过度工程** — 抽象接口层可能增加不必要的复杂度

**结论**：限制本次 RFC 范围到 **3 个高收益低投入的特性**，其余推迟到 Phase 3 之后。

---

## 1. 动机

从 Hermes Agent 的记忆系统分析中，识别出 5 个值得借鉴的能力。经过事前剖检，筛选出 **3 个当前阶段最适合引入** 的特性：

| 特性 | 投入 | 收益 | 纳入本轮 |
|------|------|------|---------|
| ① 主动记忆 nudge | 低 | 中 | ✅ |
| ② Session 压缩 | 低 | 高 | ✅ |
| ③ 用户画像辩证建模 | 中 | 中 | ✅ |
| ④ 记忆后端插件化 | 中 | 高 | ❌ 推迟到 Phase 3 |
| ⑤ 程序记忆（技能） | 高 | 高 | ❌ 推迟到 PMF 后 |

---

## 2. 特性一：主动记忆 Nudge 引擎

### 2.1 问题

当前 MemorySystem 完全被动——agent 必须主动调用 `memory_write` 才能存储记忆。导致：
- 重要信息在会话中丢失
- 重复问题反复出现
- 跨会话的"教训"无法自动沉淀

### 2.2 设计

新增 `NudgeEngine` 模块，在 `memory-orchestrator` 包中：

```typescript
// packages/memory-orchestrator/src/nudge.ts

enum NudgeTrigger {
  COMPLEX_TASK_DONE,   // 复杂任务完成
  PATTERN_DETECTED,    // 检测到重复模式
  CROSS_SESSION,       // 跨会话识别
  ERROR_REPEATED,      // 相同错误再次出现
  DECISION_MADE,       // 用户做出了重要决策
}

interface NudgeSignal {
  trigger: NudgeTrigger;
  confidence: number;       // 0-1
  title: string;            // 建议的记忆标题
  summary: string;          // 建议的摘要
  body: string;             // 完整内容
  tags: string[];
  importance: number;       // 建议的重要性
}

interface NudgeConfig {
  /** 最低置信度阈值（默认 0.6） */
  minConfidence: number;
  /** 触发复杂任务检测的 token 数阈值（默认 2000） */
  complexTaskTokenThreshold: number;
  /** 跨会话窗口（默认 7 天） */
  crossSessionWindowDays: number;
  /** 是否默认启用 */
  enabled: boolean;
}
```

### 2.3 触发流程

```
Agent 完成一次操作
    │
    ├── NudgeEngine.evaluate(context)
    │
    ├── 检测器 1: ComplexTaskDetector
    │   └── 判断: 对话 token > 2000 + 包含工具调用
    │       → NudgeSignal("这次修复流程值得记录")
    │
    ├── 检测器 2: PatternDetector
    │   └── 判断: 查询最近的记忆，发现相同模式 ≥ 2 次
    │       → NudgeSignal("你第三次遇到这个问题了，要总结吗？")
    │
    ├── 检测器 3: ErrorBookDetector
    │   └── 判断: Moat 检测到 ERROR 日志，与 ErrorBook 记忆匹配
    │       → NudgeSignal("这个错误上次出现过，修复方案是...")
    │
    └── 输出: NudgeSignal[] (按置信度排序，取 top 3)
        → 由上层决定是否自动写入或提示用户
```

### 2.4 集成方式

NudgeEngine 不侵入 MemorySystem 核心流程，而是作为**可选的后处理钩子**：

```typescript
// MemorySystem 新增
interface MemorySystemConfig {
  // ... 现有配置
  nudge?: {
    enabled: boolean;
    config?: Partial<NudgeConfig>;
    /** 自动写入（无需用户确认）—— 默认 false */
    autoWrite?: boolean;
  };
}
```

### 2.5 输出格式

```typescript
interface NudgeResult {
  signals: Array<{
    signal: NudgeSignal;
    /** 关联的已有记忆（如果有） */
    relatedMemoryIds: string[];
    /** 建议的操作: 'auto_write' | 'suggest' | 'skip' */
    suggestedAction: 'auto_write' | 'suggest' | 'skip';
  }>;
}
```

### 2.6 文件变更

| 文件 | 变更 |
|------|------|
| `packages/memory-orchestrator/src/nudge.ts` | **新增** — NudgeEngine 核心逻辑 |
| `packages/memory-orchestrator/src/memory-system.ts` | 修改 — 集成 NudgeConfig |
| `packages/memory-orchestrator/src/index.ts` | 修改 — 导出 NudgeEngine |
| `packages/memory-orchestrator/tests/nudge.test.ts` | **新增** — 测试 |

---

## 3. 特性二：Session 压缩与跨会话注入

### 3.1 问题

当前系统没有跨会话的上下文连续机制。每次新会话：
- 记忆需要重新查询（冷启动）
- 上一次会话的上下文丢失
- 用户需要重复说明背景

### 3.2 设计

复用梦境引擎的蒸馏逻辑，新增 `SessionCompressor`：

```typescript
// packages/memory-orchestrator/src/session-compressor.ts

interface SessionSummary {
  sessionId: string;
  timestamp: number;
  duration: number;             // 会话时长（秒）
  tokenCount: number;           // 消耗 token 数
  title: string;                // 自动生成的会话标题
  summary: string;              // LLM 生成的摘要
  keyDecisions: Array<{
    decision: string;
    reason: string;
    confidence: number;
  }>;
  unresolvedItems: string[];    // 未完成的事项
  tags: string[];
  importance: number;           // 自动评估的重要性
}

interface SessionCompressorConfig {
  /** 摘要触发阈值（token 超过此值才压缩，默认 5000） */
  minTokensForSummary: number;
  /** 最大摘要长度（字符数，默认 500） */
  maxSummaryLength: number;
  /** 跨会话注入时加载最近 N 条摘要（默认 3） */
  recentSummariesCount: number;
  /** 是否自动启用 */
  enabled: boolean;
}
```

### 3.3 流程

```
会话结束 / 会话超长
    │
    ├── Step 1: 检查 token 是否 > minTokensForSummary
    │   └── 否 → 跳过（太短的会话不值得压缩）
    │
    ├── Step 2: 提取关键信息
    │   ├── 工具调用链 → 提取决策
    │   ├── 用户关键词 → 提取未完成事项
    │   └── 记忆查询 → 提取引用
    │
    ├── Step 3: 生成摘要
    │   ├── 使用 embedder 做语义聚类
    │   ├── 按重要性排序关键点
    │   └── 生成 SessionSummary 节点
    │       → node_type = 'session_summary'
    │       → 写入 memory_nodes
    │
    ├── Step 4: 关联到项目/用户
    │   └── memory_edges: 'summarizes'
    │
    └── Step 5: 新会话启动时
        └── 自动查询最近 N 条 session_summary
            → 注入到系统提示的上下文
```

### 3.4 与梦境引擎的关系

SessionCompressor 是梦境引擎的**轻量实时版**：

| 维度 | 梦境引擎 (Dream) | Session 压缩 |
|------|-----------------|-------------|
| 触发时机 | 定时（每天凌晨 3 点） | 会话结束时 |
| 处理范围 | 全量记忆 | 单次会话 |
| 操作 | 合并/删除/归档 | 只创建摘要，不修改原文 |
| 数据量 | 数千条 | 一次会话 |
| LLM 调用 | 可选 | 不需要（纯算法） |

### 3.5 文件变更

| 文件 | 变更 |
|------|------|
| `packages/memory-orchestrator/src/session-compressor.ts` | **新增** |
| `packages/memory-orchestrator/src/memory-system.ts` | 修改 — 集成 SessionCompressorConfig |
| `packages/memory-graph/src/database.ts` | 修改 — 新增 `session_summary` 节点类型 |
| `packages/memory-mcp/src/tools.ts` | 修改 — 新增 `session_summary` 查询过滤 |
| `packages/memory-orchestrator/tests/session-compressor.test.ts` | **新增** |

---

## 4. 特性三：用户画像辩证建模

### 4.1 问题

当前 `Person Memory` 只是简单的"存-取"模式，没有：
- 矛盾检测（用户前后说法不一致）
- 置信度衰减（旧信息随时间降低权重）
- 跨会话观点演化追踪

### 4.2 设计

在 `memory-orchestrator` 中新增 `UserProfileEngine`：

```typescript
// packages/memory-orchestrator/src/user-profile.ts

interface UserProfile {
  userId: string;
  /** 偏好列表（带置信度和时间戳） */
  preferences: Array<{
    key: string;           // e.g. "communication_style"
    value: string;         // e.g. "concise"
    confidence: number;    // 0-1，基于确认次数
    firstObserved: number;
    lastConfirmed: number;
    source: string;        // 来源会话 ID
  }>;
  /** 检测到的矛盾 */
  contradictions: Array<{
    key: string;
    prevValue: string;
    newValue: string;
    detectedAt: number;
    resolved: boolean;
  }>;
  /** 事实性记忆 */
  facts: Array<{
    key: string;
    value: string;
    confidence: number;
  }>;
}

interface UserProfileConfig {
  /** 置信度衰减半衰期（天，默认 30） */
  confidenceHalfLifeDays: number;
  /** 最低置信度阈值（低于此值被淘汰，默认 0.2） */
  minConfidence: number;
  /** 矛盾检测的语义相似度阈值（默认 0.7） */
  contradictionThreshold: number;
  /** 是否启用 */
  enabled: boolean;
}
```

### 4.3 矛盾检测

```
用户说 "我偏好简洁的回答"
    │
    ├── 提取: key="communication_style", value="concise"
    ├── 写入 UserProfile.preferences (confidence=0.6)
    │
    ... 2 天后 ...
    │
    用户说 "能不能详细一点？"
    │
    ├── 提取: key="communication_style", value="detailed"
    ├── 检测: 与已有记录 "concise" 矛盾
    │   ├── 语义相似度 < contradictionThreshold? → 是
    │   └── 记录到 UserProfile.contradictions
    │
    ├── 更新: 不覆盖，而是追加
    │   ├── preference: "concise" (confidence=0.5, 已衰减)
    │   └── preference: "detailed" (confidence=0.6, 新)
    │
    └── 输出: "检测到偏好变化：concise → detailed，需要确认？"
```

### 4.4 与现有系统的集成

```typescript
// UserProfile 存储在 memory_nodes 中
// node_type = 'user_profile'
// 每个用户一条，通过 user_id 隔离

// 查询时自动注入
MemorySystem.query("用户偏好", {
  userId: "user_zhangsan",
  includeProfile: true,  // 自动加载用户画像
})
```

### 4.5 文件变更

| 文件 | 变更 |
|------|------|
| `packages/memory-orchestrator/src/user-profile.ts` | **新增** |
| `packages/memory-orchestrator/src/memory-system.ts` | 修改 — 集成 UserProfileConfig |
| `packages/memory-graph/src/database.ts` | 修改 — 新增 `user_profile` 节点类型 |
| `packages/memory-graph/src/importance-learner.ts` | 修改 — 用户画像的置信度衰减复用现有逻辑 |
| `packages/memory-orchestrator/tests/user-profile.test.ts` | **新增** |

---

## 5. 推迟特性（Phase 3 后）

### 5.1 记忆后端插件化（推迟原因：过度工程风险）

理想设计：

```typescript
interface MemoryBackend {
  name: string;
  init(config: any): Promise<void>;
  write(entry: MemoryNode): Promise<string>;
  query(query: QueryRequest): Promise<QueryResult>;
  dream(): Promise<DreamReport>;
  health(): Promise<HealthStatus>;
  shutdown(): Promise<void>;
}

// 默认实现：图-向量混合引擎（现有）
// 可选实现：纯 SQLite FTS5（轻量版）
// 可选实现：MCP 代理（远程记忆服务）
```

**推迟理由**：
- 当前只有一个实现（图-向量引擎），不存在"替换"需求
- 抽象接口一旦引入，所有新功能都要过接口设计
- 等到有第二个实现需求时再抽象，比提前抽象更安全

### 5.2 程序记忆/技能（推迟原因：PMF 优先）

**推迟理由**：
- 技能系统是一个独立产品，不只是记忆系统的一个功能
- 需要定义技能格式、执行引擎、反馈循环
- MVP 阶段的核心命题是 PMF 验证，不是加功能

---

## 6. 实施计划

### 6.1 里程碑

| 阶段 | 特性 | 预计工时 | 依赖 |
|------|------|---------|------|
| **Phase A** | Session 压缩 | 1-2 天 | 梦境引擎（已有） |
| **Phase B** | 主动 Nudge | 2-3 天 | Session 压缩（提供上下文） |
| **Phase C** | 用户画像 | 2-3 天 | 多租户隔离（已有） |

### 6.2 不可行性校验

| 假设 | 风险 | 验证方式 |
|------|------|---------|
| Session 摘要可以纯算法（无 LLM） | 摘要质量可能不够 | 先做纯算法版，评估后决定是否加 LLM |
| Nudge 不会干扰用户 | 过度提示导致反感 | 默认不自动写入，只生成建议 |
| 用户画像冲突检测准确 | 误报矛盾 | 设置 conservative 阈值（0.7 语义相似度） |

### 6.3 依赖关系

```
Session Compressor  ──→  梦境引擎的蒸馏逻辑复用
       │
       ▼
Nudge Engine  ──→  Session Compressor 提供上下文信号
       │
       ▼
User Profile  ──→  多租户隔离层提供 user_id 映射
```

---

## 7. 回退方案

如果某个特性在实现后效果不佳：

| 特性 | 回退操作 | 回滚成本 |
|------|---------|---------|
| Session 压缩 | 删除 `session_summary` 类型的节点 | 低（不影响其他节点） |
| Nudge 引擎 | 通过 `nudge.enabled = false` 关闭 | 零（配置开关） |
| 用户画像 | 清空 `user_profile` 节点 | 低（每条 profile 独立） |

---

## 8. 附录：与 Hermes 的对应关系

| One Memory 新增 | 对应的 Hermes 能力 | 差异说明 |
|----------------|-------------------|---------|
| NudgeEngine | 周期性记忆 nudges | Hermes 更主动（直接提示用户），我们更保守（只生成建议） |
| SessionCompressor | FTS5 搜索 + LLM 总结 | Hermes 用 LLM 做总结，我们用纯算法复用梦境引擎 |
| UserProfileEngine | Honcho 辩证用户建模 | Honcho 更复杂（辩证推理），我们从矛盾检测和置信度衰减做起 |
| ❌ 推迟：插件接口 | `plugins/memory/` 插件体系 | 等到有第二个实现需求时再做 |
| ❌ 推迟：技能记忆 | 技能系统 + 技能自我改进 | 核心产品功能，不作为记忆系统的一部分 |

---

## 9. 文件索引

```
specs/
├── 06-rfc-hermes-inspired.md        ← 本文件
```

**新增源文件**（预计）：

```
packages/memory-orchestrator/src/
├── nudge.ts                         ← Phase B
├── session-compressor.ts            ← Phase A
├── user-profile.ts                  ← Phase C
└── tests/
    ├── nudge.test.ts
    ├── session-compressor.test.ts
    └── user-profile.test.ts
```

**修改文件**（预计）：

```
packages/memory-orchestrator/src/
├── memory-system.ts                 ← 集成 3 个新配置
├── index.ts                         ← 导出新模块

packages/memory-graph/src/
├── database.ts                      ← 新增节点类型

packages/memory-mcp/src/
├── tools.ts                         ← 新增查询过滤
```