/**
 * Session Compressor — 跨会话上下文压缩与注入
 *
 * 复用梦境引擎的蒸馏思路，但更轻量、实时：
 *   会话结束时 → 提取关键信息 → 生成摘要节点 → 关联到项目
 *   新会话启动 → 自动查询最近 N 条摘要 → 注入上下文
 *
 * 纯算法实现（无 LLM 调用），零外部依赖。
 */

import { MemoryDatabase, type MemoryNodeType, type EdgeRelation } from "../../memory-graph/src/database";
import { SqliteVectorStore } from "../../memory-vector/src/vector-store";
import type { Embedder } from "../../memory-vector/src/embedder";

// ===== Types =====

export interface SessionSummary {
  /** 自动生成的会话标题 */
  title: string;
  /** 一句话摘要 */
  summary: string;
  /** 关键决策列表 */
  keyDecisions: Array<{
    decision: string;
    reason: string;
    confidence: number;
  }>;
  /** 未完成事项 */
  unresolvedItems: string[];
  /** 关联标签 */
  tags: string[];
  /** 自动评估的重要性 1-10 */
  importance: number;
  /** 被引用的记忆 ID 列表 */
  referencedMemoryIds: string[];
  /** 被引用的代码符号 ID 列表 */
  referencedCodeSymbolIds: string[];
}

export interface CompressedSession {
  /** 会话 ID（外部传入） */
  sessionId: string;
  /** 会话开始时间戳 */
  sessionStart: number;
  /** 会话结束时间戳 */
  sessionEnd: number;
  /** 消耗的 token 数 */
  tokenCount: number;
  /** 生成的摘要 */
  summary: SessionSummary;
  /** 生成的记忆节点 ID */
  memoryNodeId: string;
}

export interface SessionCompressorConfig {
  /** 摘要触发阈值（token 超过此值才压缩，默认 5000） */
  minTokensForSummary: number;
  /** 最大摘要长度（字符数，默认 500） */
  maxSummaryLength: number;
  /** 跨会话注入时加载最近 N 条摘要（默认 3） */
  recentSummariesCount: number;
  /** 摘要 TTL 天数（默认 30 天，过期后梦境引擎自动处理） */
  summaryTtlDays: number;
  /** 是否自动启用 */
  enabled: boolean;
}

export const DEFAULT_COMPRESSOR_CONFIG: SessionCompressorConfig = {
  minTokensForSummary: 5000,
  maxSummaryLength: 500,
  recentSummariesCount: 3,
  summaryTtlDays: 30,
  enabled: true,
};

// ===== Session Compressor =====

export class SessionCompressor {
  private config: SessionCompressorConfig;
  private memoryDb: MemoryDatabase;
  private vectorStore: SqliteVectorStore;
  private embedder: Embedder;

  constructor(
    memoryDb: MemoryDatabase,
    vectorStore: SqliteVectorStore,
    embedder: Embedder,
    config: Partial<SessionCompressorConfig> = {},
  ) {
    this.memoryDb = memoryDb;
    this.vectorStore = vectorStore;
    this.embedder = embedder;
    this.config = { ...DEFAULT_COMPRESSOR_CONFIG, ...config };
  }

  // ===== Public API =====

