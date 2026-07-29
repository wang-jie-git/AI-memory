/**
 * User Profile Engine — 辩证用户建模
 *
 * 受 Hermes Honcho 辩证建模启发（RFC-06 Phase C）。
 * 不只是"存-取"用户偏好，而是：
 * 1. 矛盾检测 — 新观察与历史记录对比，发现不一致
 * 2. 置信度衰减 — 旧观察随时间降低置信度
 * 3. 观点演化 — 跟踪偏好随时间的变化轨迹
 *
 * 使用方式：
 *   const engine = new UserProfileEngine(db);
 *   engine.observe("preference", "风格", "偏好简洁", { confidence: 0.8 });
 *   engine.observe("preference", "风格", "需要详细说明", { confidence: 0.7 });
 *   // → 返回矛盾检测结果
 *
 *   const profile = engine.getProfile("default");
 *   // → 返回当前用户画像（含矛盾列表）
 *
 * 设计原则：
 * - 轻量级：无 LLM 依赖，纯规则匹配
 * - 兼容现有 MemoryNode：复用 decision + insight 节点类型
 * - 可进化：观点按时间线存储，支持回溯
 */

import { MemoryDatabase, MemoryNode } from "./database";

// ===== Types =====

export type ObservationType = "preference" | "behavior" | "skill" | "knowledge" | "trait";

export interface Observation {
  id: string;
  type: ObservationType;
  /** 领域/分类（如 "风格", "通信", "代码"） */
  domain: string;
  /** 观察内容 */
  content: string;
  /** 置信度 (0-1) */
  confidence: number;
  /** 来源会话 ID */
  sourceSession: string | null;
  /** 创建时间 */
  createdAt: number;
  /** 更新时间（最近一次相同观察的修正） */
  updatedAt: number;
  /** 标签 */
  tags: string[];
  /** 是否被标记为矛盾 */
  contradicted: boolean;
  /** 矛盾的观察 ID（如果有） */
  contradictedBy: string | null;
}

export interface ProfileTrait {
  /** 领域 */
  domain: string;
  /** 核心观察（当前置信度最高的） */
  current: string;
  /** 置信度 */
  confidence: number;
  /** 历史版本 */
  history: Array<{
    content: string;
    confidence: number;
    timestamp: number;
  }>;
  /** 是否检测到矛盾 */
  hasContradiction: boolean;
  /** 矛盾列表 */
  contradictions: Array<{
    old: string;
    new: string;
    detectedAt: number;
  }>;
}

export interface UserProfile {
  userId: string;
  traits: ProfileTrait[];
  /** 所有活跃观察 */
  observations: Observation[];
  /** 矛盾总数 */
  contradictionCount: number;
  /** 最后更新时间 */
  lastUpdated: number;
}

export interface ObserveResult {
  observation: Observation;
  contradictions: Array<{
    existing: Observation;
    message: string;
  }>;
  isNew: boolean;
}

export interface ObserveOptions {
  /** 置信度 */
  confidence?: number;
  /** 来源会话 */
  sourceSession?: string | null;
  /** 用户 ID */
  userId?: string;
  /** 标签 */
  tags?: string[];
}

// ===== User Profile Engine =====

export class UserProfileEngine {
  private db: MemoryDatabase;

  // 矛盾检测阈值：同一 domain 下，两条观察的内容相似度低于此值视为矛盾
  private static readonly CONTRADICTION_THRESHOLD = 0.3;

  // 置信度衰减：每天衰减比例
  private static readonly CONFIDENCE_DECAY_PER_DAY = 0.02;

  // 观察过期时间（天）：超过此时间未更新的观察被标记为低置信度
  private static readonly OBSERVATION_TTL_DAYS = 90;

  constructor(db: MemoryDatabase) {
    this.db = db;
  }

