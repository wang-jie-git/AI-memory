/**
 * memory-orchestrator: MemorySystem — 统一入口
 *
 * One App 通过 MemorySystem 完成所有记忆操作：
 *   init(dbPath) → 连接图 + 向量 + embedder
 *   write(entry) → 图写入 + 向量索引 + Obsidian 同步
 *   query(text)  → 混合查询
 *   dream()      → 梦境整理（熵减）
 *   getHealth()  → 健康检查
 *   getLogs()    → 日志查询
 *   shutdown()   → flush 缓冲 + 关闭所有连接
 */

import { MemoryDatabase, type MemoryNode, type MemoryNodeType, type MemoryStatus, type MemorySource, type MemoryScope } from "../../memory-graph/src/database";
import { ObsidianWriter } from "../../memory-graph/src/obsidian-writer";
import { SqliteVectorStore } from "../../memory-vector/src/vector-store";
import { LocalEmbedder, ApiEmbedder, SimpleEmbedder, NoopQueryOptimizer, NoopReranker, LLMQueryOptimizer, EmbeddingReranker } from "../../memory-vector/src";
import type { Embedder } from "../../memory-vector/src/embedder";
import type { QueryOptimizer } from "../../memory-vector/src/query-optimizer";
import type { Reranker } from "../../memory-vector/src/reranker";
import { HybridQueryEngine, type HybridQueryConfig } from "./index";
import { SessionCompressor, type SessionCompressorConfig, type CompressedSession } from "./session-compressor";
import { MemoryLogger, type LogEntry, type LogLevel } from "./memory-logger";
import { MemoryWatchdog, type HealthStatus, type WatchdogConfig, type EvaluationReport, type ReportCallback } from "./memory-watchdog";
import * as path from "node:path";
import * as fs from "node:fs";

// ===== Config =====

export interface MemorySystemConfig {
  /** CodeGraph DB 目录（包含 codegraph.db） */
  codegraphDir: string;
  /** 向量存储文件名（相对 codegraphDir） */
  vectorDbFilename?: string;
  /** Obsidian Vault 根路径（可选，不填则不初始化 ObsidianWriter） */
  obsidianVaultPath?: string;
  /** Obsidian 子目录 */
  obsidianSubDir?: string;
  /** Embedder 类型: 'local' | 'api' | 'simple' */
  embedder?: "local" | "api" | "simple";
  /** API embedder 配置（仅 embedder='api' 时需要） */
  embedderApiKey?: string;
  embedderBaseUrl?: string;
  embedderModel?: string;
  /** 混合查询配置 */
  hybridQuery?: Partial<HybridQueryConfig>;
  /** 查询优化器配置（可选，不配置则不启用优化） */
  queryOptimizer?: {
    /** 优化器类型: 'llm' | 'none' */
    type: "llm" | "none";
    /** LLM API base URL（OpenAI-compatible） */
    baseUrl?: string;
    /** API key */
    apiKey?: string;
    /** 模型名，默认 gpt-4o-mini */
    model?: string;
  };
  /** 重排序器配置（可选，不配置则不启用重排序） */
  reranker?: {
    /** 重排序器类型: 'embedding' | 'none' */
    type: "embedding" | "none";
    /** 粗召回数量，默认 20 */
    candidateK?: number;
    /** 最终返回数量，默认 5 */
    topK?: number;
  };
  /** 写入缓冲大小（条数，默认 10） */
  writeBufferSize?: number;
  /** 写入缓冲间隔（ms，默认 2000） */
  writeBufferIntervalMs?: number;
  /** 日志配置 */
  logger?: {
    bufferSize?: number;
    minLevel?: LogLevel;
    persistErrors?: boolean;
  };
  /** 会话压缩配置（默认启用） */
  sessionCompressor?: Partial<SessionCompressorConfig>;
  /** 健康检查配置 */
  watchdog?: Partial<WatchdogConfig>;
  /** 错误通知回调（error/fatal 级别触发） */
  onError?: (entry: LogEntry) => void;
  /** 系统不健康回调 */
  onUnhealthy?: (status: HealthStatus) => void;
}