  /**
   * 压缩一次会话，生成摘要记忆节点。
   *
   * @param sessionId 会话 ID
   * @param messages 会话消息列表（原始文本）
   * @param sessionStart 会话开始时间戳
   * @param options 可选参数
   * @returns CompressedSession | null（如果 token 数不足则返回 null）
   */
  async compress(
    sessionId: string,
    messages: string[],
    sessionStart: number,
    options?: {
      tokenCount?: number;
      referencedMemoryIds?: string[];
      referencedCodeSymbolIds?: string[];
      userId?: string;
    },
  ): Promise<CompressedSession | null> {
    if (!this.config.enabled) return null;

    // 合并所有消息文本用于分析
    const fullText = messages.join("\n");
    const tokenEstimate = options?.tokenCount ?? this._estimateTokens(fullText);

    // 太短的会话不值得压缩
    if (tokenEstimate < this.config.minTokensForSummary) {
      return null;
    }

    const sessionEnd = Date.now();
    const summary = this._extractSummary(fullText, messages, options);

    // 写入记忆节点
    const node = this.memoryDb.createNode({
      title: summary.title,
      summary: summary.summary,
      body: this._renderBody(summary, sessionId, sessionStart, sessionEnd, tokenEstimate),
      importance: summary.importance,
      status: "active",
      source: "system",
      sourceSession: sessionId,
      tags: summary.tags,
      nodeType: "session_summary" as MemoryNodeType,
      ttlDays: this.config.summaryTtlDays,
      scope: "public",
      tierMin: 1,
      userId: options?.userId ?? "default",
      negativeExamples: [],
      isDeprecated: false,
      deprecatedAt: null,
    });

    // 向量索引
    try {
      const vector = await this.embedder.embed(summary.summary);
      this.vectorStore.upsert(node.id, vector, {
        nodeId: node.id,
        type: "session_summary",
        title: summary.title,
        summary: summary.summary,
        importance: summary.importance,
        createdAt: node.createdAt,
        source: "system",
        tags: summary.tags,
      });
    } catch {
      // 向量索引失败不影响核心功能
    }

    // 关联引用的记忆
    for (const refId of summary.referencedMemoryIds) {
      try {
        this.memoryDb.createEdge({
          sourceType: "memory",
          sourceId: node.id,
          targetType: "memory",
          targetId: refId,
          relation: "summarizes" as EdgeRelation,
          weight: 0.7,
          description: `Session ${sessionId} referenced this memory`,
        });
      } catch {
        // 单个关联失败不影响整体
      }
    }

    // 关联引用的代码符号
    for (const refId of summary.referencedCodeSymbolIds) {
      try {
        this.memoryDb.createEdge({
          sourceType: "memory",
          sourceId: node.id,
          targetType: "code",
          targetId: refId,
          relation: "links_to_code" as EdgeRelation,
          weight: 0.5,
          description: `Session ${sessionId} referenced this code symbol`,
        });
      } catch {
        // 单个关联失败不影响整体
      }
    }

    return {
      sessionId,
      sessionStart,
      sessionEnd,
      tokenCount: tokenEstimate,
      summary,
      memoryNodeId: node.id,
    };
  }

  /**
   * 获取最近 N 条会话摘要，用于跨会话上下文注入。
   *
   * @param count 返回数量（默认 config.recentSummariesCount）
   * @param userId 用户 ID 过滤（可选）
   * @returns 摘要列表（按时间降序）
   */
  getRecentSummaries(count?: number, userId?: string): SessionSummary[] {
    const limit = count ?? this.config.recentSummariesCount;
    const rows = this.memoryDb.getRawDb()
      .prepare(`
        SELECT title, summary, body, tags, importance, created_at
        FROM memory_nodes
        WHERE node_type = 'session_summary'
          AND status = 'active'
          AND user_id = ?
        ORDER BY created_at DESC
        LIMIT ?
      `)
      .all(userId ?? "default", limit) as Array<{
        title: string; summary: string; body: string;
        tags: string; importance: number; created_at: number;
      }>;

    return rows.map((r) => this._parseBody(r.body, {
      title: r.title,
      summary: r.summary,
      importance: r.importance,
      tags: JSON.parse(r.tags),
    }));
  }

  /**
   * 格式化会话摘要为上下文注入文本。
   */
  formatForContext(summaries: SessionSummary[]): string {
    if (summaries.length === 0) return "";

    const lines: string[] = ["## 近期会话摘要", ""];
    for (const s of summaries) {
      lines.push(`### ${s.title}`);
      lines.push(s.summary);
      if (s.keyDecisions.length > 0) {
        lines.push("");
        lines.push("关键决策：");
        for (const d of s.keyDecisions) {
          lines.push(`- ${d.decision}（置信度: ${(d.confidence * 100).toFixed(0)}%）`);
        }
      }
      if (s.unresolvedItems.length > 0) {
        lines.push("");
        lines.push("未完成事项：");
        for (const item of s.unresolvedItems) {
          lines.push(`- ${item}`);
        }
      }
      lines.push("");
    }
    return lines.join("\n");
  }

  // ===== Private: 摘要提取 =====

  private _extractSummary(
    fullText: string,
    messages: string[],
    options?: {
      referencedMemoryIds?: string[];
      referencedCodeSymbolIds?: string[];
    },
  ): SessionSummary {
    // 从消息中提取最高频的词汇作为标题候选
    const title = this._generateTitle(fullText, messages);

    // 提取关键决策（基于 "决定"、"选择"、"采用" 等关键词）
    const keyDecisions = this._extractDecisions(messages);

    // 提取未完成事项（基于 "TODO"、"待办"、"下次" 等关键词）
    const unresolvedItems = this._extractUnresolved(messages);

    // 生成摘要：取前几条消息和后几条消息的核心内容
    const summary = this._generateSummary(fullText, messages);

    // 提取标签（基于高频名词和关键词）
    const tags = this._extractTags(fullText);

    // 评估重要性：基于消息数量、决策数量、引用的记忆数量
    const importance = this._evaluateImportance(messages.length, keyDecisions.length, fullText);

    return {
      title,
      summary,
      keyDecisions,
      unresolvedItems,
      tags,
      importance,
      referencedMemoryIds: options?.referencedMemoryIds ?? [],
      referencedCodeSymbolIds: options?.referencedCodeSymbolIds ?? [],
    };
  }

