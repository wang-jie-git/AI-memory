/**
 * memory-orchestrator: 混合查询编排器
 *
 * 向量粗召回 → 图遍历精排序 → 融合打分 → 返回 TOP K
 *
 * 架构:
 *   query("支付超时")
 *     ├── embedder.embed("支付超时") → queryVector
 *     ├── vectorStore.query(queryVector, topK=20) → candidates
 *     ├── for each candidate:
 *     │     memoryDb.getRelatedMemories(id) → graphRelevance
 *     │     computeRecency(createdAt) → recencyScore
 *     └── finalScore = α * vectorScore + β * graphScore + γ * recencyScore
 */

import { MemoryDatabase } from "../../memory-graph/src/database";
import { SqliteVectorStore, type VectorQueryOptions } from "../../memory-vector/src/vector-store";
import type { Embedder } from "../../memory-vector/src/embedder";

// ===== Config =====

export interface HybridQueryConfig {
  alpha: number;         // 向量相似度权重 (default 0.4)
  beta: number;          // 图关联度权重 (default 0.4)
  gamma: number;         // 时效性权重 (default 0.2)
  topK: number;          // 最终返回数量 (default 5)
  candidateK: number;    // 粗召回数量 (default 20)
  maxGraphDepth: number; // 图遍历深度 (default 3)
  timeoutMs: number;     // 查询超时 (default 1000)
}

export const DEFAULT_CONFIG: HybridQueryConfig = {
  alpha: 0.4,
  beta: 0.4,
  gamma: 0.2,
  topK: 5,
  candidateK: 20,
  maxGraphDepth: 3,
  timeoutMs: 1000,
};

// ===== Result Types =====

export interface MemoryQueryResult {
  nodeId: string;
  title: string;
  summary: string;
  score: number;
  vectorScore: number;
  graphScore: number;
  recencyScore: number;
  relations: Array<{
    type: string;
    direction: "incoming" | "outgoing";
    strength: number;
  }>;
  metadata: {
    type: string;
    tags: string[];
    importance: number;
    createdAt: number;
    source: string;
  };
}

export interface QueryTelemetry {
  totalTimeMs: number;
  vectorTimeMs: number;
  graphTimeMs: number;
  candidatesCount: number;
  returnedCount: number;
  degraded: false | "graph_timeout" | "vector_timeout" | "both_timeout";
  top1Score: number;
}

export interface HybridQueryResponse {
  results: MemoryQueryResult[];
  telemetry: QueryTelemetry;
}

// ===== Hybrid Query Engine =====

export class HybridQueryEngine {
  private config: HybridQueryConfig;
  private memoryDb: MemoryDatabase;
  private vectorStore: SqliteVectorStore;
  private embedder: Embedder;

