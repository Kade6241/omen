import test from "node:test";
import assert from "node:assert/strict";
import { detectPlan } from "../../src/lib/providers/volcenginePlanBinding.ts";

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