const DEFAULT_CONFIG: Partial<MemorySystemConfig> = {
  vectorDbFilename: "memory-vectors.db",
  embedder: "local",
  writeBufferSize: 10,
  writeBufferIntervalMs: 2000,
};

// ===== Write Buffer =====

interface BufferedEntry {
  node: MemoryNode;
  resolve: () => void;
  reject: (err: Error) => void;
}

// ===== MemorySystem =====

export class MemorySystem {
  private config: Required<MemorySystemConfig>;
  private memoryDb!: MemoryDatabase;
  private vectorStore!: SqliteVectorStore;
  private embedder!: Embedder;
  private obsidianWriter?: ObsidianWriter;
  private queryEngine!: HybridQueryEngine;
  /** 会话压缩器（跨会话上下文连续） */
  readonly sessionCompressor?: SessionCompressor;
  private writeBuffer: BufferedEntry[] = [];
  private bufferTimer: ReturnType<typeof setTimeout> | null = null;
  private _initialized = false;

  /** 日志系统 */
  readonly logger: MemoryLogger;
  /** 健康看门狗 */
  readonly watchdog: MemoryWatchdog;

  private constructor(config: Required<MemorySystemConfig>) {
    this.config = config;
    this.logger = new MemoryLogger(config.logger);
    this.watchdog = null!; // Will be set after init
    this.sessionCompressor = undefined; // Will be set after init
  }

  // ===== Initialize =====

