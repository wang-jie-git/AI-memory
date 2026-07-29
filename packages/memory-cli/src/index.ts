#!/usr/bin/env node
/**
 * One Memory CLI — 记忆系统管理工具
 *
 * 用于 Phase 2 的日常维护操作：
 *   one-memory init        初始化（验证连接）
 *   one-memory write       写入测试条目
 *   one-memory query       混合查询
 *   one-memory stats       查看统计
 *   one-memory prune       执行剪枝
 *   one-memory check       一致性检查
 *   one-memory rebuild     重建向量索引
 */

import * as path from "node:path";

const HOME = process.env.HOME || "/Users/mac";

function getDefaultDbPath(): string {
  return path.join(HOME, "Library", "Application Support", "@one", "electron", ".codegraph");
}

const COMMANDS = `
用法: npx tsx src/index.ts <command> [options]

命令:
  init [--db-path=<path>]     初始化并验证连接
  write <title> [--summary=]  写入一条测试记忆
  query <text>                混合查询
  stats [--db-path=<path>]    查看系统统计
  prune [--dry-run]           执行图剪枝
  check [--db-path=<path>]    一致性检查
  rebuild [--db-path=<path>]  重建向量索引
  help                        显示帮助

默认 DB 路径: ${getDefaultDbPath()}
`;

function parseArgs() {
  const args = process.argv.slice(2);
  const cmd = args[0] || "help";
  const kwargs: Record<string, string> = {};
  const positional: string[] = [];

  for (const arg of args.slice(1)) {
    if (arg.startsWith("--")) {
      const eqIdx = arg.indexOf("=");
      if (eqIdx > 0) {
        kwargs[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1);
      } else {
        kwargs[arg.slice(2)] = "true";
      }
    } else {
      positional.push(arg);
    }
  }

  return { cmd, kwargs, positional };
}

