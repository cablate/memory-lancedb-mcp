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
- `category` — preference / fact / decision / entity / skill / lesson / other
- `scope` — 記憶隔離空間

**設計決策**：

- importance 有下限 clamp（最低 0.7），避免 AI 自行設太低導致記憶快速衰減
- noise filter 是 fail-open 的（寧可多存也不漏存）
- Store 成功後，回覆中附帶 cosine 0.8~0.98 的相似記憶提示（v2.0.10+），讓 agent 當場判斷是否需要合併或調整

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
- `since`（v2.0.10+）— 時間範圍過濾，支援 `"3d"` / `"1w"` / `"2h"` 短碼或 ISO 時間戳

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

### memory_merge

**定位**：合併兩條相關記憶為一條。解決碎片化記憶累積的問題。

**處理管線**：

1. **驗證** — 兩個 ID 都存在、都在 accessible scope 內、都未被 invalidated
2. **文字合併** — 使用明確提供的 `mergedText`，或串接兩條文字
3. **Noise check** — 合併後的文字仍需通過雜訊過濾
4. **Re-embed** — 合併文字重新向量化
5. **Metadata 合併** — importance 取 max、tier 取高、access_count 相加
6. **建立新記憶** — 帶有 `merged_from` 關係指向兩條原始記憶
7. **Invalidate 原始** — 兩條原始記憶標記 `invalidated_at` 和 `superseded_by`

**關鍵參數**：

- `primaryId`（必填）— 主記憶 ID
- `secondaryId`（必填）— 被吸收的記憶 ID
- `mergedText`（選填）— 明確的合併文字（不提供則串接）
- `importance`（選填）— 覆蓋重要性（預設取兩者最大值）

**設計決策**：

- 建立新記憶（非原地更新），保留完整歷史鏈
- 一次只合併兩條（刻意限制，避免批次誤操作）
- 已 invalidated 的記憶不能被合併

---

### memory_history

**定位**：追蹤記憶的版本演化歷史。透過 supersede/merge 鏈向前/向後遍歷。

**處理管線**：

1. **起點解析** — 從任意鏈中節點出發（可以是 active 或 superseded）
2. **向後遍歷** — 沿 `supersedes` 指標回溯到最初版本
3. **向前遍歷** — 沿 `superseded_by` 指標追蹤到最新版本
4. **環路保護** — visited set + 最大深度 50 防止無限迴圈
5. **格式化輸出** — 依時間序列顯示每個版本的狀態

**關鍵參數**：

- `memoryId`（必填）— 鏈中任一節點的 ID
- `direction`（選填）— `"forward"` / `"backward"` / `"both"`（預設 `"both"`）

**設計決策**：

- 無需索引建置，純粹沿 metadata 指標遍歷
- 最大深度 50（足以覆蓋任何合理的版本鏈）
- 單一節點直接回報「無歷史」，不浪費 token

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
- 休眠記憶數（超過 30 天未被 access，v2.0.10+）

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

| 模組                    | 接入方式                                                    |
| ----------------------- | ----------------------------------------------------------- |
| `noise-filter.ts`       | store 和 recall 都使用                                      |
| `decay-engine.ts`       | 透過 retriever 的 scoring pipeline                          |
| `access-tracker.ts`     | recall 時自動更新 access metadata                           |
| `tier-manager.ts`       | 3-tier 生命週期管理，recall 時自動評估晉升/降級（v2.0.11+） |
| `chunker.ts`            | embedder 內部呼叫，超長文字自動分塊                         |
| `smart-metadata.ts`     | store 和 update 時生成 L0/L1/L2 摘要                        |
| `workspace-boundary.ts` | store 攔截 profile 資訊、recall 過濾結果                    |
| `scopes.ts`             | 所有 tool 的權限檢查                                        |
| `embedder.ts`           | store/update 的向量化                                       |
| `retriever.ts`          | recall/forget/update 的混合檢索                             |
| `store.ts`              | 所有 tool 的 LanceDB CRUD                                   |

### 已清除的死代碼（v2.0.11+）

以下模組源自原始 fork（CortexReach/memory-lancedb-pro），從未接入 server.ts，已全部移除：

- `smart-extractor.ts` + `extraction-prompts.ts` + `noise-prototypes.ts`（LLM 自動提取管線）
- `llm-client.ts`（SmartExtractor 的 LLM 抽象層）
- `memory-upgrader.ts`（舊格式升級工具）
- `migrate.ts`（Schema migration）
- `adaptive-retrieval.ts`（跳過檢索的 pattern matcher）
- `reflection-store.ts` + 6 個 reflection 子模組（OpenClaw 反思管線）

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

