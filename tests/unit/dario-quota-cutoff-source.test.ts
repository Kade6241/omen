import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const cutoffSource = fs.readFileSync(
  new URL("../../open-sse/services/combo/quotaExhaustionCutoff.ts", import.meta.url),
  "utf8"
);
const strategiesSource = fs.readFileSync(
  new URL("../../open-sse/services/combo/quotaStrategies.ts", import.meta.url),
  "utf8"
);
const comboSource = fs.readFileSync(
  new URL("../../open-sse/services/combo.ts", import.meta.url),
  "utf8"
);

test("non-auto combo quota cutoff resolves fetcher from the loaded connection", () => {
  assert.match(cutoffSource, /resolveQuotaFetcher\(provider, connection\)/);
  assert.doesNotMatch(cutoffSource, /const fetcher = getQuotaFetcher\(provider\)/);
});

test("reset-aware quota strategies resolve fetchers from connections", () => {
  assert.match(strategiesSource, /resolveQuotaFetcher\(provider, connection\)/);
  assert.match(strategiesSource, /isCompatibleProviderConnectionId\(provider\)/);
  assert.match(
    strategiesSource,
    /activeConnections\.filter\(\(connection\) =>\s*resolveQuotaFetcher\(provider, connection\)\s*\)/
  );
});

test("auto combo quota scoring resolves fetcher from its connection", () => {
  assert.match(comboSource, /resolveQuotaFetcher\(resolveProviderId\(provider\), connection\)/);
});

test("reset-aware refresh preserves last-known-good quota when refresh returns null", () => {
  assert.match(
    strategiesSource,
    /if \(quota\)[\s\S]*?resetAwareQuotaCache\.set\(cacheKey,[\s\S]*?else if \(!existing\?\.quota\)[\s\S]*?resetAwareQuotaCache\.delete\(cacheKey\)/
  );
});
