<div align="center">

# memory-lancedb-mcp

**通过 [MCP](https://modelcontextprotocol.io) 为 AI Agent 提供生产级长期记忆**

*混合检索（向量 + BM25）、Cross-Encoder 重排序、多 Scope 隔离、记忆生命周期管理*

[![npm version](https://img.shields.io/npm/v/@cablate/memory-lancedb-mcp)](https://www.npmjs.com/package/@cablate/memory-lancedb-mcp)
[![LanceDB](https://img.shields.io/badge/LanceDB-Vectorstore-orange)](https://lancedb.com)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

[English](README.md) | **简体中文**

</div>

---

## 为什么选择 memory-lancedb-mcp？

大多数 AI Agent 都有"失忆症"——每次新对话都从零开始。这个 MCP 服务器为任何 MCP 兼容客户端提供**持久化、智能化的长期记忆**——完全自动，无需手动管理。

| | 你得到什么 |
|---|---|
| **混合检索** | 向量 + BM25 全文搜索，Cross-Encoder 重排序融合 |
| **智能提取** | LLM 驱动的 6 分类记忆提取 |
| **记忆生命周期** | Weibull 衰减 + 三层晋升——重要记忆上浮，过时记忆淡出 |
| **多 Scope 隔离** | 按 Agent、用户、项目隔离记忆边界 |
| **任意 Embedding 提供商** | OpenAI、Jina、Gemini、DeepInfra、Ollama 或任何 OpenAI 兼容 API |
| **自我改进工具** | 结构化学习/错误日志与 Skill 提取 |

---

## 快速开始

### 1. 安装

```bash
npm install -g @cablate/memory-lancedb-mcp
```

### 2. 配置 MCP 客户端

添加到 MCP 客户端设置（如 Claude Desktop 的 `claude_desktop_config.json`）：

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

### 3. 高级配置（可选）

创建配置文件并指定路径：

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

详见 [config.example.json](config.example.json)。

---

## MCP 工具

### 核心工具

| 工具 | 说明 |
|------|------|
| `memory_recall` | 混合检索搜索记忆（向量 + 关键词），支持 scope/category 过滤 |
| `memory_store` | 保存信息到长期记忆，带重要性评分和噪声过滤 |
| `memory_forget` | 按 ID 或搜索查询删除记忆 |
| `memory_update` | 更新现有记忆。时间类 category 自动创建新版本以保留历史 |

### 管理工具（需启用）

| 工具 | 说明 |
|------|------|
| `memory_stats` | 按 scope 和 category 统计记忆用量 |
| `memory_list` | 列出最近记忆，支持过滤 |

配置：`"enableManagementTools": true`

### 自我改进工具（需启用）

| 工具 | 说明 |
|------|------|
| `self_improvement_log` | 记录结构化的学习/错误条目 |
| `self_improvement_extract_skill` | 从学习条目创建 Skill 脚手架 |
| `self_improvement_review` | 汇总治理积压情况 |

禁用：`"enableSelfImprovementTools": false`

---

## 核心特性

### 混合检索
- **向量搜索** — 通过 LanceDB ANN（余弦距离）进行语义相似度搜索
- **BM25 全文搜索** — 通过 LanceDB FTS 索引进行精确关键词匹配
- **融合** — 向量分数为基础，BM25 命中获得 15% 加成

### Cross-Encoder 重排序
- 支持 Jina、TEI、SiliconFlow、Voyage AI、Pinecone、DashScope
- 混合评分：60% Cross-Encoder + 40% 原始融合分数
- API 失败时优雅降级

### 多 Scope 隔离
- 内置 scope：`global`、`agent:<id>`、`custom:<name>`、`project:<id>`、`user:<id>`
- 通过 `scopes.agentAccess` 进行 Agent 级别的访问控制

### 噪声过滤
- 过滤 Agent 拒绝、元问题、问候语、低质量内容
- CJK 感知阈值（中文：6 字符 vs 英文：15 字符）

### 记忆生命周期（衰减 + 分层）
- **Weibull 衰减**：综合分数 = 新鲜度 + 访问频率 + 内在价值
- **三层晋升**：Peripheral ↔ Working ↔ Core
- **访问强化**：频繁召回的记忆衰减更慢

---

## 环境变量

| 变量 | 必需 | 说明 |
|------|------|------|
| `EMBEDDING_API_KEY` | 是 | Embedding 提供商的 API Key |
| `EMBEDDING_MODEL` | 否 | 模型名称（默认：`text-embedding-3-small`） |
| `EMBEDDING_BASE_URL` | 否 | 非 OpenAI 提供商的自定义 Base URL |
| `MEMORY_DB_PATH` | 否 | LanceDB 存储目录 |
| `MEMORY_LANCEDB_CONFIG` | 否 | JSON 配置文件路径 |

---

## 开发

```bash
git clone https://github.com/cablate/memory-lancedb-mcp.git
cd memory-lancedb-mcp
npm install
npm test
```

本地运行：

```bash
EMBEDDING_API_KEY=your-key npx tsx server.ts
```

---

## 致谢

本项目 fork 自 [CortexReach/memory-lancedb-pro](https://github.com/CortexReach/memory-lancedb-pro)，从 OpenClaw 插件重构为独立 MCP 服务器。原始作者：[win4r](https://github.com/win4r) 及贡献者。

## 许可证

MIT — 详见 [LICENSE](LICENSE)。
