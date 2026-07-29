/**
 * Nudge Engine 测试 — 主动记忆提示系统
 *
 * RFC-06 Phase B 实现验证。
 * 测试场景：
 *   1. 空记忆 → 空建议
 *   2. 高重要性记忆 → complex_task nudge
 *   3. 有 body 无 summary → knowledge_gap
 *   4. system/session_summary 节点被跳过
 *   5. 重复模式检测 (analyzeRecent)
 *   6. updateOptions 动态调整
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { MemoryDatabase } from "../src/database";
import { NudgeEngine } from "../src/nudge-engine";

const TEST_DIR = path.join(__dirname, ".nudge-test");
const CG_DB = path.join(TEST_DIR, "codegraph.db");

function cleanTestDir() {
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(TEST_DIR, { recursive: true });
}

describe("NudgeEngine", () => {
  let db: MemoryDatabase;
  let engine: NudgeEngine;

  beforeEach(() => {
    cleanTestDir();
    db = MemoryDatabase.create(CG_DB);
    engine = new NudgeEngine(db);
  });

  afterEach(() => {
    cleanTestDir();
  });

  describe("onMemoryWritten", () => {
    it("空记忆列表返回空数组", () => {
      const suggestions = engine.onMemoryWritten([]);
      expect(suggestions).toEqual([]);
    });

    it("高重要性记忆触发 complex_task nudge", () => {
      const mem = db.createNode({
        title: "支付模块重构完成",
        summary: "支付模块从单体拆分微服务，核心交易延迟降低 60%",
        importance: 8,
        status: "active",
        source: "agent",
        sourceSession: "sess-1",
        tags: ["支付", "重构"],
        nodeType: "decision",
        userId: "default",
        scope: "public",
        tierMin: 1,
        negativeExamples: [],
        isDeprecated: false,
        deprecatedAt: null,
        ttlDays: null,
      });

      const suggestions = engine.onMemoryWritten([mem]);

      // 应该有 complex_task 建议
      const taskNudge = suggestions.find((s) => s.reason === "complex_task");
      expect(taskNudge).toBeDefined();
      expect(taskNudge!.confidence).toBeGreaterThanOrEqual(0.5);
      expect(taskNudge!.action).toBe("write_memory");
      expect(taskNudge!.triggeredBy).toContain(mem.id);
    });

    it("低重要性记忆不触发 complex_task", () => {
      const mem = db.createNode({
        title: "小笔记",
        summary: "日常记录",
        importance: 3,
        status: "active",
        source: "agent",
        sourceSession: "sess-1",
        tags: ["日常"],
        nodeType: "memory_entry",
        userId: "default",
        scope: "public",
        tierMin: 1,
        negativeExamples: [],
        isDeprecated: false,
        deprecatedAt: null,
        ttlDays: null,
      });

      const suggestions = engine.onMemoryWritten([mem]);
      const taskNudge = suggestions.find((s) => s.reason === "complex_task");
      expect(taskNudge).toBeUndefined();
    });

    it("有 body 无 summary 的记忆触发 knowledge_gap", () => {
      const mem = db.createNode({
        title: "冗长记录",
        summary: "短", // 太短
        body: "x".repeat(200), // 但 body 很长
        importance: 5,
        status: "active",
        source: "agent",
        sourceSession: "sess-1",
        tags: ["测试"],
        nodeType: "memory_entry",
        userId: "default",
        scope: "public",
        tierMin: 1,
        negativeExamples: [],
        isDeprecated: false,
        deprecatedAt: null,
        ttlDays: null,
      });

      const suggestions = engine.onMemoryWritten([mem]);
      const gapNudge = suggestions.find((s) => s.reason === "knowledge_gap");
      expect(gapNudge).toBeDefined();
      expect(gapNudge!.action).toBe("update_memory");
    });

    it("system 来源和 session_summary 节点被跳过", () => {
      const systemMem = db.createNode({
        title: "系统节点",
        summary: "自动生成的系统记录",
        importance: 8,
        status: "active",
        source: "system",
        sourceSession: "sess-1",
        tags: ["system"],
        nodeType: "memory_entry",
        userId: "default",
        scope: "public",
        tierMin: 1,
        negativeExamples: [],
        isDeprecated: false,
        deprecatedAt: null,
        ttlDays: null,
      });

      const summaryMem = db.createNode({
        title: "会话摘要",
        summary: "三次对话的摘要",
        importance: 7,
        status: "active",
        source: "agent",
        sourceSession: "sess-1",
        tags: ["session_summary"],
        nodeType: "session_summary" as any,
        userId: "default",
        scope: "public",
        tierMin: 1,
        negativeExamples: [],
        isDeprecated: false,
        deprecatedAt: null,
        ttlDays: null,
      });

      const suggestions = engine.onMemoryWritten([systemMem, summaryMem]);
      // system 节点的 complex_task 应该被跳过
      const systemNudge = suggestions.find((s) => s.triggeredBy.includes(systemMem.id));
      expect(systemNudge).toBeUndefined();
      // session_summary 节点的 complex_task 应该被跳过
      const summaryNudge = suggestions.find((s) => s.triggeredBy.includes(summaryMem.id));
      expect(summaryNudge).toBeUndefined();
    });

    it("同一条记忆的重复 nudge 被去重", () => {
      const mem = db.createNode({
        title: "修复高重要性 Bug",
        summary: "修复了 CoreEngine 的竞态问题",
        importance: 9,
        status: "active",
        source: "agent",
        sourceSession: "sess-1",
        tags: ["bug", "修复"],
        nodeType: "decision",
        userId: "default",
        scope: "public",
        tierMin: 1,
        negativeExamples: [],
        isDeprecated: false,
        deprecatedAt: null,
        ttlDays: null,
      });

      // 两次调用应返回相同数量的建议
      const first = engine.onMemoryWritten([mem]);
      const second = engine.onMemoryWritten([mem]);
      expect(first.length).toBe(second.length);
    });
  });

  describe("analyzeRecent", () => {
    it("无近期记忆返回空数组", () => {
      const suggestions = engine.analyzeRecent(1);
      expect(suggestions).toEqual([]);
    });

    it("同一标签多次出现触发 repeated_pattern", () => {
      const now = Date.now();
      // 创建 3 条同一标签的记忆，时间在 1 小时内
      for (let i = 0; i < 3; i++) {
        db.createNode({
          title: `支付修复 #${i + 1}`,
          summary: `支付模块问题修复记录 ${i + 1}`,
          importance: 6,
          status: "active",
          source: "agent",
          sourceSession: `sess-pay-${i}`,
          tags: ["支付", "bug"],
          nodeType: "memory_entry",
          userId: "default",
          scope: "public",
          tierMin: 1,
          negativeExamples: [],
          isDeprecated: false,
          deprecatedAt: null,
          ttlDays: null,
        });
      }

      const suggestions = engine.analyzeRecent(24);
      const patternNudge = suggestions.find((s) => s.reason === "repeated_pattern");
      expect(patternNudge).toBeDefined();
      expect(patternNudge!.confidence).toBeGreaterThanOrEqual(0.5);
    });
  });

  describe("updateOptions", () => {
    it("动态调整配置影响行为", () => {
      // 先禁用 complex_task
      engine.updateOptions({ enabledScenes: ["repeated_pattern"] });

      const mem = db.createNode({
        title: "高重要性任务",
        summary: "应该被忽略（因为 complex_task 被禁用）",
        importance: 9,
        status: "active",
        source: "agent",
        sourceSession: "sess-1",
        tags: ["测试"],
        nodeType: "memory_entry",
        userId: "default",
        scope: "public",
        tierMin: 1,
        negativeExamples: [],
        isDeprecated: false,
        deprecatedAt: null,
        ttlDays: null,
      });

      const suggestions = engine.onMemoryWritten([mem]);
      const taskNudge = suggestions.find((s) => s.reason === "complex_task");
      expect(taskNudge).toBeUndefined();

      // 恢复后应该能检测到
      engine.updateOptions({ enabledScenes: ["complex_task", "repeated_pattern", "error_revisit"] });
      const suggestions2 = engine.onMemoryWritten([mem]);
      const taskNudge2 = suggestions2.find((s) => s.reason === "complex_task");
      expect(taskNudge2).toBeDefined();
    });
  });
});