async function main() {
  const { cmd, kwargs, positional } = parseArgs();

  const dbPath = kwargs["db-path"] || getDefaultDbPath();

  switch (cmd) {
    case "init": {
      console.log("🔌 Initializing MemorySystem...\n");
      const { MemorySystem } = await import("../../memory-orchestrator/src/memory-system");
      const sys = await MemorySystem.init({
        codegraphDir: dbPath,
        embedder: "local",
        obsidianVaultPath: path.join(HOME, "Documents/ObsidianVault"),
        obsidianSubDir: "2.项目/One Platform/1.Agent_Memory",
        writeBufferSize: 5,
      });

      const stats = sys.stats();
      console.log(`  ✅ 图数据库:   ${stats.graph.totalNodes} 节点, ${stats.graph.totalEdges} 边`);
      console.log(`  ✅ 向量存储:   ${stats.vector.total} 条, ${stats.vector.dimension} 维`);
      console.log(`  ✅ Obsidian:   ${stats.obsidian} 笔记`);
      console.log(`  ✅ 缓冲待写:   ${stats.bufferPending} 条`);

      await sys.shutdown();
      break;
    }

    case "write": {
      const title = positional[0] || "CLI 测试记忆";
      const { MemorySystem } = await import("./memory-system");
      const sys = await MemorySystem.init({
        codegraphDir: dbPath,
        embedder: "local",
        obsidianVaultPath: path.join(HOME, "Documents/ObsidianVault"),
        obsidianSubDir: "2.项目/One Platform/1.Agent_Memory",
      });

      const node = await sys.write({
        title,
        summary: kwargs["summary"] || `通过 CLI 写入: ${title}`,
        importance: Number(kwargs["importance"] || 5),
        tags: (kwargs["tags"] || "").split(",").filter(Boolean),
        source: "system",
      });

      console.log(`  ✍️  已写入: ${node.id.slice(0, 8)} — "${node.title}"`);
      await sys.shutdown();
      break;
    }

    case "query": {
      const text = positional.join(" ") || "memory";
      const { MemorySystem } = await import("./memory-system");
      const sys = await MemorySystem.init({
        codegraphDir: dbPath,
        embedder: "local",
      });

      console.log(`\n🔍 查询: "${text}"\n`);
      const result = await sys.query(text, kwargs["min-importance"]
        ? { importanceMin: Number(kwargs["min-importance"]) }
        : undefined);

      const { results, telemetry } = result;
      console.log(`  耗时: ${telemetry.totalTimeMs}ms (vec=${telemetry.vectorTimeMs}ms, graph=${telemetry.graphTimeMs}ms)`);
      console.log(`  降级: ${telemetry.degraded}`);
      console.log(`  返回: ${results.length}/${telemetry.candidatesCount} 条\n`);

      if (results.length === 0) {
        console.log("  (无结果)");
      } else {
        for (let i = 0; i < results.length; i++) {
          const r = results[i];
          console.log(`  ${i + 1}. [${r.score.toFixed(3)}] ${r.title}`);
          console.log(`     vec=${r.vectorScore.toFixed(3)} graph=${r.graphScore.toFixed(3)} recency=${r.recencyScore.toFixed(3)}`);
          console.log(`     ${r.summary.slice(0, 100)}`);
          if (r.relations.length > 0) {
            console.log(`     → ${r.relations.map((rel) => `${rel.type} (${rel.direction})`).join(", ")}`);
          }
          console.log("");
        }
      }

      await sys.shutdown();
      break;
    }

    case "stats": {
      const { MemorySystem } = await import("./memory-system");
      const sys = await MemorySystem.init({
        codegraphDir: dbPath,
        embedder: "local",
        obsidianVaultPath: path.join(HOME, "Documents/ObsidianVault"),
        obsidianSubDir: "2.项目/One Platform/1.Agent_Memory",
      });

      const s = sys.stats();
      console.log("\n📊 One Memory 系统统计\n");
      console.log(`  图数据库:`);
      console.log(`    节点:      ${s.graph.totalNodes}`);
      console.log(`    边:        ${s.graph.totalEdges}`);
      console.log(`    代码关联:  ${s.graph.codeLinked}`);
      console.log(`    按类型:    ${JSON.stringify(s.graph.byType)}`);
      console.log(`    按状态:    ${JSON.stringify(s.graph.byStatus)}`);
      console.log(`  向量存储:`);
      console.log(`    条目:      ${s.vector.total}`);
      console.log(`    维度:      ${s.vector.dimension}`);
      console.log(`  Obsidian:`);
      console.log(`    笔记:      ${s.obsidian}`);
      console.log(`  缓冲:`);
      console.log(`    待写:      ${s.bufferPending}`);

      await sys.shutdown();
      break;
    }

    case "prune": {
      const { MemorySystem } = await import("./memory-system");
      const sys = await MemorySystem.init({
        codegraphDir: dbPath,
        embedder: "local",
      });

      const dryRun = kwargs["dry-run"] !== "false" && kwargs["dry-run"] !== "no";
      const result = sys.prune({ dryRun });

      if (dryRun) {
        console.log(`\n✂️  剪枝预览 (dry-run):\n`);
        console.log(`  待删除:  ${result.deleted} 条过期`);
        console.log(`  待归档:  ${result.archived} 条低重要度`);
        console.log(`\n  执行正式剪枝: one-memory prune --dry-run=false`);
      } else {
        console.log(`\n✂️  剪枝完成:\n`);
        console.log(`  已删除:  ${result.deleted} 条`);
        console.log(`  已归档:  ${result.archived} 条`);
      }

      await sys.shutdown();
      break;
    }

    case "check": {
      const { MemorySystem } = await import("./memory-system");
      const sys = await MemorySystem.init({
        codegraphDir: dbPath,
        embedder: "local",
      });

      const result = sys.checkConsistency();
      console.log("\n✅ 一致性检查\n");
      console.log(`  图数据库:   ${result.inGraph} 节点`);
      console.log(`  向量存储:   ${result.inVector} 条`);
      console.log(`  状态:       ${result.ok ? "✅ 一致" : "⚠️  不一致 (差异 > 10)"}`);

      if (result.graphOnly.length > 0) {
        console.log(`  仅在图库:  ${result.graphOnly.join(", ")}`);
      }

      await sys.shutdown();
      break;
    }

    case "rebuild": {
      console.log("\n🔄 重建向量索引...\n");
      const { MemorySystem } = await import("./memory-system");
      const sys = await MemorySystem.init({
        codegraphDir: dbPath,
        embedder: "local",
      });

      const count = await sys.rebuildVectorIndex();
      console.log(`  ✅ 已重建 ${count} 条向量索引`);
      await sys.shutdown();
      break;
    }

    case "help":
    default:
      console.log(COMMANDS);
  }
}

main().catch((err) => {
  console.error("\n❌ Error:", err.message);
  process.exit(1);
});
