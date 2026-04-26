/**
 * Memory Visualization — generates a self-contained HTML explorer
 *
 * Reads all memories from the store, computes cosine similarity edges,
 * Label Propagation clusters, and duplicate pairs, then injects the
 * data into an HTML template.
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { MemoryStore } from "./store.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface VisMemory {
  id: string;
  text: string;
  category: string;
  scope: string;
  importance: number;
  timestamp: number;
  tier: string;
  access_count: number;
  confidence: number;
  memory_category: string;
  topic: string | null;
}

interface VisEdge {
  from: number;
  to: number;
  sim: number;
}

interface ClusterInfo {
  label: string;
  members: number[];
  size: number;
}

interface TopicInfo {
  label: string;
  members: number[];
  size: number;
}

interface VisData {
  memories: VisMemory[];
  edges: VisEdge[];
  clusters: number[];
  clusterInfo: Record<string, ClusterInfo>;
  topicInfo: Record<string, TopicInfo>;
  duplicates: VisEdge[];
}

export interface VisualizeOptions {
  /** Cosine similarity threshold for edges (default: 0.65) */
  threshold?: number;
  /** Max edges per node (default: 4) */
  maxNeighbors?: number;
  /** Scope filter (default: all accessible scopes) */
  scopeFilter?: string[];
}

// ---------------------------------------------------------------------------
// Math
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Label Propagation clustering
// ---------------------------------------------------------------------------

function labelPropagation(nodeCount: number, edges: VisEdge[], maxIter = 30): number[] {
  const labels = Array.from({ length: nodeCount }, (_, i) => i);
  const adj: Array<Array<{ to: number; w: number }>> = Array.from({ length: nodeCount }, () => []);
  edges.forEach((e) => {
    adj[e.from].push({ to: e.to, w: e.sim });
    adj[e.to].push({ to: e.from, w: e.sim });
  });

  for (let iter = 0; iter < maxIter; iter++) {
    let changed = false;
    const order = Array.from({ length: nodeCount }, (_, i) => i);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    for (const i of order) {
      if (adj[i].length === 0) continue;
      const votes: Record<number, number> = {};
      adj[i].forEach((e) => {
        votes[labels[e.to]] = (votes[labels[e.to]] || 0) + e.w;
      });
      const best = parseInt(Object.entries(votes).sort((a, b) => (b[1] as number) - (a[1] as number))[0][0]);
      if (best !== labels[i]) {
        labels[i] = best;
        changed = true;
      }
    }
    if (!changed) break;
  }

  // Normalize labels to 0..N-1
  const uniq = [...new Set(labels)].sort((a, b) => a - b);
  const map: Record<number, number> = {};
  uniq.forEach((l, i) => (map[l] = i));
  return labels.map((l) => map[l]);
}

// ---------------------------------------------------------------------------
// Cluster info generation
// ---------------------------------------------------------------------------

function buildClusterInfo(memories: VisMemory[], clusters: number[]): Record<string, ClusterInfo> {
  const info: Record<string, ClusterInfo> = {};
  memories.forEach((m, i) => {
    const c = clusters[i];
    if (!info[c]) info[c] = { label: "", members: [], size: 0 };
    info[c].members.push(i);
    info[c].size++;
  });

  for (const [id, ci] of Object.entries(info)) {
    const words: Record<string, number> = {};
    ci.members.forEach((i) => {
      memories[i].text
        .replace(/[^\u4e00-\u9fff\w]+/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 1)
        .forEach((w) => (words[w] = (words[w] || 0) + 1));
    });
    const top = Object.entries(words)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([w]) => w);
    ci.label = top.join("/") || `Cluster ${id}`;
  }
  return info;
}

// ---------------------------------------------------------------------------
// Topic info generation
// ---------------------------------------------------------------------------

function buildTopicInfo(memories: VisMemory[]): Record<string, TopicInfo> {
  const info: Record<string, TopicInfo> = {};
  memories.forEach((m, i) => {
    const key = m.topic ?? "_untagged";
    if (!info[key]) info[key] = { label: key, members: [], size: 0 };
    info[key].members.push(i);
    info[key].size++;
  });
  return info;
}

// ---------------------------------------------------------------------------
// Main: generate visualization HTML
// ---------------------------------------------------------------------------

