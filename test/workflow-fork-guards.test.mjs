import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const claudeWorkflow = readFileSync(
  new URL("../.github/workflows/claude-code-review.yml", import.meta.url),
  "utf8",
);

test("claude review skips fork pull requests", () => {
  assert.match(
    claudeWorkflow,
    /if:\s*\$\{\{\s*github\.event\.pull_request\.head\.repo\.fork == false\s*\}\}/m,
  );
});