  constructor(
    memoryDb: MemoryDatabase,
    vectorStore: SqliteVectorStore,
    embedder: Embedder,
    config: Partial<HybridQueryConfig> = {},
  ) {
    this.memoryDb = memoryDb;
    this.vectorStore = vectorStore;
    this.embedder = embedder;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Hybrid query: vector semantic recall → graph traversal refine → fusion scoring
   */
  async query(
    queryText: string,
    filter?: VectorQueryOptions["filter"],
  ): Promise<HybridQueryResponse> {
    const startTime = performance.now();
    let vectorTimeMs = 0;
    let graphTimeMs = 0;
    let degraded: QueryTelemetry["degraded"] = false;

    // ── Step 1: Embed the query text ──
    let queryVector: Float32Array;
    try {
      const t0 = performance.now();
      queryVector = await this.embedder.embed(queryText);
      vectorTimeMs += performance.now() - t0;
    } catch (err) {
      // Embedder failed — degrade to text search only
      degraded = "vector_timeout";
      return this.fallbackTextSearch(queryText, filter, startTime);
    }

    // ── Step 2: Vector coarse recall ──
    let candidates: Array<{
      id: string;
      score: number;
      metadata: {
        nodeId: string;
        type: string;
        title: string;
        summary: string;
        importance: number;
        createdAt: number;
        source: string;
      };
    }>;
    try {
      const t0 = performance.now();
      const results = this.vectorStore.query(queryVector, {
        topK: this.config.candidateK,
        filter,
      });
      vectorTimeMs += performance.now() - t0;
      candidates = results.map((r) => ({
        id: r.id,
        score: r.score,
        metadata: r.metadata,
      }));
    } catch {
      degraded = "vector_timeout";
      return this.fallbackTextSearch(queryText, filter, startTime);
    }

    if (candidates.length === 0) {
      degraded = "vector_timeout";
      return this.fallbackTextSearch(queryText, filter, startTime);
    }

    // ── Step 3: Graph traversal refine ──
    const graphStart = performance.now();
    const withGraphScores = candidates.map((candidate) => {
      let graphScore = 0;

      try {
        // Look up the memory node in graph
        const node = this.memoryDb.getNode(candidate.metadata.nodeId);
        if (!node) {
          graphScore = 0;
        } else {
          // 3a. Code linkage score: how many code symbols this memory links to
          const codeLinks = this.memoryDb.getMemoryWithCodeSymbols(node.id);
          const codeLinkageScore = Math.min(codeLinks.length / 3, 1.0); // 3+ links = full score

          // 3b. Relation density: how many other memories reference this
          const related = this.memoryDb.getRelatedMemories(node.id, {
            depth: 1,
            minWeight: 0.1,
          });
          const incomingCount = related.filter((r) => r.direction === "incoming").length;
          const outgoingCount = related.filter((r) => r.direction === "outgoing").length;
          const relationDensity = Math.min((incomingCount + outgoingCount) / 10, 1.0);

          // 3c. Importance score (normalized)
          const importanceScore = node.importance / 10;

          // Combined graph score
          graphScore = 0.4 * codeLinkageScore + 0.3 * relationDensity + 0.3 * importanceScore;
        }
      } catch {
        // Individual node may fail — score as 0, don't fail the whole query
        graphScore = 0;
      }

      return { ...candidate, graphScore };
    });
    graphTimeMs = performance.now() - graphStart;

    // ── Step 4: Fusion scoring ──
    const scored = withGraphScores.map((item) => {
      const vectorScore = Math.max((item.score + 1) / 2, 0); // Normalize [-1,1] → [0,1]
      const graphScore = item.graphScore;
      const recencyScore = this.computeRecency(item.metadata.createdAt);

      const finalScore =
        this.config.alpha * vectorScore +
        this.config.beta * graphScore +
        this.config.gamma * recencyScore;

      return { item, finalScore, vectorScore, graphScore, recencyScore };
    });

    // Sort by final score descending
    scored.sort((a, b) => b.finalScore - a.finalScore);
    const topResults = scored.slice(0, this.config.topK);

    // ── Step 5: Build result objects ──
    const results: MemoryQueryResult[] = [];
    for (const sr of topResults) {
      let relations: MemoryQueryResult["relations"] = [];
      try {
        const related = this.memoryDb.getRelatedMemories(sr.item.metadata.nodeId, { depth: 1 });
        relations = related.map((r) => ({
          type: r.relation as string,
          direction: r.direction,
          strength: r.weight,
        }));
      } catch {
        // Relations are non-critical
      }

      results.push({
        nodeId: sr.item.metadata.nodeId,
        title: sr.item.metadata.title,
        summary: sr.item.metadata.summary,
        score: sr.finalScore,
        vectorScore: sr.vectorScore,
        graphScore: sr.graphScore,
        recencyScore: sr.recencyScore,
        relations,
        metadata: {
          type: sr.item.metadata.type,
          tags: [], // Would need full node for tags
          importance: sr.item.metadata.importance,
          createdAt: sr.item.metadata.createdAt,
          source: sr.item.metadata.source,
        },
      });
    }

    const totalTimeMs = performance.now() - startTime;

    return {
      results,
      telemetry: {
        totalTimeMs: Math.round(totalTimeMs),
        vectorTimeMs: Math.round(vectorTimeMs),
        graphTimeMs: Math.round(graphTimeMs),
        candidatesCount: candidates.length,
        returnedCount: results.length,
        degraded,
        top1Score: results.length > 0 ? results[0].score : 0,
      },
    };
  }

  /**
   * Fallback: text search when vector store is unavailable
   */
  private fallbackTextSearch(
    queryText: string,
    filter: VectorQueryOptions["filter"] | undefined,
    startTime: number,
  ): HybridQueryResponse {
    const nodes = this.memoryDb.searchByText(queryText, this.config.topK);

    // Apply importance filter if specified
    let filtered = nodes;
    if (filter?.importanceMin !== undefined) {
      filtered = filtered.filter((n) => n.importance >= filter.importanceMin!);
    }
    if (filter?.types !== undefined) {
      filtered = filtered.filter((n) => filter.types!.includes(n.nodeType));
    }

    const results: MemoryQueryResult[] = filtered.map((node) => ({
      nodeId: node.id,
      title: node.title,
      summary: node.summary,
      score: node.importance / 10, // Fallback scoring by importance
      vectorScore: 0,
      graphScore: node.importance / 10,
      recencyScore: this.computeRecency(node.createdAt),
      relations: [],
      metadata: {
        type: node.nodeType,
        tags: node.tags,
        importance: node.importance,
        createdAt: node.createdAt,
        source: node.source,
      },
    }));

    const totalTimeMs = performance.now() - startTime;

    return {
      results,
      telemetry: {
        totalTimeMs: Math.round(totalTimeMs),
        vectorTimeMs: 0,
        graphTimeMs: 0,
        candidatesCount: results.length,
        returnedCount: results.length,
        degraded: "vector_timeout",
        top1Score: results.length > 0 ? results[0].score : 0,
      },
    };
  }

  // ===== Scoring Helpers =====

  private computeRecency(timestamp: number): number {
    const now = Date.now();
    const ageMs = now - timestamp;
    const ageDays = ageMs / (1000 * 60 * 60 * 24);

    if (ageDays < 1) return 1.0;
    if (ageDays < 7) return 0.8;
    if (ageDays < 30) return 0.5;
    if (ageDays < 90) return 0.2;
    if (ageDays < 365) return 0.05;
    return 0.01;
  }

  /** Update config at runtime */
  setConfig(config: Partial<HybridQueryConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /** Close all underlying connections */
  close(): void {
    try { this.memoryDb.close(); } catch { /* ignore */ }
    try { this.vectorStore.close(); } catch { /* ignore */ }
  }
}

// ===== Session Compressor =====

export {
  SessionCompressor,
  type SessionSummary,
  type CompressedSession,
  type SessionCompressorConfig,
  DEFAULT_COMPRESSOR_CONFIG,
} from "./session-compressor";
