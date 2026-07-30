# Spec 01: Hybrid Query Flow

**状态**: Draft → **Implementing** | **优先级**: P0 | **最后更新**: 2026-07-30

> **更新说明**：本 spec 已更新以匹配实际实现：
> - ✅ 加入 QueryOptimizer（Step 0）和 Reranker（Step 2.5）— 参考 Agentic RAG 多步模式
> - ✅ 移除 CodeGraph 耦合 — 图遍历使用 `memory_edges` 而非 `codegraph_node/callers/callees`
> - ✅ 新增配置项 `enableQueryOptimization` / `enableReranking`

## 1. 查询入口

```typescript
async function queryMemory(
  query: string,
  options?: {
    topK?: number;                    // 最终返回数量，默认 5
    candidateK?: number;              // 粗召回数量，默认 20
    alpha?: number;                   // 向量权重，默认 0.4
    beta?: number;                    // 图权重，默认 0.4
    gamma?: number;                   // 时效权重，默认 0.2
    maxGraphDepth?: number;           // 图遍历深度，默认 3
    timeoutMs?: number;               // 查询超时，默认 1000
    enableQueryOptimization?: boolean; // 启用查询优化，默认 true
    enableReranking?: boolean;        // 启用重排序，默认 true
    filter?: {
      importanceMin?: number;
      type?: string[];
      source?: string[];
      timeRange?: [number, number];
      userId?: string;
    };
  }
): Promise<HybridQueryResponse>;
```

## 2. 完整流程

```
queryMemory("支付超时")
    │
    ├── Step 0: 查询优化（可选）
    │   ├── LLMQueryOptimizer.optimize("支付超时")
    │   │   → "支付模块 超时 故障 排查"
    │   ├── 默认模型: gpt-4o-mini（成本低）
    │   └── NoopQueryOptimizer 兜底
    │       ( 耗时: < 200ms )
    │
    ├── Step 1: 向量粗召回
    │   ├── embedder.embed(optimizedQuery) → queryVector
    │   ├── vectorStore.query(queryVector, { topK: candidateK })
    │   └── candidates = [{nodeId, score, metadata}, ...]
    │       ( 耗时: < 50ms )
    │
    ├── Step 2: 图遍历精排序（并行）
    │   ├── for each candidate:
    │   │   ├── memoryDb.getRelatedMemories(nodeId, depth)
    │   │   │   → 读 memory_edges 表
    │   │   └── graphScore = computeGraphRelevance(relations)
    │   └── candidates with graphScore
    │       ( 耗时: < 100ms for 20 candidates, depth=3 )
    │
    ├── Step 2.5: 重排序（可选）
    │   ├── EmbeddingReranker.rerank(query, candidates)
    │   │   → query-doc cosSimilarity
    │   │   → 融合 = 0.7 * cosSim + 0.3 * originalScore
    │   ├── Top-20 → Top-5
    │   └── NoopReranker 兜底
    │       ( 耗时: < 100ms )
    │
    ├── Step 3: 融合打分
    │   ├── recency = computeRecency(timestamp)
    │   │   // 24h=1.0, 7d=0.8, 30d=0.5, 90d=0.2
    │   └── finalScore = α*vector + β*graph + γ*recency
    │
    └── Step 4: 返回 TOP K
        └── [{nodeId, title, summary, score, relations, metadata}]
```

## 3. 降级链

```
语义搜索（有 embedding 配置）
  → FTS5 全文搜索
    → LIKE 模糊搜索（兜底）
```

| 场景 | 行为 |
|------|------|
| 查询优化 API 失败 | 用原始查询，标记 `degraded: "optimizer_fail"` |
| Embedding API 失败 | 降级为 FTS5 |
| 图遍历超时 | 跳过图分数，纯向量+时效排序 |
| 向量库为空 | 降级为 FTS5 |
| 全部超时 | 返回空 + 错误码 |

## 4. 缓存策略

- 向量 embedding 结果缓存 5 分钟（LRU, 最大 1000 条）
- 查询优化结果不缓存（上下文敏感）
- 图遍历结果不缓存
- 融合打分结果不缓存

## 5. 监控埋点

```typescript
interface QueryTelemetry {
  totalTimeMs: number;
  vectorTimeMs: number;
  graphTimeMs: number;
  candidatesCount: number;
  returnedCount: number;
  degraded: false
    | "optimizer_fail" | "vector_timeout"
    | "graph_timeout" | "both_timeout";
  top1Score: number;
  /** 新增字段 */
  queryOptimized: boolean;       // 是否被改写
  originalQuery: string;          // 原始查询
  optimizedQuery?: string;        // 改写后
  optimizerTimeMs?: number;       // 优化耗时
  rerankerTimeMs?: number;        // 重排耗时
}
```

## 6. 性能目标（全链路）

| 阶段 | 目标耗时 |
|------|---------|
| 查询优化 | < 200ms |
| Embedding | < 100ms |
| 向量搜索 | < 50ms |
| 图遍历 | < 100ms |
| 重排序 | < 100ms |
| **总计** | **< 550ms** |

> 注意：当前向量搜索为 O(n) 暴力余弦，记录 > 10,000 时需换 IVF 索引。
