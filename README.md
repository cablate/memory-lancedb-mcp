<div align="center">

<img src="assets/banner.png" alt="memory-lancedb-mcp" width="100%" />

> **Built on [CortexReach/memory-lancedb-pro](https://github.com/CortexReach/memory-lancedb-pro)** — original work by [win4r](https://github.com/win4r) and contributors. Refactored from OpenClaw plugin into a standalone MCP server.

[![npm version](https://img.shields.io/npm/v/@cablate/memory-lancedb-mcp)](https://www.npmjs.com/package/@cablate/memory-lancedb-mcp)
[![LanceDB](https://img.shields.io/badge/LanceDB-Vectorstore-orange)](https://lancedb.com)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

**English** | [繁體中文](README_ZH.md)

</div>

---

## Why memory-lancedb-mcp?

Most AI agents forget everything the moment you start a new session. This MCP server gives any MCP-compatible client **persistent, intelligent long-term memory** — without manual management.

|                            | What you get                                                                   |
| -------------------------- | ------------------------------------------------------------------------------ |
| **Hybrid Retrieval**       | Vector + BM25 full-text search, fused with cross-encoder reranking             |
| **Smart Extraction**       | LLM-powered 6-category memory extraction                                       |
| **Memory Lifecycle**       | Weibull decay + 3-tier promotion — important memories surface, stale ones fade |
| **Multi-Scope Isolation**  | Per-agent, per-user, per-project memory boundaries                             |
| **Any Embedding Provider** | OpenAI, Jina, Gemini, DeepInfra, Ollama, or any OpenAI-compatible API          |
| **Self-Improvement Tools** | Structured learning/error logging with skill extraction                        |

---

## Quick Start

### 1. Install

```bash
npm install -g @cablate/memory-lancedb-mcp
```

### 2. Configure your MCP client

Add to your MCP client settings (e.g. Claude Desktop `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "memory": {
      "command": "npx",
      "args": ["-y", "@cablate/memory-lancedb-mcp"],
      "env": {
        "EMBEDDING_API_KEY": "your-api-key",
        "EMBEDDING_MODEL": "text-embedding-3-small"
      }
    }
  }
}
```

### 3. Advanced configuration (optional)

For full control, create a config file and point to it:

```json
{
  "mcpServers": {
    "memory": {
      "command": "npx",
      "args": ["-y", "@cablate/memory-lancedb-mcp"],
      "env": {
        "MEMORY_LANCEDB_CONFIG": "/path/to/config.json"
      }
    }
  }
}
```

See [config.example.json](config.example.json) for a full example.

---

## MCP Tools

This server exposes the following tools to MCP clients:

### Core Tools

| Tool             | Description                                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------------------------------ |
| `memory_recall`  | Hybrid retrieval (vector + keyword) with batch support (`queries` array), relation-aware 1-hop expansion, topic filtering, and maintenance hints. Responses use XML tags (`<memories>`, `<hints>`, `<refs>`) for clean parsing. |
| `memory_store`   | Save information to long-term memory with importance scoring and noise filtering. Auto-links related memories, detects contradictions, and auto-infers topic labels. |
| `memory_forget`  | Delete memories by ID or search query.                                                                             |
| `memory_update`  | Update existing memories. Temporal categories auto-supersede to preserve history.                                  |
| `memory_merge`   | Merge two related memories into one. Invalidates both originals and creates a unified entry.                       |
| `memory_history` | Trace version history of a memory through its supersede/merge chain.                                               |

### Management Tools (opt-in)

| Tool           | Description                                                                                      |
| -------------- | ------------------------------------------------------------------------------------------------ |
| `memory_stats` | Get memory usage statistics by scope and category.                                               |
| `memory_list`  | List recent memories with optional filtering.                                                    |
| `memory_lint`  | Run health checks: detect orphan memories, stale entries, and auto-fix missing relations.        |

Enable with `"enableManagementTools": true` in config.

### Self-Improvement Tools (opt-in, disabled by default)

| Tool                             | Description                                           |
| -------------------------------- | ----------------------------------------------------- |
| `self_improvement_log`           | Log structured learning/error entries for governance. |
| `self_improvement_extract_skill` | Create skill scaffolds from learning entries.         |
| `self_improvement_review`        | Summarize governance backlog.                         |

Enable with `"enableSelfImprovementTools": true` in config or `MEMORY_ENABLE_SELF_IMPROVEMENT=true` env var.

### Visualization Tools (on by default)

| Tool | Description |
|------|-------------|
| `memory_visualize` | Generate an interactive HTML visualization of the memory graph. Shows semantic clusters, similarity edges, duplicate detection, importance distribution, and growth timeline. |

The visualization computes cosine similarity edges between all memories, runs Label Propagation clustering, and detects near-duplicate pairs (similarity >= 0.90). The output is a self-contained HTML file that can be opened in any browser.

**Parameters:**
- `output_path` — File path to write HTML. If omitted, returns HTML content directly.
- `scope` — Scope to visualize (default: all accessible scopes).
- `threshold` — Cosine similarity threshold for edges (0.0–1.0, default: 0.65).
- `max_neighbors` — Maximum edges per node (default: 4).

Disable with `"enableVisualizationTools": false` in config.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                  server.ts (MCP Server)                  │
│    Tool Registration · Config Loading · Request Routing  │
└────────┬──────────┬──────────┬──────────┬───────────────┘
         │          │          │          │
    ┌────▼───┐ ┌────▼───┐ ┌───▼────┐ ┌──▼──────────┐
    │ store  │ │embedder│ │retriever│ │   scopes    │
    │ .ts    │ │ .ts    │ │ .ts    │ │    .ts      │
    └────────┘ └────────┘ └────────┘ └─────────────┘
         │                     │
    ┌────▼────────┐      ┌────▼──────────┐
    │smart-       │      │noise-filter.ts│
    │metadata.ts  │      │decay-engine.ts│
    └─────────────┘      └───────────────┘
```

### Multi-Stage Scoring Pipeline

```
Query → embedQuery() ─┐
                       ├─→ RRF Fusion → Rerank → Lifecycle Decay → Length Norm → Filter
Query → BM25 FTS ─────┘
```

| Stage                    | Effect                                                         |
| ------------------------ | -------------------------------------------------------------- |
| **RRF Fusion**           | Combines semantic and exact-match recall                       |
| **Cross-Encoder Rerank** | Promotes semantically precise hits                             |
| **Lifecycle Decay**      | Weibull freshness + access frequency + importance × confidence |
| **Length Normalization** | Prevents long entries from dominating (anchor: 500 chars)      |
| **Hard Min Score**       | Removes irrelevant results (default: 0.35)                     |
| **MMR Diversity**        | Cosine similarity > 0.85 → demoted                             |

---

## Configuration

### Environment Variables

| Variable                | Required | Description                                    |
| ----------------------- | -------- | ---------------------------------------------- |
| `EMBEDDING_API_KEY`     | Yes      | API key for embedding provider                 |
| `EMBEDDING_MODEL`       | No       | Model name (default: `text-embedding-3-small`) |
| `EMBEDDING_BASE_URL`    | No       | Custom base URL for non-OpenAI providers       |
| `MEMORY_DB_PATH`        | No       | LanceDB storage directory                      |
| `MEMORY_LANCEDB_CONFIG` | No       | Path to JSON config file                       |

### Config File

<details>
<summary><strong>Full configuration example</strong></summary>

```json
{
  "embedding": {
    "apiKey": "${EMBEDDING_API_KEY}",
    "model": "jina-embeddings-v5-text-small",
    "baseURL": "https://api.jina.ai/v1",
    "dimensions": 1024,
    "taskQuery": "retrieval.query",
    "taskPassage": "retrieval.passage",
    "normalized": true
  },
  "dbPath": "./memory-data",
  "retrieval": {
    "mode": "hybrid",
    "vectorWeight": 0.7,
    "bm25Weight": 0.3,
    "minScore": 0.3,
    "rerank": "cross-encoder",
    "rerankApiKey": "${JINA_API_KEY}",
    "rerankModel": "jina-reranker-v3",
    "rerankEndpoint": "https://api.jina.ai/v1/rerank",
    "rerankProvider": "jina",
    "candidatePoolSize": 20,
    "hardMinScore": 0.35,
    "filterNoise": true
  },
  "enableManagementTools": true,
  "enableSelfImprovementTools": false,
  "enableVisualizationTools": true,
  "scopes": {
    "default": "global",
    "definitions": {
      "global": { "description": "Shared knowledge" },
      "agent:my-bot": { "description": "Private to my-bot" }
    },
    "agentAccess": {
      "my-bot": ["global", "agent:my-bot"]
    }
  },
  "decay": {
    "recencyHalfLifeDays": 30,
    "frequencyWeight": 0.3,
    "intrinsicWeight": 0.3
  }
}
```

</details>

<details>
<summary><strong>Embedding providers</strong></summary>

Works with **any OpenAI-compatible embedding API**:

| Provider           | Model                           | Base URL                                                   | Dimensions |
| ------------------ | ------------------------------- | ---------------------------------------------------------- | ---------- |
| **OpenAI**         | `text-embedding-3-small`        | `https://api.openai.com/v1`                                | 1536       |
| **Jina**           | `jina-embeddings-v5-text-small` | `https://api.jina.ai/v1`                                   | 1024       |
| **DeepInfra**      | `Qwen/Qwen3-Embedding-8B`       | `https://api.deepinfra.com/v1/openai`                      | 1024       |
| **Google Gemini**  | `gemini-embedding-001`          | `https://generativelanguage.googleapis.com/v1beta/openai/` | 3072       |
| **Ollama** (local) | `nomic-embed-text`              | `http://localhost:11434/v1`                                | _varies_   |

</details>

<details>
<summary><strong>Rerank providers</strong></summary>

| Provider             | `rerankProvider` | Endpoint                                                | Example Model             |
| -------------------- | ---------------- | ------------------------------------------------------- | ------------------------- |
| **Jina**             | `jina`           | `https://api.jina.ai/v1/rerank`                         | `jina-reranker-v3`        |
| **Hugging Face TEI** | `tei`            | `http://host:8081/rerank`                               | `BAAI/bge-reranker-v2-m3` |
| **SiliconFlow**      | `siliconflow`    | `https://api.siliconflow.com/v1/rerank`                 | `BAAI/bge-reranker-v2-m3` |
| **Voyage AI**        | `voyage`         | `https://api.voyageai.com/v1/rerank`                    | `rerank-2.5`              |
| **Pinecone**         | `pinecone`       | `https://api.pinecone.io/rerank`                        | `bge-reranker-v2-m3`      |
| **DashScope**        | `dashscope`      | `https://dashscope.aliyuncs.com/api/v1/services/rerank` | `gte-rerank`              |

</details>

---

## Core Features

### Hybrid Retrieval

- **Vector Search** — semantic similarity via LanceDB ANN (cosine distance)
- **BM25 Full-Text Search** — exact keyword matching via LanceDB FTS index
- **Fusion** — vector score as base, BM25 hits get a 15% boost

### Cross-Encoder Reranking

- Supports Jina, TEI, SiliconFlow, Voyage AI, Pinecone, DashScope
- Hybrid scoring: 60% cross-encoder + 40% original fused score
- Graceful degradation on API failure

### Multi-Scope Isolation

- Built-in scopes: `global`, `agent:<id>`, `custom:<name>`, `project:<id>`, `user:<id>`
- Agent-level access control via `scopes.agentAccess`

### Noise Filtering

- Filters agent refusals, meta-questions, greetings, low-quality content
- CJK-aware thresholds (Chinese: 6 chars vs English: 15 chars)

### Memory Lifecycle (Decay + Tiers)

- **Weibull Decay**: composite score = recency + frequency + intrinsic value
- **Three-Tier Promotion**: Peripheral ↔ Working ↔ Core
- **Access Reinforcement**: frequently recalled memories decay slower

### Smart Metadata

- L0/L1/L2 layered storage for progressive detail retrieval
- Temporal versioning with supersede chains
- Fact key deduplication

### Auto-Linking & Contradiction Detection

- **Auto-Link**: `memory_store` automatically creates bidirectional relations with similar memories (cosine > 0.7)
- **Contradiction Hints**: Detects potential contradictions between new and existing memories at store time
- **Health Checks**: `memory_lint` finds orphan memories, stale entries, and auto-fixes missing relations

### Topic Labels & Recall Hints

- **Topic Auto-Inference**: `memory_store` infers topic labels from similar memories. Explicit `topic` param overrides.
- **Topic Filtering**: `memory_recall` accepts a `topic` parameter to retrieve all memories under a specific topic.
- **Recall Hints**: `memory_recall` appends maintenance hints — near-duplicate pairs, dormant memories, and contradictions among results — so agents can act on issues without separate health checks.

### Batch Recall & Token Efficiency

- **Batch Recall**: `memory_recall` accepts a `queries` string array — multiple searches run in parallel, results are deduplicated, and memories matching multiple queries rank higher. Limit auto-scales by query count.
- **Relation-Aware Recall**: Results include 1-hop expansion via auto-linked relations, surfacing semantically connected memories that vector search alone would miss.
- **Compact Responses**: IDs compressed to 8-char refs in footer, category/scope tags removed from results, store responses minimized. Output wrapped in XML tags (`<memories>`, `<hints>`, `<refs>`) for clean model parsing.

---

## Database Schema

LanceDB table `memories`:

| Field        | Type          | Description                                                                  |
| ------------ | ------------- | ---------------------------------------------------------------------------- |
| `id`         | string (UUID) | Primary key                                                                  |
| `text`       | string        | Memory text (FTS indexed)                                                    |
| `vector`     | float[]       | Embedding vector                                                             |
| `category`   | string        | `preference` / `fact` / `decision` / `entity` / `skill` / `lesson` / `other` |
| `scope`      | string        | Scope identifier                                                             |
| `importance` | float         | Importance score 0–1                                                         |
| `timestamp`  | int64         | Creation timestamp (ms)                                                      |
| `metadata`   | string (JSON) | Extended metadata (L0/L1/L2, tier, access_count, etc.)                       |

---

## Development

```bash
git clone https://github.com/cablate/memory-lancedb-mcp.git
cd memory-lancedb-mcp
npm install
npm test
```

Run the server locally:

```bash
EMBEDDING_API_KEY=your-key npx tsx server.ts
```

---

## License

MIT — see [LICENSE](LICENSE) for details.