  static async init(config: MemorySystemConfig): Promise<MemorySystem> {
    const fullConfig = { ...DEFAULT_CONFIG, ...config } as Required<MemorySystemConfig>;
    const startedAt = Date.now();

    const cgDbPath = path.join(fullConfig.codegraphDir, "codegraph.db");
    if (!fs.existsSync(cgDbPath)) {
      throw new Error(`CodeGraph database not found: ${cgDbPath}\nRun 'codegraph index' first.`);
    }

    const sys = new MemorySystem(fullConfig);

    // 1. Open graph DB
    try {
      sys.memoryDb = MemoryDatabase.open(cgDbPath);
      sys.logger.info("init", "openGraph", "图数据库已连接", { path: cgDbPath });
    } catch (err) {
      sys.logger.error("init", "openGraph", "图数据库连接失败", err as Error, { path: cgDbPath });
      throw err;
    }

    // 2. Open vector store
    try {
      const vecDbPath = path.join(fullConfig.codegraphDir, fullConfig.vectorDbFilename);
      sys.vectorStore = SqliteVectorStore.open(vecDbPath);
      sys.logger.info("init", "openVector", "向量库已连接", { path: vecDbPath, entries: sys.vectorStore.stats().totalEntries });
    } catch (err) {
      sys.logger.error("init", "openVector", "向量库连接失败", err as Error);
      throw err;
    }

    // 3. Initialize embedder
    try {
      if (fullConfig.embedder === "api") {
        sys.embedder = new ApiEmbedder({
          model: fullConfig.embedderModel ?? "text-embedding-3-small",
          apiKey: fullConfig.embedderApiKey!,
          baseUrl: fullConfig.embedderBaseUrl,
        });
        sys.logger.info("init", "initEmbedder", "API embedder 已创建", { model: sys.embedder.modelName });
      } else if (fullConfig.embedder === "simple") {
        sys.embedder = new SimpleEmbedder();
        sys.logger.info("init", "initEmbedder", "轻量内置 embedder 已创建", { dim: sys.embedder.dimension });
      } else {
        const local = new LocalEmbedder();
        await local.init();
        sys.embedder = local;
        sys.logger.info("init", "initEmbedder", "本地 embedder 已加载", { model: local.modelName, dim: local.dimension });
      }
    } catch (err) {
      sys.logger.error("init", "initEmbedder", "Embedder 初始化失败", err as Error);
      throw err;
    }

    // 4. Initialize Obsidian writer (optional)
    if (fullConfig.obsidianVaultPath) {
      try {
        sys.obsidianWriter = new ObsidianWriter({
          vaultPath: fullConfig.obsidianVaultPath,
          subDir: fullConfig.obsidianSubDir,
        });
        sys.logger.info("init", "initObsidian", "Obsidian 同步已启用", { vault: fullConfig.obsidianVaultPath });
      } catch (err) {
        sys.logger.warn("init", "initObsidian", "Obsidian 初始化失败（不影响核心功能）", { error: (err as Error).message });
      }
    }

    // 5. Initialize query engine
    try {
      // Build query optimizer
      let queryOptimizer: QueryOptimizer = new NoopQueryOptimizer();
      if (fullConfig.queryOptimizer?.type === "llm" && fullConfig.queryOptimizer.apiKey) {
        queryOptimizer = new LLMQueryOptimizer({
          baseUrl: fullConfig.queryOptimizer.baseUrl,
          apiKey: fullConfig.queryOptimizer.apiKey,
          model: fullConfig.queryOptimizer.model,
        });
        sys.logger.info("init", "initQueryOptimizer", "LLM 查询优化器已启用", {
          model: fullConfig.queryOptimizer.model ?? "gpt-4o-mini",
        });
      }

      // Build reranker
      let reranker: Reranker = new NoopReranker();
      if (fullConfig.reranker?.type === "embedding") {
        reranker = new EmbeddingReranker(sys.embedder, {
          candidateK: fullConfig.reranker.candidateK,
          topK: fullConfig.reranker.topK,
        });
        sys.logger.info("init", "initReranker", "Embedding 重排序器已启用", {
          model: sys.embedder.modelName,
        });
      }

      sys.queryEngine = new HybridQueryEngine(
        sys.memoryDb,
        sys.vectorStore,
        sys.embedder,
        fullConfig.hybridQuery,
        queryOptimizer,
        reranker,
      );
    } catch (err) {
      sys.logger.error("init", "initQueryEngine", "查询引擎初始化失败", err as Error);
      throw err;
    }

    // 5b. Initialize session compressor (跨会话上下文压缩)
    try {
      const scConfig = fullConfig.sessionCompressor ?? {};
      (sys as any).sessionCompressor = new SessionCompressor(
        sys.memoryDb,
        sys.vectorStore,
        sys.embedder,
        scConfig,
      );
      if (scConfig.enabled !== false) {
        sys.logger.info("init", "initSessionCompressor", "会话压缩器已初始化");
      }
    } catch (err) {
      sys.logger.warn("init", "initSessionCompressor", "会话压缩器初始化失败（不影响核心功能）", { error: (err as Error).message });
    }

    // 6. Initialize watchdog (with logger persistence)
    try {
      // 绑定日志持久化到 graph DB
      sys.logger.setPersistDb({
        run: (sql: string, ...params: unknown[]) => {
          sys.memoryDb.getRawDb().prepare(sql).run(...params);
        },
      });
    } catch (err) {
      // 日志持久化失败不影响核心功能
      sys.logger.warn("init", "initLogger", "日志持久化设置失败", { error: (err as Error).message });
    }

    // 7. Initialize watchdog
    const watchdog = new MemoryWatchdog(
      sys.memoryDb, sys.vectorStore, sys.embedder,
      sys.logger, sys.obsidianWriter, fullConfig.watchdog,
    );
    (sys as any).watchdog = watchdog;

    // 8. Register error callback from config
    if (fullConfig.onError) {
      sys.logger.onError(fullConfig.onError);
    }

    // 9. Register unhealthy callback from config
    if (fullConfig.onUnhealthy) {
      watchdog.onUnhealthy(fullConfig.onUnhealthy);
    }

    sys._initialized = true;

    // 记录 init 完成
    const initDuration = Date.now() - startedAt;
    sys.logger.info("init", "complete", `MemorySystem 初始化完成`, {
      duration: initDuration,
      codegraphDir: fullConfig.codegraphDir,
      embedderType: fullConfig.embedder,
    });

    // 首次健康检查（不阻塞 init）
    watchdog.checkHealth().catch(() => {});

    // 自动启动定时健康检查
    watchdog.start();

    return sys;
  }

