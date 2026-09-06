import test from "node:test";
import assert from "node:assert/strict";

import { getUsageForProvider, USAGE_FETCHER_PROVIDERS } from "../../open-sse/services/usage.ts";
import { isSupportedUsageConnection } from "../../src/lib/usage/providerLimits.ts";

test("usage registry includes the internal Dario adapter", () => {
  assert.equal((USAGE_FETCHER_PROVIDERS as readonly string[]).includes("dario"), true);
});

test("Provider Limits accepts only API-key compatible connections with Dario capability", () => {
  assert.equal(
    isSupportedUsageConnection({
      id: "dario",
      provider: "anthropic-compatible-12345678-abcd-4abc-8abc-123456789abc",
      authType: "apikey",
      providerSpecificData: { usageAdapter: "dario" },
    }),
    true
  );
  assert.equal(
    isSupportedUsageConnection({
      id: "ordinary",
      provider: "anthropic-compatible-12345678-abcd-4abc-8abc-123456789abc",
      authType: "apikey",
      providerSpecificData: {},
    }),
    false
  );
  assert.equal(
    isSupportedUsageConnection({ id: "github-api-key", provider: "github", authType: "apikey" }),
    false
  );
});

test("dynamic compatible provider dispatches usage through the Dario adapter", async () => {
  const originalFetch = globalThis.fetch;
  let calledUrl = "";
  globalThis.fetch = async (input) => {
    calledUrl = String(input);
    return new Response(
      JSON.stringify({
        accounts: [{ id: "a", util5h: 0.25, util7d: 0.5, utilAgeMs: 1 }],
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };

  try {
    const usage = (await getUsageForProvider({
      provider: "anthropic-compatible-12345678-abcd-4abc-8abc-123456789abc",
      authType: "apikey",
      apiKey: "test-key",
      providerSpecificData: {
        baseUrl: "https://example.com/dario/v1",
        usageAdapter: "dario",
      },
    })) as { quotas?: Record<string, { used: number }> };

    assert.equal(calledUrl, "https://example.com/dario/accounts");
    assert.equal(usage.quotas?.["session (5h)"].used, 25);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
