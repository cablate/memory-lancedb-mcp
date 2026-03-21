#!/usr/bin/env node
/**
 * memory-lancedb-mcp — MCP server for LanceDB-backed long-term memory
 *
 * Standalone MCP server providing hybrid retrieval (Vector + BM25),
 * cross-encoder rerank, multi-scope isolation, and memory lifecycle management.
 *
 * Usage:
 *   npx memory-lancedb-mcp                         # stdio transport
 *   EMBEDDING_API_KEY=sk-... npx memory-lancedb-mcp
 *   MEMORY_LANCEDB_CONFIG=./config.json npx memory-lancedb-mcp
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { loadConfig, type McpConfig } from "./config.js";
import { MemoryStore, validateStoragePath } from "./src/store.js";
import { createEmbedder, getVectorDimensions, type Embedder } from "./src/embedder.js";
import { createRetriever, type MemoryRetriever, type RetrievalResult } from "./src/retriever.js";
import { createScopeManager, type MemoryScopeManager } from "./src/scopes.js";
import { createDecayEngine } from "./src/decay-engine.js";
// tier-manager is optional; the retriever works without it
import { isNoise } from "./src/noise-filter.js";
import {
  buildSmartMetadata,
  deriveFactKey,
  parseSmartMetadata,
  stringifySmartMetadata,
  appendRelation,
} from "./src/smart-metadata.js";
import { TEMPORAL_VERSIONED_CATEGORIES } from "./src/memory-categories.js";
import { getDisplayCategoryTag } from "./src/reflection-metadata.js";
import {
  filterUserMdExclusiveRecallResults,
  isUserMdExclusiveMemory,
  type WorkspaceBoundaryConfig,
} from "./src/workspace-boundary.js";
import { appendSelfImprovementEntry, ensureSelfImprovementLearningFiles } from "./src/self-improvement-files.js";
import { join } from "node:path";
import { readFile, mkdir, writeFile } from "node:fs/promises";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MEMORY_CATEGORIES = ["preference", "fact", "decision", "entity", "skill", "other"] as const;

function clamp01(v: number, fallback: number): number {
  const n = Number.isFinite(v) ? v : fallback;
  return Math.max(0, Math.min(1, n));
}

function clampInt(v: number, min: number, max: number): number {
  const n = Number.isFinite(v) ? v : min;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function retrieveWithRetry(
  retriever: MemoryRetriever,
  ctx: Parameters<MemoryRetriever["retrieve"]>[0]
): Promise<RetrievalResult[]> {
  let results = await retriever.retrieve(ctx);
  if (results.length === 0) {
    await sleep(75);
    results = await retriever.retrieve(ctx);
  }
  return results;
}

function sanitizeForSerialization(results: RetrievalResult[]) {
  return results.map((r) => ({
    id: r.entry.id,
    text: r.entry.text,
    category: r.entry.category,
    scope: r.entry.scope,
    importance: r.entry.importance,
    timestamp: r.entry.timestamp,
    score: r.score,
    sources: r.sources,
  }));
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

// ---------------------------------------------------------------------------
// Server context
// ---------------------------------------------------------------------------

interface ServerContext {
  store: MemoryStore;
  embedder: Embedder;
  retriever: MemoryRetriever;
  scopeManager: MemoryScopeManager;
  workspaceBoundary?: WorkspaceBoundaryConfig;
  config: McpConfig;
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const CORE_TOOLS = [
  {
    name: "memory_recall",
    description:
      "Search through long-term memories using hybrid retrieval (vector + keyword search). Use when you need context about user preferences, past decisions, or previously discussed topics.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search query for finding relevant memories" },
        limit: { type: "number", description: "Max results to return (default: 5, max: 20)" },
        scope: { type: "string", description: "Specific memory scope to search in (optional)" },
        category: { type: "string", enum: MEMORY_CATEGORIES, description: "Filter by category" },
      },
      required: ["query"],
    },
  },
  {
    name: "memory_store",
    description:
      "Save important information in long-term memory. Use for preferences, facts, decisions, and other notable information.",
    inputSchema: {
      type: "object" as const,
      properties: {
        text: { type: "string", description: "Information to remember" },
        importance: { type: "number", description: "Importance score 0-1 (default: 0.7)" },
        category: { type: "string", enum: MEMORY_CATEGORIES, description: "Memory category" },
        scope: { type: "string", description: "Memory scope (optional, defaults to default scope)" },
      },
      required: ["text"],
    },
  },
  {
    name: "memory_forget",
    description: "Delete specific memories. Supports both search-based and direct ID-based deletion.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search query to find memory to delete" },
        memoryId: { type: "string", description: "Specific memory ID to delete" },
        scope: { type: "string", description: "Scope to search/delete from (optional)" },
      },
    },
  },
  {
    name: "memory_update",
    description:
      "Update an existing memory. For preferences/entities, changing text creates a new version (supersede) to preserve history. Metadata-only changes (importance, category) update in-place.",
    inputSchema: {
      type: "object" as const,
      properties: {
        memoryId: { type: "string", description: "ID of the memory to update (full UUID or 8+ char prefix)" },
        text: { type: "string", description: "New text content (triggers re-embedding)" },
        importance: { type: "number", description: "New importance score 0-1" },
        category: { type: "string", enum: MEMORY_CATEGORIES, description: "New category" },
      },
      required: ["memoryId"],
    },
  },
];

const MANAGEMENT_TOOLS = [
  {
    name: "memory_stats",
    description: "Get statistics about memory usage, scopes, and categories.",
    inputSchema: {
      type: "object" as const,
      properties: {
        scope: { type: "string", description: "Specific scope to get stats for (optional)" },
      },
    },
  },
  {
    name: "memory_list",
    description: "List recent memories with optional filtering by scope and category.",
    inputSchema: {
      type: "object" as const,
      properties: {
        limit: { type: "number", description: "Max memories to list (default: 10, max: 50)" },
        scope: { type: "string", description: "Filter by specific scope (optional)" },
        category: { type: "string", enum: MEMORY_CATEGORIES, description: "Filter by category" },
        offset: { type: "number", description: "Number of memories to skip (default: 0)" },
      },
    },
  },
];

const SELF_IMPROVEMENT_TOOLS = [
  {
    name: "self_improvement_log",
    description: "Log structured learning/error entries into .learnings for governance and later distillation.",
    inputSchema: {
      type: "object" as const,
      properties: {
        type: { type: "string", enum: ["learning", "error"], description: "Entry type" },
        summary: { type: "string", description: "One-line summary" },
        details: { type: "string", description: "Detailed context or error output" },
        suggestedAction: { type: "string", description: "Concrete action to prevent recurrence" },
        category: { type: "string", description: "learning category (correction/best_practice/knowledge_gap)" },
        area: { type: "string", description: "frontend|backend|infra|tests|docs|config or custom area" },
        priority: { type: "string", description: "low|medium|high|critical" },
      },
      required: ["type", "summary"],
    },
  },
  {
    name: "self_improvement_extract_skill",
    description: "Create a new skill scaffold from a learning entry and mark the source learning as promoted_to_skill.",
    inputSchema: {
      type: "object" as const,
      properties: {
        learningId: { type: "string", description: "Learning ID like LRN-YYYYMMDD-001" },
        skillName: { type: "string", description: "Skill folder name, lowercase with hyphens" },
        sourceFile: { type: "string", enum: ["LEARNINGS.md", "ERRORS.md"], description: "Source file" },
        outputDir: { type: "string", description: "Relative output dir under workspace (default: skills)" },
      },
      required: ["learningId", "skillName"],
    },
  },
  {
    name: "self_improvement_review",
    description: "Summarize governance backlog from .learnings files (pending/high-priority/promoted counts).",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
];

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

async function handleMemoryRecall(ctx: ServerContext, params: Record<string, unknown>) {
  const query = String(params.query || "");
  const limit = clampInt(Number(params.limit) || 5, 1, 20);
  const scope = params.scope as string | undefined;
  const category = params.category as string | undefined;

  let scopeFilter = ctx.scopeManager.getAccessibleScopes("main");
  if (scope) {
    if (ctx.scopeManager.isAccessible(scope, "main")) {
      scopeFilter = [scope];
    } else {
      return textResult(`Access denied to scope: ${scope}`);
    }
  }

  const results = filterUserMdExclusiveRecallResults(
    await retrieveWithRetry(ctx.retriever, { query, limit, scopeFilter, category, source: "manual" }),
    ctx.workspaceBoundary
  );

  if (results.length === 0) {
    return textResult("No relevant memories found.");
  }

  // Update access metadata
  const now = Date.now();
  await Promise.allSettled(
    results.map((result) => {
      const meta = parseSmartMetadata(result.entry.metadata, result.entry);
      return ctx.store.patchMetadata(
        result.entry.id,
        {
          access_count: meta.access_count + 1,
          last_accessed_at: now,
        },
        scopeFilter
      );
    })
  );

  const text = results
    .map((r, i) => {
      const tag = getDisplayCategoryTag(r.entry);
      return `${i + 1}. [${r.entry.id}] [${tag}] ${r.entry.text}`;
    })
    .join("\n");

  return textResult(`Found ${results.length} memories:\n\n${text}`);
}

async function handleMemoryStore(ctx: ServerContext, params: Record<string, unknown>) {
  const text = String(params.text || "");
  const importance = clamp01(Number(params.importance) || 0.7, 0.7);
  const category = (params.category as string) || "other";
  const scope = (params.scope as string) || ctx.scopeManager.getDefaultScope("main");

  if (!ctx.scopeManager.isAccessible(scope, "main")) {
    return textResult(`Access denied to scope: ${scope}`);
  }

  if (isNoise(text)) {
    return textResult("Skipped: text detected as noise (greeting, boilerplate, or meta-question)");
  }

  if (isUserMdExclusiveMemory({ text }, ctx.workspaceBoundary)) {
    return textResult("Skipped: this fact belongs in USER.md, not plugin memory.");
  }

  const vector = await ctx.embedder.embedPassage(text);

  // Duplicate check
  let existing: Awaited<ReturnType<MemoryStore["vectorSearch"]>> = [];
  try {
    existing = await ctx.store.vectorSearch(vector, 1, 0.1, [scope], { excludeInactive: true });
  } catch {
    /* fail-open */
  }

  if (existing.length > 0 && existing[0].score > 0.98) {
    return textResult(`Similar memory already exists: "${existing[0].entry.text}"`);
  }

  const entry = await ctx.store.store({
    text,
    vector,
    importance,
    category: category as any,
    scope,
    metadata: stringifySmartMetadata(
      buildSmartMetadata(
        { text, category: category as any, importance },
        { l0_abstract: text, l1_overview: `- ${text}`, l2_content: text }
      )
    ),
  });

  return textResult(`Stored: "${text.slice(0, 100)}${text.length > 100 ? "..." : ""}" in scope '${scope}'`);
}

