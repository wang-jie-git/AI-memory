/**
 * Nudge Engine — 主动记忆提示系统
 *
 * 受 Hermes 周期性 nudge 机制启发（RFC-06 Phase B）。
 * 当 agent 完成复杂任务、发现重复模式、或复现已知问题时，
 * 主动建议写入记忆，而不是等待显式调用 memory_write。
 *
 * 三种触发场景：
 * 1. COMPLEX_TASK — 检测到高重要性/多步骤操作完成
 * 2. REPEATED_PATTERN — 同一话题/任务出现多次
 * 3. ERROR_REVISIT — 已知错误模式再次出现
 *
 * 使用方式：
 *   const engine = new NudgeEngine(db);
 *   engine.onMemoryWritten(newMemories, options);
 *   // → 返回 nudge 建议列表
 *
 * 设计原则：
 * - 零阻塞：所有分析在写路径外异步完成
 * - 轻量级：不使用 LLM，只做规则匹配和相似度分析
 * - 可配置：阈值可调，可禁用特定场景
 */

import { MemoryDatabase, MemoryNode, EdgeRelation } from "./database";

// ===== Types =====

export type NudgeReason =
  | "complex_task"
  | "repeated_pattern"
  | "error_revisit"
  | "knowledge_gap";

export interface NudgeSuggestion {
  /** 提示原因 */
  reason: NudgeReason;
  /** 提示文本 */
  message: string;
  /** 建议的操作 */
  action: "write_memory" | "update_memory" | "create_decision" | "review";
  /** 建议写入的记忆内容 */
  suggestedMemory: {
    title: string;
    summary: string;
    tags: string[];
    importance: number;
  };
  /** 触发的源记忆 ID 列表 */
  triggeredBy: string[];
  /** 置信度 (0-1) */
  confidence: number;
  /** 关联的已有记忆 ID（如果有） */
  relatedMemoryId?: string;
}

export interface NudgeOptions {
  /** 启用场景（默认全开） */
  enabledScenes?: NudgeReason[];
  /** 重复模式检测：同一话题最小出现次数 */
  repeatThreshold?: number;
  /** 重复模式检测：时间窗口（毫秒） */
  repeatWindowMs?: number;
  /** 复杂任务检测：最小重要性阈值 */
  complexTaskMinImportance?: number;
  /** 复杂任务检测：最小记忆数 */
  complexTaskMinMemories?: number;
  /** 用户 ID（多租户） */
  userId?: string;
}

// ===== Nudge Engine =====

export class NudgeEngine {
  private db: MemoryDatabase;
  private options: Required<NudgeOptions>;

  // 默认配置
  private static readonly DEFAULTS: Required<NudgeOptions> = {
    enabledScenes: ["complex_task", "repeated_pattern", "error_revisit"],
    repeatThreshold: 2,
    repeatWindowMs: 3600000, // 1 小时
    complexTaskMinImportance: 7,
    complexTaskMinMemories: 3,
    userId: "default",
  };

  constructor(db: MemoryDatabase, options: NudgeOptions = {}) {
    this.db = db;
    this.options = { ...NudgeEngine.DEFAULTS, ...options };
  }

  /**
   * 当新记忆写入时调用，返回 nudge 建议列表
   *
   * 在写路径外异步调用，不阻塞主流程。
   * 每条新记忆独立分析，去重后返回。
   */
  onMemoryWritten(
    memories: MemoryNode[],
    options?: { sessionId?: string },
  ): NudgeSuggestion[] {
    if (memories.length === 0) return [];

    const suggestions: NudgeSuggestion[] = [];
    const seenKeys = new Set<string>();

    for (const mem of memories) {
      // 跳过系统级别和 session_summary 节点
      if (mem.source === "system" || mem.nodeType === "session_summary") continue;

      const sceneHints = this._detectScene(mem);

      for (const scene of sceneHints) {
        const key = `${scene.reason}:${mem.id}`;
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);

        // 去重：检查是否已有相同建议
        if (scene.confidence < 0.3) continue;

        suggestions.push(scene);
      }
    }

