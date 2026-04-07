/**
 * Configuration loader for memory-lancedb-mcp
 * Supports: env vars, JSON config file, or direct object
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface McpConfig {
  embedding: {
    provider: "openai-compatible";
    apiKey: string | string[];
    model: string;
    baseURL?: string;
    dimensions?: number;
    taskQuery?: string;
    taskPassage?: string;
    normalized?: boolean;
    chunking?: boolean;
  };
  dbPath: string;
  retrieval?: {
    mode?: "hybrid" | "vector";
    vectorWeight?: number;
    bm25Weight?: number;
    minScore?: number;
    rerank?: "cross-encoder" | "lightweight" | "none";
    candidatePoolSize?: number;
    rerankApiKey?: string;
    rerankModel?: string;
    rerankEndpoint?: string;
    rerankProvider?: "jina" | "siliconflow" | "voyage" | "pinecone" | "dashscope" | "tei";
    recencyHalfLifeDays?: number;
    recencyWeight?: number;
    filterNoise?: boolean;
    lengthNormAnchor?: number;
    hardMinScore?: number;
    timeDecayHalfLifeDays?: number;
    reinforcementFactor?: number;
    maxHalfLifeMultiplier?: number;
  };
  decay?: {
    recencyHalfLifeDays?: number;
    recencyWeight?: number;
    frequencyWeight?: number;
    intrinsicWeight?: number;
    staleThreshold?: number;
    searchBoostMin?: number;
    importanceModulation?: number;
    betaCore?: number;
    betaWorking?: number;
    betaPeripheral?: number;
    coreDecayFloor?: number;
    workingDecayFloor?: number;
    peripheralDecayFloor?: number;
  };
  tier?: {
    coreAccessThreshold?: number;
    coreCompositeThreshold?: number;
    coreImportanceThreshold?: number;
    peripheralCompositeThreshold?: number;
    peripheralAgeDays?: number;
    workingAccessThreshold?: number;
    workingCompositeThreshold?: number;
  };
  scopes?: {
    default?: string;
    definitions?: Record<string, { description: string }>;
    agentAccess?: Record<string, string[]>;
  };
  enableManagementTools?: boolean;
  enableSelfImprovementTools?: boolean;
  enableVisualizationTools?: boolean;
  llm?: {
    apiKey?: string;
    model?: string;
    baseURL?: string;
    timeoutMs?: number;
  };
}

// ---------------------------------------------------------------------------
// Env var resolution
// ---------------------------------------------------------------------------

function resolveEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, name) => process.env[name] || "");
}

function parsePositiveInt(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const n = typeof value === "string" ? parseInt(value, 10) : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : undefined;
}

// ---------------------------------------------------------------------------
// Default DB path
// ---------------------------------------------------------------------------

export function getDefaultDbPath(): string {
  return join(homedir(), ".memory-lancedb-mcp", "data");
}

// ---------------------------------------------------------------------------
// Load config
// ---------------------------------------------------------------------------

export function loadConfig(): McpConfig {
  // 1. Try config file path from env
  const configPath = process.env.MEMORY_LANCEDB_CONFIG;
  let raw: Record<string, unknown> = {};

  if (configPath) {
    try {
      raw = JSON.parse(readFileSync(configPath, "utf-8"));
    } catch (err) {
      throw new Error(`Failed to load config from ${configPath}: ${err}`);
    }
  }

  // 2. Env vars override config file values
  const embeddingRaw = (raw.embedding as Record<string, unknown>) || {};

  const apiKey =
    process.env.EMBEDDING_API_KEY ||
    process.env.OPENAI_API_KEY ||
    (typeof embeddingRaw.apiKey === "string" ? embeddingRaw.apiKey : "") ||
    (Array.isArray(embeddingRaw.apiKey) ? embeddingRaw.apiKey : "");

  if (!apiKey || (Array.isArray(apiKey) && apiKey.length === 0)) {
    throw new Error(
      "Embedding API key required. Set EMBEDDING_API_KEY or OPENAI_API_KEY env var, or provide embedding.apiKey in config file."
    );
  }

  const model =
    process.env.EMBEDDING_MODEL ||
    (typeof embeddingRaw.model === "string" ? embeddingRaw.model : "text-embedding-3-small");

  const baseURL =
    process.env.EMBEDDING_BASE_URL ||
    (typeof embeddingRaw.baseURL === "string" ? resolveEnvVars(embeddingRaw.baseURL) : undefined);

  const dimensions = parsePositiveInt(process.env.EMBEDDING_DIMENSIONS) || parsePositiveInt(embeddingRaw.dimensions);

  const dbPath = process.env.MEMORY_DB_PATH || (typeof raw.dbPath === "string" ? raw.dbPath : getDefaultDbPath());

  return {
    embedding: {
      provider: "openai-compatible",
      apiKey,
      model,
      baseURL,
      dimensions,
      taskQuery: typeof embeddingRaw.taskQuery === "string" ? embeddingRaw.taskQuery : undefined,
      taskPassage: typeof embeddingRaw.taskPassage === "string" ? embeddingRaw.taskPassage : undefined,
      normalized: typeof embeddingRaw.normalized === "boolean" ? embeddingRaw.normalized : undefined,
      chunking: typeof embeddingRaw.chunking === "boolean" ? embeddingRaw.chunking : undefined,
    },
    dbPath,
    retrieval: typeof raw.retrieval === "object" && raw.retrieval !== null ? (raw.retrieval as any) : undefined,
    decay: typeof raw.decay === "object" && raw.decay !== null ? (raw.decay as any) : undefined,
    tier: typeof raw.tier === "object" && raw.tier !== null ? (raw.tier as any) : undefined,
    scopes: typeof raw.scopes === "object" && raw.scopes !== null ? (raw.scopes as any) : undefined,
    enableManagementTools: raw.enableManagementTools === true || process.env.MEMORY_ENABLE_MANAGEMENT === "true",
    enableSelfImprovementTools:
      raw.enableSelfImprovementTools === true || process.env.MEMORY_ENABLE_SELF_IMPROVEMENT === "true",
    enableVisualizationTools: raw.enableVisualizationTools !== false,
    llm: typeof raw.llm === "object" && raw.llm !== null ? (raw.llm as any) : undefined,
  };
}
