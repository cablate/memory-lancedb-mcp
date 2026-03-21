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

**處理管線**：
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

**處理管線**：
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

**兩種更新模式**：

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

## 模組接入狀態

### 已接入（server.ts 直接使用）

| 模組 | 接入方式 |
|------|---------|
| `noise-filter.ts` | store 和 recall 都使用 |
| `decay-engine.ts` | 透過 retriever 的 scoring pipeline |
| `access-tracker.ts` | recall 時自動更新 access metadata |
| `chunker.ts` | embedder 內部呼叫，超長文字自動分塊 |
| `smart-metadata.ts` | store 和 update 時生成 L0/L1/L2 摘要 |
| `workspace-boundary.ts` | store 攔截 profile 資訊、recall 過濾結果 |
| `scopes.ts` | 所有 tool 的權限檢查 |
| `embedder.ts` | store/update 的向量化 |
| `retriever.ts` | recall/forget/update 的混合檢索 |
| `store.ts` | 所有 tool 的 LanceDB CRUD |

### 未接入（Library Code）

| 模組 | 說明 |
|------|------|
| `smart-extractor.ts` | LLM-powered 資訊擷取（從對話中自動提取 facts/preferences）。需要額外 LLM API 配置 |
| `tier-manager.ts` | 3-tier 生命週期管理（Peripheral ↔ Working ↔ Core）。設計完成但未整合 |

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

---

# 改進路線圖

## 現有痛點分析

基於 AI agent 多工作區（每個 agent 獨立 `.memory-db/`）的實際使用模式，對照現有工具能力，識別出以下差距：

### 痛點 1：Store 不回饋相似記憶

**現狀**：cosine > 0.98 才攔截（完全重複），0.85~0.97 的高度相似記憶靜默通過。
**後果**：同一主題的零散記憶越積越多，例如：
- 「Cab 偏好直接溝通」
- 「Cab 說一次就要聽進去」
- 「與 Cab 討論設計時先提判斷再給選項」

這三條語義高度相關，但都低於 0.98 門檻，全部存入。隨時間推移，碎片化記憶拉低 recall 品質。

**改進**：Store 成功時，附帶回覆最相似的已存記憶（若 cosine > 0.8）。Agent 在存入當下就能判斷要不要調整或合併。

---

### 痛點 2：Recall 缺少時間維度

**現狀**：只能用語義查詢搜尋，沒有時間範圍參數。
**後果**：每次 session 啟動，agent 要用「猜關鍵字」的方式搜記憶。「最近三天學了什麼？」→ 做不到。

**改進**：`memory_recall` 加 `since` 參數（epoch ms 或 `"3d"` / `"1w"` 格式），在 retriever 層加時間過濾。

**啟動協議變化**：
```
# 現在
memory_recall "當前任務相關關鍵字"      ← 命中率靠運氣

# 改完後
memory_recall query="*" since="3d"      ← 最近 3 天全部記憶
memory_recall query="lancedb" since="7d" ← 特定主題 + 時間範圍
```

---

### 痛點 3：Category 缺少 `lesson`

**現狀**：踩坑教訓是 agent 最常記錄的類型，但沒有對應 category。被迫拆成 `fact`（技術事實）+ `decision`（行為決策）雙寫。
**後果**：
- 每次踩坑要存兩條，增加漏存風險
- Recall 時無法 `category: "lesson"` 精準篩選踩坑記錄
- 語義上是一個概念，硬拆成兩條不自然

**改進**：加 `lesson` 到 MEMORY_CATEGORIES enum。Session-end checklist 從「踩坑必須雙層」簡化為「踩坑 → `memory_store category="lesson"`」。

---

### 痛點 4：Stats 缺少休眠記憶統計

**現狀**：`memory_stats` 只輸出總數和分類計數，不知道有多少記憶從未被 recall。
**後果**：記憶只增不減，agent 沒有動力整理。100 條記憶裡可能有 40 條從未被用過，但 agent 看不到。