  get initialized(): boolean {
    return this._initialized;
  }

  /**
   * checkSystemTier — 系统层级权限校验
   *
   * 4 层防御链的第 2 层（软校验）：
   * - 第 1 层：工具注册表不向 Employee Agent 分发 global_* 工具名
   * - 第 2 层：运行时校验环境变量 ONE_AGENT_TIER
   * - 第 3 层：查询时强制过滤 scope="public"（memory_query handler）
   * - 第 4 层：SQLite CHECK 约束限制 scope/tier_min
   *
   * @param requiredTier "global" 操作需要 ONE_AGENT_TIER=prime
   * @returns true 如果通过校验
   * @throws Error 如果权限不足
   */
  static checkSystemTier(requiredTier: "global" | "public" = "global"): boolean {
    if (requiredTier === "public") return true;
    const tier = process.env.ONE_AGENT_TIER ?? "employee";
    if (tier !== "prime" && tier !== "orchestrator") {
      throw new Error(
        `[checkSystemTier] 权限不足：需要 ONE_AGENT_TIER=prime 才能执行全局操作，当前=${tier}`,
      );
    }
    return true;
  }

  // ===== Logger Accessors =====

  /** 获取最近 N 条日志 */
  getLogs(limit = 50, minLevel?: LogLevel): LogEntry[] {
    return this.logger.getRecent(limit, minLevel);
  }

  /** 获取最近错误 */
  getRecentErrors(hours = 1): LogEntry[] {
    const cutoff = Date.now() - hours * 3600000;
    return this.logger.getErrorsSince(cutoff);
  }

  /** 获取指定模块日志 */
  getLogsByModule(module: string, limit = 20): LogEntry[] {
    return this.logger.getByModule(module, limit);
  }

  /** 注册日志回调 */
  onLog(cb: (entry: LogEntry) => void): void {
    this.logger.onLog(cb);
  }

  /** 注册错误通知回调 */
  onError(cb: (entry: LogEntry) => void): void {
    this.logger.onError(cb);
  }

  // ===== Health Accessors =====

  /** 执行一次健康检查 */
  async checkHealth(): Promise<HealthStatus> {
    return this.watchdog.checkHealth();
  }

  /** 获取最近一次健康状态 */
  getHealth(): HealthStatus | null {
    return this.watchdog.lastStatus;
  }

  /** 注册不健康回调 */
  onUnhealthy(cb: (status: HealthStatus) => void): void {
    this.watchdog.onUnhealthy(cb);
  }

  // ===== Evaluation Report =====

  /** 生成评估报告（手动触发） */
  generateReport(): EvaluationReport {
    return this.watchdog.generateReport(undefined, "on_demand");
  }

  /** 注册评估报告回调（系统不健康时自动触发） */
  onReport(cb: ReportCallback): void {
    this.watchdog.onReport(cb);
  }

  /** 获取格式化文本报告 */
  formatReport(report?: EvaluationReport): string {
    return this.watchdog.formatReport(report);
  }

  // ===== Write (buffered) =====