  /**
   * 记录一条用户观察
   *
   * 流程：
   * 1. 创建/更新 observation 记忆节点
   * 2. 与同 domain 的已有观察对比，检测矛盾
   * 3. 如果检测到矛盾，创建 contradicts 边
   * 4. 返回观察结果和矛盾列表
   */
  observe(
    type: ObservationType,
    domain: string,
    content: string,
    options: ObserveOptions = {},
  ): ObserveResult {
    const userId = options.userId ?? "default";
    const confidence = options.confidence ?? 0.7;
    const sourceSession = options.sourceSession ?? null;
    const tags = options.tags ?? ["user_profile", domain, type];
    const now = Date.now();

    // 查找同 domain 同类型的最新观察
    const existing = this._findLatestObservation(type, domain, userId);

    // 创建观察节点
    const observationId = `obs-${userId}-${type}-${domain}-${now}`;
    const node = this.db.createNode({
      title: `[${type}] ${domain}: ${content}`,
      summary: content,
      body: JSON.stringify({
        type,
        domain,
        confidence,
        userId,
        sourceSession,
        contradicted: false,
        contradictedBy: null,
      }),
      importance: Math.round(confidence * 10),
      status: "active",
      source: "system",
      sourceSession: sourceSession ?? null,
      tags: [...new Set(["user_profile", type, domain, ...tags])],
      nodeType: "insight",
      ttlDays: UserProfileEngine.OBSERVATION_TTL_DAYS,
      scope: "public",
      tierMin: 1,
      negativeExamples: [],
      isDeprecated: false,
      deprecatedAt: null,
      userId,
    });

    const observation: Observation = {
      id: node.id,
      type,
      domain,
      content,
      confidence,
      sourceSession,
      createdAt: now,
      updatedAt: now,
      tags,
      contradicted: false,
      contradictedBy: null,
    };

    // 矛盾检测
    const contradictions: Array<{ existing: Observation; message: string }> = [];

    if (existing) {
      const similarity = this._computeSimilarity(content, existing.content);

      // 如果语义相似度低且置信度都高，可能矛盾
      if (
        similarity < UserProfileEngine.CONTRADICTION_THRESHOLD &&
        confidence >= 0.5 &&
        existing.confidence >= 0.5
      ) {
        // 用时效性判断谁更新：新观察覆盖旧观察
        const message = this._buildContradictionMessage(
          type,
          domain,
          existing.content,
          content,
          existing.createdAt,
          now,
        );

        // 标记旧观察为矛盾（更新 body 和状态）
        const existingUserId = (existing as any).userId ?? "default";
        this.db.updateNode(existing.id, {
          status: "pending_review",
          tags: [...existing.tags, "contradicted"],
          body: JSON.stringify({
            type: existing.type,
            domain: existing.domain,
            confidence: existing.confidence,
            userId: existingUserId,
            sourceSession: existing.sourceSession,
            contradicted: true,
            contradictedBy: node.id,
          }),
        });

        // 创建 contradicts 边（新 → 旧）
        this.db.linkMemoryToMemory(
          node.id,
          existing.id,
          "contradicts" as "contradicts",
          0.8,
          `${type}:${domain} — "${existing.content}" → "${content}"`,
        );

        // 更新新观察节点的 body，持久化 contradicted 标记
        this.db.updateNode(node.id, {
          body: JSON.stringify({
            type,
            domain,
            confidence,
            userId,
            sourceSession,
            contradicted: true,
            contradictedBy: existing.id,
          }),
        });

        contradictions.push({
          existing: existing,
          message,
        });

        observation.contradicted = true;
        observation.contradictedBy = existing.id;
      }
    }

    return {
      observation,
      contradictions,
      isNew: !existing,
    };
  }

