import test from "node:test";
import assert from "node:assert/strict";

const genericModule = await import("../../open-sse/services/genericQuotaFetcher.ts");
const preflightModule = await import("../../open-sse/services/quotaPreflight.ts");

const { convertUsageToQuotaInfo, fetchGenericQuota, registerGenericQuotaFetchers } = genericModule;
const { getQuotaFetcher, preflightQuota, resolveQuotaFetcher } = preflightModule;

test("convertUsageToQuotaInfo returns null on null/undefined input", () => {
  assert.equal(convertUsageToQuotaInfo(null), null);
  assert.equal(convertUsageToQuotaInfo(undefined), null);
});

test("convertUsageToQuotaInfo returns null when only an error message is present", () => {
  // Auth-expired-style response from getUsageForProvider — fail open.
  assert.equal(convertUsageToQuotaInfo({ message: "auth expired" }), null);
});

test("convertUsageToQuotaInfo maps remainingPercentage into per-window percentUsed", () => {
  const result = convertUsageToQuotaInfo({
    quotas: {
      session: { remainingPercentage: 30, resetAt: "2026-05-14T20:00:00Z" },
      weekly: { remainingPercentage: 10, resetAt: "2026-05-21T00:00:00Z" },
    },
  });
  assert.ok(result);
  assert.deepEqual(result!.windows, {
    session: { percentUsed: 0.7, resetAt: "2026-05-14T20:00:00Z" },
    weekly: { percentUsed: 0.9, resetAt: "2026-05-21T00:00:00Z" },
  });
  // Worst-case percentUsed mirrors what the legacy single-signal field needs.
  assert.equal(result!.percentUsed, 0.9);
  // Reset time should track the worst-case window so preflight can surface it.
  assert.equal(result!.resetAt, "2026-05-21T00:00:00Z");
});

test("convertUsageToQuotaInfo falls back to used/total when remainingPercentage is absent", () => {
  const result = convertUsageToQuotaInfo({
    quotas: { session: { used: 45, total: 100, resetAt: null } },
  });
  assert.ok(result);
  assert.equal(result!.windows!.session.percentUsed, 0.45);
});

test("convertUsageToQuotaInfo skips unlimited and unmeasurable windows", () => {
  const result = convertUsageToQuotaInfo({
    quotas: {
      session: { remainingPercentage: 50, resetAt: null },
      // No percentage and no used/total → skipped.
      unknown_shape: { resetAt: null },
      // Unlimited windows are intentionally ignored — preflight can't block on them.
      unlimited_credits: { unlimited: true, remainingPercentage: 99 },
    },
  });
  assert.ok(result);
  assert.deepEqual(Object.keys(result!.windows || {}), ["session"]);
});

test("convertUsageToQuotaInfo returns null when no windows are measurable", () => {
  const result = convertUsageToQuotaInfo({
    quotas: { unlimited_thing: { unlimited: true } },
  });
  assert.equal(result, null);
});

test("convertUsageToQuotaInfo clamps remainingPercentage outside 0-100", () => {
  const result = convertUsageToQuotaInfo({
    quotas: {
      a: { remainingPercentage: 150, resetAt: null }, // clamped to 100 → 0% used
      b: { remainingPercentage: -10, resetAt: null }, // clamped to 0 → 100% used
    },
  });
  assert.ok(result);
  assert.equal(result!.windows!.a.percentUsed, 0);
  assert.equal(result!.windows!.b.percentUsed, 1);
});

test("convertUsageToQuotaInfo ignores a window whose fraction was not reported by upstream (#6295)", () => {
  // Antigravity sets fractionReported:false and defaults remainingPercentage
  // to 0 when a model's usage fraction isn't returned upstream. That must
  // NOT be treated as "100% used" — the window should be skipped entirely.
  const result = convertUsageToQuotaInfo({
    quotas: {
      unreported_model: { remainingPercentage: 0, fractionReported: false, resetAt: null },
    },
  });
  assert.equal(result, null);
});

test("convertUsageToQuotaInfo does not let an unreported window inflate worstPercent (#6295)", () => {
  const result = convertUsageToQuotaInfo({
    quotas: {
      reported_low: { remainingPercentage: 80, fractionReported: true, resetAt: null },
      unreported_model: { remainingPercentage: 0, fractionReported: false, resetAt: null },
    },
  });
  assert.ok(result);
  assert.deepEqual(Object.keys(result!.windows || {}), ["reported_low"]);
  assert.equal(result!.percentUsed, 0.2);
  assert.equal(result!.limitReached, false);
});

test("registerGenericQuotaFetchers registers Claude, GLM, and OpenCode Go via the generic adapter", () => {
  registerGenericQuotaFetchers();
  // Claude has no bespoke fetcher → should be registered.
  assert.ok(getQuotaFetcher("claude"), "claude should be registered");
  assert.ok(getQuotaFetcher("glm"), "glm should be registered");
  assert.ok(getQuotaFetcher("zai"), "zai should be registered");
  assert.ok(getQuotaFetcher("opencode-go"), "opencode-go should be registered");
  // Codex has its own dedicated fetcher (registered by codexQuotaFetcher.ts,
  // not by the generic registrar) — the generic registrar skips it. We can't
  // assert "codex" here without first calling registerCodexQuotaFetcher,
  // which would couple this test to chat.ts startup wiring. The skip list
  // semantics are exercised by the source code review.
});

test("Dario quota fetcher resolves from a compatible connection capability", () => {
  registerGenericQuotaFetchers();
  const connection = {
    provider: "anthropic-compatible-12345678-abcd-4abc-8abc-123456789abc",
    authType: "apikey",
    providerSpecificData: { usageAdapter: "dario" },
  };
  assert.equal(resolveQuotaFetcher(connection.provider, connection), getQuotaFetcher("dario"));
  assert.equal(
    resolveQuotaFetcher("anthropic-compatible-12345678-abcd-4abc-8abc-123456789abc", {
      provider: "anthropic-compatible-12345678-abcd-4abc-8abc-123456789abc",
      providerSpecificData: {},
    }),
    undefined
  );
});

test("Dario preflight blocks when either observed window reaches its cutoff", async () => {
  registerGenericQuotaFetchers();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({ accounts: [{ id: "a", util5h: 0.5, util7d: 0.99, utilAgeMs: 1 }] }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  try {
    const connection = {
      provider: "anthropic-compatible-12345678-abcd-4abc-8abc-123456789abc",
      authType: "apikey",
      apiKey: "test-key",
      providerSpecificData: {
        usageAdapter: "dario",
        usageBaseUrl: "https://example.com/dario",
      },
    };
    const result = await preflightQuota(connection.provider, "dario-cutoff-test", connection, {
      resolveMinRemainingPercent: () => 2,
    });
    assert.equal(result.proceed, false);
    assert.equal(result.reason, "quota_exhausted");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Dario generic quota cache stays isolated by connection id", async () => {
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    calls++;
    return new Response(
      JSON.stringify({ accounts: [{ id: "a", util5h: 0.2, util7d: 0.3, utilAgeMs: 1 }] }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };
  const connection = {
    provider: "anthropic-compatible-12345678-abcd-4abc-8abc-123456789abc",
    authType: "apikey",
    apiKey: "test-key",
    providerSpecificData: {
      usageAdapter: "dario",
      usageBaseUrl: "https://example.com/dario",
    },
  };
  try {
    await fetchGenericQuota("dario-cache-a", connection);
    await fetchGenericQuota("dario-cache-a", connection);
    await fetchGenericQuota("dario-cache-b", connection);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
