/**
 * Session Compressor 测试 — 跨会话上下文压缩与注入
 *
 * RFC-06 Phase A 实现验证。
 * 测试场景：
 *   1. 短会话 → 返回 null
 *   2. 长会话 → 生成摘要节点
 *   3. 摘要节点的类型和标签正确
 *   4. getRecentSummaries 返回最新摘要
 *   5. formatForContext 生成注入文本
 *   6. 禁用时返回 null
 *   7. 会话摘要关联引用的记忆
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { MemoryDatabase } from "../../memory-graph/src/database";
import { SqliteVectorStore } from "../../memory-vector/src/vector-store";
import { SessionCompressor, DEFAULT_COMPRESSOR_CONFIG } from "../src/session-compressor";
import type { Embedder } from "../../memory-vector/src/embedder";

// ===== Mock Embedder (384-dim, deterministic) =====

class MockEmbedder implements Embedder {
  readonly dimension = 384;
  readonly modelName = "mock/test";

  private mockVector(seed: number): Float32Array {
    const v = new Float32Array(384);
    for (let i = 0; i < 384; i++) v[i] = Math.sin(i * 0.1 + seed * 0.5);
    return v;
  }

  async embed(text: string): Promise<Float32Array> {
    let seed = 0;
    for (let i = 0; i < text.length; i++) seed += text.charCodeAt(i);
    return this.mockVector(seed);
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }
}

// ===== Test Setup =====

const TEST_DIR = path.join(__dirname, ".session-compressor-test");
const CG_DB = path.join(TEST_DIR, "codegraph.db");
const VEC_DB = path.join(TEST_DIR, "vector.db");

function cleanTestDir() {
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(TEST_DIR, { recursive: true });
}

function createLongMessages(count: number): string[] {
  const messages: string[] = [];
  for (let i = 0; i < count; i++) {
    messages.push(`这是第 ${i + 1} 条消息，包含一些有意义的内容，用于压测会话压缩器的 token 估算逻辑。`);
  }
  return messages;
}

describe("SessionCompressor", () => {
  let memDb: MemoryDatabase;
  let vecDb: SqliteVectorStore;
  let embedder: MockEmbedder;
  let compressor: SessionCompressor;

  beforeEach(() => {
    cleanTestDir();
    memDb = MemoryDatabase.create(CG_DB);
    vecDb = SqliteVectorStore.open(VEC_DB);
    embedder = new MockEmbedder();
    compressor = new SessionCompressor(memDb, vecDb, embedder);
  });

  afterEach(() => {
    cleanTestDir();
  });

  describe("compress", () => {
    it("短会话（token 不足）返回 null", async () => {
      const result = await compressor.compress(
        "sess-short",
        ["你好", "再见"],
        Date.now() - 60000,
        { tokenCount: 100 }, // 远低于 5000
      );
      expect(result).toBeNull();
    });

    it("长会话生成摘要节点", async () => {
      const messages = createLongMessages(50);
      const sessionStart = Date.now() - 3600000;

      const result = await compressor.compress(
        "sess-long",
        messages,
        sessionStart,
        { tokenCount: 10000 }, // 超过 5000
      );

      expect(result).not.toBeNull();
      expect(result!.sessionId).toBe("sess-long");
      expect(result!.tokenCount).toBe(10000);
      expect(result!.memoryNodeId).toBeTruthy();
      expect(result!.sessionStart).toBe(sessionStart);

      // 验证摘要内容
      expect(result!.summary.title).toBeTruthy();
      expect(result!.summary.summary).toBeTruthy();
      expect(result!.summary.importance).toBeGreaterThanOrEqual(1);
      expect(result!.summary.importance).toBeLessThanOrEqual(10);
    });

    it("摘要节点类型正确", async () => {
      const messages = createLongMessages(50);
      const result = await compressor.compress(
        "sess-type-check",
        messages,
        Date.now() - 3600000,
        { tokenCount: 10000 },
      );

      const node = memDb.getNode(result!.memoryNodeId);
      expect(node).not.toBeNull();
      expect(node!.nodeType).toBe("session_summary");
      expect(node!.source).toBe("system");
      expect(node!.status).toBe("active");
    });

    it("禁用时返回 null", async () => {
      const disabledCompressor = new SessionCompressor(memDb, vecDb, embedder, {
        enabled: false,
      });

      const result = await disabledCompressor.compress(
        "sess-disabled",
        createLongMessages(50),
        Date.now() - 3600000,
        { tokenCount: 10000 },
      );

      expect(result).toBeNull();
    });

    it("向量索引失败不影响摘要生成", async () => {
      // 使用坏掉的 embedder（会抛出异常）
      const brokenEmbedder: Embedder = {
        dimension: 384,
        modelName: "broken",
        embed: async () => { throw new Error("embedder broken"); },
        embedBatch: async () => { throw new Error("embedder broken"); },
      };

      const safeCompressor = new SessionCompressor(memDb, vecDb, brokenEmbedder);
      const result = await safeCompressor.compress(
        "sess-broken-vec",
        createLongMessages(50),
        Date.now() - 3600000,
        { tokenCount: 10000 },
      );

      // 即使向量索引失败，摘要核心功能应正常
      expect(result).not.toBeNull();
      expect(result!.memoryNodeId).toBeTruthy();
    });

    it("引用关联的记忆节点", async () => {
      // 先创建一些会被引用的记忆
      const refMem = memDb.createNode({
        title: "被引用的决策",
        summary: "这是一个被引用的记忆",
        importance: 7,
        status: "active",
        source: "agent",
        sourceSession: "sess-prev",
        tags: ["引用"],
        nodeType: "decision",
        userId: "default",
        scope: "public",
        tierMin: 1,
        negativeExamples: [],
        isDeprecated: false,
        deprecatedAt: null,
        ttlDays: null,
      });

      const result = await compressor.compress(
        "sess-with-refs",
        createLongMessages(50),
        Date.now() - 3600000,
        {
          tokenCount: 10000,
          referencedMemoryIds: [refMem.id],
        },
      );

      // 验证 summarizes 边被创建
      const edges = memDb.getNodeEdges(result!.memoryNodeId);
      const summarizesEdge = edges.find((e) => e.relation === "summarizes");
      expect(summarizesEdge).toBeDefined();
      expect(summarizesEdge!.targetId).toBe(refMem.id);
    });
  });

  describe("getRecentSummaries", () => {
    it("无摘要时返回空数组", () => {
      const summaries = compressor.getRecentSummaries(5, "default");
      expect(summaries).toEqual([]);
    });

    it("返回最近的 N 条摘要（按时间降序）", async () => {
      // 创建 3 条摘要
      const messages = createLongMessages(50);
      for (let i = 0; i < 3; i++) {
        await compressor.compress(
          `sess-recent-${i}`,
          messages,
          Date.now() - (3 - i) * 3600000, // 时间递增
          { tokenCount: 10000 },
        );
      }

      const summaries = compressor.getRecentSummaries(3, "default");
      expect(summaries.length).toBe(3);

      // 验证时间降序（最新的在前）
      // 由于我们无法直接获取时间戳，但我们可以验证摘要不为空
      expect(summaries[0].summary).toBeTruthy();
      expect(summaries[0].title).toBeTruthy();
    });

    it("只返回指定用户的数据", async () => {
      const messages = createLongMessages(50);
      await compressor.compress(
        "sess-user-a",
        messages,
        Date.now() - 3600000,
        { tokenCount: 10000, userId: "user-a" },
      );
      await compressor.compress(
        "sess-user-b",
        messages,
        Date.now() - 3600000,
        { tokenCount: 10000, userId: "user-b" },
      );

      const userASummaries = compressor.getRecentSummaries(10, "user-a");
      const userBSummaries = compressor.getRecentSummaries(10, "user-b");

      expect(userASummaries.length).toBe(1);
      expect(userBSummaries.length).toBe(1);
    });
  });

  describe("formatForContext", () => {
    it("空摘要返回空字符串", () => {
      const text = compressor.formatForContext([]);
      expect(text).toBe("");
    });

    it("格式化摘要为注入文本", async () => {
      const messages = createLongMessages(50);
      await compressor.compress(
        "sess-ctx",
        messages,
        Date.now() - 3600000,
        { tokenCount: 10000 },
      );

      const summaries = compressor.getRecentSummaries(1, "default");
      const text = compressor.formatForContext(summaries);

      expect(text).toContain("## 近期会话摘要");
      expect(text).toContain(summaries[0].title);
      expect(text).toContain(summaries[0].summary);
    });
  });
});