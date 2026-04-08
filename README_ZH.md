<div align="center">

<img src="assets/banner.png" alt="memory-lancedb-mcp" width="100%" />

> **基於 [CortexReach/memory-lancedb-pro](https://github.com/CortexReach/memory-lancedb-pro)** — 原作者 [win4r](https://github.com/win4r) 及貢獻者們。從 OpenClaw 外掛重構為獨立 MCP 伺服器。

[![npm version](https://img.shields.io/npm/v/@cablate/memory-lancedb-mcp)](https://www.npmjs.com/package/@cablate/memory-lancedb-mcp)
[![LanceDB](https://img.shields.io/badge/LanceDB-Vectorstore-orange)](https://lancedb.com)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

[English](README.md) | **繁體中文**

</div>

---

## 為什麼選擇 memory-lancedb-mcp？

大多數 AI Agent 都有「失憶症」——每次新對話都從零開始。這個 MCP 伺服器為任何 MCP 相容客戶端提供**持久化、智慧化的長期記憶**——完全自動，無需手動管理。

|                           | 你得到什麼                                                     |
| ------------------------- | -------------------------------------------------------------- |
| **混合檢索**              | 向量 + BM25 全文搜尋，Cross-Encoder 重排序融合                 |
| **智慧擷取**              | LLM 驅動的 6 分類記憶擷取                                      |
| **記憶生命週期**          | Weibull 衰減 + 三層晉升——重要記憶上浮，過時記憶淡出            |
| **多 Scope 隔離**         | 按 Agent、使用者、專案隔離記憶邊界                             |
| **任意 Embedding 供應商** | OpenAI、Jina、Gemini、DeepInfra、Ollama 或任何 OpenAI 相容 API |
| **自我改進工具**          | 結構化學習/錯誤日誌與 Skill 擷取                               |

---

## 快速開始

### 1. 安裝

```bash
npm install -g @cablate/memory-lancedb-mcp
```

### 2. 設定 MCP 客戶端

加入 MCP 客戶端設定（如 Claude Desktop 的 `claude_desktop_config.json`）：

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

### 3. 進階設定（選用）

建立設定檔並指定路徑：

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

詳見 [config.example.json](config.example.json)。

---

## MCP 工具

本伺服器向 MCP 客戶端公開以下工具：

### 核心工具

| 工具             | 說明                                                                       |
| ---------------- | -------------------------------------------------------------------------- |
| `memory_recall`  | 混合檢索（向量 + 關鍵字），支援批次搜尋（`queries` 陣列）、關聯記憶 1-hop 展開、topic 過濾、維護提示。回傳使用 XML 標籤（`<memories>`、`<hints>`、`<refs>`）便於模型解析 |
| `memory_store`   | 儲存資訊至長期記憶，附帶重要性評分與雜訊過濾。自動連結相關記憶、偵測矛盾、自動推導 topic 標籤 |
| `memory_forget`  | 依 ID 或搜尋查詢刪除記憶                                                   |
| `memory_update`  | 更新現有記憶。時間類 category 自動建立新版本以保留歷史                     |
| `memory_merge`   | 合併兩條相關記憶為一條。使兩條原始記憶失效並建立統一版本                   |
| `memory_history` | 追蹤記憶的版本歷史（supersede/merge 鏈）                                   |

### 管理工具（需啟用）

| 工具           | 說明                              |
| -------------- | --------------------------------- |
| `memory_stats` | 依 scope 與 category 統計記憶用量                                       |
| `memory_list`  | 列出近期記憶，支援過濾                                                  |
| `memory_lint`  | 健康檢查：偵測孤兒記憶、過期條目，自動修復缺失的關聯連結                |

設定：`"enableManagementTools": true`

### 自我改進工具（預設關閉）

| 工具                             | 說明                      |
| -------------------------------- | ------------------------- |
| `self_improvement_log`           | 記錄結構化的學習/錯誤條目 |
| `self_improvement_extract_skill` | 從學習條目建立 Skill 骨架 |
| `self_improvement_review`        | 彙總治理積壓狀況          |

啟用：`"enableSelfImprovementTools": true` 或環境變數 `MEMORY_ENABLE_SELF_IMPROVEMENT=true`

### 視覺化工具（預設啟用）

| 工具 | 說明 |
|------|------|
| `memory_visualize` | 產生互動式記憶圖譜 HTML。包含語意聚類、相似度連線、重複偵測、重要性分布、成長時間軸。 |

設定：`"enableVisualizationTools": false` 可關閉。

---

## 架構

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

### 多階段評分管線

```
Query → embedQuery() ─┐
                       ├─→ RRF Fusion → Rerank → Lifecycle Decay → Length Norm → Filter
Query → BM25 FTS ─────┘
```

| 階段                     | 效果                                        |
| ------------------------ | ------------------------------------------- |
| **RRF Fusion**           | 結合語意與精確匹配召回                      |
| **Cross-Encoder Rerank** | 提升語意精確度高的結果                      |
| **Lifecycle Decay**      | Weibull 新鮮度 + 存取頻率 + 重要性 × 信心度 |
| **Length Normalization** | 防止長條目主導排名（錨點：500 字元）        |
| **Hard Min Score**       | 移除不相關結果（預設：0.35）                |
| **MMR Diversity**        | 餘弦相似度 > 0.85 → 降權                    |

---

## 設定

### 環境變數

| 變數                    | 必填 | 說明                                       |
| ----------------------- | ---- | ------------------------------------------ |
| `EMBEDDING_API_KEY`     | 是   | Embedding 供應商的 API Key                 |
| `EMBEDDING_MODEL`       | 否   | 模型名稱（預設：`text-embedding-3-small`） |
| `EMBEDDING_BASE_URL`    | 否   | 非 OpenAI 供應商的自訂 Base URL            |
| `MEMORY_DB_PATH`        | 否   | LanceDB 儲存目錄                           |
| `MEMORY_LANCEDB_CONFIG` | 否   | JSON 設定檔路徑                            |

### 設定檔

<details>
<summary><strong>完整設定範例</strong></summary>

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
<summary><strong>Embedding 供應商</strong></summary>

支援**任何 OpenAI 相容的 embedding API**：

| 供應商             | 模型                            | Base URL                                                   | 維度         |
| ------------------ | ------------------------------- | ---------------------------------------------------------- | ------------ |
| **OpenAI**         | `text-embedding-3-small`        | `https://api.openai.com/v1`                                | 1536         |
| **Jina**           | `jina-embeddings-v5-text-small` | `https://api.jina.ai/v1`                                   | 1024         |
| **DeepInfra**      | `Qwen/Qwen3-Embedding-8B`       | `https://api.deepinfra.com/v1/openai`                      | 1024         |
| **Google Gemini**  | `gemini-embedding-001`          | `https://generativelanguage.googleapis.com/v1beta/openai/` | 3072         |
| **Ollama**（本地） | `nomic-embed-text`              | `http://localhost:11434/v1`                                | _視模型而定_ |

</details>

<details>
<summary><strong>Rerank 供應商</strong></summary>

| 供應商               | `rerankProvider` | Endpoint                                                | 範例模型                  |
| -------------------- | ---------------- | ------------------------------------------------------- | ------------------------- |
| **Jina**             | `jina`           | `https://api.jina.ai/v1/rerank`                         | `jina-reranker-v3`        |
| **Hugging Face TEI** | `tei`            | `http://host:8081/rerank`                               | `BAAI/bge-reranker-v2-m3` |
| **SiliconFlow**      | `siliconflow`    | `https://api.siliconflow.com/v1/rerank`                 | `BAAI/bge-reranker-v2-m3` |
| **Voyage AI**        | `voyage`         | `https://api.voyageai.com/v1/rerank`                    | `rerank-2.5`              |
| **Pinecone**         | `pinecone`       | `https://api.pinecone.io/rerank`                        | `bge-reranker-v2-m3`      |
| **DashScope**        | `dashscope`      | `https://dashscope.aliyuncs.com/api/v1/services/rerank` | `gte-rerank`              |

</details>

---

## 核心特性

### 混合檢索

- **向量搜尋** — 透過 LanceDB ANN（餘弦距離）進行語意相似度搜尋
- **BM25 全文搜尋** — 透過 LanceDB FTS 索引進行精確關鍵字匹配
- **融合** — 向量分數為基底，BM25 命中獲得 15% 加成

### Cross-Encoder 重排序

- 支援 Jina、TEI、SiliconFlow、Voyage AI、Pinecone、DashScope
- 混合評分：60% Cross-Encoder + 40% 原始融合分數
- API 失敗時優雅降級

### 多 Scope 隔離

- 內建 scope：`global`、`agent:<id>`、`custom:<name>`、`project:<id>`、`user:<id>`
- 透過 `scopes.agentAccess` 進行 Agent 級別的存取控制

### 雜訊過濾

- 過濾 Agent 拒絕回應、後設問題、問候語、低品質內容
- CJK 感知閾值（中文：6 字元 vs 英文：15 字元）

### 記憶生命週期（衰減 + 分層）

- **Weibull 衰減**：綜合分數 = 新鮮度 + 存取頻率 + 內在價值
- **三層晉升**：Peripheral ↔ Working ↔ Core
- **存取強化**：頻繁召回的記憶衰減更慢

### 智慧元資料

- L0/L1/L2 分層儲存，漸進式細節檢索
- 時間版本控制與取代鏈
- Fact key 去重

### 自動連結與矛盾偵測

- **自動連結**：`memory_store` 自動為相似記憶建立雙向關聯（cosine > 0.7）
- **矛盾提示**：儲存時偵測新記憶與現有記憶之間的潛在矛盾
- **健康檢查**：`memory_lint` 掃描孤兒記憶、過期條目，並自動修復缺失關聯

### Topic 標籤與 Recall 提示

- **Topic 自動推導**：`memory_store` 從相似記憶推導 topic 標籤。傳入 `topic` 參數可覆蓋自動推導。
- **Topic 過濾**：`memory_recall` 支援 `topic` 參數，一次撈出特定主題下所有記憶。
- **Recall 提示**：`memory_recall` 在結果後附加維護提示——近似重複對、休眠記憶、結果間矛盾——讓 Agent 無需額外呼叫即可處理問題。

### 批次搜尋與 Token 效率

- **批次搜尋**：`memory_recall` 支援 `queries` 字串陣列——多組搜尋平行執行、結果去重合併、命中多個查詢的記憶排序更高。Limit 依查詢數量自動放大。
- **關聯感知搜尋**：結果透過自動連結的關聯進行 1-hop 展開，找出向量搜尋單獨無法觸及的語意相關記憶。
- **精簡回傳**：ID 壓縮為 8 碼短 ref 置於尾部、移除 category/scope 標籤、store 回傳最小化。輸出以 XML 標籤（`<memories>`、`<hints>`、`<refs>`）包裝，便於模型解析。

---

## 資料庫結構

LanceDB 資料表 `memories`：

| 欄位         | 類型          | 說明                                                                         |
| ------------ | ------------- | ---------------------------------------------------------------------------- |
| `id`         | string (UUID) | 主鍵                                                                         |
| `text`       | string        | 記憶文字（FTS 索引）                                                         |
| `vector`     | float[]       | Embedding 向量                                                               |
| `category`   | string        | `preference` / `fact` / `decision` / `entity` / `skill` / `lesson` / `other` |
| `scope`      | string        | Scope 識別碼                                                                 |
| `importance` | float         | 重要性分數 0–1                                                               |
| `timestamp`  | int64         | 建立時間戳（毫秒）                                                           |
| `metadata`   | string (JSON) | 擴充元資料（L0/L1/L2、tier、access_count 等）                                |

---

## 開發

```bash
git clone https://github.com/cablate/memory-lancedb-mcp.git
cd memory-lancedb-mcp
npm install
npm test
```

本地執行：

```bash
EMBEDDING_API_KEY=your-key npx tsx server.ts
```

---

## 授權

MIT — 詳見 [LICENSE](LICENSE)。