  async write(data: {
    title: string;
    summary?: string;
    body?: string;
    importance?: number;
    tags?: string[];
    nodeType?: MemoryNodeType;
    source?: MemorySource;
    sourceSession?: string;
    ttlDays?: number | null;
    scope?: MemoryScope;
    tierMin?: number;
    negativeExamples?: Array<{ scenario: string; whyFails: string; betterApproach: string }>;
    isDeprecated?: boolean;
    deprecatedAt?: number | null;
    userId?: string;
  }): Promise<MemoryNode> {
    // Create node in graph (immediate — graph is authoritative)
    const node = this.memoryDb.createNode({
      id: crypto.randomUUID(),
      title: data.title,
      summary: data.summary ?? "",
      body: data.body ?? "",
      importance: data.importance ?? 5,
      status: "active",
      source: data.source ?? "agent",
      sourceSession: data.sourceSession ?? null,
      tags: data.tags ?? [],
      nodeType: data.nodeType ?? "memory_entry",
      ttlDays: data.ttlDays ?? null,
      scope: data.scope ?? "public",
      tierMin: data.tierMin ?? 1,
      negativeExamples: data.negativeExamples ?? [],
      isDeprecated: data.isDeprecated ?? false,
      deprecatedAt: data.deprecatedAt ?? null,
      userId: data.userId ?? "default",
    });

    this.logger.info("write", "createNode", `已创建记忆节点: ${node.title}`, {
      nodeId: node.id,
      importance: node.importance,
      tags: node.tags,
    });

    // Buffer the vector + obsidian write
    // 注意：graph 节点已创建（authoritative），但向量/Obsidian 写入是异步的。
    // 如果 flush 时向量写入失败，会在 reject 回调中回滚 graph 节点（见 flush 方法）。
    return new Promise((resolve, reject) => {
      this.writeBuffer.push({
        node,
        resolve: () => {
          this.watchdog.recordWrite(true);
          resolve(node);
        },
        reject: (err) => {
          this.watchdog.recordWrite(false);
          this.logger.error("write", "flush", `写入失败: ${node.title}`, err, { nodeId: node.id });
          // 回滚：向量/Obsidian 写入失败时，删除已创建的 graph 节点，
          // 避免出现"图中有节点但向量库中缺失"的不一致状态
          try {
            this.memoryDb.deleteNode(node.id);
            this.logger.warn("write", "rollback", `已回滚 graph 节点: ${node.title}`, { nodeId: node.id });
          } catch (rollbackErr) {
            this.logger.error("write", "rollback", `回滚失败: ${node.title}`, rollbackErr as Error, { nodeId: node.id });
          }
          reject(err);
        },
      });
      this.scheduleFlush();
    });
  }

  async writeBatch(entries: Array<{
    title: string;
    summary?: string;
    body?: string;
    importance?: number;
    tags?: string[];
    nodeType?: MemoryNodeType;
    source?: MemorySource;
    userId?: string;
  }>): Promise<MemoryNode[]> {
    this.logger.info("write", "writeBatch", `批量写入 ${entries.length} 条记忆`);

    const nodes: MemoryNode[] = [];
    const vectorEntries: Array<{
      id: string;
      vector: Float32Array;
      metadata: {
        nodeId: string;
        type: string;
        title: string;
        summary: string;
        importance: number;
        createdAt: number;
        source: string;
        tenantId?: string;
      };
    }> = [];

    for (const data of entries) {
      const node = this.memoryDb.createNode({
        id: crypto.randomUUID(),
        title: data.title,
        summary: data.summary ?? "",
        body: data.body ?? "",
        importance: data.importance ?? 5,
        status: "active",
        source: data.source ?? "agent",
        sourceSession: null,
        tags: data.tags ?? [],
        nodeType: data.nodeType ?? "memory_entry",
        ttlDays: null,
        scope: "public",
        tierMin: 1,
        negativeExamples: [],
        isDeprecated: false,
        deprecatedAt: null,
        userId: data.userId ?? "default",
      });
      nodes.push(node);

      let vector: Float32Array;
      try {
        const summary = data.summary ?? data.title;
        vector = await this.embedder.embed(summary);
      } catch (err) {
        this.logger.error("write", "embedBatch", `Embedding 失败: ${data.title}`, err as Error);
        throw err;
      }

      vectorEntries.push({
        id: node.id,
        vector,
        metadata: {
          nodeId: node.id,
          type: node.nodeType,
          title: node.title,
          summary: node.summary,
          importance: node.importance,
          createdAt: node.createdAt,
          source: node.source,
          tenantId: node.userId === "default" ? undefined : node.userId,
        },
      });

      // Sync to Obsidian
      if (this.obsidianWriter) {
        try { this.obsidianWriter.write(node); } catch (err) {
          this.logger.warn("write", "obsidianSync", `Obsidian 同步失败: ${node.title}`, { error: (err as Error).message });
        }
      }
    }

    try {
      this.vectorStore.upsertBatch(vectorEntries);
      this.logger.info("write", "embedBatch", `向量批量索引完成: ${vectorEntries.length} 条`);
    } catch (err) {
      this.logger.error("write", "embedBatch", "向量批量索引失败", err as Error);
      throw err;
    }

    this.watchdog.recordWrite(true);
    return nodes;
  }

