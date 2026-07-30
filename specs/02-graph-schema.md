# Spec 02: Graph Schema — Memory Tables

**状态**: Implementing → **Outdated (v1)** → 当前实现为 v10 | **优先级**: P0 | **最后更新**: 2026-07-30

> ⚠️ **本 spec 已过时**。当前 schema 为 v10，以下列出的是完整的最新版本。
> 原始 spec（v1）部分假设已被推翻：
> - ❌ memory 不共享 CodeGraph 的 SQLite DB，而是**独立的 SQLite 数据库**
> - ❌ 不使用 `nodes` 表的外键关联 — memory 是独立服务，通过 MCP 通信
> - ❌ `memory_edges` 不引用 `nodes.id` — memory-to-code 关联走 tag/metadata 方式
> - ✅ `memory_nodes` 表结构保留并扩展了 v1 的设计
>
> **本文件已重写为当前 v10 架构的真实描述。**

## 1. 架构定位

Memory 系统是**独立 MCP 服务器**，运行自己的 SQLite 数据库，不共享 CodeGraph 的 DB。

```
AI-memory 进程（独立 MCP Server）
  └── memory.db
      ├── memory_nodes          ← 记忆节点
      ├── memory_edges          ← 记忆关联边
      ├── schema_versions       ← Schema 版本管理
      └── memory_nodes_fts      ← FTS5 全文索引
```

CodeGraph 通过 MCP 的 `memory_query` / `memory_write` 工具通信，不直连 DB。

## 2. SQL Schema（v10 当前版本）

```sql
-- =============================================================================
-- Memory Schema Version 10
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
    id TEXT PRIMARY KEY,                          -- UUID v4
    title TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT '',
    content_hash TEXT NOT NULL,
    importance INTEGER NOT NULL DEFAULT 5,
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'archived', 'pending_review', 'deprecated')),
    source TEXT NOT NULL DEFAULT 'agent'
        CHECK (source IN ('agent', 'user', 'system', 'imported', 'obsidian')),
    source_session TEXT,
    tags TEXT NOT NULL DEFAULT '[]',
    node_type TEXT NOT NULL DEFAULT 'memory_entry'
        CHECK (node_type IN (
            'memory_entry', 'decision', 'project_milestone',
            'insight', 'structure_template', 'session_summary', 'procedure'
        )),
    scope TEXT NOT NULL DEFAULT 'public'
        CHECK (scope IN ('public', 'global', 'personal')),
    tier_min INTEGER NOT NULL DEFAULT 0,
    user_id TEXT NOT NULL DEFAULT 'default',
    negative_examples TEXT,
    is_deprecated INTEGER NOT NULL DEFAULT 0,
    deprecated_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    ttl_days INTEGER
);

-- =============================================================================
-- FTS5 全文搜索
-- =============================================================================

CREATE VIRTUAL TABLE IF NOT EXISTS memory_nodes_fts USING fts5(
    title, summary, body, tags,
    content='memory_nodes',
    content_rowid='rowid',
    tokenize='unicode61'
);

-- =============================================================================
-- Memory Edges
-- =============================================================================

CREATE TABLE IF NOT EXISTS memory_edges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_type TEXT NOT NULL CHECK (source_type IN ('memory')),
    source_id TEXT NOT NULL,
    target_type TEXT NOT NULL CHECK (target_type IN ('memory')),
    target_id TEXT NOT NULL,
    relation TEXT NOT NULL
        CHECK (relation IN (
            'causes','fixes','precedes','follows','references',
            'contradicts','supersedes','summarizes','relates_to',
            'implements','questions','dream_action'
        )),
    weight REAL NOT NULL DEFAULT 1.0,
    description TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    FOREIGN KEY (source_id) REFERENCES memory_nodes(id) ON DELETE CASCADE,
    FOREIGN KEY (target_id) REFERENCES memory_nodes(id) ON DELETE CASCADE
);

-- =============================================================================
-- 向量元数据
-- =============================================================================

CREATE TABLE IF NOT EXISTS memory_vectors (
    id TEXT PRIMARY KEY,
    node_id TEXT NOT NULL UNIQUE,
    embedder_name TEXT NOT NULL,
    dimension INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (node_id) REFERENCES memory_nodes(id) ON DELETE CASCADE
);

-- =============================================================================
-- Indexes
-- =============================================================================

CREATE INDEX IF NOT EXISTS idx_memory_nodes_tags ON memory_nodes(tags);
CREATE INDEX IF NOT EXISTS idx_memory_nodes_source ON memory_nodes(source);
CREATE INDEX IF NOT EXISTS idx_memory_nodes_created_at ON memory_nodes(created_at);
CREATE INDEX IF NOT EXISTS idx_memory_nodes_importance ON memory_nodes(importance);
CREATE INDEX IF NOT EXISTS idx_memory_nodes_status ON memory_nodes(status);
CREATE INDEX IF NOT EXISTS idx_memory_nodes_node_type ON memory_nodes(node_type);
CREATE INDEX IF NOT EXISTS idx_memory_nodes_user_id ON memory_nodes(user_id);
CREATE INDEX IF NOT EXISTS idx_memory_edges_source ON memory_edges(source_id, source_type);
CREATE INDEX IF NOT EXISTS idx_memory_edges_target ON memory_edges(target_id, target_type);
CREATE INDEX IF NOT EXISTS idx_memory_edges_relation ON memory_edges(relation);
CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_vectors_node_unique ON memory_vectors(node_id);
```

## 3. 多租户隔离（v10 新增）

三层硬隔离：

| 层 | 机制 | 说明 |
|:---|:---|:---|
| 存储层 | `memory_nodes.user_id` 列 + 索引 | SQLite WHERE 过滤 |
| 向量层 | 向量 metadata 中 `tenantId` 字段 | 向量搜索时过滤 |
| 工具层 | MCP 工具接受 `user_id` 参数 | 服务端强制过滤 |

- `user_id = 'default'` 时所有用户共享（向后兼容）
- 用户身份由 MCP 调用方硬性绑定，LLM 不参与

## 4. 查询示例

```sql
-- 查询某个用户的活跃记忆
SELECT id, title, summary, importance
FROM memory_nodes
WHERE user_id = 'user_zhangsan' AND status = 'active'
ORDER BY importance DESC LIMIT 10;

-- 查询决策及其因果链
SELECT d.id, d.title, me.relation, mn_related.title AS related_memory
FROM memory_nodes d
JOIN memory_edges me ON me.source_id = d.id
JOIN memory_nodes mn_related ON mn_related.id = me.target_id
WHERE d.node_type = 'decision'
  AND d.user_id = 'user_zhangsan'
  AND me.relation IN ('causes', 'fixes', 'implements');
```

## 5. Schema 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| v1 | 2026-06-06 | 初始设计（与 CodeGraph 同 DB） |
| v3→v9 | 2026-07-24 | 独立 DB、FTS5、scope/tier_min、structure_template、is_deprecated |
| v10 | 2026-07-24 | 多租户隔离（user_id 列 + 索引） |

## 6. vs CodeGraph `nodes` 表

| 维度 | `nodes` (CodeGraph) | `memory_nodes` (Memory) |
|------|--------------------|------------------------|
| 用途 | 代码符号 | 记忆/决策/洞察/模板 |
| 数据库 | 独立文件 | 独立文件 |
| ID 格式 | `FileSymbol_qualified_name` | UUID v4 |
| 通信 | — | MCP 工具调用 |
| 字段 | code-specific | memory-specific (summary, tags, importance, userId) |
| FTS | 有 (nodes_fts) | 有 (memory_nodes_fts) |
