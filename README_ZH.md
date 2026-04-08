<div align="center">

<img src="assets/banner.png" alt="memory-lancedb-mcp" width="100%" />

**為任何 MCP 相容 AI Agent 提供持久化、智慧化的長期記憶。**

[![npm version](https://img.shields.io/npm/v/@cablate/memory-lancedb-mcp)](https://www.npmjs.com/package/@cablate/memory-lancedb-mcp)
[![npm downloads](https://img.shields.io/npm/dm/@cablate/memory-lancedb-mcp)](https://www.npmjs.com/package/@cablate/memory-lancedb-mcp)
[![LanceDB](https://img.shields.io/badge/LanceDB-Vectorstore-orange)](https://lancedb.com)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

[English](README.md) | **繁體中文**

</div>

---

## 裝了之後差在哪

沒有記憶，每次對話從零開始。有了 memory-lancedb-mcp，Agent 跨 session 自動累積知識。

**Before** — Agent 沒有上下文：
```
使用者：「用跟上次一樣的動畫風格」
Agent：「我沒有之前動畫的相關資訊，可以描述一下你想要的效果嗎？」
```

**After** — Agent 回憶過去的決策：
```xml
<memories>
1. Remotion spring 動畫：duration >= 20，damping 12-15 可獲得平滑緩動
2. 影片輸出預設：社群用 1080p 30fps，demo 用 60fps
</memories>
<refs>#1=6352a7d2 #2=bed148f0</refs>
```

Store 回傳極簡——沒有噪音，只有確認：
```
Stored. [topic: remotion]
```

---

## 快速開始

### 1. 安裝

```bash
npm install -g @cablate/memory-lancedb-mcp
```

### 2. 設定

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

<details>
<summary><strong>進階：使用設定檔完整控制</strong></summary>

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

</details>

---

## 運作原理

```
          store                          recall
            │                              │
   ┌────────▼────────┐           ┌────────▼────────┐
   │  雜訊過濾       │           │ 向量 + BM25     │
   │  Embed + 儲存   │           │ RRF 融合        │
   │  自動連結關聯   │           │ Cross-Encoder   │
   │  偵測矛盾       │           │ 生命週期衰減    │
   │  推導 Topic     │           │ 1-hop 關聯展開  │
   └────────┬────────┘           │ 批次合併        │
            │                    └────────┬────────┘
            ▼                             ▼
   ┌─────────────────────────────────────────────┐
   │          LanceDB（本地、零設定）              │
   │     向量 ANN + BM25 FTS + Metadata           │
   └─────────────────────────────────────────────┘
```

每次 `memory_store` 寫入 LanceDB，自動連結相關記憶、偵測矛盾、推導 topic 標籤——全部不需額外 API 呼叫。每次 `memory_recall` 執行混合檢索，透過關聯圖譜展開結果，並附加維護提示讓 Agent 能自我維護知識庫。

---

## 功能特性

### 檢索

- **混合搜尋** — 向量（cosine ANN）+ BM25 全文，RRF 融合
- **Cross-Encoder 重排序** — 支援 6 家供應商（Jina、TEI、Voyage AI 等）
- **批次搜尋** — `queries` 陣列一次多關鍵詞搜尋；結果去重，多次命中的記憶排序更高
- **關聯感知展開** — 透過自動連結的關聯進行 1-hop 展開，找出向量搜尋單獨觸及不到的記憶
- **Token 高效輸出** — XML 標籤回傳（`<memories>`、`<hints>`、`<refs>`），壓縮 ID，無 category/scope 噪音

### 儲存

- **自動連結** — 儲存時自動建立雙向關聯（cosine > 0.7）
- **矛盾偵測** — 新記憶與現有記憶衝突時發出警告
- **Topic 推導** — 從相似記憶自動推導 topic 標籤；傳入 `topic` 參數可覆蓋
- **雜訊過濾** — 過濾問候語、拒絕回應、後設問題；CJK 感知閾值

### 生命週期

- **Weibull 衰減** — 綜合分數：新鮮度 + 存取頻率 + 內在重要性
- **三層晉升** — Peripheral → Working → Core；頻繁存取的記憶晉升更快
- **時間版本控制** — 取代鏈保留歷史；`memory_history` 追蹤版本脈絡

### 維護

- **Recall 提示** — 重複對、休眠記憶、矛盾內嵌於結果中
- **`memory_lint`** — 健康檢查：孤兒偵測、過期清理、缺失關聯修復
- **`memory_merge`** — 合併冗餘記憶；原始記憶失效
- **`memory_visualize`** — 互動式 HTML 圖譜：語意聚類、相似度連線、成長時間軸

---

## 視覺化

執行 `memory_visualize` 產生互動式記憶知識圖譜：

- 力導向布局 + 語意聚類（Label Propagation）
- 相似度連線、重複偵測、重要性分布
- 時間篩選、成長動畫、聚類檢視
- 獨立 HTML 檔——任何瀏覽器開啟即可

---

## 評分管線

```
Query → embedQuery() ─┐
                       ├─→ RRF 融合 → 重排序 → 生命週期衰減 → 長度正規化 → 過濾
Query → BM25 FTS ─────┘
```

| 階段 | 效果 |
|------|------|
| **RRF 融合** | 結合語意與精確匹配召回 |
| **Cross-Encoder 重排序** | 提升語意精確度高的結果 |
| **生命週期衰減** | Weibull 新鮮度 + 存取頻率 + 重要性 |
| **長度正規化** | 防止長條目主導排名（錨點：500 字元） |
| **最低分數門檻** | 移除不相關結果（預設：0.35） |
| **MMR 多樣性** | 餘弦相似度 > 0.85 → 降權 |

---

## 設定

### 環境變數

| 變數 | 必填 | 說明 |
|------|------|------|
| `EMBEDDING_API_KEY` | 是 | Embedding 供應商的 API Key |
| `EMBEDDING_MODEL` | 否 | 模型名稱（預設：`text-embedding-3-small`） |
| `EMBEDDING_BASE_URL` | 否 | 非 OpenAI 供應商的自訂 Base URL |
| `MEMORY_DB_PATH` | 否 | LanceDB 儲存目錄 |
| `MEMORY_LANCEDB_CONFIG` | 否 | JSON 設定檔路徑 |

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

| 供應商 | 模型 | Base URL | 維度 |
|--------|------|----------|------|
| **OpenAI** | `text-embedding-3-small` | `https://api.openai.com/v1` | 1536 |
| **Jina** | `jina-embeddings-v5-text-small` | `https://api.jina.ai/v1` | 1024 |
| **DeepInfra** | `Qwen/Qwen3-Embedding-8B` | `https://api.deepinfra.com/v1/openai` | 1024 |
| **Google Gemini** | `gemini-embedding-001` | `https://generativelanguage.googleapis.com/v1beta/openai/` | 3072 |
| **Ollama**（本地） | `nomic-embed-text` | `http://localhost:11434/v1` | _視模型而定_ |

</details>

<details>
<summary><strong>Rerank 供應商</strong></summary>

| 供應商 | `rerankProvider` | Endpoint | 範例模型 |
|--------|-----------------|----------|----------|
| **Jina** | `jina` | `https://api.jina.ai/v1/rerank` | `jina-reranker-v3` |
| **Hugging Face TEI** | `tei` | `http://host:8081/rerank` | `BAAI/bge-reranker-v2-m3` |
| **SiliconFlow** | `siliconflow` | `https://api.siliconflow.com/v1/rerank` | `BAAI/bge-reranker-v2-m3` |
| **Voyage AI** | `voyage` | `https://api.voyageai.com/v1/rerank` | `rerank-2.5` |
| **Pinecone** | `pinecone` | `https://api.pinecone.io/rerank` | `bge-reranker-v2-m3` |
| **DashScope** | `dashscope` | `https://dashscope.aliyuncs.com/api/v1/services/rerank` | `gte-rerank` |

</details>

---

<details>
<summary><strong>工具參考</strong></summary>

### 核心工具

| 工具 | 說明 |
|------|------|
| `memory_recall` | 混合檢索，支援批次搜尋、關聯展開、topic 過濾、維護提示 |
| `memory_store` | 儲存，含自動連結、矛盾偵測、topic 推導、雜訊過濾 |
| `memory_forget` | 依 ID 或搜尋查詢刪除 |
| `memory_update` | 更新，附帶時間取代鏈 |
| `memory_merge` | 合併兩條記憶為一條 |
| `memory_history` | 追蹤 supersede/merge 版本歷史 |

### 管理工具（需啟用）

| 工具 | 說明 |
|------|------|
| `memory_stats` | 依 scope 與 category 統計用量 |
| `memory_list` | 列出近期記憶，支援過濾 |
| `memory_lint` | 健康檢查 + 自動修復缺失關聯 |

啟用：`"enableManagementTools": true`

### 自我改進工具（預設關閉）

| 工具 | 說明 |
|------|------|
| `self_improvement_log` | 記錄結構化學習/錯誤條目 |
| `self_improvement_extract_skill` | 從學習條目建立 Skill 骨架 |
| `self_improvement_review` | 彙總治理積壓狀況 |

啟用：`"enableSelfImprovementTools": true`

### 視覺化工具（預設啟用）

| 工具 | 說明 |
|------|------|
| `memory_visualize` | 產生互動式 HTML 記憶圖譜 |

參數：`output_path`、`scope`、`threshold`（預設 0.65）、`max_neighbors`（預設 4）

關閉：`"enableVisualizationTools": false`

</details>

---

## 資料庫結構

LanceDB 資料表 `memories`：

| 欄位 | 類型 | 說明 |
|------|------|------|
| `id` | string (UUID) | 主鍵 |
| `text` | string | 記憶文字（FTS 索引） |
| `vector` | float[] | Embedding 向量 |
| `category` | string | `preference` / `fact` / `decision` / `entity` / `skill` / `lesson` / `other` |
| `scope` | string | Scope 識別碼 |
| `importance` | float | 重要性分數 0-1 |
| `timestamp` | int64 | 建立時間戳（毫秒） |
| `metadata` | string (JSON) | 擴充元資料（L0/L1/L2、tier、access_count、relations、topic 等） |

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

## 致謝

基於 [CortexReach/memory-lancedb-pro](https://github.com/CortexReach/memory-lancedb-pro) — 原作者 [win4r](https://github.com/win4r) 及貢獻者們。

## 授權

MIT — 詳見 [LICENSE](LICENSE)。
