# CLAUDE.md

## Project Principles

1. **Zero-config works** — `EMBEDDING_API_KEY` alone should give you a working memory server
2. **Graceful degradation** — Rerank API down? Fall back to cosine. FTS index fails? Fall back to lexical scan. No LLM? Skip extraction
3. **Behavior over implementation** — Tests validate what the tool does, not how it's coded internally
4. **Backward compatible** — New features must not break existing configs. Metadata schema changes must include migration
5. **Noise-resilient** — Filter junk at every layer: input, extraction, retrieval, output

## Git Workflow

- **Never push directly to master.** All changes go through feature branch → PR → CI pass → merge.
- Flow: `git checkout -b feat/xxx` → `git push -u origin feat/xxx` → `gh pr create`
- Release is fully automated: merge to master → auto version bump → npm publish → GitHub Release

## Development Commands

```bash
npm run lint          # ESLint
npm run format        # Prettier auto-fix
npm run format:check  # Prettier check (CI uses this)
npm run typecheck     # TypeScript (currently has known errors, not enforced in CI)
npm test              # All tests via node --test
```

## Architecture

TypeScript executed directly via tsx/jiti — no build step.

### Module Map

```
server.ts              ← MCP entry point: tool registration + request routing
config.ts              ← Config loading (env vars + JSON file → typed McpConfig)
bin/memory-lancedb-mcp.mjs ← CLI entry (tsx/jiti loader)

src/
├── store.ts           ← LanceDB CRUD with scope filtering, serialized updates, FTS index
├── embedder.ts        ← OpenAI-compatible embedding (LRU cache, multi-key rotation, auto-chunking)
├── retriever.ts       ← Hybrid retrieval pipeline: vector+BM25 → RRF → rerank → scoring → filter
├── scopes.ts          ← Multi-scope isolation (global, agent:, project:, user:, custom:)
├── decay-engine.ts    ← Weibull decay scoring (recency × frequency × intrinsic × tier)
├── tier-manager.ts    ← 3-tier lifecycle (Peripheral ↔ Working ↔ Core)
├── smart-metadata.ts  ← L0/L1/L2 metadata layers, temporal versioning, relation graph
├── smart-extractor.ts ← LLM-powered extraction (standalone, not wired in server.ts by default)
├── noise-filter.ts    ← Regex noise detection (denials, boilerplate, meta-questions)
├── access-tracker.ts  ← Debounced access count tracking with reinforcement
├── llm-client.ts      ← OpenAI chat wrapper for JSON extraction
├── chunker.ts         ← Semantic text chunking for oversized inputs
├── memory-categories.ts ← 6-category taxonomy + dedup behavior rules
├── workspace-boundary.ts ← Routes profile/identity facts away from LanceDB
└── reflection-*.ts    ← Reflection/governance stores (library code)
```

### Data Flow

```
memory_store:  noise check → boundary check → embed → dedup check → build metadata → LanceDB write
memory_recall: resolve scopes → embed query → vector+BM25 parallel → RRF fusion → rerank → decay → noise filter → MMR dedup
memory_forget: resolve ID (or fuzzy search) → LanceDB delete
memory_update: resolve ID → temporal versioning (if applicable) → re-embed → LanceDB update
```

## Tool Positioning

See `docs/tool-positioning.md` for each tool's functional positioning, design intent, processing pipeline, and design decisions.

## Tool Change Checklist

When adding, removing, or renaming an MCP tool:

| # | File | What to update |
|---|------|----------------|
| 1 | `server.ts` | Tool definition (CORE_TOOLS / MANAGEMENT_TOOLS / SELF_IMPROVEMENT_TOOLS) + switch case handler |
| 2 | `README.md` | MCP Tools tables |
| 3 | `README_ZH.md` | MCP 工具表格 (Traditional Chinese) |
| 4 | `test/mcp-contract-smoke.test.mjs` | CORE_TOOL_NAMES array |
| 5 | `server.json` | Description if tool count is mentioned |

## PR Checklist

Before submitting a PR:

1. `npm run lint` — 0 errors (warnings OK)
2. `npm run format:check` — all files pass
3. `npm test` — all tests pass
4. If tool changed → update all files in Tool Change Checklist above
5. If config option added → update `config.example.json` + README Config section
