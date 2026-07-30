/**
 * reranker: 重排序器
 *
 * 对向量粗召回的候选结果重新打分排序。
 * 参考架构: Agentic RAG 的 Multi-Step RAG 模式
 *   - 原文: 先粗筛20个候选 → CrossEncoder 精排 → Top5
 *   - 准确率提升 30%+
 *
 * 默认实现: EmbeddingReranker — 用 embedding 相似度重排序
 * 兜底: NoopReranker — 透传原始顺序
 */

// ===== Interface =====

export interface RerankerCandidate {
  id: string;
  content: string;
  originalScore: number;
  metadata?: Record<string, unknown>;
}

export interface ScoredCandidate {
  id: string;
  score: number;
  originalScore: number;
  metadata?: Record<string, unknown>;
}

export interface Reranker {
  /** 对候选结果重排序，返回重新打分排序后的结果 */
  rerank(query: string, candidates: RerankerCandidate[]): Promise<ScoredCandidate[]>;
  readonly modelName: string;
}

// ===== Noop Fallback =====

export class NoopReranker implements Reranker {
  readonly modelName = "noop";

  async rerank(_query: string, candidates: RerankerCandidate[]): Promise<ScoredCandidate[]> {
    return candidates.map((c) => ({
      id: c.id,
      score: c.originalScore,
      originalScore: c.originalScore,
      metadata: c.metadata,
    }));
  }
}

// ===== Embedding-based Reranker =====

import type { Embedder } from "./embedder";

export interface EmbeddingRerankerConfig {
  /** 粗召回数量，默认 20 */
  candidateK?: number;
  /** 最终返回数量，默认 5 */
  topK?: number;
  /** 重排序权重（0-1），新分数 = w * sim + (1-w) * originalScore，默认 0.7 */
  rerankWeight?: number;
}

export class EmbeddingReranker implements Reranker {
  readonly modelName: string;
  private embedder: Embedder;
  private config: Required<EmbeddingRerankerConfig>;

  constructor(
    embedder: Embedder,
    config: EmbeddingRerankerConfig = {},
  ) {
    this.embedder = embedder;
    this.modelName = `embedding-reranker(${embedder.modelName})`;
    this.config = {
      candidateK: config.candidateK ?? 20,
      topK: config.topK ?? 5,
      rerankWeight: config.rerankWeight ?? 0.7,
    };
  }

  async rerank(query: string, candidates: RerankerCandidate[]): Promise<ScoredCandidate[]> {
    if (candidates.length === 0) return [];

    // Sort by original score descending, take top candidateK
    const sorted = [...candidates].sort((a, b) => b.originalScore - a.originalScore);
    const topCandidates = sorted.slice(0, this.config.candidateK);

    // Embed query and all candidate contents
    const texts = [query, ...topCandidates.map((c) => c.content)];
    const vectors = await this.embedder.embedBatch(texts);

    const queryVec = vectors[0];
    const candidateVecs = vectors.slice(1);

    // Normalize original scores to [0, 1]
    const maxOrig = Math.max(...topCandidates.map((c) => c.originalScore), 0.001);

    // Compute combined scores
    const scored = topCandidates.map((c, i) => {
      const simScore = this.cosineSimilarity(queryVec, candidateVecs[i]);
      const normOrig = c.originalScore / maxOrig;
      const combined = this.config.rerankWeight * simScore + (1 - this.config.rerankWeight) * normOrig;

      return {
        id: c.id,
        score: combined,
        originalScore: c.originalScore,
        metadata: c.metadata,
      };
    });

    // Sort by combined score descending, take topK
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, this.config.topK);
  }

  private cosineSimilarity(a: Float32Array, b: Float32Array): number {
    if (a.length !== b.length) return 0;
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  }
}