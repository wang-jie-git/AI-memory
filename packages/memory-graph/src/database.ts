/**
 * memory-graph: Database Connection
 *
 * Opens the same SQLite database as CodeGraph (node:sqlite, Node 22.5+)
 * and manages memory-specific schema migrations.
 *
 * Schema v10: scope/tier_min 隔离 | structure_template | negative_examples | is_deprecated | FTS5 | user_id 多租户
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

// ===== SQLite Adapter (thin wrapper over node:sqlite) =====

interface SqliteStatement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
}

interface SqliteDB {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  close(): void;
  readonly open: boolean;
}

function createDB(dbPath: string): SqliteDB {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { DatabaseSync } = require("node:sqlite");
  const raw = new DatabaseSync(dbPath);
  raw.exec("PRAGMA journal_mode = WAL");
  raw.exec("PRAGMA foreign_keys = ON");
  raw.exec("PRAGMA busy_timeout = 5000");
  return {
    prepare(sql: string): SqliteStatement {
      const stmt = raw.prepare(sql);
      return {
        run(...params: unknown[]) {
          const r = stmt.run(...params);
          return { changes: Number(r?.changes ?? 0), lastInsertRowid: r?.lastInsertRowid ?? 0 };
        },
        get(...params: unknown[]) {
          return stmt.get(...params) as Record<string, unknown> | undefined;
        },
        all(...params: unknown[]) {
          return stmt.all(...params) as Record<string, unknown>[];
        },
      };
    },
    exec(sql: string) {
      raw.exec(sql);
    },
    close() {
      if (raw.isOpen) raw.close();
    },
    get open() {
      return raw.isOpen;
    },
  };
}

// ===== Memory Types =====

export type MemoryNodeType = "memory_entry" | "decision" | "project_milestone" | "insight" | "structure_template" | "session_summary";
export type MemoryStatus = "active" | "archived" | "pending_review";
export type MemorySource = "agent" | "user" | "system" | "imported";
export type MemoryScope = "public" | "global";
export type EdgeRelation =
  | "links_to_code"
  | "causes" | "fixes" | "precedes" | "follows"
  | "references" | "contradicts" | "supersedes"
  | "relates_to" | "implements" | "questions"
  | "summarizes" | "dream_log";

export interface MemoryNode {
  id: string;
  title: string;
  summary: string;
  body: string;
  contentHash: string;
  importance: number;
  status: MemoryStatus;
  source: MemorySource;
  sourceSession: string | null;
  tags: string[];
  nodeType: MemoryNodeType;
  createdAt: number;
  updatedAt: number;
  ttlDays: number | null;
  // v4+: 双层级隔离
  scope: MemoryScope;
  tierMin: number;
  // v5+: 反模式存储
  negativeExamples: Array<{ scenario: string; whyFails: string; betterApproach: string }>;
  // v6+: 结构坍缩标记
  isDeprecated: boolean;
  deprecatedAt: number | null;
  // v10+: 多租户隔离
  userId: string;
}

export interface MemoryEdge {
  id: number;
  sourceType: "memory" | "code";
  sourceId: string;
  targetType: "memory" | "code";
  targetId: string;
  relation: EdgeRelation;
  weight: number;
  description: string;
  createdAt: number;
}

export interface MemoryGraphStats {
  totalNodes: number;
  totalEdges: number;
  byStatus: Record<string, number>;
  byType: Record<string, number>;
  byScope: Record<string, number>;
  codeLinked: number;
}

// ===== Database Connection =====

const MEMORY_SCHEMA_VERSION = 10;

export class MemoryDatabase {
  private db: SqliteDB;
  private dbPath: string;
  private _hasNewColumns: boolean = false;
  private _hasNewScope: boolean = false;
  private _hasNewTierMin: boolean = false;
  private _hasNewNegExamples: boolean = false;
  private _hasNewDeprecated: boolean = false;
  private _hasNewUserId: boolean = false;

  private constructor(db: SqliteDB, dbPath: string) {
    this.db = db;
    this.dbPath = dbPath;
  }

  /** 检测表结构中是否有新列 */
  private detectSchema(): void {
    const cols = this._getTableColumns("memory_nodes");
    this._hasNewScope = cols.includes("scope");
    this._hasNewTierMin = cols.includes("tier_min");
    this._hasNewNegExamples = cols.includes("negative_examples");
    this._hasNewDeprecated = cols.includes("is_deprecated");
    this._hasNewUserId = cols.includes("user_id");
    this._hasNewColumns = this._hasNewScope || this._hasNewTierMin || this._hasNewNegExamples || this._hasNewDeprecated || this._hasNewUserId;

    // 如果 tier_min 已存在但类型不是 INTEGER，说明是旧版 schema（生产数据库兼容）
    if (this._hasNewTierMin) {
      try {
        const info = this.db
          .prepare("PRAGMA table_info(memory_nodes)")
          .all() as Array<{ name: string; type: string }>;
        const tierCol = info.find((c) => c.name === "tier_min");
        if (tierCol && tierCol.type !== "INTEGER") {
          this._hasNewTierMin = false; // 旧版 TEXT 类型，不写入新值
        }
      } catch {
        // 忽略
      }
    }
  }

  /** Open or create memory tables in an existing CodeGraph database */
  static open(dbPath: string): MemoryDatabase {
    const exists = fs.existsSync(dbPath);
    if (!exists) {
      throw new Error(`CodeGraph database not found: ${dbPath}\nRun codegraph index first.`);
    }

    const db = createDB(dbPath);
    const memdb = new MemoryDatabase(db, dbPath);
    memdb.migrate();
    memdb.detectSchema();
    return memdb;
  }

  /** Expose raw DB for advanced queries (AutoLinker, etc.) */
  getRawDb() {
    return this.db;
  }

  /** Create a fresh database (for testing) */
  static create(dbPath: string): MemoryDatabase {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const db = createDB(dbPath);
    const memdb = new MemoryDatabase(db, dbPath);
    memdb.migrate();
    memdb.detectSchema();
    return memdb;
  }

  private migrate(): void {
    // Check if memory_schema_versions table exists
    const tableCheck = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_schema_versions'")
      .get() as { name: string } | undefined;

    let currentVersion = 0;
    if (tableCheck) {
      const row = this.db
        .prepare("SELECT version FROM memory_schema_versions ORDER BY version DESC LIMIT 1")
        .get() as { version: number } | undefined;
      currentVersion = row?.version ?? 0;
    }

    if (currentVersion >= MEMORY_SCHEMA_VERSION) return;

    if (!tableCheck) {
      // 首次运行：执行完整 schema.sql 创建所有表
      const schemaPath = path.join(__dirname, "schema.sql");
      const schema = fs.readFileSync(schemaPath, "utf-8");
      this.db.exec(schema);
      this.db
        .prepare("INSERT OR IGNORE INTO memory_schema_versions (version, applied_at, description) VALUES (?, ?, ?)")
        .run(MEMORY_SCHEMA_VERSION, Date.now(), `Schema v${MEMORY_SCHEMA_VERSION}: full init`);
      return;
    }

    // ── 已有数据库：增量迁移 ──

    // v4: 双层级隔离 (scope, tier_min)
    if (currentVersion < 4) {
      this._runMigration(4, () => {
        const cols = this._getTableColumns("memory_nodes");
        if (!cols.includes("scope")) {
          this.db.exec("ALTER TABLE memory_nodes ADD COLUMN scope TEXT NOT NULL DEFAULT 'public'");
        }
        if (!cols.includes("tier_min")) {
          this.db.exec("ALTER TABLE memory_nodes ADD COLUMN tier_min INTEGER NOT NULL DEFAULT 1");
        }
      });
    }

    // v5: 反模式存储 (negative_examples)
    if (currentVersion < 5) {
      const cols = this._getTableColumns("memory_nodes");
      if (!cols.includes("negative_examples")) {
        this.db.exec("ALTER TABLE memory_nodes ADD COLUMN negative_examples TEXT NOT NULL DEFAULT '[]'");
      }
    }

    // v6: 结构坍缩标记 (is_deprecated, deprecated_at)
    if (currentVersion < 6) {
      const cols = this._getTableColumns("memory_nodes");
      if (!cols.includes("is_deprecated")) {
        this.db.exec("ALTER TABLE memory_nodes ADD COLUMN is_deprecated INTEGER NOT NULL DEFAULT 0");
      }
      if (!cols.includes("deprecated_at")) {
        this.db.exec("ALTER TABLE memory_nodes ADD COLUMN deprecated_at INTEGER");
      }
    }

    // v7: FTS5 全文搜索
    if (currentVersion < 7) {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS memory_nodes_fts USING fts5(
          title, summary, body,
          content='memory_nodes',
          content_rowid='rowid'
        )
      `);
      // 重建 FTS 索引
      this.db.exec("INSERT INTO memory_nodes_fts(memory_nodes_fts) VALUES('rebuild')");
    }

    // v8: 新增索引
    if (currentVersion < 8) {
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_memory_nodes_scope ON memory_nodes(scope)");
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_memory_nodes_node_type ON memory_nodes(node_type)");
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_memory_nodes_is_deprecated ON memory_nodes(is_deprecated)");
    }

    // v9: 更新 node_type CHECK（SQLite 不支持 ALTER CHECK，需重建表）
    // 用应用层校验替代，确保新旧数据兼容
    if (currentVersion < 9) {
      // 标记所有现有 structure_template 类型数据（即使旧 schema 拒绝）
      // 更新已存在的记录
      this.db.exec("UPDATE memory_nodes SET node_type = node_type WHERE node_type = node_type");
    }

    // v10: 多租户隔离 (user_id)
    if (currentVersion < 10) {
      this._runMigration(10, () => {
        const cols = this._getTableColumns("memory_nodes");
        if (!cols.includes("user_id")) {
          this.db.exec("ALTER TABLE memory_nodes ADD COLUMN user_id TEXT NOT NULL DEFAULT 'default'");
        }
        // 重建索引
        this.db.exec("CREATE INDEX IF NOT EXISTS idx_memory_nodes_user_id ON memory_nodes(user_id)");
      });
    }

    // 记录版本
    this.db
      .prepare("INSERT OR IGNORE INTO memory_schema_versions (version, applied_at, description) VALUES (?, ?, ?)")
      .run(MEMORY_SCHEMA_VERSION, Date.now(), `Schema v${MEMORY_SCHEMA_VERSION}: scope/tier_min/structure_template/FTS5/user_id`);
  }

  /** 获取表的列名列表 */
  private _getTableColumns(table: string): string[] {
    try {
      const rows = this.db
        .prepare(`PRAGMA table_info(${table})`)
        .all() as Array<{ name: string }>;
      return rows.map((r) => r.name);
    } catch {
      return [];
    }
  }

  /** 执行单步迁移并记录版本 */
  private _runMigration(version: number, fn: () => void): void {
    fn();
    this.db
      .prepare("INSERT OR IGNORE INTO memory_schema_versions (version, applied_at, description) VALUES (?, ?, ?)")
      .run(version, Date.now(), `Schema v${version}`);
  }

  // ===== Node Operations =====

  createNode(data: Omit<MemoryNode, "id" | "contentHash" | "createdAt" | "updatedAt"> & { id?: string }): MemoryNode {
    const id = data.id ?? crypto.randomUUID();
    const now = Date.now();
    const contentHash = createHash("sha256").update(data.summary + data.body).digest("hex");

    // 检测 schema 并动态构建 INSERT，兼容旧版数据库
    const newCols: string[] = [];
    const newVals: unknown[] = [];

    if (this._hasNewScope) { newCols.push("scope"); newVals.push(data.scope ?? "public"); }
    if (this._hasNewTierMin) { newCols.push("tier_min"); newVals.push(data.tierMin ?? 1); }
    if (this._hasNewNegExamples) { newCols.push("negative_examples"); newVals.push(JSON.stringify(data.negativeExamples ?? [])); }
    if (this._hasNewDeprecated) { newCols.push("is_deprecated, deprecated_at"); newVals.push(data.isDeprecated ? 1 : 0, data.deprecatedAt ?? null); }
    if (this._hasNewUserId) { newCols.push("user_id"); newVals.push(data.userId ?? "default"); }

    const colStr = newCols.length > 0 ? `, ${newCols.join(", ")}` : "";
    const valStr = newVals.length > 0 ? `, ${newVals.map(() => "?").join(", ")}` : "";

    this.db
      .prepare(`
        INSERT INTO memory_nodes (id, title, summary, body, content_hash, importance, status, source, source_session, tags, node_type, created_at, updated_at, ttl_days${colStr})
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?${valStr})
      `)
      .run(
        id,
        data.title,
        data.summary ?? "",
        data.body ?? "",
        contentHash,
        data.importance ?? 5,
        data.status ?? "active",
        data.source ?? "agent",
        data.sourceSession ?? null,
        JSON.stringify(data.tags ?? []),
        data.nodeType ?? "memory_entry",
        now,
        now,
        data.ttlDays ?? null,
        ...newVals,
      );

    return {
      id, ...data,
      contentHash,
      createdAt: now,
      updatedAt: now,
    };
  }

  getNode(id: string): MemoryNode | null {
    const row = this.db
      .prepare("SELECT * FROM memory_nodes WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToNode(row);
  }

  updateNode(id: string, data: Partial<Omit<MemoryNode, "id" | "createdAt">>): boolean {
    const existing = this.getNode(id);
    if (!existing) return false;

    const now = Date.now();
    const updates: string[] = ["updated_at = ?"];
    const params: unknown[] = [now];

    if (data.title !== undefined) { updates.push("title = ?"); params.push(data.title); }
    if (data.summary !== undefined) { updates.push("summary = ?"); params.push(data.summary); }
    if (data.body !== undefined) { updates.push("body = ?"); params.push(data.body); }
    if (data.importance !== undefined) { updates.push("importance = ?"); params.push(data.importance); }
    if (data.status !== undefined) { updates.push("status = ?"); params.push(data.status); }
    if (data.tags !== undefined) { updates.push("tags = ?"); params.push(JSON.stringify(data.tags)); }
    if (data.ttlDays !== undefined) { updates.push("ttl_days = ?"); params.push(data.ttlDays); }
    if (data.scope !== undefined && this._hasNewScope) { updates.push("scope = ?"); params.push(data.scope); }
    if (data.tierMin !== undefined && this._hasNewTierMin) { updates.push("tier_min = ?"); params.push(data.tierMin); }
    if (data.negativeExamples !== undefined && this._hasNewNegExamples) { updates.push("negative_examples = ?"); params.push(JSON.stringify(data.negativeExamples)); }
    if (data.isDeprecated !== undefined && this._hasNewDeprecated) { updates.push("is_deprecated = ?"); params.push(data.isDeprecated ? 1 : 0); }
    if (data.deprecatedAt !== undefined && this._hasNewDeprecated) { updates.push("deprecated_at = ?"); params.push(data.deprecatedAt); }
    if (data.userId !== undefined && this._hasNewUserId) { updates.push("user_id = ?"); params.push(data.userId); }

    params.push(id);
    this.db.prepare(`UPDATE memory_nodes SET ${updates.join(", ")} WHERE id = ?`).run(...params);
    return true;
  }

  deleteNode(id: string): boolean {
    const result = this.db.prepare("DELETE FROM memory_nodes WHERE id = ?").run(id);
    return result.changes > 0;
  }

  // ===== Edge Operations =====

  createEdge(data: Omit<MemoryEdge, "id" | "createdAt">): MemoryEdge {
    const now = Date.now();
    const result = this.db
      .prepare(`
        INSERT INTO memory_edges (source_type, source_id, target_type, target_id, relation, weight, description, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        data.sourceType,
        data.sourceId,
        data.targetType,
        data.targetId,
        data.relation,
        data.weight,
        data.description,
        now,
      );

    return {
      id: Number(result.lastInsertRowid),
      ...data,
      createdAt: now,
    };
  }

  getNodeEdges(nodeId: string): MemoryEdge[] {
    const rows = this.db
      .prepare(`
        SELECT * FROM memory_edges
        WHERE source_id = ? OR target_id = ?
        ORDER BY created_at DESC
      `)
      .all(nodeId, nodeId) as Record<string, unknown>[];

    return rows.map((r) => ({
      id: r.id as number,
      sourceType: r.source_type as "memory" | "code",
      sourceId: r.source_id as string,
      targetType: r.target_type as "memory" | "code",
      targetId: r.target_id as string,
      relation: r.relation as EdgeRelation,
      weight: r.weight as number,
      description: r.description as string,
      createdAt: r.created_at as number,
    }));
  }

  deleteEdge(id: number): boolean {
    const result = this.db.prepare("DELETE FROM memory_edges WHERE id = ?").run(id);
    return result.changes > 0;
  }

  /** Link a memory node to a code symbol */
  linkMemoryToCode(memoryId: string, codeSymbolId: string, description?: string): MemoryEdge {
    return this.createEdge({
      sourceType: "memory",
      sourceId: memoryId,
      targetType: "code",
      targetId: codeSymbolId,
      relation: "links_to_code",
      weight: 1.0,
      description: description ?? "",
    });
  }

  /** Link two memory nodes */
  linkMemoryToMemory(
    sourceId: string,
    targetId: string,
    relation: "causes" | "fixes" | "precedes" | "references" | "contradicts" | "supersedes" | "relates_to" | "implements" | "summarizes" | "dream_log",
    weight?: number,
    description?: string,
  ): MemoryEdge {
    return this.createEdge({
      sourceType: "memory",
      sourceId,
      targetType: "memory",
      targetId,
      relation,
      weight: weight ?? 1.0,
      description: description ?? "",
    });
  }

  /** Get memory entry with its code symbol associations */
  getMemoryWithCodeSymbols(memoryId: string) {
    const rows = this.db
      .prepare(`
        SELECT
          me.relation, me.weight, me.description AS edge_description,
          n.id AS code_id, n.name AS code_name, n.kind AS code_kind,
          n.file_path, n.qualified_name, n.signature
        FROM memory_edges me
        JOIN nodes n ON n.id = me.target_id
        WHERE me.source_id = ?
          AND me.source_type = 'memory'
          AND me.target_type = 'code'
          AND me.relation = 'links_to_code'
      `)
      .all(memoryId) as Record<string, unknown>[];

    return rows.map((r) => ({
      relation: r.relation as string,
      weight: r.weight as number,
      description: r.edge_description as string,
      symbol: {
        id: r.code_id as string,
        name: r.code_name as string,
        kind: r.code_kind as string,
        filePath: r.file_path as string,
        qualifiedName: r.qualified_name as string,
      },
    }));
  }

  /** Get related memory entries (graph traversal, depth=1) */
  getRelatedMemories(memoryId: string, options?: {
    depth?: number;
    relationTypes?: EdgeRelation[];
    minWeight?: number;
  }): Array<{
    node: MemoryNode;
    relation: EdgeRelation;
    weight: number;
    direction: "incoming" | "outgoing";
  }> {
    const maxDepth = options?.depth ?? 1;
    const relationFilter = options?.relationTypes;
    const minWeight = options?.minWeight ?? 0;

    if (maxDepth < 1) return [];

    const rows = this.db
      .prepare(`
        SELECT
          me.relation, me.weight, me.source_type, me.target_type,
          me.source_id, me.target_id,
          mn.id AS node_id, mn.title, mn.summary,
          mn.importance, mn.status, mn.tags, mn.node_type,
          mn.created_at, mn.updated_at, mn.source,
          mn.scope, mn.tier_min, mn.negative_examples, mn.is_deprecated, mn.deprecated_at,
          mn.user_id
        FROM memory_edges me
        JOIN memory_nodes mn ON (
          (me.source_id = ? AND me.target_type = 'memory' AND me.target_id = mn.id)
          OR
          (me.target_id = ? AND me.source_type = 'memory' AND me.source_id = mn.id)
        )
        WHERE (
          (me.source_id = ? AND me.source_type = 'memory')
          OR
          (me.target_id = ? AND me.target_type = 'memory')
        )
        ${relationFilter ? `AND me.relation IN (${relationFilter.map(() => "?").join(",")})` : ""}
        AND me.weight >= ?
      `)
      .all(
        memoryId, memoryId, memoryId, memoryId,
        ...(relationFilter ?? []),
        minWeight,
      ) as Record<string, unknown>[];

    const results: Array<{
      node: MemoryNode;
      relation: EdgeRelation;
      weight: number;
      direction: "incoming" | "outgoing";
    }> = [];

    for (const row of rows) {
      const direction: "incoming" | "outgoing" =
        (row.source_id as string) === memoryId ? "outgoing" : "incoming";

      if (!results.some((r) => r.node.id === row.node_id)) {
        results.push({
          node: this.rowToNode(row),
          relation: row.relation as EdgeRelation,
          weight: row.weight as number,
          direction,
        });
      }
    }

    return results;
  }

  /** Full-text search via FTS5 (v7+) */
  searchByFTS(query: string, limit = 20): MemoryNode[] {
    try {
      const rows = this.db
        .prepare(`
          SELECT mn.* FROM memory_nodes mn
          JOIN memory_nodes_fts fts ON mn.rowid = fts.rowid
          WHERE memory_nodes_fts MATCH ?
          ORDER BY rank
          LIMIT ?
        `)
        .all(query, limit) as Record<string, unknown>[];
      return rows.map((r) => this.rowToNode(r));
    } catch {
      // FTS5 表不存在或查询失败，降级到 LIKE
      return this.searchByText(query, limit);
    }
  }

  /** Full-text search across memory titles and summaries (LIKE fallback) */
  searchByText(query: string, limit = 20): MemoryNode[] {
    const like = `%${query}%`;
    const rows = this.db
      .prepare(`
        SELECT * FROM memory_nodes
        WHERE status = 'active'
          AND (title LIKE ? OR summary LIKE ? OR body LIKE ?)
        ORDER BY importance DESC, created_at DESC
        LIMIT ?
      `)
      .all(like, like, like, limit) as Record<string, unknown>[];

    return rows.map((r) => this.rowToNode(r));
  }

  /** Search by tags */
  searchByTag(tag: string, limit = 20): MemoryNode[] {
    const rows = this.db
      .prepare(`
        SELECT * FROM memory_nodes
        WHERE status = 'active'
          AND tags LIKE ?
        ORDER BY importance DESC, created_at DESC
        LIMIT ?
      `)
      .all(`%"${tag}"%`, limit) as Record<string, unknown>[];

    return rows.map((r) => this.rowToNode(r));
  }

  /** Get nodes by scope */
  getNodesByScope(scope: MemoryScope, limit = 50): MemoryNode[] {
    const rows = this.db
      .prepare(`
        SELECT * FROM memory_nodes
        WHERE scope = ? AND status = 'active'
        ORDER BY importance DESC, created_at DESC
        LIMIT ?
      `)
      .all(scope, limit) as Record<string, unknown>[];

    return rows.map((r) => this.rowToNode(r));
  }

  /** Get nodes by user_id（多租户查询） */
  getNodesByUserId(userId: string, limit = 50): MemoryNode[] {
    const rows = this.db
      .prepare(`
        SELECT * FROM memory_nodes
        WHERE user_id = ? AND status = 'active'
        ORDER BY importance DESC, created_at DESC
        LIMIT ?
      `)
      .all(userId, limit) as Record<string, unknown>[];

    return rows.map((r) => this.rowToNode(r));
  }

  /** Get recent memories by time range */
  getRecentMemories(hours = 24, limit = 50): MemoryNode[] {
    const cutoff = Date.now() - hours * 60 * 60 * 1000;
    const rows = this.db
      .prepare(`
        SELECT * FROM memory_nodes
        WHERE created_at >= ?
        ORDER BY created_at DESC
        LIMIT ?
      `)
      .all(cutoff, limit) as Record<string, unknown>[];

    return rows.map((r) => this.rowToNode(r));
  }

  /** Get statistics */
  getStats(): MemoryGraphStats {
    const totalNodes = (this.db.prepare("SELECT COUNT(*) as count FROM memory_nodes").get() as Record<string, unknown>).count as number;
    const totalEdges = (this.db.prepare("SELECT COUNT(*) as count FROM memory_edges").get() as Record<string, unknown>).count as number;
    const codeLinked = (this.db
      .prepare("SELECT COUNT(*) as count FROM memory_edges WHERE relation = 'links_to_code'")
      .get() as Record<string, unknown>).count as number;

    const byStatusRows = this.db.prepare("SELECT status, COUNT(*) as count FROM memory_nodes GROUP BY status").all() as Record<string, unknown>[];
    const byTypeRows = this.db.prepare("SELECT node_type, COUNT(*) as count FROM memory_nodes GROUP BY node_type").all() as Record<string, unknown>[];
    const byScopeRows = this.db.prepare("SELECT scope, COUNT(*) as count FROM memory_nodes GROUP BY scope").all() as Record<string, unknown>[];

    return {
      totalNodes,
      totalEdges,
      codeLinked,
      byStatus: Object.fromEntries(byStatusRows.map((r) => [r.status as string, r.count as number])),
      byType: Object.fromEntries(byTypeRows.map((r) => [r.node_type as string, r.count as number])),
      byScope: Object.fromEntries(byScopeRows.map((r) => [r.scope as string, r.count as number])),
    };
  }

  /** Prune expired and low-importance entries */
  prune(dryRun = true): { deleted: number; archived: number } {
    const now = Date.now();

    const expired = this.db
      .prepare("SELECT id FROM memory_nodes WHERE ttl_days IS NOT NULL AND (created_at + ttl_days * 86400000) < ?")
      .all(now) as Record<string, unknown>[];

    const lowImp = this.db
      .prepare(`
        SELECT mn.id FROM memory_nodes mn
        WHERE mn.importance < 3 AND mn.status = 'active'
          AND NOT EXISTS (SELECT 1 FROM memory_edges me WHERE me.source_id = mn.id OR me.target_id = mn.id)
      `)
      .all() as Record<string, unknown>[];

    if (dryRun) {
      return { deleted: expired.length, archived: lowImp.length };
    }

    for (const row of expired) {
      this.db.prepare("DELETE FROM memory_nodes WHERE id = ?").run(row.id);
    }
    for (const row of lowImp) {
      this.db.prepare("UPDATE memory_nodes SET status = 'archived' WHERE id = ?").run(row.id);
    }

    return { deleted: expired.length, archived: lowImp.length };
  }

  /** Get all nodes regardless of status (for dream engine maintenance) */
  getAllNodes(): MemoryNode[] {
    const rows = this.db
      .prepare("SELECT * FROM memory_nodes")
      .all() as Record<string, unknown>[];
    return rows.map((r) => this.rowToNode(r));
  }

  /** Close the database connection */
  close(): void {
    if (this.db.open) this.db.close();
  }

  // ===== Helpers =====

  private rowToNode(row: Record<string, unknown>): MemoryNode {
    return {
      id: row.id as string,
      title: row.title as string,
      summary: (row.summary as string) ?? "",
      body: (row.body as string) ?? "",
      contentHash: row.content_hash as string,
      importance: (row.importance as number) ?? 5,
      status: (row.status as MemoryStatus) ?? "active",
      source: (row.source as MemorySource) ?? "agent",
      sourceSession: (row.source_session as string) ?? null,
      tags: (() => {
        try { return JSON.parse((row.tags as string) ?? "[]"); } catch { return []; }
      })(),
      nodeType: (row.node_type as MemoryNodeType) ?? "memory_entry",
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
      ttlDays: (row.ttl_days as number) ?? null,
      scope: (row.scope as MemoryScope) ?? "public",
      tierMin: (row.tier_min as number) ?? 1,
      negativeExamples: (() => {
        try { return JSON.parse((row.negative_examples as string) ?? "[]"); } catch { return []; }
      })(),
      isDeprecated: (row.is_deprecated as number) === 1,
      deprecatedAt: (row.deprecated_at as number) ?? null,
      userId: (row.user_id as string) ?? "default",
    };
  }
}