  private scheduleFlush(): void {
    if (this.bufferTimer) return;

    if (this.writeBuffer.length >= this.config.writeBufferSize) {
      this.flush();
      return;
    }

    this.bufferTimer = setTimeout(() => {
      this.bufferTimer = null;
      if (this.writeBuffer.length > 0) this.flush();
    }, this.config.writeBufferIntervalMs);
  }

  private flush(): void {
    if (this.bufferTimer) {
      clearTimeout(this.bufferTimer);
      this.bufferTimer = null;
    }

    const batch = this.writeBuffer.splice(0);
    if (batch.length === 0) return;

    this.logger.info("write", "flush", `Flush ${batch.length} 条缓冲记忆`);

    (async () => {
      let successCount = 0;
      for (const entry of batch) {
        try {
          const vector = await this.embedder.embed(entry.node.summary || entry.node.title);
          this.vectorStore.upsert(entry.node.id, vector, {
            nodeId: entry.node.id,
            type: entry.node.nodeType,
            title: entry.node.title,
            summary: entry.node.summary,
            importance: entry.node.importance,
            createdAt: entry.node.createdAt,
            source: entry.node.source,
            tenantId: entry.node.userId === "default" ? undefined : entry.node.userId,
          });

          if (this.obsidianWriter) {
            this.obsidianWriter.write(entry.node);
          }

          entry.resolve();
          successCount++;
        } catch (err) {
          this.logger.error("write", "flushItem", `单条 flush 失败: ${entry.node.title}`, err as Error);
          entry.reject(err instanceof Error ? err : new Error(String(err)));
        }
      }
      this.watchdog.recordWrite(successCount === batch.length);
    })();
  }

  // ===== Query =====

  async query(text: string, filter?: { importanceMin?: number; userId?: string }) {
    this.logger.info("query", "hybridSearch", `查询: "${text.slice(0, 60)}"`, filter);
    const startTime = performance.now();

    try {
      // 将 userId 映射为向量库的 tenantId 过滤
      const vectorFilter: { importanceMin?: number; tenantId?: string } = {};
      if (filter?.importanceMin !== undefined) vectorFilter.importanceMin = filter.importanceMin;
      if (filter?.userId !== undefined && filter.userId !== "default") vectorFilter.tenantId = filter.userId;

      const result = await this.queryEngine.query(text, vectorFilter);
      const duration = Math.round(performance.now() - startTime);
      this.logger.info("query", "hybridSearch", `查询完成: ${result.results.length} 条结果`, {
        duration,
        top1Score: result.telemetry.top1Score,
        degraded: result.telemetry.degraded,
      });
      this.watchdog.recordQuery(true);
      return result;
    } catch (err) {
      this.watchdog.recordQuery(false);
      this.logger.error("query", "hybridSearch", `查询失败: "${text.slice(0, 60)}"`, err as Error);
      throw err;
    }
  }

