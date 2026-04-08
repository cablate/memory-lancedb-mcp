<div align="center">

<img src="assets/banner.png" alt="memory-lancedb-mcp" width="100%" />

**Persistent, intelligent long-term memory for any MCP-compatible AI agent.**

[![npm version](https://img.shields.io/npm/v/@cablate/memory-lancedb-mcp)](https://www.npmjs.com/package/@cablate/memory-lancedb-mcp)
[![npm downloads](https://img.shields.io/npm/dm/@cablate/memory-lancedb-mcp)](https://www.npmjs.com/package/@cablate/memory-lancedb-mcp)
[![LanceDB](https://img.shields.io/badge/LanceDB-Vectorstore-orange)](https://lancedb.com)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

**English** | [繁體中文](README_ZH.md)

</div>

---

## Before / After

Without memory, every session starts from zero. With memory-lancedb-mcp, your agent accumulates knowledge across sessions — automatically.

**Before** — agent has no context:
```
User: "Use the same animation style as last time"
Agent: "I don't have any context about previous animations. Could you describe what you'd like?"
```

**After** — agent recalls past decisions:
```xml
<memories>
1. Remotion spring animation: use duration >= 20, damping 12-15 for smooth easing
2. Video export preset: 1080p, 30fps for social, 60fps for demo
</memories>
<refs>#1=6352a7d2 #2=bed148f0</refs>
```

Store responses are minimal — no noise, just confirmation:
```
Stored. [topic: remotion]
```

---

## Quick Start

### 1. Install

```bash
npm install -g @cablate/memory-lancedb-mcp
```

### 2. Configure

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

<details>
<summary><strong>Advanced: use a config file for full control</strong></summary>

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

See [config.example.json](config.example.json) for all options.

</details>

---

## How It Works

```
          store                          recall
            │                              │
   ┌────────▼────────┐           ┌────────▼────────┐
   │  Filter junk     │           │ Search by meaning │
   │  Save + embed    │           │   AND keywords    │
   │  Link related    │           │ Re-rank results   │
   │  Flag conflicts  │           │ Fade stale ones   │
   │  Tag topic       │           │ Pull in related   │
   └────────┬────────┘           │ Merge duplicates  │
            │                    └────────┬────────┘
            ▼                             ▼
   ┌─────────────────────────────────────────────┐
   │          LanceDB (local, zero-config)        │
   └─────────────────────────────────────────────┘
```

Every `memory_store` saves to a local database, automatically links related memories, flags contradictions, and assigns topic labels — no extra API calls needed. Every `memory_recall` searches by both meaning and keywords, pulls in related memories the main search might miss, and includes maintenance hints so the agent can keep its own knowledge base clean.

---

## Features

### Retrieval

- **Finds the right memory even when you use different words** — searches by meaning and exact keywords simultaneously, then combines the best of both
- **More precise results, not just surface matches** — an optional second pass re-ranks results by actual relevance (6 providers supported)
- **Search multiple topics at once** — pass a `queries` array to search several keywords in one call; results are deduplicated and memories that match multiple queries rank higher
- **Finding A automatically surfaces related B** — when a memory is found, its linked neighbors are pulled in too, even if they use completely different words
- **Minimal token overhead** — responses use compact XML tags (`<memories>`, `<hints>`, `<refs>`) with short IDs, no category/scope noise

### Storage

- **Related memories link themselves** — when you store something new, it automatically creates bidirectional links to similar existing memories
- **Conflicts get flagged** — if a new memory contradicts an existing one, you get a warning so nothing silently overwrites
- **Topics assigned automatically** — each memory gets a topic label inferred from its content and neighbors; you can also set it explicitly
- **Junk gets filtered out** — greetings, refusals, and meta-questions are rejected before they waste storage

### Lifecycle

- **Frequently used memories stay sharp, stale ones fade** — a decay model balances how recent, how often accessed, and how important each memory is
- **Memories earn their keep** — three tiers (Peripheral → Working → Core); the more a memory gets used, the faster it promotes
- **Full version history** — when you update a memory, the old version is preserved in a chain you can trace with `memory_history`

### Maintenance

- **The agent maintains itself** — recall results include inline hints about duplicates, dormant memories, and contradictions
- **Health checks on demand** — `memory_lint` finds orphaned memories, stale entries, and missing links, then fixes what it can
- **Merge duplicates** — `memory_merge` combines two redundant memories into one; originals are marked as superseded
- **See your memory space** — `memory_visualize` generates an interactive HTML graph you can open in any browser

---

## Visualization

Run `memory_visualize` to generate an interactive knowledge graph of your memory space:

- Automatic clustering — related memories group together visually
- Similarity edges, duplicate detection, importance sizing
- Time filter, growth animation, cluster view
- Self-contained HTML — open in any browser

---

<details>
<summary><strong>Scoring Pipeline (technical details)</strong></summary>

```
Query → embedQuery() ─┐
                       ├─→ RRF Fusion → Rerank → Lifecycle Decay → Length Norm → Filter
Query → BM25 FTS ─────┘
```

| Stage | Effect |
|-------|--------|
| **RRF Fusion** | Combines semantic and exact-match recall |
| **Cross-Encoder Rerank** | Promotes semantically precise hits |
| **Lifecycle Decay** | Weibull freshness + access frequency + importance |
| **Length Normalization** | Prevents long entries from dominating (anchor: 500 chars) |
| **Hard Min Score** | Removes irrelevant results (default: 0.35) |
| **MMR Diversity** | Cosine similarity > 0.85 → demoted |

</details>

---

## Configuration

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `EMBEDDING_API_KEY` | Yes | API key for embedding provider |
| `EMBEDDING_MODEL` | No | Model name (default: `text-embedding-3-small`) |
| `EMBEDDING_BASE_URL` | No | Custom base URL for non-OpenAI providers |
| `MEMORY_DB_PATH` | No | LanceDB storage directory |
| `MEMORY_LANCEDB_CONFIG` | No | Path to JSON config file |

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

| Provider | Model | Base URL | Dimensions |
|----------|-------|----------|------------|
| **OpenAI** | `text-embedding-3-small` | `https://api.openai.com/v1` | 1536 |
| **Jina** | `jina-embeddings-v5-text-small` | `https://api.jina.ai/v1` | 1024 |
| **DeepInfra** | `Qwen/Qwen3-Embedding-8B` | `https://api.deepinfra.com/v1/openai` | 1024 |
| **Google Gemini** | `gemini-embedding-001` | `https://generativelanguage.googleapis.com/v1beta/openai/` | 3072 |
| **Ollama** (local) | `nomic-embed-text` | `http://localhost:11434/v1` | _varies_ |

</details>

<details>
<summary><strong>Rerank providers</strong></summary>

| Provider | `rerankProvider` | Endpoint | Example Model |
|----------|-----------------|----------|---------------|
| **Jina** | `jina` | `https://api.jina.ai/v1/rerank` | `jina-reranker-v3` |
| **Hugging Face TEI** | `tei` | `http://host:8081/rerank` | `BAAI/bge-reranker-v2-m3` |
| **SiliconFlow** | `siliconflow` | `https://api.siliconflow.com/v1/rerank` | `BAAI/bge-reranker-v2-m3` |
| **Voyage AI** | `voyage` | `https://api.voyageai.com/v1/rerank` | `rerank-2.5` |
| **Pinecone** | `pinecone` | `https://api.pinecone.io/rerank` | `bge-reranker-v2-m3` |
| **DashScope** | `dashscope` | `https://dashscope.aliyuncs.com/api/v1/services/rerank` | `gte-rerank` |

</details>

---

<details>
<summary><strong>Tools Reference</strong></summary>

### Core Tools

| Tool | Description |
|------|-------------|
| `memory_recall` | Search memories — supports batch queries, relation expansion, topic filtering, and inline maintenance hints |
| `memory_store` | Save a memory — auto-links related ones, flags contradictions, infers topic, filters junk |
| `memory_forget` | Delete by ID or search query |
| `memory_update` | Update a memory; the old version is preserved in a version chain |
| `memory_merge` | Merge two memories into one |
| `memory_history` | Trace version history through update/merge chains |

### Management Tools (opt-in)

| Tool | Description |
|------|-------------|
| `memory_stats` | Usage statistics by scope and category |
| `memory_list` | List recent memories with filtering |
| `memory_lint` | Health checks + auto-fix missing relations |

Enable: `"enableManagementTools": true`

### Self-Improvement Tools (opt-in)

| Tool | Description |
|------|-------------|
| `self_improvement_log` | Log structured learning/error entries |
| `self_improvement_extract_skill` | Create skill scaffolds from learnings |
| `self_improvement_review` | Summarize governance backlog |

Enable: `"enableSelfImprovementTools": true`

### Visualization Tools (on by default)

| Tool | Description |
|------|-------------|
| `memory_visualize` | Generate interactive HTML memory graph |

Params: `output_path`, `scope`, `threshold` (default: 0.65), `max_neighbors` (default: 4)

Disable: `"enableVisualizationTools": false`

</details>

---

<details>
<summary><strong>Database Schema</strong></summary>

LanceDB table `memories`:

| Field | Type | Description |
|-------|------|-------------|
| `id` | string (UUID) | Primary key |
| `text` | string | Memory text (FTS indexed) |
| `vector` | float[] | Embedding vector |
| `category` | string | `preference` / `fact` / `decision` / `entity` / `skill` / `lesson` / `other` |
| `scope` | string | Scope identifier |
| `importance` | float | Importance score 0-1 |
| `timestamp` | int64 | Creation timestamp (ms) |
| `metadata` | string (JSON) | Extended metadata (tier, access_count, relations, topic, etc.) |

</details>

---

## Development

```bash
git clone https://github.com/cablate/memory-lancedb-mcp.git
cd memory-lancedb-mcp
npm install
npm test
```

Run locally:

```bash
EMBEDDING_API_KEY=your-key npx tsx server.ts
```

---

## Credits

Built on [CortexReach/memory-lancedb-pro](https://github.com/CortexReach/memory-lancedb-pro) — original work by [win4r](https://github.com/win4r) and contributors.

## License

MIT — see [LICENSE](LICENSE) for details.