    return suggestions;
  }

  /**
   * 批量分析：扫描近期所有记忆，发现跨会话模式
   *
   * 适合定时触发（如每 5 分钟），
   * 发现新 nudge 时返回建议列表。
   */
  analyzeRecent(hours = 1): NudgeSuggestion[] {
    const recent = this.db.getRecentMemories(hours, 100);
    if (recent.length === 0) return [];

    const suggestions: NudgeSuggestion[] = [];
    const sessionId = `batch-${Date.now()}`;

    // 1. 检测重复模式
    suggestions.push(...this._detectRepeatedPatterns(recent));

    // 2. 检测错误复现
    suggestions.push(...this._detectErrorRevisits(recent));

    // 3. 检测知识缺口
    suggestions.push(...this._detectKnowledgeGaps(recent));

    // 去重
    return this._deduplicate(suggestions);
  }

  /**
   * 更新配置（运行时动态调整）
   */
  updateOptions(options: Partial<NudgeOptions>): void {
    this.options = { ...this.options, ...options };
  }

  // ===== Private: Scene Detection =====

  /**
   * 对单条新记忆检测所有可能的 nudge 场景
   */
  private _detectScene(mem: MemoryNode): NudgeSuggestion[] {
    const results: NudgeSuggestion[] = [];

    // 场景 1: 复杂任务完成
    if (
      this.options.enabledScenes.includes("complex_task") &&
      (mem.importance ?? 5) >= this.options.complexTaskMinImportance
    ) {
      results.push({
        reason: "complex_task",
        message: `检测到高重要性记忆"${mem.title}"（重要性 ${mem.importance}），建议记录为经验。`,
        action: "write_memory",
        suggestedMemory: {
          title: `[经验] ${mem.title}`,
          summary: mem.summary,
          tags: ["experience", ...(mem.tags ?? [])],
          importance: mem.importance ?? 7,
        },
        triggeredBy: [mem.id],
        confidence: 0.6,
      });
    }

    // 场景 2: 可能的知识缺口（记忆有 body 但无 summary，或标题太短）
    if (
      mem.nodeType === "memory_entry" &&
      (!mem.summary || mem.summary.length < 20) &&
      (mem.body && mem.body.length > 100)
    ) {
      results.push({
        reason: "knowledge_gap",
        message: `"${mem.title}" 有详细内容但没有摘要，建议补充。`,
        action: "update_memory",
        suggestedMemory: {
          title: mem.title,
          summary: mem.body.slice(0, 200) + (mem.body.length > 200 ? "..." : ""),
          tags: mem.tags ?? [],
          importance: mem.importance ?? 5,
        },
        triggeredBy: [mem.id],
        confidence: 0.5,
      });
    }

    return results;
  }

  /**
   * 检测重复模式：同一话题短时间多次出现
   */
  private _detectRepeatedPatterns(memories: MemoryNode[]): NudgeSuggestion[] {
    const results: NudgeSuggestion[] = [];
    if (!this.options.enabledScenes.includes("repeated_pattern")) return results;

    const windowMs = this.options.repeatWindowMs;
    const threshold = this.options.repeatThreshold;
    const now = Date.now();

    // 按标签分组统计
    const tagGroups = new Map<string, MemoryNode[]>();

    for (const mem of memories) {
      const tags = mem.tags ?? [];
      for (const tag of tags) {
        if (tag === "session_summary") continue;
        if (!tagGroups.has(tag)) tagGroups.set(tag, []);
        tagGroups.get(tag)!.push(mem);
      }
    }

    // 检测：同一标签下，事件间距在窗口内的
    for (const [tag, tagged] of tagGroups) {
      if (tagged.length < threshold) continue;

      // 按时间排序
      tagged.sort((a, b) => a.createdAt - b.createdAt);

      // 滑动窗口统计
      let maxCount = 0;
      let maxWindow: MemoryNode[] = [];

      for (let i = 0; i < tagged.length; i++) {
        const windowStart = tagged[i].createdAt;
        const windowEnd = windowStart + windowMs;
        const inWindow = tagged.filter(
          (m) => m.createdAt >= windowStart && m.createdAt <= windowEnd,
        );
        if (inWindow.length > maxCount) {
          maxCount = inWindow.length;
          maxWindow = inWindow;
        }
      }

      if (maxCount >= threshold) {
        const titles = maxWindow.map((m) => m.title).join(", ");
        // 只对最新一条触发（避免重复提示）
        const latest = maxWindow[maxWindow.length - 1];

        // 检查是否已有相关的 decision 节点
        const hasDecision = this._hasRelatedDecision(latest, tag);

        if (!hasDecision) {
          results.push({
            reason: "repeated_pattern",
            message: `标签"${tag}"在 ${maxWindow.length} 次操作中重复出现（${titles}）。建议记录为通用经验。`,
            action: "create_decision",
            suggestedMemory: {
              title: `[规则] 关于 ${tag} 的通用经验`,
              summary: `从 ${maxWindow.length} 次实践中总结关于"${tag}"的通用经验。`,
              tags: [tag, "rule", "experience"],
              importance: 6,
            },
            triggeredBy: maxWindow.map((m) => m.id),
            confidence: Math.min(0.4 + maxCount * 0.1, 0.9),
          });
        }
      }
    }

    return results;
  }

  /**
   * 检测错误复现：新记忆与已知的 decision/错误记录匹配
   */
  private _detectErrorRevisits(memories: MemoryNode[]): NudgeSuggestion[] {
    const results: NudgeSuggestion[] = [];
    if (!this.options.enabledScenes.includes("error_revisit")) return results;

    // 获取所有活跃的 decision 节点（>= 中等重要性）
    const rawDb = this.db.getRawDb();
    const decisions = rawDb
      .prepare(
        `SELECT * FROM memory_nodes
         WHERE node_type = 'decision'
           AND status = 'active'
           AND importance >= 4
         ORDER BY created_at DESC
         LIMIT 50`,
      )
      .all() as Record<string, unknown>[];

    if (decisions.length === 0) return results;

    for (const mem of memories) {
      // 只检查 memory_entry 和 insight
      if (mem.nodeType !== "memory_entry" && mem.nodeType !== "insight") continue;

      const memTerms = this._extractTerms(mem.title + " " + mem.summary);

      for (const dec of decisions) {
        const decTitle = (dec.title as string) ?? "";
        const decSummary = (dec.summary as string) ?? "";
        const decTerms = this._extractTerms(decTitle + " " + decSummary);

        // 简单重叠度计算
        const overlap = memTerms.filter((t) => decTerms.includes(t)).length;
        const overlapRatio = decTerms.length > 0 ? overlap / decTerms.length : 0;

        if (overlapRatio >= 0.4) {
          results.push({
            reason: "error_revisit",
            message: `新记忆"${mem.title}"与已有决策"${decTitle}"高度相关（重叠度 ${Math.round(overlapRatio * 100)}%）。建议回顾。`,
            action: "review",
            suggestedMemory: {
              title: mem.title,
              summary: mem.summary,
              tags: mem.tags ?? [],
              importance: mem.importance ?? 5,
            },
            triggeredBy: [mem.id],
            relatedMemoryId: dec.id as string,
            confidence: overlapRatio * 0.8,
          });
        }
      }
    }

    return results;
  }

  /**
   * 检测知识缺口：高重要性记忆但未被关联到代码符号
   */
  private _detectKnowledgeGaps(memories: MemoryNode[]): NudgeSuggestion[] {
    const results: NudgeSuggestion[] = [];
    if (!this.options.enabledScenes.includes("knowledge_gap")) return results;

    for (const mem of memories) {
      if (mem.importance < 6) continue;
      if (mem.nodeType === "session_summary") continue;

      // 检查是否已关联到代码符号
      const edges = this.db.getNodeEdges(mem.id);
      const hasCodeLink = edges.some((e) => e.relation === "links_to_code");

      if (!hasCodeLink) {
        results.push({
          reason: "knowledge_gap",
          message: `高重要性记忆"${mem.title}"（重要性 ${mem.importance}）未关联到任何代码符号。建议关联以增强可追溯性。`,
          action: "update_memory",
          suggestedMemory: {
            title: mem.title,
            summary: mem.summary,
            tags: [...(mem.tags ?? []), "needs_code_link"],
            importance: mem.importance,
          },
          triggeredBy: [mem.id],
          confidence: 0.5,
        });
      }
    }

    return results;
  }

  // ===== Private: Helpers =====

  /**
   * 检查是否已有相关的 decision 节点
   */
  private _hasRelatedDecision(mem: MemoryNode, tag: string): boolean {
    const rawDb = this.db.getRawDb();
    const row = rawDb
      .prepare(
        `SELECT id FROM memory_nodes
         WHERE node_type = 'decision'
           AND status = 'active'
           AND tags LIKE ?
         LIMIT 1`,
      )
      .get(`%"${tag}"%`) as Record<string, unknown> | undefined;
    return row !== undefined;
  }

  /**
   * 提取文本中的关键词（去停用词）
   */
  private _extractTerms(text: string): string[] {
    const stopWords = new Set([
      "的", "了", "在", "是", "我", "有", "和", "就", "不", "人", "都", "一",
      "一个", "上", "也", "很", "到", "说", "要", "去", "你", "会", "着",
      "没有", "看", "好", "自己", "这", "他", "她", "它", "们",
      "the", "a", "an", "is", "are", "was", "were", "be", "been",
      "being", "have", "has", "had", "do", "does", "did", "will",
      "would", "could", "should", "may", "might", "can", "shall",
      "to", "of", "in", "for", "on", "with", "at", "by", "from",
      "as", "into", "through", "during", "before", "after",
      "and", "but", "or", "nor", "not", "so", "yet", "if", "then",
      "this", "that", "these", "those", "it", "its", "my", "your",
      "我们", "你们", "他们", "这个", "那个", "什么", "怎么", "为什么",
    ]);

    return text
      .toLowerCase()
      .split(/[\s,，。！？、；：""''（）()\[\]【】{}]+/)
      .filter((t) => t.length >= 2 && !stopWords.has(t));
  }

  /**
   * 去重：相同 reason + 相同 triggeredBy
   */
  private _deduplicate(suggestions: NudgeSuggestion[]): NudgeSuggestion[] {
    const seen = new Set<string>();
    return suggestions.filter((s) => {
      const key = `${s.reason}:${s.triggeredBy.sort().join(",")}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
}