# Spec 04: Dual-Write Consistency

**状态**: Draft → **Implementing** | **优先级**: P0 | **最后更新**: 2026-07-30

> **更新说明**：本 spec 已更新以匹配实际架构：
> - ❌ CodeGraph 不再是源 — Memory **独立 DB** 是 Source of Truth
> - ❌ 无 `codegraph.createMemoryEntry()` — 改为 `memoryDb.createNode(data)`
> - ✅ 「向量 = 派生索引」的设计保留
> - ✅ 「可重建」概念保留，重建源改为 memory DB
> - ✅ Obsidian 双写已验证为可选（Decision 001）

## 1. 架构角色

| 存储 | 角色 | 一致性 | 可重建 |
|------|------|--------|--------|
| **memory.db** (SQLite) | **Source of Truth** | 强一致 | — |
| 向量索引（内存 Map） | 派生索引 | 最终一致 | ✅ 从 memory.db 重建 |
| Obsidian Vault | 人类可读缓存（可选） | 最终一致 | ✅ 从 memory.db 重建 |

**关键变化**：Memory 系统是独立 MCP 服务器，拥有自己的 SQLite DB。
CodeGraph 不直接访问 memory.db，而是通过 MCP 工具调用。

## 2. 写入协议

### 2.1 正常写入

```
mutation writeMemory(entry) {
  // Phase 1: memory.db 写入（权威）
  const nodeId = memoryDb.createNode(entry);

  // Phase 2: 向量写入（同步，同进程）
  const vector = await embedder.embed(entry.summary);
  await vectorStore.upsert(nodeId, vector, metadata).catch(err => {
    // 向量写入失败 → 记录失败事件
    failureQueue.push({ type: 'vector', nodeId, entry, error: err });
    telemetry.incr('vector_write_failure');
  });

  // Phase 3: Obsidian 写入（可选，异步）
  if (obsidianWriter) {
    const markdown = toMarkdown(entry);
    await obsidianWriter.write(entry.id, markdown).catch(err => {
      failureQueue.push({ type: 'obsidian', nodeId, entry, error: err });
    });
  }

  return nodeId;
}
```

### 2.2 失败恢复

```typescript
const failureQueue: Queue<{
  type: 'vector' | 'obsidian';
  nodeId: string;
  entry: MemoryEntry;
  error: Error;
  retryCount: number;
}>;

// 重试策略
// - 每 30s 扫描队列
// - 最大重试 5 次
// - 指数退避: 10s, 30s, 60s, 120s, 300s
// - 5 次后标记 dead_letter
```

## 3. 一致性验证

```typescript
// 定时验证 memory.db vs 向量索引
async function verifyConsistency() {
  const dbNodes = await memoryDb.getAllNodes({ limit: 10000 });
  const vectorIds = await vectorStore.listIds();

  const report = {
    total: dbNodes.length,
    missingInVector: dbNodes.filter(n => !vectorIds.includes(n.id)).length,
    orphanedInVector: vectorIds.filter(id => !dbNodes.find(n => n.id === id)).length,
  };

  if (report.missingInVector > 10) {
    telemetry.alert('memory_inconsistency_high', report);
  }
  return report;
}
```

## 4. 全量重建

```typescript
async function rebuildFromMemoryDb() {
  // 1. 清空向量库
  await vectorStore.flush();

  // 2. 遍历所有 memory 节点
  const allNodes = await memoryDb.getAllNodes({ limit: Infinity });

  // 3. 批量向量化
  const BATCH_SIZE = 50;
  for (let i = 0; i < allNodes.length; i += BATCH_SIZE) {
    const batch = allNodes.slice(i, i + BATCH_SIZE);
    const texts = batch.map(n => n.summary);
    const vectors = await embedder.embed(texts);

    await vectorStore.upsertBatch(
      batch.map((n, j) => ({
        id: n.id,
        vector: vectors[j],
        metadata: toMetadata(n)
      }))
    );
  }

  // 4. 如果启用了 Obsidian，重建它
  if (obsidianWriter) {
    await rebuildObsidianFromMemoryDb();
  }

  telemetry.incr('memory_rebuild_complete');
}
```

## 5. 数据恢复 SLA

| 场景 | RTO | RPO | 操作 |
|------|-----|-----|------|
| 向量索引损坏 | 5 分钟 | 0 | `rebuildFromMemoryDb()` |
| Obsidian 删除 | 1 小时 | 0 | `rebuildObsidianFromMemoryDb()` |
| memory.db 损坏 | 取决于备份 | 最近备份点 | 从备份恢复 → 重建向量 |
| 全量丢失 | 2 小时 | 最近备份点 | 备份恢复 → 重建向量/Obsidian |

## 6. 相关决策

| 决策 | 来源 | 内容 |
|------|------|------|
| Obsidian 可选关闭 | Decision 001 | `obsidianVaultPath` 可选，不传则不初始化 |
| 双视图渲染 | Decision 002 | MCP 短格式 / 前端完整格式 / Obsidian Markdown |
| 多租户隔离 | schema v10 | `user_id` 列 + 向量 `tenantId` 过滤 |
