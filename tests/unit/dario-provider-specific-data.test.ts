import test from "node:test";
import assert from "node:assert/strict";

import { validateProviderSpecificData } from "../../src/shared/validation/providerSpecificData.ts";

function issuesFor(data: Record<string, unknown>) {
  const issues: Array<{ path?: PropertyKey[]; message: string }> = [];
  validateProviderSpecificData(data, {
    addIssue(issue) {
      issues.push(issue as { path?: PropertyKey[]; message: string });
    },
  } as Parameters<typeof validateProviderSpecificData>[1]);
  return issues;
}

test("provider metadata accepts the allowlisted Dario usage capability", () => {
  assert.deepEqual(
    issuesFor({ usageAdapter: "dario", usageBaseUrl: "https://example.com/prefix" }),
    []
  );
});

test("provider metadata rejects arbitrary usage adapters", () => {
  const issues = issuesFor({ usageAdapter: "../../module" });
  assert.equal(
    issues.some((issue) => issue.path?.includes("usageAdapter")),
    true
  );
});

test("provider metadata rejects ambiguous or credential-bearing usage URLs", () => {
  for (const usageBaseUrl of [
    "ftp://example.com",
    "https://user:pass@example.com",
    "https://example.com?token=value",
    "https://example.com/#fragment",
  ]) {
    const issues = issuesFor({ usageAdapter: "dario", usageBaseUrl });
    assert.equal(
      issues.some((issue) => issue.path?.includes("usageBaseUrl")),
      true
    );
  }
});
