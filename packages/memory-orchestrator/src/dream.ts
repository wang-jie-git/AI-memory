/**
 * Dream Engine — 记忆熵减引擎
 *
 * 模拟人脑睡眠时的记忆整理过程：
 *   冗余合并 → 主题聚类 → insight 提取 → 低价值修剪
 *
 * 核心哲学：
 *   写入是熵增（清醒），梦境是熵减（睡眠）。
 *   无梦境则系统趋于混乱，有梦境则记忆精炼。
 */

import { MemoryDatabase, type MemoryNode, type MemoryNodeType, type MemoryStatus, type EdgeRelation } from "../../memory-graph/src/database";
import { SqliteVectorStore } from "../../memory-vector/src/vector-store";
import type { Embedder } from "../../memory-vector/src/embedder";

// ===== Types =====

export interface DreamConfig {
  /** 余弦相似度阈值，高于此值视为冗余 (0-1, 默认 0.92) */
  redundancyThreshold: number;
  /** 聚类相似度阈值 (0-1, 默认 0.75) */
  clusterSimilarity: number;
  /** 最小聚类规模，低于此不生成 insight (默认 3) */
  minClusterSize: number;
  /** 低重要性阈值，低于此可能被归档 (1-10, 默认 3) */
  lowImportanceThreshold: number;
  /** 最大 TTL 天数，超过此值且低重要性的被删除 (默认 365) */
  maxAgeDays: number;
  /** 预览模式：不实际修改数据 */
  dryRun: boolean;
  /** 是否启用 LLM 摘要生成（默认 false，纯算法模式） */
  llmEnabled: boolean;
}

export const DEFAULT_DREAM_CONFIG: DreamConfig = {
  redundancyThreshold: 0.92,
  clusterSimilarity: 0.75,
  minClusterSize: 3,
  lowImportanceThreshold: 3,
  maxAgeDays: 365,
  dryRun: false,
  llmEnabled: false,
};

export interface DreamSnapshot {
  nodes: number;
  edges: number;
  activeByType: Record<string, number>;
  coldVectors: number;
}

export interface MergeAction {
  targetId: string;
  targetTitle: string;
  sourceIds: string[];
  sourceTitles: string[];
  mergedImportance: number;
  mergedTags: string[];
}

export interface InsightAction {
  title: string;
  confidence: number;
  relatedNodeIds: string[];
  relatedTitles: string[];
  commonTags: string[];
  insightId: string;
}

export interface DreamReport {
  dreamId: string;
  timestamp: number;
  duration: number;
  dryRun: boolean;
  summary: {
    before: DreamSnapshot;
    after: DreamSnapshot;
  };
  actions: {
    merged: MergeAction[];
    archived: string[];
    deleted: string[];
    insights: InsightAction[];
  };
  healthScore: number;
}

// ===== Union-Find (用于聚类) =====

class UnionFind {
  parent: Map<string, string> = new Map();

  find(x: string): string {
    if (!this.parent.has(x)) this.parent.set(x, x);
    const p = this.parent.get(x)!;
    if (p !== x) {
      this.parent.set(x, this.find(p));
    }
    return this.parent.get(x)!;
  }

  union(a: string, b: string): void {
    const ra = this.find(a), rb = this.find(b);
    if (ra !== rb) this.parent.set(rb, ra);
  }

  groups(): Map<string, string[]> {
    const map = new Map<string, string[]>();
    for (const key of this.parent.keys()) {
      const root = this.find(key);
      if (!map.has(root)) map.set(root, []);
      map.get(root)!.push(key);
    }
    return map;
  }
}

// ===== Dream Engine =====

export class DreamEngine {
  private config: DreamConfig;
  private memoryDb: MemoryDatabase;
  private vectorStore: SqliteVectorStore;
  private embedder: Embedder;

  constructor(
    memoryDb: MemoryDatabase,
    vectorStore: SqliteVectorStore,
    embedder: Embedder,
    config: Partial<DreamConfig> = {},
  ) {
    this.memoryDb = memoryDb;
    this.vectorStore = vectorStore;
    this.embedder = embedder;
    this.config = { ...DEFAULT_DREAM_CONFIG, ...config };
  }

