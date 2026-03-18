#!/usr/bin/env node
import { register } from "node:module";
import { pathToFileURL } from "node:url";

// Register tsx for TypeScript support
try {
  register("tsx/esm", pathToFileURL("./"));
} catch {
  // tsx not available, try jiti
  try {
    const { default: jiti } = await import("jiti");
    const loader = jiti(import.meta.url, { interopDefault: true });
    loader("../server.ts");
    // jiti handles execution, so we exit here
    process.exit(0);
  } catch {
    console.error(
      "memory-lancedb-mcp requires 'tsx' or 'jiti' to run TypeScript.\n" +
      "Install with: npm install -g tsx"
    );
    process.exit(1);
  }
}

// If tsx registered successfully, import the server
await import("../server.ts");