async function handleMemoryForget(ctx: ServerContext, params: Record<string, unknown>) {
  const query = params.query as string | undefined;
  const memoryId = params.memoryId as string | undefined;
  const scope = params.scope as string | undefined;

  let scopeFilter = ctx.scopeManager.getAccessibleScopes("main");
  if (scope) {
    if (ctx.scopeManager.isAccessible(scope, "main")) {
      scopeFilter = [scope];
    } else {
      return textResult(`Access denied to scope: ${scope}`);
    }
  }

  if (memoryId) {
    const deleted = await ctx.store.delete(memoryId, scopeFilter);
    return deleted
      ? textResult(`Memory ${memoryId} forgotten.`)
      : textResult(`Memory ${memoryId} not found or access denied.`);
  }

  if (query) {
    const results = await retrieveWithRetry(ctx.retriever, { query, limit: 5, scopeFilter });

    if (results.length === 0) return textResult("No matching memories found.");

    if (results.length === 1 && results[0].score > 0.9) {
      const deleted = await ctx.store.delete(results[0].entry.id, scopeFilter);
      if (deleted) return textResult(`Forgotten: "${results[0].entry.text}"`);
    }

    const list = results
      .map((r) => `- [${r.entry.id.slice(0, 8)}] ${r.entry.text.slice(0, 60)}${r.entry.text.length > 60 ? "..." : ""}`)
      .join("\n");
    return textResult(`Found ${results.length} candidates. Specify memoryId to delete:\n${list}`);
  }

  return textResult("Provide either 'query' to search for memories or 'memoryId' to delete specific memory.");
}