  private _generateTitle(fullText: string, messages: string[]): string {
    // 取第一条非空用户消息的前 50 个字符作为标题基底
    for (const msg of messages) {
      const trimmed = msg.trim();
      if (trimmed.length > 10) {
        const firstLine = trimmed.split("\n")[0].trim();
        // 限制标题长度
        return firstLine.length > 60 ? firstLine.slice(0, 57) + "..." : firstLine;
      }
    }
    return "会话摘要";
  }

  private _extractDecisions(messages: string[]): Array<{ decision: string; reason: string; confidence: number }> {
    const decisions: Array<{ decision: string; reason: string; confidence: number }> = [];
    // 中文决策关键词
    const cnPatterns = [/决定[：:]\s*(.+)/, /选择[：:]\s*(.+)/, /采用[：:]\s*(.+)/, /使用[：:]\s*(.+)/];
    // 英文决策关键词
    const enPatterns = [/decid(?:e|ed)[\s:]+(.+)/i, /choose[\s:]+(.+)/i, /select[\s:]+(.+)/i, /use[\s:]+(.+)/i];

    for (const msg of messages) {
      for (const pattern of [...cnPatterns, ...enPatterns]) {
        const match = msg.match(pattern);
        if (match) {
          const decision = match[1].trim().slice(0, 100);
          // 避免重复
          if (!decisions.some((d) => d.decision === decision)) {
            decisions.push({ decision, reason: "从对话中提取", confidence: 0.6 });
          }
        }
      }
    }
    return decisions;
  }

  private _extractUnresolved(messages: string[]): string[] {
    const items: string[] = [];
    // 中文未完成关键词
    const cnPatterns = [/TODO[：:]\s*(.+)/, /待办[：:]\s*(.+)/, /下次[：:]\s*(.+)/, /还需要[：:]\s*(.+)/, /尚未[：:]\s*(.+)/];
    // 英文未完成关键词
    const enPatterns = [/TODO[\s:]+(.+)/i, /next[\s:]+(.+)/i, /remaining[\s:]+(.+)/i, /still need[\s:]+(.+)/i];

    for (const msg of messages) {
      for (const pattern of [...cnPatterns, ...enPatterns]) {
        const match = msg.match(pattern);
        if (match) {
          const item = match[1].trim().slice(0, 100);
          if (!items.includes(item)) {
            items.push(item);
          }
        }
      }
    }
    return items;
  }

  private _generateSummary(fullText: string, messages: string[]): string {
    // 纯算法摘要：取前 10% 和后 10% 消息的核心内容，结合高频关键词
    const total = messages.length;
    if (total === 0) return "";

    const headCount = Math.max(1, Math.ceil(total * 0.1));
    const tailCount = Math.max(1, Math.ceil(total * 0.1));

    const headParts: string[] = [];
    const tailParts: string[] = [];

    // 取前几条消息的话题
    for (let i = 0; i < headCount && i < total; i++) {
      const line = messages[i].trim().split("\n")[0];
      if (line.length > 10) headParts.push(line.slice(0, 100));
    }

    // 取后几条消息的结论
    for (let i = Math.max(0, total - tailCount); i < total; i++) {
      const line = messages[i].trim().split("\n")[0];
      if (line.length > 10) tailParts.push(line.slice(0, 100));
    }

    // 提取高频关键词作为上下文
    const topWords = this._extractTopKeywords(fullText, 5);

    let summary = `对话主题：${headParts[0] ?? "未识别"}`;
    if (tailParts.length > 0) {
      summary += `。结论：${tailParts[tailParts.length - 1]}`;
    }
    if (topWords.length > 0) {
      summary += `。关键词：${topWords.join("、")}`;
    }

    return summary.slice(0, this.config.maxSummaryLength);
  }