## 已實作改進（v2.0.9 ~ v2.0.10）

基於 AI agent 多工作區（每個 agent 獨立 `.memory-db/`）的實際使用模式，對照現有工具能力識別差距並完成修復。

### ✅ Store 回饋相似記憶（v2.0.10）

**原痛點**：cosine > 0.98 才攔截（完全重複），0.85~0.97 的高度相似記憶靜默通過，導致碎片化記憶越積越多。

**已實作**：`handleMemoryStore` 存入成功後，回覆中附帶 cosine 0.8~0.98 的相似記憶提示（最多 3 條），Agent 當場可判斷要不要合併或調整。vectorSearch 從取 1 條改為取 3 條以捕捉相似（非重複）記憶。

---

### ✅ Recall `since` 時間過濾（v2.0.10）

**原痛點**：只能語義搜尋，無法按時間範圍檢索（「最近三天學了什麼？」做不到）。

**已實作**：`memory_recall` 新增 `since` 參數，支援 `"3d"` / `"1w"` / `"2h"` 短碼或 ISO 時間戳。以 post-filter 實作（over-fetch 3x 再過濾），不侵入 retriever 內部。

**啟動協議整合**：

```
memory_recall query="*" since="3d"       ← 最近 3 天全部記憶
memory_recall query="lancedb" since="7d" ← 特定主題 + 時間範圍
```

---

### ✅ `lesson` Category（v2.0.10）

**原痛點**：踩坑教訓被迫拆成 `fact` + `decision` 雙寫，增加漏存風險且語義不自然。

**已實作**：`MEMORY_CATEGORIES` 新增 `lesson`，所有 tool 的 enum 自動生效。踩坑 → `memory_store category="lesson"` 一步到位。

---

### ✅ Stats 休眠記憶統計（v2.0.10）

**原痛點**：`memory_stats` 只有總數和分類計數，agent 看不到有多少記憶從未被 recall。

**已實作**：`store.stats()` 新增 `dormantCount`，統計 `last_accessed_at` 超過 30 天的記憶數。不需 TierManager，純 metadata 查詢。

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

### ✅ Self-Improvement Tools 預設關閉（v2.0.9）

**原痛點**：三個 self_improvement tools 寫入 `.learnings/` 目錄，但多 agent 架構中該目錄已被移除。功能形同死代碼。

**已實作**：`enableSelfImprovementTools` 預設值從 `true` 改為 `false`。新增 `MEMORY_ENABLE_SELF_IMPROVEMENT` 環境變數。需要的使用者明確設 `true` 啟用，既有明確設定的使用者不受影響。

---

## 實作摘要

| 版本        | 改進項                                                        | 改動範圍                                    |
| ----------- | ------------------------------------------------------------- | ------------------------------------------- |
| **v2.0.9**  | Self-Improvement tools 預設關閉                               | `config.ts`、`server.ts`、README            |
| **v2.0.10** | Store 回饋 + lesson + since + dormant                         | `server.ts`、`src/store.ts`、README         |
| **v2.0.11** | 死代碼清理 + TierManager 接入 + memory_merge + memory_history | `server.ts`、`src/retriever.ts`、刪除 16 檔 |

## 推遲項目

| 項目                | 理由                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------- |
| SmartExtractor 重建 | 原始代碼已移除。如需 LLM 自動提取記憶功能，需從頭設計並加入 LLM API 配置              |
| Dual-write 自動同步 | 檔案記憶（git-versioned 人類可讀）和向量記憶（AI 語義檢索）目的不同，強制同步模糊邊界 |

## 使用整合建議

### 啟動協議整合（Recall + since）

啟動協議第 5 步標準化為：

```
1. memory_recall query="*" since="3d" limit=10   → 最近 3 天的記憶快照
2. memory_recall query="{當前任務關鍵字}"          → 語義搜尋補充
```

兩步組合 = 確定性（時間）+ 語義（主題），覆蓋率大幅提升。

### Session-End Checklist 整合（lesson + store 回饋）

```
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
  3. 同 category 高度重疊 → memory_merge 合併
  4. 產出簡報寫入 memory/{date}.md
```

### Skill 輔助（sys-memory-hygiene）

建立記憶整理的標準化方法：

- 什麼條件觸發整理（dormant > 20、同主題 > 3 條）
- 整理動作標準（forget 門檻、merge 判斷、保留理由）
- 整理後驗證（重新跑 memory_stats 確認改善）
