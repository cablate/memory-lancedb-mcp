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
import { createDecayEngine, type DecayEngine } from "./src/decay-engine.js";
import { createTierManager } from "./src/tier-manager.js";
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
import { generateVisualization } from "./src/visualize.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MEMORY_CATEGORIES = ["preference", "fact", "decision", "entity", "skill", "lesson", "other"] as const;

function cosineSim(a: number[], b: number[]): number {
  let dot = 0,
    na = 0,
    nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

const DORMANT_DAYS = 30;

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

function parseSince(since: string | undefined): number | undefined {
  if (!since) return undefined;
  const match = since.match(/^(\d+)(h|d|w|m)$/);
  if (match) {
    const value = parseInt(match[1], 10);
    const unit = match[2];
    const msMap: Record<string, number> = { h: 3600000, d: 86400000, w: 604800000, m: 2592000000 };
    return Date.now() - value * msMap[unit];
  }
  const ts = new Date(since).getTime();
  return isNaN(ts) ? undefined : ts;
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
        since: {
          type: "string",
          description:
            'Time range filter. Use shorthand like "3d" (3 days), "1w" (1 week), "2h" (2 hours), or ISO timestamp.',
        },
        topic: {
          type: "string",
          description:
            'Filter by topic label (e.g. "remotion", "invoice"). Only returns memories tagged with this topic.',
        },
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
        topic: {
          type: "string",
          description:
            'Topic label for grouping related memories (e.g. "remotion", "invoice"). Auto-inferred from similar memories if omitted.',
        },
        lesson_trigger: {
          type: "string",
          description: 'For category="lesson": what situation triggers this lesson (e.g. "when editing CSS layout")',
        },
        lesson_rule: {
          type: "string",
          description:
            'For category="lesson": the derived rule to follow (e.g. "check for syntax errors before assuming cache issues")',
        },
        lesson_principle: {
          type: "string",
          description:
            'For category="lesson": the universal principle (e.g. "verify assumptions with evidence before acting")',
        },
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
  {
    name: "memory_merge",
    description:
      "Merge two related memories into one. Creates a new merged memory and invalidates both originals. Use when duplicate or fragmented memories cover the same topic.",
    inputSchema: {
      type: "object" as const,
      properties: {
        primaryId: {
          type: "string",
          description: "ID of the primary memory (text used as base if mergedText is not provided)",
        },
        secondaryId: { type: "string", description: "ID of the secondary memory to absorb" },
        mergedText: {
          type: "string",
          description: "Explicit merged text. If omitted, both texts are concatenated.",
        },
        importance: { type: "number", description: "Override importance (default: max of both)" },
        scope: { type: "string", description: "Scope filter (optional)" },
      },
      required: ["primaryId", "secondaryId"],
    },
  },
  {
    name: "memory_history",
    description:
      "Trace the version history of a memory through its supersede/merge chain. Shows how a memory evolved over time.",
    inputSchema: {
      type: "object" as const,
      properties: {
        memoryId: { type: "string", description: "ID of any memory in the chain (full UUID or 8+ char prefix)" },
        direction: {
          type: "string",
          enum: ["forward", "backward", "both"],
          description: 'Traversal direction (default: "both")',
        },
        scope: { type: "string", description: "Scope filter (optional)" },
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
  {
    name: "memory_lint",
    description:
      "Run health checks on the memory store. Detects contradictions, orphan memories (no relations and low access), stale memories (old + never accessed), and suggests cleanup actions.",
    inputSchema: {
      type: "object" as const,
      properties: {
        scope: {
          type: "string",
          description: "Scope to lint (default: all accessible scopes)",
        },
        fix: {
          type: "boolean",
          description: "Auto-fix simple issues like missing relations (default: false)",
        },
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

const VISUALIZATION_TOOLS = [
  {
    name: "memory_visualize",
    description:
      "Generate an interactive HTML visualization of the memory graph. " +
      "Shows semantic clusters, similarity edges, duplicate detection, " +
      "importance distribution, and growth timeline. Returns the HTML as text " +
      "or writes it to a file path.",
    inputSchema: {
      type: "object" as const,
      properties: {
        output_path: {
          type: "string",
          description: "File path to write the HTML output. If omitted, returns the HTML content directly.",
        },
        scope: {
          type: "string",
          description: "Scope to visualize (default: all accessible scopes)",
        },
        threshold: {
          type: "number",
          description: "Cosine similarity threshold for drawing edges between memories (0.0-1.0, default: 0.65)",
        },
        max_neighbors: {
          type: "number",
          description: "Maximum edges per node (default: 4)",
        },
      },
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
  const sinceTs = parseSince(params.since as string | undefined);
  const topicFilter = params.topic as string | undefined;

  let scopeFilter = ctx.scopeManager.getAccessibleScopes("main");
  if (scope) {
    if (ctx.scopeManager.isAccessible(scope, "main")) {
      scopeFilter = [scope];
    } else {
      return textResult(`Access denied to scope: ${scope}`);
    }
  }

  // Fetch more candidates when time-filtering to compensate for post-filter loss
  const fetchLimit = sinceTs ? Math.min(limit * 3, 20) : limit;

  let results = filterUserMdExclusiveRecallResults(
    await retrieveWithRetry(ctx.retriever, { query, limit: fetchLimit, scopeFilter, category, source: "manual" }),
    ctx.workspaceBoundary
  );

  if (sinceTs) {
    results = results.filter((r) => r.entry.timestamp >= sinceTs);
  }

  if (topicFilter) {
    const normalizedTopic = topicFilter.toLowerCase().trim();
    results = results.filter((r) => {
      const meta = parseSmartMetadata(r.entry.metadata, r.entry);
      const memTopic = (meta as Record<string, unknown>).topic as string | undefined;
      return memTopic && memTopic.toLowerCase().trim() === normalizedTopic;
    });
  }

  results = results.slice(0, limit);

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
      let line = `${i + 1}. [${r.entry.id}] [${tag}] ${r.entry.text}`;
      // Surface lesson structure if present
      const meta = parseSmartMetadata(r.entry.metadata, r.entry);
      if (meta.lesson_trigger || meta.lesson_rule || meta.lesson_principle) {
        const parts: string[] = [];
        if (meta.lesson_trigger) parts.push(`  Trigger: ${meta.lesson_trigger}`);
        if (meta.lesson_rule) parts.push(`  Rule: ${meta.lesson_rule}`);
        if (meta.lesson_principle) parts.push(`  Principle: ${meta.lesson_principle}`);
        line += "\n" + parts.join("\n");
      }
      return line;
    })
    .join("\n");

  // Generate maintenance hints from recall results
  const hints: string[] = [];
  const dormantThreshold = now - DORMANT_DAYS * 86400000;

  // Detect near-duplicate pairs among results
  for (let i = 0; i < results.length; i++) {
    const vi = results[i].entry.vector;
    if (!vi?.length) continue;
    for (let j = i + 1; j < results.length; j++) {
      const vj = results[j].entry.vector;
      if (!vj?.length) continue;
      const sim = cosineSim(vi, vj);
      if (sim > 0.9) {
        hints.push(
          `#${i + 1} and #${j + 1} are very similar (${(sim * 100).toFixed(0)}%). Consider \`memory_merge\` if redundant.`
        );
      }
    }
  }

  // Detect dormant memories
  for (let i = 0; i < results.length; i++) {
    const meta = parseSmartMetadata(results[i].entry.metadata, results[i].entry);
    const lastAccess = meta.last_accessed_at || results[i].entry.timestamp;
    if (lastAccess < dormantThreshold && meta.access_count <= 1) {
      const days = Math.floor((now - lastAccess) / 86400000);
      hints.push(`#${i + 1} has not been accessed in ${days} days. Verify if still relevant, or \`memory_forget\`.`);
    }
  }

  // Detect contradictions among results
  for (let i = 0; i < results.length; i++) {
    for (let j = i + 1; j < results.length; j++) {
      if (detectContradictionHint(results[i].entry.text, results[j].entry.text)) {
        hints.push(`#${i + 1} and #${j + 1} may conflict. Consider \`memory_update\` to resolve.`);
      }
    }
  }

  let response = `Found ${results.length} memories:\n\n${text}`;
  if (hints.length > 0) {
    response += "\n\n" + hints.map((h) => `💡 ${h}`).join("\n");
  }

  return textResult(response);
}

// ---------------------------------------------------------------------------
// Contradiction hint detection (heuristic, not NLP)
// ---------------------------------------------------------------------------

const NEGATION_WORDS = ["not", "don't", "shouldn't", "never", "不", "沒有", "不要", "不能", "無法"];

function detectContradictionHint(textA: string, textB: string): boolean {
  const aLower = textA.toLowerCase();
  const bLower = textB.toLowerCase();

  // Check if one has a negation word and the other doesn't
  const aNegated = NEGATION_WORDS.some((w) => aLower.includes(w));
  const bNegated = NEGATION_WORDS.some((w) => bLower.includes(w));
  if (aNegated !== bNegated) {
    // They differ in negation — check if they share enough topic words to be about the same thing
    const aWords = new Set(aLower.split(/\W+/).filter((w) => w.length > 3));
    const bWords = new Set(bLower.split(/\W+/).filter((w) => w.length > 3));
    if (aWords.size === 0 || bWords.size === 0) return false;
    let shared = 0;
    for (const w of aWords) {
      if (bWords.has(w)) shared++;
    }
    const overlapRatio = shared / Math.min(aWords.size, bWords.size);
    return overlapRatio > 0.5;
  }

  return false;
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

  // Duplicate / similarity check
  let existing: Awaited<ReturnType<MemoryStore["vectorSearch"]>> = [];
  try {
    existing = await ctx.store.vectorSearch(vector, 6, 0.1, [scope], { excludeInactive: true });
  } catch {
    /* fail-open */
  }

  if (existing.length > 0 && existing[0].score > 0.98) {
    return textResult(`Similar memory already exists: "${existing[0].entry.text}"`);
  }

  // Resolve topic: explicit param > inherit from similar memories > undefined
  let topic = params.topic as string | undefined;
  if (!topic && existing.length > 0) {
    const topicCounts: Record<string, number> = {};
    for (const e of existing.filter((e) => e.score > 0.7)) {
      const eMeta = parseSmartMetadata(e.entry.metadata, e.entry);
      const eTopic = (eMeta as Record<string, unknown>).topic as string | undefined;
      if (eTopic) {
        topicCounts[eTopic] = (topicCounts[eTopic] || 0) + 1;
      }
    }
    const sorted = Object.entries(topicCounts).sort((a, b) => b[1] - a[1]);
    if (sorted.length > 0) {
      topic = sorted[0][0];
    }
  }

  const smartMeta = buildSmartMetadata(
    { text, category: category as any, importance },
    {
      l0_abstract: text,
      l1_overview: `- ${text}`,
      l2_content: text,
      lesson_trigger: params.lesson_trigger as string | undefined,
      lesson_rule: params.lesson_rule as string | undefined,
      lesson_principle: params.lesson_principle as string | undefined,
    }
  );
  if (topic) {
    (smartMeta as Record<string, unknown>).topic = topic;
  }

  const entry = await ctx.store.store({
    text,
    vector,
    importance,
    category: category as any,
    scope,
    metadata: stringifySmartMetadata(smartMeta),
  });

  let response = `Stored: "${text.slice(0, 100)}${text.length > 100 ? "..." : ""}" in scope '${scope}'`;
  if (topic) {
    response += ` [topic: ${topic}]`;
  }

  // Auto-link bidirectional relations with similar memories (score > 0.7, not duplicates)
  const linkCandidates = existing.filter((e) => e.score > 0.7 && e.score <= 0.98).slice(0, 4);
  if (linkCandidates.length > 0) {
    await Promise.allSettled(
      linkCandidates.map(async (candidate) => {
        // Patch new entry: add relation pointing to existing
        const newMeta = parseSmartMetadata(entry.metadata, entry);
        await ctx.store.patchMetadata(
          entry.id,
          { relations: appendRelation(newMeta.relations, { type: "related", targetId: candidate.entry.id }) },
          [scope]
        );
        // Patch existing entry: add relation pointing to new entry
        const existingMeta = parseSmartMetadata(candidate.entry.metadata, candidate.entry);
        await ctx.store.patchMetadata(
          candidate.entry.id,
          { relations: appendRelation(existingMeta.relations, { type: "related", targetId: entry.id }) },
          [scope]
        );
      })
    );
    response += `\n\nAuto-linked ${linkCandidates.length} relation${linkCandidates.length === 1 ? "" : "s"} (bidirectional).`;
  }

  // Surface similar memories for awareness
  const similar = existing.filter((e) => e.score > 0.8 && e.score <= 0.98);
  if (similar.length > 0) {
    const hints = similar
      .map((s) => `  - [${s.entry.id.slice(0, 8)}] (${(s.score * 100).toFixed(0)}%) ${s.entry.text.slice(0, 80)}`)
      .join("\n");
    response += `\n\nRelated (${similar.length} similar ${similar.length === 1 ? "memory" : "memories"}):\n${hints}`;
  }

  // Contradiction detection among similar memories (score 0.8-0.95)
  const contradictionCandidates = existing.filter((e) => e.score >= 0.8 && e.score <= 0.95);
  for (const candidate of contradictionCandidates) {
    if (detectContradictionHint(text, candidate.entry.text)) {
      const excerpt = candidate.entry.text.slice(0, 60);
      response += `\n\n⚠️ Potential contradiction with [${candidate.entry.id.slice(0, 8)}]: "${excerpt}${candidate.entry.text.length > 60 ? "..." : ""}"`;
    }
  }

  return textResult(response);
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

// ---------------------------------------------------------------------------
// memory_merge handler
// ---------------------------------------------------------------------------

async function handleMemoryMerge(ctx: ServerContext, params: Record<string, unknown>) {
  const primaryId = String(params.primaryId || "");
  const secondaryId = String(params.secondaryId || "");
  const mergedTextParam = params.mergedText as string | undefined;
  const importanceParam = params.importance !== undefined ? Number(params.importance) : undefined;

  if (!primaryId || !secondaryId) return textResult("Both primaryId and secondaryId are required.");
  if (primaryId === secondaryId) return textResult("Cannot merge a memory with itself.");

  const scopeFilter = ctx.scopeManager.getAccessibleScopes("main");
  if (params.scope) {
    const s = String(params.scope);
    if (!ctx.scopeManager.isAccessible(s, "main")) return textResult(`Access denied to scope: ${s}`);
  }

  const primary = await ctx.store.getById(primaryId, scopeFilter);
  if (!primary) return textResult(`Primary memory ${primaryId.slice(0, 8)}... not found or access denied.`);

  const secondary = await ctx.store.getById(secondaryId, scopeFilter);
  if (!secondary) return textResult(`Secondary memory ${secondaryId.slice(0, 8)}... not found or access denied.`);

  // Check neither is already invalidated
  const primaryMeta = parseSmartMetadata(primary.metadata, primary);
  const secondaryMeta = parseSmartMetadata(secondary.metadata, secondary);

  if (primaryMeta.invalidated_at)
    return textResult(`Primary memory ${primaryId.slice(0, 8)}... is already superseded/invalidated.`);
  if (secondaryMeta.invalidated_at)
    return textResult(`Secondary memory ${secondaryId.slice(0, 8)}... is already superseded/invalidated.`);

  // Build merged text
  const mergedText = mergedTextParam || `${primary.text}\n---\n${secondary.text}`;
  if (isNoise(mergedText)) return textResult("Skipped: merged text detected as noise.");

  // Re-embed
  const newVector = await ctx.embedder.embedPassage(mergedText);

  // Choose best metadata
  const now = Date.now();
  const mergedImportance =
    importanceParam !== undefined ? clamp01(importanceParam, 0.7) : Math.max(primary.importance, secondary.importance);
  const mergedCategory = primary.category; // primary wins
  const higherTier = tierRank(primaryMeta.tier) >= tierRank(secondaryMeta.tier) ? primaryMeta.tier : secondaryMeta.tier;
  const totalAccess = (primaryMeta.access_count || 0) + (secondaryMeta.access_count || 0);

  const newMeta = buildSmartMetadata(
    { text: mergedText, category: mergedCategory },
    {
      l0_abstract: mergedText.slice(0, 200),
      l1_overview: primaryMeta.l1_overview,
      l2_content: mergedText,
      memory_category: mergedCategory as any,
      tier: higherTier,
      access_count: totalAccess,
      confidence: mergedImportance,
      valid_from: now,
      relations: [
        { type: "merged_from" as any, targetId: primary.id },
        { type: "merged_from" as any, targetId: secondary.id },
      ],
    }
  );

  // Create new merged memory
  const newEntry = await ctx.store.store({
    text: mergedText,
    vector: newVector,
    category: mergedCategory,
    scope: primary.scope,
    importance: mergedImportance,
    metadata: stringifySmartMetadata(newMeta),
  });

  // Invalidate both originals
  const invalidate = async (id: string, meta: ReturnType<typeof parseSmartMetadata>) => {
    try {
      const invalidatedMeta = buildSmartMetadata(
        { text: "", category: meta.memory_category },
        {
          ...meta,
          invalidated_at: now,
          superseded_by: newEntry.id,
          relations: appendRelation(meta.relations, { type: "superseded_by", targetId: newEntry.id }),
        }
      );
      await ctx.store.update(id, { metadata: stringifySmartMetadata(invalidatedMeta) }, scopeFilter);
    } catch {
      /* new record is source of truth */
    }
  };

  await Promise.all([invalidate(primary.id, primaryMeta), invalidate(secondary.id, secondaryMeta)]);

  return textResult(
    `Merged ${primary.id.slice(0, 8)}... + ${secondary.id.slice(0, 8)}... → ${newEntry.id.slice(0, 8)}...\n` +
      `Text: "${mergedText.slice(0, 100)}${mergedText.length > 100 ? "..." : ""}"`
  );
}

function tierRank(tier: string): number {
  switch (tier) {
    case "core":
      return 3;
    case "working":
      return 2;
    case "peripheral":
      return 1;
    default:
      return 2;
  }
}

// ---------------------------------------------------------------------------
// memory_history handler
// ---------------------------------------------------------------------------

async function handleMemoryHistory(ctx: ServerContext, params: Record<string, unknown>) {
  const memoryId = String(params.memoryId || "");
  const direction = (params.direction as string) || "both";

  if (!memoryId) return textResult("memoryId is required.");

  const scopeFilter = ctx.scopeManager.getAccessibleScopes("main");
  if (params.scope) {
    const s = String(params.scope);
    if (!ctx.scopeManager.isAccessible(s, "main")) return textResult(`Access denied to scope: ${s}`);
  }

  const startMemory = await ctx.store.getById(memoryId, scopeFilter);
  if (!startMemory) return textResult(`Memory ${memoryId.slice(0, 8)}... not found or access denied.`);

  interface ChainNode {
    id: string;
    text: string;
    timestamp: number;
    active: boolean;
    tier: string;
    importance: number;
    category: string;
    relations: string[];
  }

  const visited = new Set<string>();
  const chain: ChainNode[] = [];
  const MAX_DEPTH = 50;

  const toNode = (entry: NonNullable<Awaited<ReturnType<typeof ctx.store.getById>>>): ChainNode => {
    const meta = parseSmartMetadata(entry.metadata, entry);
    const rels: string[] = [];
    if (meta.supersedes) rels.push(`supersedes:${meta.supersedes.slice(0, 8)}`);
    if (meta.superseded_by) rels.push(`superseded_by:${meta.superseded_by.slice(0, 8)}`);
    if (meta.relations) {
      for (const r of meta.relations) {
        if (r.type === "merged_from") rels.push(`merged_from:${r.targetId.slice(0, 8)}`);
      }
    }
    return {
      id: entry.id,
      text: entry.text,
      timestamp: entry.timestamp,
      active: !meta.invalidated_at,
      tier: meta.tier,
      importance: entry.importance,
      category: entry.category,
      relations: rels,
    };
  };

  // Backward traversal
  const backward: ChainNode[] = [];
  if (direction === "backward" || direction === "both") {
    let current = startMemory;
    visited.add(current.id);
    for (let i = 0; i < MAX_DEPTH; i++) {
      const meta = parseSmartMetadata(current.metadata, current);
      if (!meta.supersedes) break;
      if (visited.has(meta.supersedes)) break;
      visited.add(meta.supersedes);
      const prev = await ctx.store.getById(meta.supersedes, scopeFilter);
      if (!prev) break;
      backward.unshift(toNode(prev));
      current = prev;
    }
  }

  // Forward traversal
  const forward: ChainNode[] = [];
  if (direction === "forward" || direction === "both") {
    let current = startMemory;
    if (!visited.has(current.id)) visited.add(current.id);
    for (let i = 0; i < MAX_DEPTH; i++) {
      const meta = parseSmartMetadata(current.metadata, current);
      if (!meta.superseded_by) break;
      if (visited.has(meta.superseded_by)) break;
      visited.add(meta.superseded_by);
      const next = await ctx.store.getById(meta.superseded_by, scopeFilter);
      if (!next) break;
      forward.push(toNode(next));
      current = next;
    }
  }

  // Combine: backward + start + forward
  chain.push(...backward, toNode(startMemory), ...forward);

  if (chain.length === 1) {
    return textResult(`Memory ${memoryId.slice(0, 8)}... has no version history (standalone).`);
  }

  const lines = chain.map((node, i) => {
    const date = new Date(node.timestamp).toISOString().slice(0, 16).replace("T", " ");
    const status = node.active ? "ACTIVE" : "SUPERSEDED";
    const relStr = node.relations.length > 0 ? ` (${node.relations.join(", ")})` : "";
    return `${i + 1}. [${status}] ${node.id.slice(0, 8)}... [${date}] [${node.category}/${node.tier}] imp=${node.importance}\n   "${node.text.slice(0, 100)}${node.text.length > 100 ? "..." : ""}"${relStr}`;
  });

  return textResult(`Version history (${chain.length} entries, oldest → newest):\n\n${lines.join("\n\n")}`);
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
    `• Dormant (>30d no access): ${stats.dormantCount}`,
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
// memory_lint handler
// ---------------------------------------------------------------------------

async function handleMemoryLint(ctx: ServerContext, params: Record<string, unknown>) {
  const scope = params.scope as string | undefined;
  const fix = params.fix === true;

  let scopeFilter = ctx.scopeManager.getAccessibleScopes("main");
  if (scope) {
    if (ctx.scopeManager.isAccessible(scope, "main")) {
      scopeFilter = [scope];
    } else {
      return textResult(`Access denied to scope: ${scope}`);
    }
  }

  const entries = await ctx.store.list(scopeFilter, undefined, 1000, 0);

  const now = Date.now();
  const DAY_MS = 86400000;
  const ORPHAN_AGE_DAYS = 7;
  const STALE_AGE_DAYS = 30;

  const orphans: string[] = [];
  const stale: string[] = [];
  let fixedRelations = 0;

  for (const entry of entries) {
    const meta = parseSmartMetadata(entry.metadata, entry);
    if (meta.invalidated_at) continue;

    const ageDays = (now - entry.timestamp) / DAY_MS;
    const accessCount = meta.access_count ?? 0;
    const hasRelations = meta.relations && meta.relations.length > 0;

    // Orphan: no relations, low access, age > 7 days
    if (!hasRelations && accessCount <= 1 && ageDays > ORPHAN_AGE_DAYS) {
      orphans.push(entry.id);
    }

    // Stale: never accessed, age > 30 days
    if (accessCount === 0 && ageDays > STALE_AGE_DAYS) {
      stale.push(entry.id);
    }

    // Fix missing relations via vector search
    if (fix) {
      try {
        // Only attempt if entry has a vector (we don't store vector on entry object, so we re-embed)
        const candidateVector = await ctx.embedder.embedPassage(entry.text);
        const candidates = await ctx.store.vectorSearch(candidateVector, 3, 0.3, scopeFilter, {
          excludeInactive: true,
        });
        const linkable = candidates.filter(
          (c) =>
            c.entry.id !== entry.id && c.score > 0.7 && !(meta.relations ?? []).some((r) => r.targetId === c.entry.id)
        );
        if (linkable.length > 0) {
          await Promise.allSettled(
            linkable.map(async (candidate) => {
              const updatedMeta = parseSmartMetadata(entry.metadata, entry);
              await ctx.store.patchMetadata(
                entry.id,
                { relations: appendRelation(updatedMeta.relations, { type: "related", targetId: candidate.entry.id }) },
                scopeFilter
              );
              const candidateMeta = parseSmartMetadata(candidate.entry.metadata, candidate.entry);
              await ctx.store.patchMetadata(
                candidate.entry.id,
                { relations: appendRelation(candidateMeta.relations, { type: "related", targetId: entry.id }) },
                scopeFilter
              );
              fixedRelations++;
            })
          );
        }
      } catch {
        /* skip on error */
      }
    }
  }

  const lines = [
    `Memory Health Report (${entries.length} active memories scanned):`,
    ``,
    `Orphans (no relations, low access, age > ${ORPHAN_AGE_DAYS}d): ${orphans.length}`,
    orphans.length > 0
      ? orphans
          .slice(0, 10)
          .map((id) => `  - [${id.slice(0, 8)}]`)
          .join("\n")
      : "  None",
    ``,
    `Stale (never accessed, age > ${STALE_AGE_DAYS}d): ${stale.length}`,
    stale.length > 0
      ? stale
          .slice(0, 10)
          .map((id) => `  - [${id.slice(0, 8)}]`)
          .join("\n")
      : "  None",
  ];

  if (fix) {
    lines.push(``, `Auto-fix: added ${fixedRelations} missing relation(s).`);
  } else if (orphans.length > 0 || stale.length > 0) {
    lines.push(``, `Tip: run with fix=true to auto-link missing relations.`);
  }

  lines.push(
    ``,
    `Recommendations:`,
    orphans.length > 0 ? `- Consider merging or forgetting ${orphans.length} orphan memory/memories.` : "",
    stale.length > 0 ? `- Consider deleting ${stale.length} stale memory/memories.` : "",
    orphans.length === 0 && stale.length === 0 ? `- Memory store looks healthy.` : ""
  );

  return textResult(lines.filter((l) => l !== "").join("\n"));
}

async function handleMemoryVisualize(ctx: ServerContext, params: Record<string, unknown>) {
  const scope = params.scope as string | undefined;
  const outputPath = params.output_path as string | undefined;
  const threshold = params.threshold as number | undefined;
  const maxNeighbors = params.max_neighbors as number | undefined;

  let scopeFilter: string[] | undefined;
  if (scope) {
    if (ctx.scopeManager.isAccessible(scope, "main")) {
      scopeFilter = [scope];
    } else {
      return textResult(`Access denied to scope: ${scope}`);
    }
  }

  const html = await generateVisualization(ctx.store, {
    threshold,
    maxNeighbors,
    scopeFilter,
  });

  if (outputPath) {
    await writeFile(outputPath, html, "utf-8");
    return textResult(
      `Memory Explorer written to ${outputPath} (${(html.length / 1024).toFixed(0)} KB). Open in a browser to explore.`
    );
  }

  return {
    content: [{ type: "text" as const, text: html }],
  };
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
  const tierManager = createTierManager();

  const retriever = createRetriever(store, embedder, config.retrieval, { decayEngine });
  retriever.setTierManager(tierManager);

  const ctx: ServerContext = {
    store,
    embedder,
    retriever,
    scopeManager,
    workspaceBoundary: undefined,
    config,
  };

  // Build tool list
  const allTools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> = [...CORE_TOOLS];
  if (config.enableManagementTools) {
    allTools.push(...MANAGEMENT_TOOLS);
  }
  if (config.enableSelfImprovementTools) {
    allTools.push(...SELF_IMPROVEMENT_TOOLS);
  }
  if (config.enableVisualizationTools !== false) {
    allTools.push(...VISUALIZATION_TOOLS);
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
        case "memory_merge":
          return await handleMemoryMerge(ctx, params);
        case "memory_history":
          return await handleMemoryHistory(ctx, params);
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
        case "memory_visualize":
          return await handleMemoryVisualize(ctx, params);
        case "memory_lint":
          return await handleMemoryLint(ctx, params);
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
