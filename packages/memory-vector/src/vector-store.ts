/**
 * memory-vector: SQLite 向量存储
 *
 * 在 CodeGraph DB 同目录下维护独立的 memory-vectors.db，
 * 存储 id → Float32Array BLOB + metadata JSON。
 *
 * 查询策略：余弦相似度暴力搜索（O(n)），适合 MVP 阶段 <10,000 条记录。
 * 后期可换装 LanceDB / ChromaDB 等专用向量引擎。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

// ===== Types =====

export interface VectorMetadata {
  nodeId: string;
  type: string;
  title: string;
  summary: string;
  importance: number;
  createdAt: number;
  source: string;
  tags?: string[];      // 标签（用于搜索过滤）
  tenantId?: string;    // 租户隔离（Phase 4）
  tier?: "hot" | "cold"; // 存储层级
}

export interface VectorEntry {
  id: string;
  vector: Float32Array;
  metadata: VectorMetadata;
}

export interface VectorQueryOptions {
  topK: number;
  filter?: {
    types?: string[];
    importanceMin?: number;
    sources?: string[];
    timeRange?: [number, number];
    tenantId?: string;          // 租户隔离
    tiers?: ("hot" | "cold")[]; // 存储层级过滤
  };
  scoreThreshold?: number;
}

export interface VectorResult {
  id: string;
  score: number;
  metadata: VectorMetadata;
}

export interface VectorStoreStats {
  totalEntries: number;
  dimension: number;
  memoryUsageBytes: number;
}

// ===== Cosine Similarity =====

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
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

// ===== SQLite Vector Store =====

interface SqliteStmt {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
}

export class SqliteVectorStore {
  private db: any;
  private dbPath: string;
  private _dimension = 0;

  private constructor(db: any, dbPath: string) {
    this.db = db;
    this.dbPath = dbPath;
  }

  /** Open existing or create new vector store at dbPath */
  static open(dbPath: string): SqliteVectorStore {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DatabaseSync } = require("node:sqlite");

    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const raw = new DatabaseSync(dbPath);
    raw.exec("PRAGMA journal_mode = WAL");
    raw.exec("PRAGMA busy_timeout = 5000");

    raw.exec(`
      CREATE TABLE IF NOT EXISTS vectors (
        id TEXT PRIMARY KEY,
        vector BLOB NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_vectors_created ON vectors(created_at);
    `);

    const store = new SqliteVectorStore(raw, dbPath);
    return store;
  }

  /** Total number of stored vectors */
  get totalEntries(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as c FROM vectors")
      .get() as { c: number };
    return row.c;
  }

  /** Vector dimension (detected from first entry) */
  get dimension(): number {
    if (this._dimension > 0) return this._dimension;
    const row = this.db
      .prepare("SELECT vector FROM vectors LIMIT 1")
      .get() as { vector: Buffer } | undefined;
    if (row) {
      this._dimension = row.vector.byteLength / 4;
    }
    return this._dimension;
  }

  // ===== Write =====

  upsert(id: string, vector: Float32Array, metadata: VectorMetadata): void {
    this.db
      .prepare(`
        INSERT INTO vectors (id, vector, metadata_json, created_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          vector = excluded.vector,
          metadata_json = excluded.metadata_json
      `)
      .run(id, Buffer.from(vector.buffer), JSON.stringify(metadata), Date.now());

    if (this._dimension === 0) this._dimension = vector.length;
  }

  upsertBatch(entries: VectorEntry[]): void {
    const stmt = this.db.prepare(`
      INSERT INTO vectors (id, vector, metadata_json, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        vector = excluded.vector,
        metadata_json = excluded.metadata_json
    `);

    const now = Date.now();
    for (const entry of entries) {
      stmt.run(entry.id, Buffer.from(entry.vector.buffer), JSON.stringify(entry.metadata), now);
    }

    if (this._dimension === 0 && entries.length > 0) {
      this._dimension = entries[0].vector.length;
    }
  }

  delete(id: string): boolean {
    const result = this.db.prepare("DELETE FROM vectors WHERE id = ?").run(id);
    return result.changes > 0;
  }

  // ===== Query =====

  query(queryVector: Float32Array, options: VectorQueryOptions): VectorResult[] {
    const topK = options.topK;
    const threshold = options.scoreThreshold ?? -Infinity;

    // Build SQL with optional filters
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (options.filter) {
      const f = options.filter;
      if (f.importanceMin !== undefined) {
        conditions.push("json_extract(metadata_json, '$.importance') >= ?");
        params.push(f.importanceMin);
      }
      if (f.sources?.length) {
        const placeholders = f.sources.map(() => "?").join(",");
        conditions.push(`json_extract(metadata_json, '$.source') IN (${placeholders})`);
        params.push(...f.sources);
      }
      if (f.types?.length) {
        const placeholders = f.types.map(() => "?").join(",");
        conditions.push(`json_extract(metadata_json, '$.type') IN (${placeholders})`);
        params.push(...f.types);
      }
      if (f.timeRange) {
        conditions.push("json_extract(metadata_json, '$.createdAt') >= ? AND json_extract(metadata_json, '$.createdAt') <= ?");
        params.push(f.timeRange[0], f.timeRange[1]);
      }
      if (f.tenantId) {
        conditions.push("json_extract(metadata_json, '$.tenantId') = ?");
        params.push(f.tenantId);
      }
      if (f.tiers?.length) {
        const placeholders = f.tiers.map(() => "?").join(",");
        conditions.push(`json_extract(metadata_json, '$.tier') IN (${placeholders})`);
        params.push(...f.tiers);
      }
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT id, vector, metadata_json FROM vectors ${where}`)
      .all(...params) as Array<{ id: string; vector: Buffer; metadata_json: string }>;

    // Compute cosine similarity
    const scored: VectorResult[] = [];
    for (const row of rows) {
      const buf = row.vector as Buffer;
      // Buffer.buffer may be a larger internal pool — use byteOffset + byteLength
      const storedVector = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
      const score = cosineSimilarity(queryVector, storedVector);

      if (score < threshold) continue;

      scored.push({
        id: row.id,
        score,
        metadata: JSON.parse(row.metadata_json) as VectorMetadata,
      });
    }

    // Sort by score descending, return top K
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  // ===== Maintenance =====

  stats(): VectorStoreStats {
    const count = (this.db
      .prepare("SELECT COUNT(*) as c FROM vectors")
      .get() as { c: number }).c;
    return {
      totalEntries: count,
      dimension: this.dimension,
      memoryUsageBytes: count * this.dimension * 4,
    };
  }

  /** Delete all vectors and rebuild from scratch */
  clear(): void {
    this.db.exec("DELETE FROM vectors");
  }

  // ===== Cold Storage =====

  /** Move entries to cold tier (update metadata) */
  moveToCold(nodeIds: string[]): number {
    let count = 0;
    const stmt = this.db.prepare(
      `UPDATE vectors SET metadata_json = json_set(metadata_json, '$.tier', 'cold') WHERE id = ?`,
    );
    for (const id of nodeIds) {
      const r = stmt.run(id);
      count += r.changes;
    }
    return count;
  }

  /** Move entries back to hot tier */
  moveToHot(nodeIds: string[]): number {
    let count = 0;
    const stmt = this.db.prepare(
      `UPDATE vectors SET metadata_json = json_set(metadata_json, '$.tier', 'hot') WHERE id = ?`,
    );
    for (const id of nodeIds) {
      const r = stmt.run(id);
      count += r.changes;
    }
    return count;
  }

  /** Auto-archive: entries older than N days with low importance become cold */
  autoTier(daysOld: number, importanceThreshold: number): { movedToCold: number } {
    const cutoff = Date.now() - daysOld * 86400000;
    const rows = this.db
      .prepare(`
        SELECT id FROM vectors
        WHERE json_extract(metadata_json, '$.tier') IS NULL
          AND json_extract(metadata_json, '$.createdAt') < ?
          AND json_extract(metadata_json, '$.importance') < ?
      `)
      .all(cutoff, importanceThreshold) as Array<{ id: string }>;

    const ids = rows.map((r) => r.id);
    if (ids.length === 0) return { movedToCold: 0 };

    return { movedToCold: this.moveToCold(ids) };
  }

  /** Delete all cold entries */
  purgeCold(): number {
    const result = this.db
      .prepare(`DELETE FROM vectors WHERE json_extract(metadata_json, '$.tier') = 'cold'`)
      .run();
    return result.changes;
  }

  close(): void {
    if (this.db?.isOpen) this.db.close();
  }

  /** Get database file path */
  getPath(): string {
    return this.dbPath;
  }
}
