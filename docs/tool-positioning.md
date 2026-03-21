# MCP Tool 功能定位與設計意圖

## 工具分層架構

```
┌─────────────────────────────────────────────────┐
│  CORE TOOLS（核心記憶操作）                       │
│  memory_recall / memory_store / memory_forget    │
│  memory_update                                   │
├─────────────────────────────────────────────────┤
│  MANAGEMENT TOOLS（觀測與管理）                   │
│  memory_stats / memory_list                      │
├─────────────────────────────────────────────────┤
│  SELF-IMPROVEMENT TOOLS（治理與演化）             │
│  self_improvement_log / extract_skill / review    │
└─────────────────────────────────────────────────┘
```

---

## Core Tools

### memory_store

**定位**：寫入新記憶。AI agent 的「記住這件事」動作。

**設計意圖**：不只是寫入 DB，而是一個有防護的寫入管線：
1. **Noise filter** — 自動過濾問候語、樣板文字、meta-question（「你是誰」之類的）
2. **Workspace boundary** — 個人 profile 類資訊（名字、身份、偏好）會被攔截，引導寫入 USER.md 而非向量 DB
3. **Embedding** — 文字轉向量
4. **Dedup check** — cosine > 0.98 視為重複，不寫入
5. **Smart metadata** — 自動生成 L0/L1/L2 三層摘要

**關鍵參數**：
- `text`（必填）— 要記住的內容
- `importance`（預設 0.7）— 影響衰減排序
- `category` — preference / fact / decision / entity / skill / other
- `scope` — 記憶隔離空間

**設計決策**：
- importance 有下限 clamp（最低 0.7），避免 AI 自行設太低導致記憶快速衰減
- noise filter 是 fail-open 的（寧可多存也不漏存）

---

### memory_recall

**定位**：搜尋相關記憶。AI agent 的「我記得什麼」動作。

**設計意圖**：混合檢索管線，不是簡單的向量搜尋：
1. **Scope 解析** — 只搜尋 agent 有權限的 scope
2. **Hybrid retrieval** — Vector search + BM25 全文搜尋並行
3. **RRF fusion** — Reciprocal Rank Fusion 合併兩路結果
4. **Rerank**（可選）— 外部 reranker API 精排，失敗時 fall back 到 cosine
5. **Decay scoring** — Weibull 衰減（recency × frequency × intrinsic × tier）
6. **Noise filter** — 結果層再過濾一次噪音
7. **Workspace boundary filter** — 排除 USER.md 專屬內容
8. **Access tracking** — 被召回的記憶自動 +1 access_count

**關鍵參數**：
- `query`（必填）— 搜尋語句
- `limit`（預設 5，上限 20）
- `scope` — 指定搜尋範圍
- `category` — 按類別篩選

**設計決策**：
- 有 retry 機制（`retrieveWithRetry`），retrieval 失敗會重試
- Access tracking 用 `Promise.allSettled`，不因 tracking 失敗而影響結果回傳
- 結果格式：`序號. [ID] [類別標籤] 內容文字`

---

### memory_forget

**定位**：刪除記憶。支援精確刪除和模糊搜尋刪除兩種模式。

**設計意圖**：安全刪除，避免誤刪：
- **ID 刪除**（`memoryId`）— 精確刪除，直接操作
- **Query 刪除**（`query`）— 先搜尋，只有唯一結果且 score > 0.9 才自動刪除；否則列出候選讓 AI 確認

**設計決策**：
- 不提供批次刪除功能（刻意的限制）
- 模糊刪除的門檻故意設高（0.9），寧可多確認不誤刪
- Scope 權限檢查在刪除前

---

### memory_update

**定位**：更新現有記憶。最複雜的 tool，包含時序版本管理。

**設計意圖**：區分兩種更新模式：

**模式 A — Temporal Supersede（時序取代）**：
- 觸發條件：修改 `text` + 記憶屬於 temporal versioned category（preference, entity）
- 行為：建立**新記憶**，舊記憶標記 `invalidated_at` 和 `superseded_by`
- 目的：保留歷史變化軌跡（「使用者 3 月偏好 A，5 月改為 B」）

**模式 B — In-place Update（原地更新）**：
- 觸發條件：只改 importance / category，或非 temporal category
- 行為：直接更新原記錄

**ID 解析**：
- UUID 格式 → 直接使用
- 非 UUID（如文字描述）→ 先用 retriever 搜尋，高信度自動 resolve，多結果列出選擇