**改進**：`memory_stats` 加 dormant count（超過 N 天未被 access 的記憶數量）。不需要接入 TierManager，只需查詢 `last_accessed_at` 欄位。

**搭配排程使用**：
```yaml
# 每週記憶衛生排程
schedule: "0 9 * * 1"
prompt: |
  1. memory_stats 看 dormant count
  2. dormant > 20 → 列出最舊的 10 條，判斷 forget 或保留
  3. 檢查同 category 下有無高度重疊的記憶
  4. 產出簡報寫入 memory/{date}.md
```

---

### 痛點 5：Self-Improvement Tools 與現有治理體系衝突

**現狀**：三個 self_improvement tools 寫入 `.learnings/` 目錄（LEARNINGS.md、ERRORS.md）。
**問題**：在多 agent 工作區架構中，`.learnings/` 已被移除（與 CLAUDE.md Lessons Learned、knowledge/ 嚴重重疊）。這三個 tool 寫入的目錄不存在。

**建議**：移除這三個 tool 的暴露，或重新定位為寫入向量記憶（而非檔案系統）。

---

## 實作優先級

| 優先級 | 改進項 | 改動量 | 效益 |
|--------|--------|--------|------|
| **P1** | Store 回饋相似記憶 | 小 — 改 `handleMemoryStore` 回傳 | 從源頭提升記憶品質 |
| **P1** | 加 `lesson` category | 小 — 加 enum 值 | 消除雙寫負擔 |
| **P2** | Recall 加 `since` 參數 | 中 — 改 retriever 層 | 解決 session 啟動最大痛點 |
| **P2** | Stats 加 dormant count | 小 — 加一個查詢 | 記憶衛生的觀測基礎 |
| **P3** | Self-Improvement tools 重定位 | 中 — 移除或重寫 handler | 消除死功能 |

## 推遲項目

| 項目 | 理由 |
|------|------|
| memory_merge | 有價值但複雜度高（向量重算、supersede 鏈、metadata 合併）。先用 weekly hygiene 手動整理 |
| memory_history | 版本追溯是低頻需求。Supersede 機制已在底層記錄，未來需要時再加 tool 暴露 |
| TierManager 接入 | dormant count 能覆蓋 80% 需求。等 agent 規模更大時再考慮自動化生命週期 |
| SmartExtractor 接入 | 需要額外 LLM API 配置且增加成本。當前 agent 手動 store 的品質已足夠 |
| Dual-write 自動同步 | 檔案記憶（git-versioned 人類可讀）和向量記憶（AI 語義檢索）目的不同，強制同步模糊邊界 |

## 使用整合建議

### 啟動協議整合（Recall + since）

改完 `since` 參數後，啟動協議第 5 步可標準化為：
```
1. memory_recall query="*" since="3d" limit=10   → 最近 3 天的記憶快照
2. memory_recall query="{當前任務關鍵字}"          → 語義搜尋補充
```

兩步組合 = 確定性（時間）+ 語義（主題），覆蓋率大幅提升。

### Session-End Checklist 整合（lesson + store 回饋）

```
# 改完後的 checklist 流程
踩坑 → memory_store category="lesson"（一步到位，不再雙寫）
       ↓
     系統回饋：「Related: 2 similar lessons exist」
       ↓
     Agent 判斷：合併？跳過？補充？
```

### 週期性記憶衛生（Stats dormant + 排程）

```yaml
# schedules/weekly-memory-hygiene.yaml
schedule: "0 9 * * 1"
prompt: |
  執行記憶衛生檢查：
  1. memory_stats → 看 dormant count
  2. dormant > 20 → memory_list 列出，逐條判斷 forget 或保留
  3. 同 category 高度重疊 → 建議 merge（手動或未來 memory_merge tool）
  4. 產出簡報寫入 memory/{date}.md
```

### Skill 輔助（sys-memory-hygiene）

建立記憶整理的標準化方法：
- 什麼條件觸發整理（dormant > 20、同主題 > 3 條）
- 整理動作標準（forget 門檻、merge 判斷、保留理由）
- 整理後驗證（重新跑 memory_stats 確認改善）