  /**
   * 获取用户画像
   *
   * 聚合所有观察，按 domain 分组，
   * 返回每个 domain 的核心观点和矛盾历史。
   */
  getProfile(userId = "default"): UserProfile {
    const rawDb = this.db.getRawDb();

    // 获取所有用户画像观察节点
    const rows = rawDb
      .prepare(
        `SELECT * FROM memory_nodes
         WHERE user_id = ?
           AND node_type = 'insight'
           AND tags LIKE '%"user_profile"%'
           AND status != 'archived'
         ORDER BY created_at DESC`,
      )
      .all(userId) as Record<string, unknown>[];

    const observations: Observation[] = rows.map((r) => this._rowToObservation(r));

    // 按 domain 分组
    const domainGroups = new Map<string, Observation[]>();
    for (const obs of observations) {
      if (!domainGroups.has(obs.domain)) {
        domainGroups.set(obs.domain, []);
      }
      domainGroups.get(obs.domain)!.push(obs);
    }

    // 构建 traits
    const traits: ProfileTrait[] = [];
    let contradictionCount = 0;

    for (const [domain, obsList] of domainGroups) {
      // 按类型分组
      const typeGroups = new Map<string, Observation[]>();
      for (const obs of obsList) {
        if (!typeGroups.has(obs.type)) typeGroups.set(obs.type, []);
        typeGroups.get(obs.type)!.push(obs);
      }

      for (const [type, typedObs] of typeGroups) {
        // 按时间排序
        typedObs.sort((a, b) => b.createdAt - a.createdAt);

        // 找到当前置信度最高的（非矛盾的优先）
        const active = typedObs.filter((o) => !o.contradicted);
        const current = active.length > 0
          ? active.reduce((a, b) => (a.confidence >= b.confidence ? a : b))
          : typedObs[0];

        // 找矛盾
        const contradictions: Array<{ old: string; new: string; detectedAt: number }> = [];
        for (const obs of typedObs) {
          if (obs.contradicted && obs.contradictedBy) {
            const contradictor = typedObs.find((o) => o.id === obs.contradictedBy);
            if (contradictor) {
              contradictions.push({
                old: obs.content,
                new: contradictor.content,
                detectedAt: contradictor.createdAt,
              });
              contradictionCount++;
            }
          }
        }

        // 历史版本
        const history = typedObs.map((o) => ({
          content: o.content,
          confidence: o.confidence,
          timestamp: o.createdAt,
        }));

        traits.push({
          domain: `${type}:${domain}`,
          current: current.content,
          confidence: this._applyDecay(current.confidence, current.updatedAt),
          history,
          hasContradiction: contradictions.length > 0,
          contradictions,
        });
      }
    }

    // 按置信度排序
    traits.sort((a, b) => b.confidence - a.confidence);

    return {
      userId,
      traits,
      observations,
      contradictionCount,
      lastUpdated: Date.now(),
    };
  }

  /**
   * 获取用户画像摘要（用于上下文注入）
   *
   * 返回格式化的文本摘要，可直接注入系统 prompt。
   */
  getProfileSummary(userId = "default", maxTraits = 10): string {
    const profile = this.getProfile(userId);
    if (profile.traits.length === 0) return "";

    const lines: string[] = [`[用户画像: ${userId}]`];

    const topTraits = profile.traits.slice(0, maxTraits);
    for (const trait of topTraits) {
      const badge = trait.hasContradiction ? " ⚠️" : "";
      lines.push(
        `- ${trait.domain}: ${trait.current} (置信度 ${Math.round(trait.confidence * 100)}%)${badge}`,
      );
    }

    if (profile.contradictionCount > 0) {
      lines.push(`\n⚠️ 检测到 ${profile.contradictionCount} 处矛盾，建议关注。`);
    }

    return lines.join("\n");
  }

  /**
   * 清理过期观察
   */
  refreshExpired(dryRun = true): { archived: number } {
    const rawDb = this.db.getRawDb();
    const cutoff = Date.now() - UserProfileEngine.OBSERVATION_TTL_DAYS * 86400000;

    const expired = rawDb
      .prepare(
        `SELECT id FROM memory_nodes
         WHERE node_type = 'insight'
           AND tags LIKE '%"user_profile"%'
           AND updated_at < ?
           AND status = 'active'`,
      )
      .all(cutoff) as Record<string, unknown>[];

    if (dryRun) {
      return { archived: expired.length };
    }

    for (const row of expired) {
      this.db.updateNode(row.id as string, {
        status: "archived",
        importance: 1,
      });
    }

    return { archived: expired.length };
  }

  // ===== Private: Helpers =====

