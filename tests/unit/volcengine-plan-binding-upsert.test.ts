import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { resetDbInstance } from "../../src/lib/db/core.ts";
import {
  createProviderConnection,
  getProviderConnectionById,
} from "../../src/models/index.ts";
import { detectPlan, __testing as bindingTesting } from "../../src/lib/providers/volcenginePlanBinding.ts";

test("detectPlan returns available: false when account has no active quota windows (unsubscribed)", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  // Mock console response with empty QuotaUsage
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        ResponseMetadata: {},
        Result: {
          QuotaUsage: [],
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );

  const coding = await detectPlan("coding", "cookie=1", "csrf=1");
  assert.equal(coding.available, false);

  // Mock console response for Agent with empty quota object
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        ResponseMetadata: {},
        Result: {},
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );

  const agent = await detectPlan("agent", "cookie=1", "csrf=1");
  assert.equal(agent.available, false);
});

test("volcenginePlanBinding upsert rules with SQLite temp isolation", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "or-volc-test-"));
  const prevDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = tempDir;

  t.after(() => {
    resetDbInstance();
    if (prevDataDir) process.env.DATA_DIR = prevDataDir;
    else delete process.env.DATA_DIR;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  resetDbInstance();

  // T-1: Single connection named 'main' is adopted and updated, preserving name and autoFetchModels
  const conn1 = await createProviderConnection({
    provider: "volcengine-coding-plan",
    name: "main",
    apiKey: "ark-original-key-1",
    providerSpecificData: { autoFetchModels: true, customTag: "keep-me" },
  });

  const updated1 = await (bindingTesting as any).upsertConnection(
    "coding",
    "ark-new-key-1",
    "new-cookie-1",
    "new-csrf-1",
    123,
    { dummy: 1 },
    undefined
  );

  assert.equal(updated1.id, conn1.id);
  assert.equal(updated1.name, "main", "Preserves original custom name 'main'");
  assert.equal(updated1.apiKey, "ark-new-key-1");
  assert.equal(updated1.providerSpecificData.autoFetchModels, true, "Preserves existing PSD autoFetchModels");
  assert.equal(updated1.providerSpecificData.customTag, "keep-me", "Preserves existing PSD customTag");
  assert.equal(updated1.providerSpecificData.volcConsoleCookie, "new-cookie-1");
  assert.equal(updated1.providerSpecificData.volcApiKeyId, 123);

  // T-4: Multiple connections exist without match -> safely creates new connection without clobbering
  await createProviderConnection({
    provider: "volcengine-coding-plan",
    name: "secondary",
    apiKey: "ark-other-key-2",
    providerSpecificData: {},
  });

  const createdNew = await (bindingTesting as any).upsertConnection(
    "coding",
    "ark-brand-new-key-3",
    "new-cookie-3",
    "new-csrf-3",
    999,
    {},
    undefined
  );

  assert.notEqual(createdNew.id, conn1.id);
  assert.equal(createdNew.name, "Volcano Ark Coding Plan");
  const preserved = await getProviderConnectionById(conn1.id as string);
  assert.equal(preserved.apiKey, "ark-new-key-1", "Original connection was NOT clobbered");

  // T-5: targetConnectionId with cross-provider guard
  const agentConn = await createProviderConnection({
    provider: "volcengine-agent-plan",
    name: "agent-main",
    apiKey: "ark-agent-key",
    providerSpecificData: {},
  });

  // Passing conn1.id (which is coding-plan) into agent upsert must NOT match conn1
  const agentUpsertResult = await (bindingTesting as any).upsertConnection(
    "agent",
    "ark-agent-new-key",
    "agent-cookie",
    "agent-csrf",
    888,
    {},
    conn1.id as string // Mismatched provider
  );
  assert.notEqual(agentUpsertResult.id, conn1.id);
  assert.equal(agentUpsertResult.id, agentConn.id, "Matched the single agent connection instead");
});
