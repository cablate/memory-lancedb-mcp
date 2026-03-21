# CLAUDE.md

## Git Workflow

- **永遠不要直接推 master**。所有變更都要先開 feature branch、推上去、建 PR，等 CI 通過後才合併。
- Commit 完成後走 `git checkout -b feat/xxx` → `git push -u origin feat/xxx` → `gh pr create` 流程。

## Development

```bash
npm run lint          # ESLint 檢查
npm run format:check  # Prettier 格式檢查
npm run typecheck     # TypeScript 型別檢查
npm test              # 執行所有測試
```

## Architecture

本專案是 TypeScript 直接執行（透過 tsx/jiti），不經過編譯步驟。

- `server.ts` — MCP 伺服器入口，工具註冊與請求路由
- `config.ts` — 設定載入與驗證
- `src/` — 核心模組（store、embedder、retriever、scopes 等）
- `bin/` — CLI 入口
- `test/` — 測試檔案（純 Node.js，無框架）

## PR Checklist

提交 PR 前請確認：

1. `npm run lint` 通過
2. `npm run format:check` 通過
3. `npm run typecheck` 通過
4. `npm test` 通過
5. 如有新增/修改工具，更新 README.md 的 MCP Tools 表格