async function handleMemoryUpdate(ctx: ServerContext, params: Record<string, unknown>) {
  const memoryId = String(params.memoryId || "");
  const text = params.text as string | undefined;
  const importance = params.importance !== undefined ? Number(params.importance) : undefined;
  const category = params.category as string | undefined;

  if (!text && importance === undefined && !category) {
    return textResult("Nothing to update. Provide at least one of: text, importance, category.");
  }

  const scopeFilter = ctx.scopeManager.getAccessibleScopes("main");

  // Resolve memoryId
  let resolvedId = memoryId;
  const uuidLike = /^[0-9a-f]{8}(-[0-9a-f]{4}){0,4}/i.test(memoryId);
  if (!uuidLike) {
    const results = await retrieveWithRetry(ctx.retriever, { query: memoryId, limit: 3, scopeFilter });
    if (results.length === 0) return textResult(`No memory found matching "${memoryId}".`);
    if (results.length === 1 || results[0].score > 0.85) {
      resolvedId = results[0].entry.id;
    } else {
      const list = results
        .map(
          (r) => `- [${r.entry.id.slice(0, 8)}] ${r.entry.text.slice(0, 60)}${r.entry.text.length > 60 ? "..." : ""}`
        )
        .join("\n");
      return textResult(`Multiple matches. Specify memoryId:\n${list}`);
    }
  }

  // Re-embed if text changed
  let newVector: number[] | undefined;
  if (text) {
    if (isNoise(text)) return textResult("Skipped: updated text detected as noise");
    newVector = await ctx.embedder.embedPassage(text);
  }

  // Temporal supersede guard
  if (text && newVector) {
    const existing = await ctx.store.getById(resolvedId, scopeFilter);
    if (existing) {
      const meta = parseSmartMetadata(existing.metadata, existing);
      if (TEMPORAL_VERSIONED_CATEGORIES.has(meta.memory_category)) {
        const now = Date.now();
        const factKey = meta.fact_key ?? deriveFactKey(meta.memory_category, text);

        const newMeta = buildSmartMetadata(
          { text, category: existing.category },
          {
            l0_abstract: text,
            l1_overview: meta.l1_overview,
            l2_content: text,
            memory_category: meta.memory_category,
            tier: meta.tier,
            access_count: 0,
            confidence: importance !== undefined ? clamp01(importance, 0.7) : meta.confidence,
            valid_from: now,
            fact_key: factKey,
            supersedes: resolvedId,
            relations: appendRelation([], { type: "supersedes", targetId: resolvedId }),
          }
        );

        const newEntry = await ctx.store.store({
          text,
          vector: newVector,
          category: category ? (category as any) : existing.category,
          scope: existing.scope,
          importance: importance !== undefined ? clamp01(importance, 0.7) : existing.importance,
          metadata: stringifySmartMetadata(newMeta),
        });

        // Invalidate old record
        try {
          const invalidatedMeta = buildSmartMetadata(existing, {
            fact_key: factKey,
            invalidated_at: now,
            superseded_by: newEntry.id,
            relations: appendRelation(meta.relations, { type: "superseded_by", targetId: newEntry.id }),
          });
          await ctx.store.update(resolvedId, { metadata: stringifySmartMetadata(invalidatedMeta) }, scopeFilter);
        } catch {
          /* new record is source of truth */
        }

        return textResult(
          `Superseded memory ${resolvedId.slice(0, 8)}... → new version ${newEntry.id.slice(0, 8)}...: "${text.slice(0, 80)}${text.length > 80 ? "..." : ""}"`
        );
      }
    }
  }

  const updates: Record<string, any> = {};
  if (text) updates.text = text;
  if (newVector) updates.vector = newVector;
  if (importance !== undefined) updates.importance = clamp01(importance, 0.7);
  if (category) updates.category = category;

  const updated = await ctx.store.update(resolvedId, updates, scopeFilter);
  if (!updated) return textResult(`Memory ${resolvedId.slice(0, 8)}... not found or access denied.`);

  return textResult(
    `Updated memory ${updated.id.slice(0, 8)}...: "${updated.text.slice(0, 80)}${updated.text.length > 80 ? "..." : ""}"`
  );
}