  // ===== Link =====

  linkMemoryToCode(memoryId: string, codeSymbolId: string, description?: string): void {
    this.logger.info("link", "memoryToCode", `关联记忆 → 代码符号`, { memoryId, codeSymbolId });
    this.memoryDb.linkMemoryToCode(memoryId, codeSymbolId, description);
  }

  linkMemoryToMemory(
    sourceId: string,
    targetId: string,
    relation: "causes" | "fixes" | "precedes" | "references" | "contradicts" | "supersedes" | "relates_to" | "implements",
    description?: string,
  ): void {
    this.logger.info("link", "memoryToMemory", `关联记忆 → 记忆`, { sourceId, targetId, relation });
    this.memoryDb.linkMemoryToMemory(sourceId, targetId, relation, 1.0, description);
  }

  // ===== Dream (熵减) =====

  async dream(dryRun = false): Promise<import("./dream").DreamReport> {
    this.logger.info("dream", "consolidate", `启动梦境整理${dryRun ? " (预览模式)" : ""}`);
    this.flush();

    const { DreamEngine } = await import("./dream");
    const engine = new DreamEngine(
      this.memoryDb,
      this.vectorStore,
      this.embedder,
      { dryRun },
    );

    try {
      const report = await engine.consolidate();
      this.logger.info("dream", "consolidate", `梦境完成: 合并${report.actions.merged.length} 聚类${report.actions.insights.length} 归档${report.actions.archived.length} 删除${report.actions.deleted.length}`, {
        healthScore: report.healthScore,
        beforeNodes: report.summary.before.nodes,
        afterNodes: report.summary.after.nodes,
        duration: report.duration,
      });
      this.watchdog.recordDream(true);
      return report;
    } catch (err) {
      this.watchdog.recordDream(false);
      this.logger.error("dream", "consolidate", "梦境整理失败", err as Error);
      throw err;
    }
  }

  // ===== Session Compressor (跨会话上下文) =====

  /**
   * 压缩会话，生成摘要记忆节点。
   * 纯算法实现，无 LLM 调用，零外部依赖。
   *
   * @param sessionId 会话 ID
   * @param messages 会话消息列表
   * @param options 可选参数（token 数、引用记忆/代码符号 ID、用户 ID）
   * @returns CompressedSession | null（会话太短则返回 null）
   */
  async compressSession(
    sessionId: string,
    messages: string[],
    options?: {
      sessionStart?: number;
      tokenCount?: number;
      referencedMemoryIds?: string[];
      referencedCodeSymbolIds?: string[];
      userId?: string;
    },
  ): Promise<import("./session-compressor").CompressedSession | null> {
    if (!this.sessionCompressor) {
      this.logger.warn("session", "compress", "会话压缩器未初始化，跳过压缩");
      return null;
    }
    return this.sessionCompressor.compress(
      sessionId,
      messages,
      options?.sessionStart ?? Date.now(),
      options,
    );
  }

  /**
   * 获取最近 N 条会话摘要，用于跨会话上下文注入。
   *
   * @param count 返回数量
   * @param userId 用户 ID 过滤（可选）
   * @returns 摘要列表
   */
  getSessionContext(count?: number, userId?: string): import("./session-compressor").SessionSummary[] {
    if (!this.sessionCompressor) return [];
    return this.sessionCompressor.getRecentSummaries(count, userId);
  }

  /**
   * 格式化会话摘要为上下文注入文本。
   */
  formatSessionContext(summaries: import("./session-compressor").SessionSummary[]): string {
    if (!this.sessionCompressor) return "";
    return this.sessionCompressor.formatForContext(summaries);
  }

  // ===== Maintenance =====

  prune(options?: { dryRun?: boolean }): { deleted: number; archived: number } {
    this.flush();
    this.logger.info("maintenance", "prune", `执行剪枝${options?.dryRun ? " (预览)" : ""}`);
    const result = this.memoryDb.prune(options?.dryRun ?? false);
    this.logger.info("maintenance", "prune", `剪枝完成: 删除${result.deleted} 归档${result.archived}`);
    return result;
  }