  /**
   * 查找同 domain 同类型的最新观察
   *
   * 优先按 body JSON 精确匹配，降级到 tag 宽松匹配。
   */
  private _findLatestObservation(
    type: string,
    domain: string,
    userId: string,
  ): Observation | null {
    const rawDb = this.db.getRawDb();

    // 精确匹配：body JSON 中包含 type + domain
    const bodyLike = `%"type":"${type}","domain":"${domain}"%`;
    const rows = rawDb
      .prepare(
        `SELECT * FROM memory_nodes
         WHERE user_id = ?
           AND node_type = 'insight'
           AND tags LIKE '%"user_profile"%'
           AND body LIKE ?
           AND status = 'active'
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .all(userId, bodyLike) as Record<string, unknown>[];

    if (rows.length > 0) {
      return this._rowToObservation(rows[0]);
    }

    // 宽松匹配：通过 tag 匹配 domain（降级路径）
    const fallback = rawDb
      .prepare(
        `SELECT * FROM memory_nodes
         WHERE user_id = ?
           AND node_type = 'insight'
           AND tags LIKE '%"user_profile"%'
           AND tags LIKE ?
           AND status = 'active'
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .all(userId, `%"${domain}"%`) as Record<string, unknown>[];

    if (fallback.length === 0) return null;
    return this._rowToObservation(fallback[0]);
  }

  /**
   * 计算文本相似度（Jaccard 相似度）
   *
   * 轻量级，无 LLM 依赖。
   */
  private _computeSimilarity(a: string, b: string): number {
    const termsA = this._extractTerms(a);
    const termsB = this._extractTerms(b);

    if (termsA.length === 0 && termsB.length === 0) return 1;
    if (termsA.length === 0 || termsB.length === 0) return 0;

    const setA = new Set(termsA);
    const setB = new Set(termsB);

    let intersection = 0;
    for (const term of setA) {
      if (setB.has(term)) intersection++;
    }

    const union = new Set([...setA, ...setB]).size;
    return intersection / union;
  }

  /**
   * 构建矛盾信息
   */
  private _buildContradictionMessage(
    type: string,
    domain: string,
    oldContent: string,
    newContent: string,
    oldTime: number,
    newTime: number,
  ): string {
    const oldDate = new Date(oldTime).toISOString().slice(0, 10);
    const newDate = new Date(newTime).toISOString().slice(0, 10);
    const timeDiff = Math.round((newTime - oldTime) / (86400000));

    return `[${type}:${domain}] "${oldContent}" (${oldDate}) → "${newContent}" (${newDate})，间隔 ${timeDiff} 天。`;
  }

  /**
   * 置信度衰减
   */
  private _applyDecay(confidence: number, lastUpdated: number): number {
    const daysSinceUpdate = (Date.now() - lastUpdated) / 86400000;
    const decay = daysSinceUpdate * UserProfileEngine.CONFIDENCE_DECAY_PER_DAY;
    return Math.max(0.1, confidence - decay);
  }

  /**
   * 提取关键词（去停用词）
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
      "偏好", "喜欢", "需要", "想要", "可以", "应该", "会", "能",
    ]);

    return text
      .toLowerCase()
      .split(/[\s,，。！？、；：""''（）()\[\]【】{}]+/)
      .filter((t) => t.length >= 2 && !stopWords.has(t));
  }

  /**
   * 将数据库行转为 Observation
   */
  private _rowToObservation(row: Record<string, unknown>): Observation {
    let parsedBody: {
      type?: string;
      domain?: string;
      confidence?: number;
      userId?: string;
      sourceSession?: string | null;
      contradicted?: boolean;
      contradictedBy?: string | null;
    } = {};
    try {
      parsedBody = JSON.parse((row.body as string) ?? "{}");
    } catch {
      // 忽略解析失败
    }

    return {
      id: row.id as string,
      type: (parsedBody.type as ObservationType) ?? "preference",
      domain: parsedBody.domain ?? "general",
      content: (row.summary as string) ?? "",
      confidence: parsedBody.confidence ?? 0.5,
      sourceSession: parsedBody.sourceSession ?? null,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
      tags: (() => {
        try { return JSON.parse((row.tags as string) ?? "[]"); } catch { return []; }
      })(),
      contradicted: parsedBody.contradicted ?? false,
      contradictedBy: parsedBody.contradictedBy ?? null,
    };
  }
}