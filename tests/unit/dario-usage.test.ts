import test from "node:test";
import assert from "node:assert/strict";

import {
  buildDarioUsage,
  getDarioUsage,
  resolveDarioAccountsUrl,
} from "../../open-sse/services/usage/dario.ts";
import {
  isDarioUsageConnection,
  resolveUsageAdapter,
} from "../../open-sse/services/usage/adapter.ts";

test("Dario capability is explicit and allowlisted", () => {
  const connection = {
    provider: "anthropic-compatible-12345678-abcd-4abc-8abc-123456789abc",
    authType: "apikey",
    providerSpecificData: { usageAdapter: "dario" },
  };

  assert.equal(isDarioUsageConnection(connection), true);
  assert.equal(resolveUsageAdapter(connection), "dario");
  assert.equal(
    isDarioUsageConnection({
      provider: connection.provider,
      authType: "apikey",
      providerSpecificData: { usageAdapter: "../../arbitrary-module" },
    }),
    false
  );
  assert.equal(resolveUsageAdapter({ provider: "claude" }), "claude");
  assert.equal(
    isDarioUsageConnection({
      provider: "claude",
      authType: "oauth",
      providerSpecificData: { usageAdapter: "dario" },
    }),
    false
  );
});

test("Dario usage URL preserves a reverse-proxy prefix", () => {
  assert.equal(
    resolveDarioAccountsUrl({
      provider: "anthropic-compatible-12345678-abcd-4abc-8abc-123456789abc",
      authType: "apikey",
      providerSpecificData: {
        usageAdapter: "dario",
        usageBaseUrl: "https://gateway.example/dario-a",
      },
    }),
    "https://gateway.example/dario-a/accounts"
  );
  assert.equal(
    resolveDarioAccountsUrl({
      provider: "anthropic-compatible-12345678-abcd-4abc-8abc-123456789abc",
      authType: "apikey",
      providerSpecificData: {
        usageAdapter: "dario",
        baseUrl: "https://gateway.example/dario-a/v1",
      },
    }),
    "https://gateway.example/dario-a/accounts"
  );
});

test("Dario usage URL rejects credentials, queries, and ambiguous fallback paths", () => {
  for (const providerSpecificData of [
    { usageAdapter: "dario", usageBaseUrl: "https://user:pass@example.com" },
    { usageAdapter: "dario", usageBaseUrl: "https://example.com?secret=value" },
    { usageAdapter: "dario", baseUrl: "https://example.com/v1/messages" },
  ]) {
    assert.throws(() =>
      resolveDarioAccountsUrl({
        provider: "anthropic-compatible-12345678-abcd-4abc-8abc-123456789abc",
        authType: "apikey",
        providerSpecificData,
      })
    );
  }
});

test("Dario maps fresh observed utilization to percentage quota windows", () => {
  const now = Date.parse("2026-09-06T10:00:00.000Z");
  const usage = buildDarioUsage(
    {
      accounts: [
        {
          id: "account-a",
          status: "healthy",
          util5h: 0.31,
          util7d: 1.2,
          utilAgeMs: 60_000,
          lastObservedAt: "2026-09-06T09:59:00.000Z",
        },
      ],
      bestAccount: "account-a",
    },
    now
  );

  assert.equal(usage.plan, "Dario pool");
  assert.deepEqual(usage.quotas["session (5h)"], {
    used: 31,
    total: 100,
    remaining: 69,
    remainingPercentage: 69,
    resetAt: null,
    unlimited: false,
  });
  assert.equal(usage.quotas["weekly (7d)"].used, 100);
  assert.equal(usage.quotas["weekly (7d)"].remainingPercentage, 0);
});

test("Dario pool uses bestAccount instead of an exhausted secondary account", () => {
  const usage = buildDarioUsage(
    {
      bestAccount: "healthy",
      accounts: [
        { id: "exhausted", util5h: 1, util7d: 1, utilAgeMs: 1 },
        { id: "healthy", util5h: 0.2, util7d: 0.4, utilAgeMs: 1 },
      ],
    },
    Date.now()
  );

  assert.equal(usage.quotas["session (5h)"].used, 20);
  assert.equal(usage.quotas["weekly (7d)"].used, 40);
});

