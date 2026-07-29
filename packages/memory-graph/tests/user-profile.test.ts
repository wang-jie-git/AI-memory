/**
 * User Profile Engine 测试 — 辩证用户建模
 *
 * RFC-06 Phase C 实现验证。
 * 测试场景：
 *   1. 新建观察 → 返回观察结果
 *   2. 同 domain 同内容重新观察 → 不创建矛盾
 *   3. 矛盾检测 → 不同内容触发 contradiction
 *   4. getProfile → 聚合所有观察
 *   5. 多用户隔离
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { MemoryDatabase } from "../src/database";
import { UserProfileEngine } from "../src/user-profile";

const TEST_DIR = path.join(__dirname, ".user-profile-test");
const CG_DB = path.join(TEST_DIR, "codegraph.db");

function cleanTestDir() {
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(TEST_DIR, { recursive: true });
}

describe("UserProfileEngine", () => {
  let db: MemoryDatabase;
  let engine: UserProfileEngine;

  beforeEach(() => {
    cleanTestDir();
    db = MemoryDatabase.create(CG_DB);
    engine = new UserProfileEngine(db);
  });

  afterEach(() => {
    cleanTestDir();
  });

  describe("observe", () => {
    it("新建观察返回正确结果", () => {
      const result = engine.observe("preference", "风格", "偏好简洁的代码", {
        confidence: 0.8,
        sourceSession: "sess-1",
        tags: ["coding-style"],
      });

      expect(result.observation).toBeDefined();
      expect(result.observation.type).toBe("preference");
      expect(result.observation.domain).toBe("风格");
      expect(result.observation.content).toBe("偏好简洁的代码");
      expect(result.observation.confidence).toBe(0.8);
      expect(result.contradictions).toEqual([]);
      expect(result.isNew).toBe(true);
    });

    it("同 domain 同内容不触发矛盾", () => {
      // 第一次观察
      engine.observe("preference", "风格", "偏好简洁的代码", {
        confidence: 0.8,
        sourceSession: "sess-1",
      });

      // 第二次相同内容，应该不触发矛盾
      const result = engine.observe("preference", "风格", "偏好简洁的代码", {
        confidence: 0.9,
        sourceSession: "sess-2",
      });

      expect(result.contradictions).toEqual([]);
      // isNew 应该为 false（因为已经存在同 domain 的同类型观察）
      // 但实际上 content 不同时才会触发矛盾检测，这里相同内容所以不矛盾
      expect(result.isNew).toBe(false);
    });

    it("矛盾检测：同一 domain 不同内容触发 contradiction", () => {
      // 第一次观察：偏好简洁
      const first = engine.observe("preference", "风格", "偏好简洁的代码", {
        confidence: 0.8,
        sourceSession: "sess-1",
      });

      // 第二次观察：矛盾内容
      const result = engine.observe("preference", "风格", "需要详细注释和说明", {
        confidence: 0.7,
        sourceSession: "sess-2",
      });

      // 应该检测到矛盾
      expect(result.contradictions.length).toBe(1);
      expect(result.contradictions[0].existing.content).toBe("偏好简洁的代码");
      expect(result.contradictions[0].message).toContain("→");

      // 验证 contradicts 边被创建
      const edges = db.getNodeEdges(result.observation.id);
      const contradictsEdge = edges.find((e) => e.relation === "contradicts");
      expect(contradictsEdge).toBeDefined();
      expect(contradictsEdge!.targetId).toBe(first.observation.id);
    });

    it("低置信度观察不触发矛盾", () => {
      // 第一次观察
      engine.observe("preference", "风格", "偏好简洁的代码", {
        confidence: 0.8,
        sourceSession: "sess-1",
      });

      // 低置信度矛盾内容 — 不应触发矛盾
      const result = engine.observe("preference", "风格", "偏好非常详细的文档", {
        confidence: 0.2, // 低置信度
        sourceSession: "sess-2",
      });

      // 低置信度不应触发矛盾
      expect(result.contradictions.length).toBe(0);
    });

    it("默认置信度为 0.7", () => {
      const result = engine.observe("behavior", "通信", "偏好文字沟通");

      expect(result.observation.confidence).toBe(0.7);
      expect(result.observation.tags).toContain("user_profile");
      expect(result.observation.tags).toContain("behavior");
      expect(result.observation.tags).toContain("通信");
    });
  });

  describe("getProfile", () => {
    it("无观察时返回空画像", () => {
      const profile = engine.getProfile("default");
      expect(profile.userId).toBe("default");
      expect(profile.traits).toEqual([]);
      expect(profile.observations).toEqual([]);
      expect(profile.contradictionCount).toBe(0);
    });

    it("聚合多个 domain 的观察", () => {
      // 观察多个 domain
      engine.observe("preference", "风格", "偏好简洁", {
        sourceSession: "sess-1",
      });
      engine.observe("preference", "通信", "偏好异步沟通", {
        sourceSession: "sess-1",
      });
      engine.observe("skill", "Python", "熟悉 FastAPI", {
        sourceSession: "sess-2",
      });

      const profile = engine.getProfile("default");
      // 应该有 3 条观察
      expect(profile.observations.length).toBe(3);
      // 应该有 3 个 trait（每个 domain 一个）
      expect(profile.traits.length).toBe(3);

      // 验证 trait 内容（domain 格式为 "type:domain"）
      const styleTrait = profile.traits.find((t) => t.domain === "preference:风格");
      expect(styleTrait).toBeDefined();
      expect(styleTrait!.current).toBe("偏好简洁");

      const commTrait = profile.traits.find((t) => t.domain === "preference:通信");
      expect(commTrait).toBeDefined();
      expect(commTrait!.current).toBe("偏好异步沟通");
    });

    it("矛盾的 domain 标记 hasContradiction", () => {
      // 先观察一个
      engine.observe("preference", "风格", "偏好简洁", {
        sourceSession: "sess-1",
      });

      // 矛盾观察
      engine.observe("preference", "风格", "偏好详细说明", {
        sourceSession: "sess-2",
      });

      const profile = engine.getProfile("default");
      const styleTrait = profile.traits.find((t) => t.domain === "preference:风格");
      expect(styleTrait).toBeDefined();
      expect(styleTrait!.hasContradiction).toBe(true);
      expect(styleTrait!.contradictions.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("多租户隔离", () => {
    it("不同用户的观察互不干扰", () => {
      // user1 的观察
      engine.observe("preference", "风格", "偏好简洁", {
        userId: "user-1",
      });

      // user2 的观察
      engine.observe("preference", "风格", "偏好详细", {
        userId: "user-2",
      });

      const profile1 = engine.getProfile("user-1");
      const profile2 = engine.getProfile("user-2");

      expect(profile1.observations.length).toBe(1);
      expect(profile1.observations[0].content).toBe("偏好简洁");

      expect(profile2.observations.length).toBe(1);
      expect(profile2.observations[0].content).toBe("偏好详细");
    });
  });
});