/**
 * MCP Contract Smoke Test
 *
 * Validates that the server correctly implements the MCP protocol:
 * - Server starts and connects via stdio
 * - tools/list returns expected core tools with correct schema shape
 * - A basic tool call (memory_store + memory_recall) works end-to-end
 *
 * This test should almost NEVER need to change unless the MCP protocol
 * or tool names change. It tests the contract, not implementation details.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

const CORE_TOOL_NAMES = ["memory_recall", "memory_store", "memory_forget", "memory_update"];

// Simple JSON-RPC over stdio helper
class McpStdioClient {
  constructor(proc) {
    this.proc = proc;
    this.id = 0;
    this.pending = new Map();
    this.rl = createInterface({ input: proc.stdout });
    this.rl.on("line", (line) => {
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          this.pending.get(msg.id)(msg);
          this.pending.delete(msg.id);
        }
      } catch {
        // ignore non-JSON lines (logs, etc.)
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout waiting for response to ${method}`));
      }, 15000);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      });
      const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
      this.proc.stdin.write(payload + "\n");
    });
  }

  async close() {
    this.rl.close();
    this.proc.stdin.end();
    this.proc.kill();
  }
}

describe("MCP Contract", async () => {
  const tmpDir = mkdtempSync(path.join(tmpdir(), "mcp-contract-"));
  let client;
  let proc;

  // Start the MCP server
  test("server starts and initializes", async () => {
    proc = spawn("npx", ["tsx", "server.ts"], {
      env: {
        ...process.env,
        EMBEDDING_API_KEY: "test-contract",
        MEMORY_DB_PATH: tmpDir,
      },
      stdio: ["pipe", "pipe", "pipe"],
      shell: true,
    });

    client = new McpStdioClient(proc);

    const result = await client.send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "contract-test", version: "1.0.0" },
    });

    assert.ok(result.serverInfo, "Server should return serverInfo");
    assert.ok(result.capabilities, "Server should return capabilities");

    // Send initialized notification
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  });

  test("tools/list returns all core tools", async () => {
    const result = await client.send("tools/list");
    const toolNames = result.tools.map((t) => t.name);

    for (const name of CORE_TOOL_NAMES) {
      assert.ok(toolNames.includes(name), `Missing core tool: ${name}`);
    }

    // Each tool must have name, description, inputSchema
    for (const tool of result.tools) {
      assert.ok(typeof tool.name === "string", "Tool must have string name");
      assert.ok(typeof tool.description === "string", "Tool must have string description");
      assert.ok(tool.inputSchema, "Tool must have inputSchema");
      assert.equal(tool.inputSchema.type, "object", "inputSchema must be object type");
    }
  });

  test("memory_store + memory_recall round-trip", async () => {
    // Store a memory
    const storeResult = await client.send("tools/call", {
      name: "memory_store",
      arguments: {
        text: "The user prefers dark mode in all applications",
      },
    });
    assert.ok(storeResult.content, "store should return content");

    // Brief delay for indexing
    await new Promise((r) => setTimeout(r, 500));

    // Recall the memory
    const recallResult = await client.send("tools/call", {
      name: "memory_recall",
      arguments: {
        query: "dark mode preference",
      },
    });
    assert.ok(recallResult.content, "recall should return content");
  });

  // Cleanup
  test("cleanup", async () => {
    if (client) await client.close();
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });
});
