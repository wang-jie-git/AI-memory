# Spec 03: Vector Engine Interface

**状态**: Draft → **Implementing** | **优先级**: P0 | **最后更新**: 2026-07-30

> **更新说明**：本 spec 已从初始设计更新为当前实现：
> - ❌ sqlite-vec 虚拟表 → ✅ **暴力余弦相似度**（内存 Float32Array + SQLite 元数据）
> - ❌ CodeGraph 节点 ID → ✅ **memory_nodes.id（UUID）**
> - ✅ 新增 QueryOptimizer / Reranker 接口
> - ✅ 新增多租户字段：tenantId, userId, scope

## 1. 抽象接口

```typescript
interface VectorStore {
  init(): Promise<void>;
  close(): Promise<void>;

  embed(text: string): Promise<Float32Array>;
  upsert(id: string, vector: Float32Array, metadata: VectorMetadata): Promise<void>;
  upsertBatch(entries: VectorEntry[]): Promise<void>;
  delete(id: string): Promise<void>;
  query(vector: Float32Array, options: VectorQueryOptions): Promise<VectorResult[]>;

  stats(): Promise<VectorStoreStats>;
  rebuildIndex(): Promise<void>;
  flush(): Promise<void>;
}

// === 类型定义 ===

type VectorMetadata = {
  node_id: string;               // memory_nodes.id（UUID）
  type: string;                  // memory_entry / decision / project_milestone / ...
  title: string;
  summary: string;
  tags: string[];
  importance: number;
  created_at: number;
  source: string;
  tenantId?: string;             // 多租户隔离（对应 user_id）
  userId?: string;               // 冗余字段，方便过滤
  scope?: string;                // public / global / personal
  tier_min?: number;             // 最低权限等级
};

type VectorEntry = {
  id: string;
  vector: Float32Array;
  metadata: VectorMetadata;
};

type VectorQueryOptions = {
  topK: number;
  filter?: {
    type?: string[];
    importanceMin?: number;
    source?: string[];
    tags?: string[];
    timeRange?: [number, number];
    tenantId?: string;           // 多租户过滤
    scope?: string;
    tierMax?: number;
  };
  scoreThreshold?: number;
};

type VectorResult = {
  id: string;
  score: number;                 // 余弦相似度 0-1
  metadata: VectorMetadata;
};

type VectorStoreStats = {
  totalEntries: number;
  dimension: number;
  memoryUsageBytes: number;
  indexType: string;
};
```

## 2. 当前实现：内存暴力余弦搜索

**文件**: `packages/memory-vector/src/vector-store.ts`

```typescript
class SqliteVectorStore implements VectorStore {
  private vectors: Map<string, Float32Array> = new Map();
  private metadata: Map<string, VectorMetadata> = new Map();
  private db: Database;  // SQLite 存储元数据

  async query(vector: Float32Array, options: VectorQueryOptions): Promise<VectorResult[]> {
    const results: VectorResult[] = [];

    for (const [id, vec] of this.vectors) {
      const meta = this.metadata.get(id);
      if (!meta) continue;
      if (!this._passesFilter(meta, options.filter)) continue;

      const score = this._cosineSimilarity(vector, vec);
      if (options.scoreThreshold !== undefined && score < options.scoreThreshold) continue;

      results.push({ id, score, metadata: meta });
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, options.topK);
  }

  private _cosineSimilarity(a: Float32Array, b: Float32Array): number {
    // 标准余弦相似度计算
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }
}
```

**性能说明**：
- O(n) 暴力搜索，n < 10,000 时 < 50ms
- 记录 > 10,000 时需换装 IVF 索引或专用向量引擎
- 向量存储于内存 Map，元数据持久化到 SQLite

## 3. Embedding 接口

```typescript
interface Embedder {
  embed(texts: string[]): Promise<Float32Array[]>;
  dimension: number;
  modelName: string;
  maxTokens: number;
}
```

### 当前实现

**LocalEmbedder**（默认）：纯本地算法，零依赖，384维
**ApiEmbedder**（可配置）：调用 OpenAI-compatible API（如 Jina AI text-embedding-v3）

配置方式：
```
OPENHARNESS_EMBEDDING_API_KEY=sk-...
OPENHARNESS_EMBEDDING_BASE_URL=https://api.jina.ai/v1
OPENHARNESS_EMBEDDING_MODEL=jina-embeddings-v3
```

### 兜底策略

| Embedder | 优先级 | 条件 |
|----------|--------|------|
| ApiEmbedder | 首选 | 配置了 API key |
| LocalEmbedder | 兜底 | 未配置 API key |
| SimpleEmbedder | 最后兜底 | LocalEmbedder 初始化失败 |

**模型切换时需重建全部向量索引。**

## 4. QueryOptimizer 接口（新增）

```typescript
interface QueryOptimizer {
  optimize(query: string): Promise<string>;
}

// LLM 实现
class LLMQueryOptimizer implements QueryOptimizer {
  // 调用文本生成 API 重写查询
  // 默认模型: gpt-4o-mini
  // 失败时返回原查询
}

// 默认实现（不优化）
class NoopQueryOptimizer implements QueryOptimizer {
  async optimize(query: string): Promise<string> {
    return query;
  }
}
```

## 5. Reranker 接口（新增）

```typescript
interface Reranker {
  rerank(query: string, candidates: RerankerCandidate[]): Promise<ScoredCandidate[]>;
}

// Embedding 实现
class EmbeddingReranker implements Reranker {
  // 流程: embed(query) + embed(candidate.summary) → cosine similarity
  // 融合分数: 0.7 * cosSim + 0.3 * originalScore
  // 默认: Top-20 → Top-5
}

// 默认实现（不重排）
class NoopReranker implements Reranker {
  async rerank(query: string, candidates: RerankerCandidate[]): Promise<ScoredCandidate[]> {
    return candidates;
  }
}
```

## 6. 同步策略

| 事件 | 向量操作 |
|------|---------|
| 写入 MemoryEntry | 同步 upsert（直接写入内存 Map + SQLite） |
| 更新 MemoryEntry | 更新向量 + metadata |
| 删除 MemoryEntry | 删除向量 |
| 重建 | 从 memory_nodes 全量遍历 → re-embed → 全量 upsert |
| 模型切换 | 全部删除 → 重建 |