async function handleMemoryStats(ctx: ServerContext, params: Record<string, unknown>) {
  const scope = params.scope as string | undefined;

  let scopeFilter = ctx.scopeManager.getAccessibleScopes("main");
  if (scope) {
    if (ctx.scopeManager.isAccessible(scope, "main")) scopeFilter = [scope];
    else return textResult(`Access denied to scope: ${scope}`);
  }

  const stats = await ctx.store.stats(scopeFilter);
  const scopeStats = ctx.scopeManager.getStats();
  const retrievalConfig = ctx.retriever.getConfig();

  const lines = [
    `Memory Statistics:`,
    `• Total memories: ${stats.totalCount}`,
    `• Available scopes: ${scopeStats.totalScopes}`,
    `• Retrieval mode: ${retrievalConfig.mode}`,
    `• FTS support: ${ctx.store.hasFtsSupport ? "Yes" : "No"}`,
    ``,
    `Memories by scope:`,
    ...Object.entries(stats.scopeCounts).map(([s, count]) => `  • ${s}: ${count}`),
    ``,
    `Memories by category:`,
    ...Object.entries(stats.categoryCounts).map(([c, count]) => `  • ${c}: ${count}`),
  ];

  return textResult(lines.join("\n"));
}

async function handleMemoryList(ctx: ServerContext, params: Record<string, unknown>) {
  const limit = clampInt(Number(params.limit) || 10, 1, 50);
  const offset = clampInt(Number(params.offset) || 0, 0, 1000);
  const scope = params.scope as string | undefined;
  const category = params.category as string | undefined;

  let scopeFilter = ctx.scopeManager.getAccessibleScopes("main");
  if (scope) {
    if (ctx.scopeManager.isAccessible(scope, "main")) scopeFilter = [scope];
    else return textResult(`Access denied to scope: ${scope}`);
  }

  const entries = await ctx.store.list(scopeFilter, category, limit, offset);
  if (entries.length === 0) return textResult("No memories found.");

  const text = entries
    .map((entry, i) => {
      const date = new Date(entry.timestamp).toISOString().split("T")[0];
      const tag = getDisplayCategoryTag(entry);
      return `${offset + i + 1}. [${entry.id}] [${tag}] ${entry.text.slice(0, 100)}${entry.text.length > 100 ? "..." : ""} (${date})`;
    })
    .join("\n");

  return textResult(`Recent memories (showing ${entries.length}):\n\n${text}`);
}