test("Dario leaves unroutable account states unknown", () => {
  for (const status of ["auth-cooldown", "rejected", "expired", "disabled"]) {
    const usage = buildDarioUsage({
      accounts: [{ id: "a", status, util5h: 0.1, util7d: 0.2, utilAgeMs: 1 }],
      bestAccount: "a",
    });
    assert.equal(usage.quotas, undefined);
  }
});

test("Dario accepts numeric lastObservedAt in epoch milliseconds", () => {
  const now = Date.parse("2026-09-06T10:00:00.000Z");
  const usage = buildDarioUsage(
    {
      accounts: [
        {
          id: "a",
          status: "healthy",
          util5h: 0.1,
          util7d: 0.2,
          lastObservedAt: now - 60_000,
        },
      ],
    },
    now
  );
  assert.equal(usage.quotas?.["session (5h)"].used, 10);
});

test("Dario rejects malformed members in an otherwise single-account pool", () => {
  const usage = buildDarioUsage({
    accounts: [{ id: "a", status: "healthy", util5h: 0.1, util7d: 0.2, utilAgeMs: 1 }, null],
  });
  assert.equal(usage.quotas, undefined);
});

test("Dario leaves empty, ambiguous, and stale observations unknown", () => {
  const now = Date.parse("2026-09-06T10:00:00.000Z");
  assert.equal(buildDarioUsage({ accounts: [] }, now).quotas, undefined);
  assert.equal(
    buildDarioUsage(
      {
        accounts: [
          { id: "a", util5h: 0.1 },
          { id: "b", util5h: 0.2 },
        ],
      },
      now
    ).quotas,
    undefined
  );
  assert.equal(
    buildDarioUsage(
      {
        accounts: [
          {
            id: "a",
            util5h: 0.1,
            util7d: 0.2,
            utilAgeMs: 15 * 60_000 + 1,
            lastObservedAt: "2026-09-06T09:44:59.999Z",
          },
        ],
      },
      now
    ).quotas,
    undefined
  );
});

test("Dario blocks cloud metadata before sending the connection credential", async () => {
  let called = false;
  const usage = await getDarioUsage(
    {
      provider: "anthropic-compatible-12345678-abcd-4abc-8abc-123456789abc",
      authType: "apikey",
      apiKey: "test-key",
      providerSpecificData: {
        usageAdapter: "dario",
        usageBaseUrl: "http://169.254.169.254/latest/meta-data",
      },
    },
    {
      fetchImpl: async () => {
        called = true;
        return new Response("{}", { headers: { "content-type": "application/json" } });
      },
    }
  );

  assert.equal(called, false);
  assert.equal(usage.message, "Dario usage request failed");
});

test("Dario fetch uses the connection API key without leaking it on failures", async () => {
  const marker = "DARIO-SECRET-MARKER";
  let request: { url?: string; init?: RequestInit } = {};
  const usage = await getDarioUsage(
    {
      provider: "anthropic-compatible-12345678-abcd-4abc-8abc-123456789abc",
      authType: "apikey",
      apiKey: marker,
      providerSpecificData: {
        usageAdapter: "dario",
        usageBaseUrl: "https://example.com/dario",
      },
    },
    {
      fetchImpl: async (url, init) => {
        request = { url: String(url), init };
        return new Response(`upstream rejected ${marker}`, { status: 401 });
      },
    }
  );

  assert.equal(request.url, "https://example.com/dario/accounts");
  assert.equal(new Headers(request.init?.headers).get("authorization"), `Bearer ${marker}`);
  assert.equal(usage.message, "Dario usage authentication failed");
  assert.equal(JSON.stringify(usage).includes(marker), false);
});
