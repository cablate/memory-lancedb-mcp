# Contributing to memory-lancedb-mcp

## Development Setup

```bash
git clone https://github.com/cablate/memory-lancedb-mcp.git
cd memory-lancedb-mcp
npm install
```

Copy `.env.example` to `.env` and fill in your embedding API key for local testing.

## Development SOP

### 1. Before You Code

- Read `CLAUDE.md` for project principles, architecture, and tool change checklist
- Check existing issues and PRs to avoid duplicate work
- For non-trivial changes, open an issue first to discuss the approach

### 2. Branch & Develop

```bash
git checkout -b feat/your-feature    # or fix/your-fix
```

- Follow existing code patterns — this project uses TypeScript executed directly (no build step)
- Don't add unnecessary dependencies — this is a lightweight MCP server
- Configuration changes must be backward compatible (new options should have sensible defaults)

### 3. Validate

Run the full validation suite before pushing:

```bash
npm run lint          # 0 errors required (warnings are OK)
npm run format:check  # Must pass
npm test              # All tests must pass
```

Auto-fix formatting issues:

```bash
npm run format
```

### 4. Submit PR

```bash
git push -u origin feat/your-feature
gh pr create
```

CI will automatically run lint + format check + tests on your PR.

### 5. After Merge

Release is fully automated. When your PR merges to `master`:
- Version is auto-bumped (patch)
- Published to npm + MCP Registry
- CHANGELOG updated
- GitHub Release created

No manual steps needed.

## Testing Guidelines

### Test Philosophy

- **Test behavior, not implementation** — validate what a tool returns, not how it internally computes it
- **Don't chase coverage numbers** — one meaningful contract test beats ten trivial unit tests
- **Tests should rarely change** — if a refactor breaks tests, the tests were testing the wrong thing

### Test Layers

| Layer | Purpose | When to write |
|-------|---------|---------------|
| **Contract/Smoke** | MCP protocol compliance, tool registration | Only when tools are added/removed |
| **Behavior** | Core functionality (store/recall/forget/update works correctly) | When adding new user-facing behavior |
| **Regression** | Specific bug reproduction | When fixing a bug |

### Writing Tests

- Tests live in `test/` as `.mjs` files
- Use `node:test` framework (preferred) or plain scripts with `node:assert/strict`
- Mock external services (embedding APIs, LLM) — tests must run without API keys
- Use temp directories for LanceDB data — clean up in `finally` blocks
- Run with: `node --test test/your-test.test.mjs`

### What NOT to Test

- Internal data structures or intermediate state
- Exact log messages or debug output
- Third-party library behavior (LanceDB internals, OpenAI SDK)
- Unreachable error paths or hypothetical scenarios

## Code Style

- Enforced by ESLint + Prettier (see `.prettierrc`)
- 120 char line width, double quotes, trailing commas
- `any` types are warned but allowed — prefer explicit types for new code
- Unused variables prefixed with `_` are allowed

## Architecture Notes

See `CLAUDE.md` for the full module map and data flow diagrams.

Key rules:
- `server.ts` is the only entry point — keep it focused on MCP protocol handling
- Business logic belongs in `src/` modules, each with a single responsibility
- New features should degrade gracefully when their dependencies are unavailable