async function handleSelfImprovementLog(_ctx: ServerContext, params: Record<string, unknown>) {
  const type = params.type as "learning" | "error";
  const summary = String(params.summary || "");
  const details = String(params.details || "");
  const suggestedAction = String(params.suggestedAction || "");
  const category = String(params.category || "best_practice");
  const area = String(params.area || "config");
  const priority = String(params.priority || "medium");

  const workspaceDir = process.env.MEMORY_WORKSPACE_DIR || process.cwd();
  const { id: entryId, filePath } = await appendSelfImprovementEntry({
    baseDir: workspaceDir,
    type,
    summary,
    details,
    suggestedAction,
    category,
    area,
    priority,
    source: "memory-lancedb-mcp/self_improvement_log",
  });

  const fileName = type === "learning" ? "LEARNINGS.md" : "ERRORS.md";
  return textResult(`Logged ${type} entry ${entryId} to .learnings/${fileName}`);
}

async function handleSelfImprovementExtractSkill(_ctx: ServerContext, params: Record<string, unknown>) {
  const learningId = String(params.learningId || "");
  const skillName = String(params.skillName || "");
  const sourceFile = (params.sourceFile as "LEARNINGS.md" | "ERRORS.md") || "LEARNINGS.md";
  const outputDir = String(params.outputDir || "skills");

  if (!/^(LRN|ERR)-\d{8}-\d{3}$/.test(learningId)) {
    return textResult("Invalid learningId format. Use LRN-YYYYMMDD-001 / ERR-...");
  }
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(skillName)) {
    return textResult("Invalid skillName. Use lowercase letters, numbers, and hyphens only.");
  }

  const workspaceDir = process.env.MEMORY_WORKSPACE_DIR || process.cwd();
  await ensureSelfImprovementLearningFiles(workspaceDir);
  const learningsPath = join(workspaceDir, ".learnings", sourceFile);
  const learningBody = await readFile(learningsPath, "utf-8");
  const escapedId = escapeRegExp(learningId.trim());
  const entryRegex = new RegExp(`## \\[${escapedId}\\][\\s\\S]*?(?=\\n## \\[|$)`, "m");
  const match = learningBody.match(entryRegex);
  if (!match) {
    return textResult(`Learning entry ${learningId} not found in .learnings/${sourceFile}`);
  }

  const summaryMatch = match[0].match(/### Summary\n([\s\S]*?)\n###/m);
  const summary = (summaryMatch?.[1] ?? "Summarize the source learning here.").trim();
  const safeOutputDir = outputDir
    .replace(/\\/g, "/")
    .split("/")
    .filter((s) => s && s !== "." && s !== "..")
    .join("/");
  const skillDir = join(workspaceDir, safeOutputDir || "skills", skillName);
  await mkdir(skillDir, { recursive: true });
  const skillPath = join(skillDir, "SKILL.md");
  const skillTitle = skillName
    .split("-")
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(" ");
  const skillContent = [
    "---",
    `name: ${skillName}`,
    `description: "Extracted from learning ${learningId}. Replace with a concise description."`,
    "---",
    "",
    `# ${skillTitle}`,
    "",
    "## Why",
    summary,
    "",
    "## When To Use",
    "- [TODO] Define trigger conditions",
    "",
    "## Steps",
    "1. [TODO] Add repeatable workflow steps",
    "2. [TODO] Add verification steps",
    "",
    "## Source Learning",
    `- Learning ID: ${learningId}`,
    `- Source File: .learnings/${sourceFile}`,
    "",
  ].join("\n");
  await writeFile(skillPath, skillContent, "utf-8");

  const promotedMarker = `**Status**: promoted_to_skill`;
  const skillPathMarker = `- Skill-Path: ${safeOutputDir || "skills"}/${skillName}`;
  let updatedEntry = match[0];
  updatedEntry = updatedEntry.includes("**Status**:")
    ? updatedEntry.replace(/\*\*Status\*\*:\s*.+/m, promotedMarker)
    : `${updatedEntry.trimEnd()}\n${promotedMarker}\n`;
  if (!updatedEntry.includes("Skill-Path:")) {
    updatedEntry = `${updatedEntry.trimEnd()}\n${skillPathMarker}\n`;
  }
  const updatedLearningBody = learningBody.replace(match[0], updatedEntry);
  await writeFile(learningsPath, updatedLearningBody, "utf-8");

  return textResult(
    `Extracted skill scaffold to ${safeOutputDir || "skills"}/${skillName}/SKILL.md and updated ${learningId}.`
  );
}

