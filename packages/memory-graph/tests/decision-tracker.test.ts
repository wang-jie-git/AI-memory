/**
 * DecisionTracker 测试
 */

import { MemoryDatabase } from "../src/database";
import { DecisionTracker } from "../src/decision-tracker";
import * as path from "node:path";
import * as fs from "node:fs";

const CG_DB = path.join(__dirname, "..", "..", "..", ".codegraph", "decision-test.db");

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(`❌ ${msg}`);
  console.log(`  ✅ ${msg}`);
}

async function runTests() {
  console.log("\n📋 DecisionTracker 测试\n");

  // Cleanup
  for (const p of [CG_DB, CG_DB+"-wal", CG_DB+"-shm"]) { try { fs.unlinkSync(p); } catch {} }

  const db = MemoryDatabase.create(CG_DB);
  const tracker = new DecisionTracker(db);

  // ── Test 1: Record a decision ──
  console.log("📝 Test 1: Record a structured decision");

  const decision = tracker.recordDecision({
    title: "熔断器阈值调整",
    context: "支付模块在高峰时段频繁触发熔断，影响用户体验",
    options: [
      {
        name: "方案A: 阈值从5改为10",
        description: "将 CircuitBreaker 阈值从 5 提升到 10",
        pros: ["简单修改，风险低", "短期见效快"],
        cons: ["治标不治本", "极端流量仍可能触发"],
      },
      {
        name: "方案B: 改为自适应阈值",
        description: "根据历史流量动态调整熔断阈值",
        pros: ["长期最优解", "适应性强"],
        cons: ["实现复杂", "需要两周开发时间"],
      },
    ],
    chosen: "方案A: 阈值从5改为10",
    rationale: "当前需要快速修复生产问题，方案A 2小时可上线。方案B 后续迭代。",
    tags: ["熔断器", "支付", "性能"],
    source: "agent",
    importance: 8,
  });

  assert(decision.nodeId.length > 0, "Decision node created");
  assert(decision.chosen === "方案A: 阈值从5改为10", "Chosen option recorded");
  assert(decision.options.length === 2, "Two options recorded");
  assert(decision.outcome === "pending", "Initial outcome is pending");
  console.log(`  Decision: "${decision.title}" (${decision.nodeId.slice(0, 8)})`);
  console.log(`  Options: ${decision.options.map((o) => o.name).join(" | ")}`);
  console.log(`  Chosen: ${decision.chosen}`);

  // ── Test 2: Update outcome ──
  console.log("\n✅ Test 2: Update decision outcome");

  const updated = tracker.updateOutcome(decision.nodeId, "success", "熔断触发频率降低 80%，无新增问题");
  assert(updated, "Outcome updated");

  const allDecisions = tracker.getAllDecisions();
  const found = allDecisions.find((d) => d.nodeId === decision.nodeId);
  assert(found?.outcome === "success", "Outcome changed to success");
  assert(found?.outcomeEvidence?.includes("80%"), "Evidence preserved");
  console.log(`  Outcome: ${found?.outcome} — ${found?.outcomeEvidence?.slice(0, 50)}...`);

  // ── Test 3: Track a failed decision ──
  console.log("\n❌ Test 3: Failed decision");

  const failedDecision = tracker.recordDecision({
    title: "从 Redis 迁移到 Memcached",
    context: "缓存层性能瓶颈分析",
    options: [
      { name: "Redis Cluster", description: "Redis 集群方案", pros: ["成熟"], cons: ["运维复杂"] },
      { name: "Memcached", description: "Memcached 方案", pros: ["简单"], cons: ["功能少"] },
    ],
    chosen: "Memcached",
    rationale: "当前需求简单，Memcached 足够",
    tags: ["缓存", "架构"],
  });
  tracker.updateOutcome(failedDecision.nodeId, "failure", "Memcached 不支持复杂数据结构，3天后切回 Redis");

  const failed = tracker.getAllDecisions("failure");
  assert(failed.length === 1, "1 failed decision");
  assert(failed[0].nodeId === failedDecision.nodeId, "Correct failed decision");
  console.log(`  Failed: ${failed[0].title} — ${failed[0].outcomeEvidence}`);

  // ── Test 4: Generate report ──
  console.log("\n📄 Test 4: Generate decision report");

  const report = tracker.generateReport();
  assert(report.includes("决策回溯报告"), "Report header present");
  assert(report.includes("成功的决策"), "Success section in report");
  assert(report.includes("熔断器阈值调整"), "Successful decision in report");
  assert(report.includes("失败的决策"), "Failure section in report");
  assert(report.includes("Memcached"), "Failed decision in report");
  assert(report.includes("成功: 1"), "Counter correct");
  console.log(`  Report length: ${report.length} chars`);

  // ── Test 5: Link decision to related memories ──
  console.log("\n🔗 Test 5: Link decision to related memory");

  const relatedNode = db.createNode({
    title: "支付模块超时监控",
    summary: "Webhook 响应时间监控配置",
    importance: 6, status: "active", source: "system",
    tags: ["支付", "监控"], nodeType: "memory_entry", ttlDays: null,
  });

  tracker.linkDecision(decision.nodeId, relatedNode.id, "implements");
  const related = db.getRelatedMemories(decision.nodeId);
  assert(related.length > 0, "Decision has related memories");
  console.log(`  Related memory: ${related[0].node.title} (${related[0].relation})`);

  // ── Test 6: Record decision with procedure ──
  console.log("\n📋 Test 6: Record decision with procedure");

  const procDecision = tracker.recordDecision({
    title: "熔断器阈值调整操作步骤",
    context: "支付模块高峰时段频繁熔断",
    options: [
      { name: "方案A", description: "阈值从5改为10", pros: ["简单"], cons: ["治标"] },
      { name: "方案B", description: "自适应阈值", pros: ["长期"], cons: ["复杂"] },
    ],
    chosen: "方案A",
    rationale: "快速修复",
    procedure: `1. 打开支付模块 CircuitBreaker 配置
  2. 将 failureThreshold 从 5 改为 10
  3. 将 resetTimeout 从 30000 改为 60000
  4. 部署到生产环境（灰度 10% 观察 10 分钟）
  5. 观察监控面板，确认熔断触发频率降低
  6. 全量发布`,
    tags: ["熔断器", "支付", "操作手册"],
  });

  assert(procDecision.procedure !== null, "Procedure stored");
  assert(procDecision.procedure!.includes("failureThreshold"), "Procedure content preserved");
  console.log(`  Procedure stored (${procDecision.procedure!.length} chars)`);

  // ── Test 7: findProcedures search ──
  console.log("\n🔍 Test 7: findProcedures search");

  const results = tracker.findProcedures("熔断器");
  assert(results.length >= 1, "At least 1 procedure found");
  assert(results[0].procedure !== null, "First result has procedure");
  assert(results[0].procedure!.includes("failureThreshold"), "Procedure content matches");
  console.log(`  Found ${results.length} procedure(s)`);
  console.log(`  First: "${results[0].title}" (${results[0].procedure!.slice(0, 60)}...)`);

  // ── Test 8: findProcedures returns empty for no match ──
  console.log("\n🔍 Test 8: findProcedures no match");

  const empty = tracker.findProcedures("不存在的查询");
  assert(empty.length === 0, "Empty result when no match");
  console.log(`  No results as expected`);

  // Cleanup
  db.close();
  for (const p of [CG_DB, CG_DB+"-wal", CG_DB+"-shm"]) { try { fs.unlinkSync(p); } catch {} }

  console.log(`\n🎉 All DecisionTracker tests passed!`);
}

runTests().catch((err) => {
  console.error("\n❌ Test failed:", err.message);
  process.exit(1);
});