  private _extractTags(fullText: string): string[] {
    // 提取高频单词（长度 >= 3，排除停用词）
    const stopWords = new Set([
      "the", "this", "that", "and", "for", "with", "from", "were",
      "have", "been", "will", "would", "could", "should", "about",
      "which", "their", "there", "what", "when", "where", "how",
      "的", "了", "在", "是", "我", "有", "和", "就", "不", "人",
      "都", "一", "一个", "上", "也", "很", "到", "说", "要", "去",
      "你", "会", "着", "没有", "看", "好", "自己", "这", "他", "她",
    ]);

    const wordCounts = new Map<string, number>();
    // 提取英文单词
    const enWords = fullText.toLowerCase().match(/[a-z]{3,}/g) ?? [];
    // 提取中文双字词
    const cnChars = fullText.match(/[\u4e00-\u9fff]{2,}/g) ?? [];

    for (const word of [...enWords, ...cnChars]) {
      if (!stopWords.has(word)) {
        wordCounts.set(word, (wordCounts.get(word) ?? 0) + 1);
      }
    }

    // 按频率排序取前 10
    return [...wordCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([word]) => word);
  }

  private _extractTopKeywords(fullText: string, count: number): string[] {
    const tags = this._extractTags(fullText);
    return tags.slice(0, count);
  }

  private _evaluateImportance(msgCount: number, decisionCount: number, fullText: string): number {
    // 基础分：消息数量
    let score = 3;
    if (msgCount > 50) score = 7;
    else if (msgCount > 30) score = 6;
    else if (msgCount > 20) score = 5;
    else if (msgCount > 10) score = 4;

    // 决策加分
    score += Math.min(decisionCount, 2);

    // 包含代码/工具调用加分
    if (/工具|tool|function|代码|code|api|API|修复|fix|bug/i.test(fullText)) {
      score = Math.min(score + 1, 10);
    }

    // 包含错误/异常加分
    if (/error|Error|错误|异常|失败|失败|报错/i.test(fullText)) {
      score = Math.min(score + 1, 10);
    }

    return Math.max(1, Math.min(10, score));
  }

  // ===== Private: 辅助方法 =====

  private _estimateTokens(text: string): number {
    // 粗略估算：中文约 1.5 字符/token，英文约 4 字符/token
    const cnChars = (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
    const enChars = text.length - cnChars;
    return Math.ceil(cnChars / 1.5 + enChars / 4);
  }

  private _renderBody(
    summary: SessionSummary,
    sessionId: string,
    sessionStart: number,
    sessionEnd: number,
    tokenCount: number,
  ): string {
    const lines: string[] = [];
    lines.push(`# 会话摘要: ${summary.title}`);
    lines.push("");
    lines.push(`- 会话 ID: ${sessionId}`);
    lines.push(`- 时间: ${new Date(sessionStart).toISOString()} → ${new Date(sessionEnd).toISOString()}`);
    lines.push(`- Token 估算: ${tokenCount}`);
    lines.push(`- 重要性: ${summary.importance}/10`);
    lines.push("");

    if (summary.keyDecisions.length > 0) {
      lines.push("## 关键决策");
      for (const d of summary.keyDecisions) {
        lines.push(`- **${d.decision}** — ${d.reason}（置信度: ${(d.confidence * 100).toFixed(0)}%）`);
      }
      lines.push("");
    }

    if (summary.unresolvedItems.length > 0) {
      lines.push("## 未完成事项");
      for (const item of summary.unresolvedItems) {
        lines.push(`- ${item}`);
      }
      lines.push("");
    }

    if (summary.tags.length > 0) {
      lines.push(`标签: ${summary.tags.join(", ")}`);
    }

    return lines.join("\n");
  }

  private _parseBody(
    body: string,
    defaults: { title: string; summary: string; importance: number; tags: string[] },
  ): SessionSummary {
    // 从 body 中解析出结构化的 SessionSummary
    const keyDecisions: Array<{ decision: string; reason: string; confidence: number }> = [];
    const unresolvedItems: string[] = [];
    let inDecisions = false;
    let inUnresolved = false;

    for (const line of body.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("## 关键决策")) {
        inDecisions = true;
        inUnresolved = false;
        continue;
      }
      if (trimmed.startsWith("## 未完成事项")) {
        inDecisions = false;
        inUnresolved = true;
        continue;
      }
      if (trimmed.startsWith("## ")) {
        inDecisions = false;
        inUnresolved = false;
        continue;
      }
      if (inDecisions && trimmed.startsWith("- **")) {
        const match = trimmed.match(/- \*\*(.+?)\*\*/);
        if (match) {
          keyDecisions.push({ decision: match[1], reason: "", confidence: 0.6 });
        }
      }
      if (inUnresolved && trimmed.startsWith("- ")) {
        unresolvedItems.push(trimmed.slice(2));
      }
    }

    return {
      title: defaults.title,
      summary: defaults.summary,
      keyDecisions,
      unresolvedItems,
      tags: defaults.tags,
      importance: defaults.importance,
      referencedMemoryIds: [],
      referencedCodeSymbolIds: [],
    };
  }
}