export async function generateVisualization(store: MemoryStore, options: VisualizeOptions = {}): Promise<string> {
  const threshold = options.threshold ?? 0.65;
  const maxNeighbors = options.maxNeighbors ?? 4;

  // Fetch all rows with vectors
  const rows = await store.listAllRaw(options.scopeFilter);

  // Parse into memories + vectors
  const memories: VisMemory[] = [];
  const vectors: number[][] = [];

  for (const row of rows) {
    // Extract vector (Arrow Vector -> JS array)
    let vec: number[];
    const rawVec = row.vector as any;
    if (rawVec && typeof rawVec.toArray === "function") {
      vec = Array.from(rawVec.toArray());
    } else if (Array.isArray(rawVec)) {
      vec = rawVec;
    } else {
      continue;
    }

    // Skip zero vectors (schema entries)
    if (vec.every((v) => v === 0)) continue;

    // Parse metadata
    let meta: Record<string, unknown> = {};
    if (row.metadata) {
      try {
        meta = typeof row.metadata === "string" ? JSON.parse(row.metadata) : (row.metadata as Record<string, unknown>);
      } catch {
        /* ignore parse errors */
      }
    }

    let category = String(row.category || "other");
    if (meta.category && typeof meta.category === "string") {
      category = meta.category;
    }

    memories.push({
      id: row.id as string,
      text: (row.text as string) || "",
      category,
      scope: (row.scope as string) || "global",
      importance: Number(row.importance) || 0.5,
      timestamp: Number(row.timestamp) || Date.now(),
      tier: (meta.tier as string) || "working",
      access_count: Number((meta.access_count ?? meta.accessCount ?? 0) as number),
      confidence: Number((meta.confidence ?? 0.5) as number),
      memory_category: (meta.memory_category as string) || "events",
      topic: (meta.topic as string) || null,
    });
    vectors.push(vec);
  }

  if (memories.length === 0) {
    throw new Error("No memories found in the database");
  }

  // Build similarity edges (top-K neighbors per node above threshold)
  const edgeMap = new Map<string, number>();
  for (let i = 0; i < vectors.length; i++) {
    const sims: Array<{ j: number; sim: number }> = [];
    for (let j = 0; j < vectors.length; j++) {
      if (i === j) continue;
      const sim = cosineSim(vectors[i], vectors[j]);
      if (sim >= threshold) sims.push({ j, sim });
    }
    sims.sort((a, b) => b.sim - a.sim);
    sims.slice(0, maxNeighbors).forEach(({ j, sim }) => {
      const key = `${Math.min(i, j)}-${Math.max(i, j)}`;
      if (!edgeMap.has(key) || edgeMap.get(key)! < sim) {
        edgeMap.set(key, sim);
      }
    });
  }
  const edges: VisEdge[] = [];
  for (const [key, sim] of edgeMap) {
    const [from, to] = key.split("-").map(Number);
    edges.push({ from, to, sim: Math.round(sim * 1000) / 1000 });
  }

  // Clustering (Label Propagation on edges with sim >= 0.7)
  const clusterEdges = edges.filter((e) => e.sim >= 0.7);
  const clusters = labelPropagation(memories.length, clusterEdges);
  const clusterInfo = buildClusterInfo(memories, clusters);
  const topicInfo = buildTopicInfo(memories);

  // Duplicate detection (sim >= 0.90)
  const duplicates: VisEdge[] = [];
  for (let i = 0; i < vectors.length; i++) {
    for (let j = i + 1; j < vectors.length; j++) {
      const sim = cosineSim(vectors[i], vectors[j]);
      if (sim >= 0.9) {
        duplicates.push({
          from: i,
          to: j,
          sim: Math.round(sim * 1000) / 1000,
        });
      }
    }
  }

  // Assemble data
  const data: VisData = {
    memories,
    edges,
    clusters,
    clusterInfo,
    topicInfo,
    duplicates,
  };

  // Load template and inject data
  // __dirname = dist/src/ after build; assets/ is at package root (two levels up)
  const templatePath = join(__dirname, "..", "..", "assets", "memory-explorer.html");
  const template = readFileSync(templatePath, "utf8");
  const html = template.replace("__MEMORY_DATA__", JSON.stringify(data));

  return html;
}