  /** 更新运行时配置 */
  setConfig(config: Partial<DreamConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * 执行一次完整的梦境整理周期
   *
   * Phase 1: 快照 — 记录整理前的状态
   * Phase 2: 冗余合并 — 检测并合并高度相似的记忆
   * Phase 3: 主题聚类 — 聚类相关记忆并生成 insight
   * Phase 4: 价值修剪 — 归档/删除低价值记忆
   * Phase 5: 报告 — 输出梦境报告
   */
  async consolidate(): Promise<DreamReport> {
    const dreamId = crypto.randomUUID();
    const startTime = performance.now();

    // ── Phase 1: Before Snapshot ──
    const before = this.takeSnapshot();

    // ── Phase 2: Redundancy Merge ──
    const merged = this.config.dryRun ? [] : await this.mergeRedundant();

    // ── Phase 3: Clustering & Insight ──
    const insights = this.config.dryRun ? [] : await this.clusterAndGenerateInsights();

    // ── Phase 4: Pruning ──
    const { archived, deleted } = this.config.dryRun ? { archived: [] as string[], deleted: [] as string[] } : this.pruneLowValue();

    // ── Phase 5: After Snapshot ──
    const after = this.takeSnapshot();

    // Dream health score
    const healthScore = this.computeHealthScore(before, after);

    const duration = Math.round(performance.now() - startTime);

    // 记录梦境日志
    if (!this.config.dryRun) {
      this.logDream(dreamId, startTime, duration, before, after, merged, archived, deleted, insights, healthScore);
    }

    return {
      dreamId,
      timestamp: startTime,
      duration,
      dryRun: this.config.dryRun,
      summary: { before, after },
      actions: { merged, archived, deleted, insights },
      healthScore,
    };
  }

  // ================================================================
  //  Phase 2: Redundancy Merge
  // ================================================================

  /**
   * 检测并合并冗余记忆。
   * 条件：向量相似度 > threshold AND 标签重叠 > 80%
   */
  private async mergeRedundant(): Promise<MergeAction[]> {
    const allNodes = this.getActiveNodes();
    if (allNodes.length < 2) return [];

    const actions: MergeAction[] = [];
    const mergedIds = new Set<string>(); // 已被合并的源节点

    for (let i = 0; i < allNodes.length; i++) {
      const nodeA = allNodes[i];
      if (mergedIds.has(nodeA.id)) continue;

      // 用向量查找可能相似的 TOP 5
      const queryVec = await this.getNodeVector(nodeA.id);
      if (!queryVec) continue;

      const similar = this.vectorStore.query(queryVec, {
        topK: 6, // 5 similar + self
        scoreThreshold: this.config.redundancyThreshold,
      });

      for (const result of similar) {
        if (result.id === nodeA.id) continue; // 跳过自身
        if (mergedIds.has(result.id)) continue; // 已被合并

        const nodeB = this.memoryDb.getNode(result.id);
        if (!nodeB) continue;

        // 检查标签重叠
        const overlap = this.tagOverlap(nodeA.tags, nodeB.tags);
        if (overlap < 0.8) continue;

        // 检查时间间隔（超过 7 天的即使相似也不合并——可能是不同上下文）
        const timeDelta = Math.abs(nodeA.createdAt - nodeB.createdAt);
        if (timeDelta > 7 * 86400000) continue;

        // 执行合并：保留 importance 更高的节点
        const [keeper, obsolete] = nodeA.importance >= nodeB.importance
          ? [nodeA, nodeB] : [nodeB, nodeA];

        // 合并标签
        const mergedTags = [...new Set([...keeper.tags, ...obsolete.tags])];

        // 合并内容
        const mergedBody = keeper.body
          ? (obsolete.body ? `${keeper.body}\n\n---\n${obsolete.body}` : keeper.body)
          : obsolete.body;
        const mergedSummary = keeper.summary.length >= obsolete.summary.length
          ? keeper.summary : obsolete.summary;

        // 更新 keeper
        this.memoryDb.updateNode(keeper.id, {
          tags: mergedTags,
          summary: mergedSummary,
          body: mergedBody,
          importance: Math.min(10, keeper.importance + 1), // 合并后重要性略增
        });

        // 标记 obsolete
        this.memoryDb.updateNode(obsolete.id, {
          status: "archived",
        });

        // 创建 supersedes 边
        this.memoryDb.linkMemoryToMemory(
          obsolete.id, keeper.id, "supersedes", 1.0,
          `梦境合并：${obsolete.title} → ${keeper.title}`,
        );

        mergedIds.add(obsolete.id);

        actions.push({
          targetId: keeper.id,
          targetTitle: keeper.title,
          sourceIds: [obsolete.id],
          sourceTitles: [obsolete.title],
          mergedImportance: keeper.importance,
          mergedTags,
        });

        break; // 每个节点只合入一次
      }
    }

    return actions;
  }

  // ================================================================
  //  Phase 3: Clustering & Insight Generation
  // ================================================================

  /**
   * 聚类相关记忆并生成 insight 节点。
   * 策略：按公共标签聚类（标签 → 节点倒排），合并重叠簇。
   * 避免 O(n²) 向量比较，用标签作为高效代理信号。
   */
  private async clusterAndGenerateInsights(): Promise<InsightAction[]> {
    const allNodes = this.getActiveNodes();
    if (allNodes.length < this.config.minClusterSize) return [];

    // Step 1: 构建标签 → 节点倒排索引
    const tagToNodes = new Map<string, string[]>();
    for (const node of allNodes) {
      for (const tag of node.tags) {
        // 跳过自动生成的标签
        if (tag.startsWith("dream-") || tag === "auto-generated") continue;
        if (!tagToNodes.has(tag)) tagToNodes.set(tag, []);
        tagToNodes.get(tag)!.push(node.id);
      }
    }

    // Step 2: 找到有足够节点的标签，用 Union-Find 合并重叠簇
    const uf = new UnionFind();
    const validTags = [...tagToNodes.entries()]
      .filter(([_, nodes]) => nodes.length >= this.config.minClusterSize);

    if (validTags.length === 0) return [];

    for (const [tag, nodeIds] of validTags) {
      // 同一标签下的所有节点连接在一起
      for (let i = 1; i < nodeIds.length; i++) {
        uf.union(nodeIds[0], nodeIds[i]);
      }
    }

    // Step 3: 提取聚类组
    const groups = uf.groups();
    const insights: InsightAction[] = [];

    for (const [rootId, memberIds] of groups) {
      if (memberIds.length < this.config.minClusterSize) continue;

      const members = memberIds
        .map((id) => allNodes.find((n) => n.id === id))
        .filter((n): n is MemoryNode => n !== undefined);

      if (members.length < this.config.minClusterSize) continue;

      // Step 4: 提取公共标签（出现在至少 50% 成员中的标签）
      const tagCount = new Map<string, number>();
      for (const m of members) {
        for (const t of m.tags) {
          tagCount.set(t, (tagCount.get(t) ?? 0) + 1);
        }
      }
      const commonTags = [...tagCount.entries()]
        .filter(([_, count]) => count >= members.length * 0.5)
        .map(([tag]) => tag);

      // 生成 insight 标题
      const title = this.synthesizeInsightTitle(members, commonTags);
      const topImportance = Math.max(...members.map((m) => m.importance));
      const avgImportance = Math.round(members.reduce((s, m) => s + m.importance, 0) / members.length);

      // 创建 insight 节点
      const insightNode = this.memoryDb.createNode({
        title,
        summary: `梦境提炼：${members.length} 条相关记忆的模式归纳`,
        body: members.map((m, i) =>
          `${i + 1}. **${m.title}** (重要性: ${m.importance}/10)\n   ${m.summary}`
        ).join("\n\n"),
        importance: Math.min(10, topImportance + 1), // insight 比最高成员略高
        status: "active",
        source: "system",
        sourceSession: null,
        tags: [...commonTags, "dream-insight", "auto-generated"],
        nodeType: "insight",
        ttlDays: null,
        scope: "public",
        tierMin: 1,
        negativeExamples: [],
        isDeprecated: false,
        deprecatedAt: null,
        userId: "default",
      });

      // 链接所有成员到 insight
      for (const m of members) {
        this.memoryDb.linkMemoryToMemory(
          m.id, insightNode.id, "references", 0.9,
          `梦境聚类：${m.title} → ${title}`,
        );
      }

      // 创建 summarizes 边（insight → 每个成员）
      for (const m of members) {
        this.memoryDb.linkMemoryToMemory(
          insightNode.id, m.id, "summarizes", avgImportance / 10,
          `梦境提炼节点`,
        );
      }

      insights.push({
        title,
        confidence: Math.round((memberIds.length / (memberIds.length + 2)) * 100) / 100,
        relatedNodeIds: members.map((m) => m.id),
        relatedTitles: members.map((m) => m.title),
        commonTags,
        insightId: insightNode.id,
      });
    }

    return insights;
  }

  // ================================================================
  //  Phase 4: Pruning
  // ================================================================

  /**
   * 修剪低价值记忆：
   * 1. TTL 过期 → 直接删除
   * 2. 低重要性 + 无引用 + 旧数据 → 归档
   * 3. 归档 + 超期 → 删除
   */
  private pruneLowValue(): { archived: string[]; deleted: string[] } {
    const now = Date.now();
    const allNodes = this.memoryDb.getAllNodes(); // 包含 archived 状态
    const archived: string[] = [];
    const deleted: string[] = [];

    for (const node of allNodes) {
      // 跳过 insight（它们是整理产出的精华，不自动修剪）
      if (node.nodeType === "insight") continue;

      // 跳过带 procedure 的决策节点（程序记忆，经验步骤，自动保留）
      if (node.nodeType === "decision") {
        try {
          const body = JSON.parse(node.body);
          if (body.procedure) continue;
        } catch {
          // body 解析失败，继续正常判断
        }
      }

      // 结构模板特殊处理：不自动归档，但已废弃的超过 7 天可删除
      if (this.isTemplateNode(node)) {
        if (node.isDeprecated && node.deprecatedAt) {
          const deprecatedAge = now - node.deprecatedAt;
          if (deprecatedAge > 7 * 86400000) {
            this.deleteNodeAndVector(node.id);
            deleted.push(node.id);
            continue;
          }
        }
        // 模板不自动归档
        continue;
      }

      // ── TTL 过期 → 删除 ──
      if (node.ttlDays !== null) {
        const expiresAt = node.createdAt + node.ttlDays * 86400000;
        if (now > expiresAt) {
          this.deleteNodeAndVector(node.id);
          deleted.push(node.id);
          continue;
        }
      }

      // ── 已归档 + 超 2 倍 maxAgeDays → 删除 ──
      if (node.status === "archived") {
        const archiveAge = now - node.updatedAt;
        if (archiveAge > this.config.maxAgeDays * 2 * 86400000) {
          this.deleteNodeAndVector(node.id);
          deleted.push(node.id);
          continue;
        }
        continue; // 已归档不再次归档
      }

      // ── 低重要性 + 无引用 + 旧数据 → 归档 ──
      if (node.importance <= this.config.lowImportanceThreshold) {
        const age = now - node.createdAt;
        const ageDays = age / 86400000;

        if (ageDays > 90) { // 超过 90 天
          // 检查是否有入边（被引用）
          const related = this.memoryDb.getRelatedMemories(node.id, { depth: 1, minWeight: 0.1 });
          const incomingCount = related.filter((r) => r.direction === "incoming").length;

          if (incomingCount === 0) {
            // 完全孤立 → 归档
            this.memoryDb.updateNode(node.id, { status: "archived" });
            archived.push(node.id);

            // 同时标记向量为 cold
            this.vectorStore.moveToCold([node.id]);
          }
        }
      }
    }

    return { archived, deleted };
  }

  // ================================================================
  //  Helpers
  // ================================================================

  /** 获取所有 active 节点（排除已废弃的） */
  private getActiveNodes(): MemoryNode[] {
    const all = this.memoryDb.searchByText("", 99999);
    return all.filter((n) => n.status === "active" && !n.isDeprecated);
  }

  /** 判断节点是否为认知模板（st_ 或 ct_ 前缀） */
  private isTemplateNode(node: MemoryNode): boolean {
    return node.nodeType === "structure_template" || node.id.startsWith("st_") || node.id.startsWith("ct_");
  }

  /** 获取节点的向量表示 */
  private async getNodeVector(nodeId: string): Promise<Float32Array | null> {
    // 直接通过向量存储查询：用 nodeId 查 metadata
    // SqliteVectorStore 没有 getById 方法，所以先粗略搜索再过滤
    const allNodes = this.getActiveNodes();
    const node = allNodes.find((n) => n.id === nodeId);
    if (!node) return null;

    // 重新 embedding 获得向量
    try {
      return await this.embedder.embed(node.summary || node.title);
    } catch {
      return null;
    }
  }

  /** 标签重叠率 (Jaccard 相似度) */
  private tagOverlap(tagsA: string[], tagsB: string[]): number {
    if (tagsA.length === 0 && tagsB.length === 0) return 0;
    const setA = new Set(tagsA);
    const setB = new Set(tagsB);
    const intersection = new Set([...setA].filter((x) => setB.has(x)));
    const union = new Set([...setA, ...setB]);
    return union.size === 0 ? 0 : intersection.size / union.size;
  }

  /** 余弦相似度 */
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

  /** 删除节点及其向量 */
  private deleteNodeAndVector(nodeId: string): void {
    this.memoryDb.deleteNode(nodeId);
    this.vectorStore.delete(nodeId);
  }

  /** 从标签中合成 insight 标题 */
  private synthesizeInsightTitle(members: MemoryNode[], commonTags: string[]): string {
    // 策略：用公共标签构建标题，加上时间范围
    const dates = members.map((m) => m.createdAt).sort();
    const dateRange = dates.length >= 2
      ? `${new Date(dates[0]).toLocaleDateString()} ~ ${new Date(dates[dates.length - 1]).toLocaleDateString()}`
      : new Date(dates[0]).toLocaleDateString();

    const tagPart = commonTags.length > 0
      ? commonTags.slice(0, 3).join(" · ")
      : "未标签记忆";

    const topMember = members.reduce((a, b) => a.importance >= b.importance ? a : b);
    const hint = topMember.title.length <= 20 ? topMember.title : topMember.title.slice(0, 20) + "…";

    return `📊 ${tagPart} (${members.length}条, ${dateRange})`;
  }

  /** 快照当前状态 */
  private takeSnapshot(): DreamSnapshot {
    const activeNodes = this.memoryDb.searchByText("", 99999);
    const activeByType: Record<string, number> = {};
    let totalActive = 0;

    for (const n of activeNodes) {
      if (n.status === "active" && !n.isDeprecated) {
        activeByType[n.nodeType] = (activeByType[n.nodeType] ?? 0) + 1;
        totalActive++;
      }
    }

    const stats = this.memoryDb.getStats();

    return {
      nodes: totalActive, // 仅 active 节点
      edges: stats.totalEdges,
      activeByType,
      coldVectors: 0,
    };
  }

  /** 计算健康评分 (0-10) */
  private computeHealthScore(before: DreamSnapshot, after: DreamSnapshot): number {
    // 因子 1: 冗余率 — 越少冗余越好 (权重 0.3)
    const redundancyRatio = before.nodes > 0
      ? Math.max(0, 1 - (after.nodes / before.nodes))
      : 0.5;
    const redundancyScore = Math.min(10, redundancyRatio * 20); // 每减少 5% 得 1 分

    // 因子 2: insight 密度 — insight 占总 active 比例 (权重 0.3)
    const totalActive = Object.values(after.activeByType).reduce((a, b) => a + b, 0);
    const insightCount = after.activeByType["insight"] ?? 0;
    const insightDensity = totalActive > 0 ? insightCount / totalActive : 0;
    const insightScore = Math.min(10, insightDensity * 100); // 1% = 1 分，封顶 10

    // 因子 3: 活跃度 — active 占比 (权重 0.2)
    const activeRatio = after.nodes > 0 ? totalActive / after.nodes : 0.5;
    const activeScore = activeRatio * 10;

    // 因子 4: 简洁度 — 平均每个 edge 覆盖的 node 数高则结构好 (权重 0.2)
    const structureDensity = after.nodes > 0 ? after.edges / after.nodes : 0;
    const structureScore = Math.min(10, structureDensity * 5); // 每个 node 有 2 条 edge 得满分

    return Math.round(
      0.3 * redundancyScore +
      0.3 * insightScore +
      0.2 * activeScore +
      0.2 * structureScore
    );
  }

  /** 记录梦境日志到 dream_logs 表 */
  private logDream(
    dreamId: string,
    startedAt: number,
    duration: number,
    before: DreamSnapshot,
    after: DreamSnapshot,
    merged: MergeAction[],
    archived: string[],
    deleted: string[],
    insights: InsightAction[],
    healthScore: number,
  ): void {
    try {
      const rawDb = this.memoryDb.getRawDb();
      rawDb.prepare(`
        INSERT INTO dream_logs (id, started_at, finished_at, duration_ms,
          before_nodes, before_edges, after_nodes, after_edges,
          merged_count, archived_count, deleted_count, insights_generated,
          health_score, report_json, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        dreamId, startedAt, Date.now(), duration,
        before.nodes, before.edges, after.nodes, after.edges,
        merged.length, archived.length, deleted.length, insights.length,
        healthScore,
        JSON.stringify({ merged, archived, deleted, insights }),
        "completed",
      );
    } catch {
      // 日志记录失败不影响梦境结果
    }
  }
}