  checkConsistency(): {
    inGraph: number;
    inVector: number;
    graphOnly: string[];
    vectorOnly: string[];
    ok: boolean;
  } {
    this.flush();
    this.logger.info("maintenance", "consistency", "检查一致性");
    const stats = this.memoryDb.getStats();
    const vecStats = this.vectorStore.stats();
    const ok = Math.abs(stats.totalNodes - vecStats.totalEntries) < 10;

    if (!ok) {
      this.logger.warn("maintenance", "consistency", `图库与向量库不一致`, {
        graphNodes: stats.totalNodes,
        vectorEntries: vecStats.totalEntries,
      });
    }

    return {
      inGraph: stats.totalNodes,
      inVector: vecStats.totalEntries,
      graphOnly: [],
      vectorOnly: [],
      ok,
    };
  }

  async rebuildVectorIndex(): Promise<number> {
    this.flush();
    this.logger.info("maintenance", "rebuildVector", "重建向量索引开始");
    this.vectorStore.clear();

    const allNodes = this.memoryDb.searchByText("", 99999);
    const batch: Array<{
      id: string;
      vector: Float32Array;
      metadata: {
        nodeId: string;
        type: string;
        title: string;
        summary: string;
        importance: number;
        createdAt: number;
        source: string;
        tenantId?: string;
      };
    }> = [];

    let errors = 0;

    for (const node of allNodes) {
      try {
        const summary = node.summary || node.title;
        const vector = await this.embedder.embed(summary);
        batch.push({
          id: node.id,
          vector,
          metadata: {
            nodeId: node.id,
            type: node.nodeType,
            title: node.title,
            summary: node.summary,
            importance: node.importance,
            createdAt: node.createdAt,
            source: node.source,
            tenantId: node.userId === "default" ? undefined : node.userId,
          },
        });
      } catch (err) {
        errors++;
        this.logger.error("maintenance", "rebuildVector", `重建向量失败: ${node.title}`, err as Error);
      }
    }

    if (batch.length > 0) {
      this.vectorStore.upsertBatch(batch);
    }

    this.logger.info("maintenance", "rebuildVector", `重建完成: ${batch.length} 条, ${errors} 条失败`);
    return batch.length;
  }

  // ===== Stats =====

  stats() {
    this.flush();
    const graphStats = this.memoryDb.getStats();
    const vecStats = this.vectorStore.stats();
    const obsidianCount = this.obsidianWriter?.count() ?? 0;
    const health = this.watchdog.lastStatus;
    const recentErrors = this.logger.getRecentErrorCount(3600000);

    return {
      graph: graphStats,
      vector: { total: vecStats.totalEntries, dimension: vecStats.dimension },
      obsidian: obsidianCount,
      bufferPending: this.writeBuffer.length,
      health: health ? {
        score: health.score,
        healthy: health.healthy,
        uptime: this.watchdog.getUptime(),
      } : null,
      recentErrors,
      logger: { buffered: this.logger.getRecent(1).length > 0 ? "active" : "empty" },
    };
  }

  // ===== Shutdown =====

  async shutdown(): Promise<void> {
    this.logger.info("shutdown", "begin", "MemorySystem 关闭中...");

    // Stop watchdog
    this.watchdog.stop();

    // Flush remaining buffer
    if (this.writeBuffer.length > 0) {
      await new Promise<void>((resolve) => {
        const check = () => {
          if (this.writeBuffer.length === 0) resolve();
          else setTimeout(check, 100);
        };
        this.flush();
        check();
      });
    }

    this.memoryDb.close();
    this.vectorStore.close();
    this._initialized = false;

    this.logger.info("shutdown", "complete", "MemorySystem 已关闭");
  }
}
