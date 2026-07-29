-- One Memory Schema v10 — 双层级隔离 + 结构沉淀 + 反模式 + FTS5 + 多租户
-- 2026-07-24 升级：scope/tier_min 隔离 | structure_template | negative_examples | is_deprecated | FTS5
-- 2026-07-24 v10: user_id 多租户隔离

-- =============================================================================
-- Memory Schema Versioning
-- =============================================================================

CREATE TABLE IF NOT EXISTS memory_schema_versions (
    version INTEGER PRIMARY KEY,
    applied_at INTEGER NOT NULL,
    description TEXT
);

-- =============================================================================
-- Memory Nodes
-- =============================================================================

CREATE TABLE IF NOT EXISTS memory_nodes (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT '',
    content_hash TEXT NOT NULL,
    importance INTEGER NOT NULL DEFAULT 5
        CHECK (importance >= 1 AND importance <= 10),
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'archived', 'pending_review')),
    source TEXT NOT NULL DEFAULT 'agent'
        CHECK (source IN ('agent', 'user', 'system', 'imported')),
    source_session TEXT,
    tags TEXT NOT NULL DEFAULT '[]',
    node_type TEXT NOT NULL DEFAULT 'memory_entry'
        CHECK (node_type IN ('memory_entry', 'decision', 'project_milestone', 'insight', 'structure_template', 'session_summary')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    ttl_days INTEGER,

    -- v4 新增：双层级隔离
    scope TEXT NOT NULL DEFAULT 'public'
        CHECK (scope IN ('public', 'global')),
    tier_min INTEGER NOT NULL DEFAULT 1
        CHECK (tier_min >= 1 AND tier_min <= 10),

    -- v5 新增：反模式存储
    negative_examples TEXT NOT NULL DEFAULT '[]',

    -- v6 新增：结构坍缩标记
    is_deprecated INTEGER NOT NULL DEFAULT 0,
    deprecated_at INTEGER,

    -- v10 新增：多租户隔离
    user_id TEXT NOT NULL DEFAULT 'default'
);

-- =============================================================================
-- Memory Edges (links to code symbols or other memory entries)
-- =============================================================================

CREATE TABLE IF NOT EXISTS memory_edges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_type TEXT NOT NULL
        CHECK (source_type IN ('memory', 'code')),
    source_id TEXT NOT NULL,
    target_type TEXT NOT NULL
        CHECK (target_type IN ('memory', 'code')),
    target_id TEXT NOT NULL,
    relation TEXT NOT NULL
        CHECK (relation IN (
            'links_to_code', 'causes', 'fixes', 'precedes',
            'follows', 'references', 'contradicts', 'supersedes',
            'relates_to', 'implements', 'questions', 'summarizes',
            'dream_log'
        )),
    weight REAL NOT NULL DEFAULT 1.0
        CHECK (weight >= 0.0 AND weight <= 1.0),
    description TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
);

-- =============================================================================
-- Dream Logs（梦境运行记录）
-- =============================================================================

CREATE TABLE IF NOT EXISTS dream_logs (
    id TEXT PRIMARY KEY,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    duration_ms INTEGER,
    before_nodes INTEGER,
    before_edges INTEGER,
    after_nodes INTEGER,
    after_edges INTEGER,
    merged_count INTEGER DEFAULT 0,
    archived_count INTEGER DEFAULT 0,
    deleted_count INTEGER DEFAULT 0,
    insights_generated INTEGER DEFAULT 0,
    health_score REAL,
    report_json TEXT,
    status TEXT NOT NULL DEFAULT 'running'
        CHECK (status IN ('running', 'completed', 'failed'))
);

-- =============================================================================
-- FTS5 全文搜索（v7 新增）
-- =============================================================================

CREATE VIRTUAL TABLE IF NOT EXISTS memory_nodes_fts USING fts5(
    title,
    summary,
    body,
    content='memory_nodes',
    content_rowid='rowid'
);

-- =============================================================================
-- Indexes
-- =============================================================================

CREATE INDEX IF NOT EXISTS idx_memory_nodes_tags ON memory_nodes(tags);
CREATE INDEX IF NOT EXISTS idx_memory_nodes_source ON memory_nodes(source);
CREATE INDEX IF NOT EXISTS idx_memory_nodes_created_at ON memory_nodes(created_at);
CREATE INDEX IF NOT EXISTS idx_memory_nodes_importance ON memory_nodes(importance);
CREATE INDEX IF NOT EXISTS idx_memory_nodes_status ON memory_nodes(status);
CREATE INDEX IF NOT EXISTS idx_memory_nodes_scope ON memory_nodes(scope);
CREATE INDEX IF NOT EXISTS idx_memory_nodes_node_type ON memory_nodes(node_type);
CREATE INDEX IF NOT EXISTS idx_memory_nodes_is_deprecated ON memory_nodes(is_deprecated);
CREATE INDEX IF NOT EXISTS idx_memory_nodes_user_id ON memory_nodes(user_id);

CREATE INDEX IF NOT EXISTS idx_memory_edges_source ON memory_edges(source_id, source_type);
CREATE INDEX IF NOT EXISTS idx_memory_edges_target ON memory_edges(target_id, target_type);
CREATE INDEX IF NOT EXISTS idx_memory_edges_relation ON memory_edges(relation);

-- =============================================================================
-- Memory Heat Tracking（v3 新增 — 替代 JSON 文件持久化）
-- =============================================================================

CREATE TABLE IF NOT EXISTS memory_heat (
    node_id TEXT PRIMARY KEY,
    hits INTEGER NOT NULL DEFAULT 0,
    last_hit_at INTEGER NOT NULL,
    heat_score REAL NOT NULL DEFAULT 0.0
        CHECK (heat_score >= 0.0 AND heat_score <= 10.0),
    updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_heat_score ON memory_heat(heat_score);