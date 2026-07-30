/**
 * memory-vector: 主入口
 *
 * 将向量存储、embedding 模型、查询优化器、重排序器组合为统一的检索能力。
 */

export { SqliteVectorStore } from "./vector-store";
export { IVFIndex } from "./ivf-index";
export { LocalEmbedder, ApiEmbedder, SimpleEmbedder } from "./embedder";
export type { Embedder } from "./embedder";
export type {
  VectorMetadata,
  VectorEntry,
  VectorQueryOptions,
  VectorResult,
  VectorStoreStats,
} from "./vector-store";

// === Query Optimizer ===
export { NoopQueryOptimizer, LLMQueryOptimizer } from "./query-optimizer";
export type { QueryOptimizer, LLMQueryOptimizerConfig } from "./query-optimizer";

// === Reranker ===
export { NoopReranker, EmbeddingReranker } from "./reranker";
export type { Reranker, RerankerCandidate, ScoredCandidate, EmbeddingRerankerConfig } from "./reranker";