async function handleSelfImprovementReview(_ctx: ServerContext) {
  const workspaceDir = process.env.MEMORY_WORKSPACE_DIR || process.cwd();
  await ensureSelfImprovementLearningFiles(workspaceDir);
  const learningsDir = join(workspaceDir, ".learnings");
  const files = ["LEARNINGS.md", "ERRORS.md"] as const;
  const stats = { pending: 0, high: 0, promoted: 0, total: 0 };

  for (const f of files) {
    const content = await readFile(join(learningsDir, f), "utf-8").catch(() => "");
    stats.total += (content.match(/^## \[/gm) || []).length;
    stats.pending += (content.match(/\*\*Status\*\*:\s*pending/gi) || []).length;
    stats.high += (content.match(/\*\*Priority\*\*:\s*(high|critical)/gi) || []).length;
    stats.promoted += (content.match(/\*\*Status\*\*:\s*promoted(_to_skill)?/gi) || []).length;
  }

  const lines = [
    "Self-Improvement Governance Snapshot:",
    `- Total entries: ${stats.total}`,
    `- Pending: ${stats.pending}`,
    `- High/Critical: ${stats.high}`,
    `- Promoted: ${stats.promoted}`,
    "",
    "Recommended loop:",
    "1) Resolve high-priority pending entries",
    "2) Distill reusable rules into AGENTS.md / SOUL.md / TOOLS.md",
    "3) Extract repeatable patterns as skills",
  ];

  return textResult(lines.join("\n"));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // Load config
  const config = loadConfig();

  // Validate storage path
  try {
    validateStoragePath(config.dbPath);
  } catch (err) {
    console.error(`Warning: storage path issue — ${err}`);
  }

  // Initialize core components
  const vectorDim = getVectorDimensions(config.embedding.model, config.embedding.dimensions);
  const store = new MemoryStore({ dbPath: config.dbPath, vectorDim });

  const embedder = createEmbedder({
    provider: "openai-compatible",
    apiKey: config.embedding.apiKey,
    model: config.embedding.model,
    baseURL: config.embedding.baseURL,
    dimensions: config.embedding.dimensions,
    taskQuery: config.embedding.taskQuery,
    taskPassage: config.embedding.taskPassage,
    normalized: config.embedding.normalized,
    chunking: config.embedding.chunking,
  });

  const decayEngine = createDecayEngine(config.decay);
  const scopeManager = createScopeManager(config.scopes);

  const retriever = createRetriever(store, embedder, config.retrieval, { decayEngine });

  const ctx: ServerContext = {
    store,
    embedder,
    retriever,
    scopeManager,
    workspaceBoundary: undefined,
    config,
  };

  // Build tool list
  const allTools = [...CORE_TOOLS];
  if (config.enableManagementTools) {
    allTools.push(...MANAGEMENT_TOOLS);
  }
  if (config.enableSelfImprovementTools) {
    allTools.push(...SELF_IMPROVEMENT_TOOLS);
  }

  // Create MCP server
  const server = new Server({ name: "memory-lancedb-mcp", version: "2.0.0" }, { capabilities: { tools: {} } });

  // List tools
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: allTools,
  }));

  // Call tool
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const params = (args || {}) as Record<string, unknown>;

    try {
      switch (name) {
        case "memory_recall":
          return await handleMemoryRecall(ctx, params);
        case "memory_store":
          return await handleMemoryStore(ctx, params);
        case "memory_forget":
          return await handleMemoryForget(ctx, params);
        case "memory_update":
          return await handleMemoryUpdate(ctx, params);
        case "memory_stats":
          return await handleMemoryStats(ctx, params);
        case "memory_list":
          return await handleMemoryList(ctx, params);
        case "self_improvement_log":
          return await handleSelfImprovementLog(ctx, params);
        case "self_improvement_extract_skill":
          return await handleSelfImprovementExtractSkill(ctx, params);
        case "self_improvement_review":
          return await handleSelfImprovementReview(ctx);
        default:
          return textResult(`Unknown tool: ${name}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text" as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  });

  // Start server
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("memory-lancedb-mcp server started (stdio)");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