**設計決策**：
- Supersede 是單向的（新 → 舊的 supersedes 關係鏈）
- 舊記錄不刪除，只標記 invalidated，支持審計追蹤
- Noise filter 在文字更新時也會觸發

---

## Management Tools

### memory_stats

**定位**：記憶系統的儀表板。觀測用，不修改任何資料。

**輸出**：
- 總記憶數
- 可用 scope 數量
- 檢索模式（hybrid/vector/keyword）
- FTS 支援狀態
- 按 scope 分組計數
- 按 category 分組計數

**使用場景**：AI agent 自我診斷、系統健康檢查、向使用者報告記憶狀態

---

### memory_list

**定位**：按時間序列瀏覽記憶。與 `memory_recall` 的差別是**不需要查詢語句**。

**使用場景**：
- 瀏覽最近記憶
- 按 scope/category 篩選列表
- 分頁瀏覽（offset + limit）

**設計決策**：
- 上限 50 條（防止單次拉取過多）
- 這是唯一不需要語義搜尋的讀取方式

---

## Self-Improvement Tools

### self_improvement_log

**定位**：結構化記錄 AI agent 的學習和錯誤。寫入 `.learnings/` 目錄。

**設計意圖**：
- 提供 AI 自我反思的持久化管道
- 結構化格式（type/summary/details/suggestedAction/category/area/priority）便於後續治理
- 寫入檔案系統而非 LanceDB（這是治理資料，不是記憶資料）

**使用場景**：AI 犯錯後記錄經驗、發現最佳實踐時記錄

---

### self_improvement_extract_skill

**定位**：從學習記錄中提煉可複用的 Skill scaffold。

**設計意圖**：學習 → Skill 的升級管道：
1. 從 `.learnings/LEARNINGS.md` 或 `ERRORS.md` 找到指定 entry
2. 生成 Skill 骨架（SKILL.md，包含 name/description/steps）
3. 標記原 learning entry 為 `promoted_to_skill`

**設計決策**：
- 只生成骨架，不自動填充內容（需要人或 AI 手動完善）
- 嚴格校驗 learningId 格式（`LRN-YYYYMMDD-NNN`）和 skillName 格式（lowercase-hyphen）

---

### self_improvement_review

**定位**：治理積壓檢視。快速了解有多少待處理的學習/錯誤記錄。

**輸出**：pending / high-priority / promoted 計數 + 建議處理流程

---

## 未接入的模組（Library Code）

以下模組存在於 `src/` 但**未在 server.ts 中直接使用**：

| 模組 | 狀態 | 說明 |
|------|------|------|
| `smart-extractor.ts` | **未接入** | LLM-powered 資訊擷取（從對話中自動提取 facts/preferences）。需要額外 LLM API 配置。目前是獨立 library |
| `tier-manager.ts` | **未接入** | 3-tier 生命週期管理（Peripheral ↔ Working ↔ Core）。設計完成但未整合進 recall/store 流程 |
| `chunker.ts` | **間接使用** | Embedder 內部呼叫，超長文字自動分塊 |
| `decay-engine.ts` | **已接入** | 透過 retriever 的 scoring pipeline 使用 |
| `noise-filter.ts` | **已接入** | store 和 recall 都使用 |
| `access-tracker.ts` | **已接入** | recall 時自動更新 access metadata |

### 未來擴充潛力

1. **SmartExtractor 整合** — 讓 `memory_store` 自動從長文中提取結構化 facts，而非只存原文
2. **TierManager 整合** — 讓記憶自動在 Peripheral/Working/Core 之間流動，低使用頻率的記憶降級
3. **新 Tool：memory_merge** — 合併相似記憶，減少冗餘
4. **新 Tool：memory_timeline** — 按時間軸查看某個 fact_key 的版本歷史（利用現有 supersede 機制）

---

## Scope 隔離模型

```
global          ← 所有 agent 共享
agent:{name}    ← 特定 agent 專屬
project:{name}  ← 特定專案專屬
user:{name}     ← 特定使用者專屬
custom:{name}   ← 自定義
```

每個 tool 操作都經過 `scopeManager.isAccessible()` 檢查。Agent 的可存取 scope 在配置中定義。

## Workspace Boundary 模型

攔截特定類型的記憶，引導到更適合的儲存位置：
- 個人 profile 資訊（名字、年齡、職業、居住地）→ 引導至 USER.md
- 配置可自訂哪些 slot 被攔截（`workspaceBoundary.userMdExclusive`）
