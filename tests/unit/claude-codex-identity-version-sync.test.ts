/**
 * tests/unit/claude-codex-identity-version-sync.test.ts
 *
 * Guards the pinned CLI identity versions against drift. The Claude Code version
 * lives in FOUR places (claudeIdentity, anthropicHeaders, claudeCodeCompatible,
 * ccBridgeTransforms) and MUST stay in lockstep — a partial bump produces an
 * inconsistent wire fingerprint. The Codex client version lives in codexClient.
 *
 * When you capture a newer claude-cli / codex release, bump ALL constants and
 * update the pinned values below in the same change.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const id = await import("../../open-sse/executors/claudeIdentity.ts");
const hdr = await import("../../open-sse/config/anthropicHeaders.ts");
const compat = await import("../../open-sse/services/claudeCodeCompatible.ts");
const bridge = await import("../../open-sse/services/ccBridgeTransforms.ts");
const codexCfg = await import("../../open-sse/config/codexClient.ts");
const canonical = await import("../../src/shared/constants/claudeCodeClient.ts");

test("Claude CLI version constants are in lockstep across all 4 sources", () => {
  const V = canonical.CLAUDE_CODE_CLIENT_VERSION;
  assert.equal(id.CLAUDE_CODE_VERSION, V, "claudeIdentity.CLAUDE_CODE_VERSION drift");
  assert.equal(hdr.CLAUDE_CLI_VERSION, V, "anthropicHeaders.CLAUDE_CLI_VERSION drift");
  assert.equal(compat.CLAUDE_CODE_COMPATIBLE_VERSION, V, "claudeCodeCompatible version drift");
  assert.equal(bridge.DEFAULT_CLAUDE_CODE_VERSION, V, "ccBridgeTransforms version drift");
  assert.equal(
    hdr.CLAUDE_CLI_USER_AGENT,
    `claude-cli/${V} (external, cli)`,
    "CLAUDE_CLI_USER_AGENT drift"
  );
  assert.equal(
    compat.CLAUDE_CODE_COMPATIBLE_USER_AGENT,
    `claude-cli/${V} (external, sdk-cli)`,
    "CLAUDE_CODE_COMPATIBLE_USER_AGENT drift"
  );
});

test("Claude CLI wire versions match the captured 2.1.258 binary", () => {
  assert.equal(canonical.CLAUDE_CODE_CLIENT_VERSION, "2.1.258");
  assert.equal(canonical.CLAUDE_CODE_CLIENT_BUILD_REVISION, "1e2");
  assert.equal(canonical.CLAUDE_CODE_CLIENT_BILLING_VERSION, "2.1.258.1e2");
  assert.equal(canonical.CLAUDE_CODE_SDK_PACKAGE_VERSION, "0.112.1");
  assert.equal(canonical.CLAUDE_CODE_RUNTIME_VERSION, "v26.3.0");
  assert.equal(
    compat.CLAUDE_CODE_COMPATIBLE_STAINLESS_PACKAGE_VERSION,
    canonical.CLAUDE_CODE_SDK_PACKAGE_VERSION
  );
  assert.equal(
    compat.CLAUDE_CODE_COMPATIBLE_STAINLESS_RUNTIME_VERSION,
    canonical.CLAUDE_CODE_RUNTIME_VERSION
  );
  assert.equal(hdr.CLAUDE_CLI_STAINLESS_PACKAGE_VERSION, canonical.CLAUDE_CODE_SDK_PACKAGE_VERSION);
  assert.equal(hdr.CLAUDE_CLI_STAINLESS_RUNTIME_VERSION, canonical.CLAUDE_CODE_RUNTIME_VERSION);
  assert.equal(hdr.CLAUDE_CLI_BILLING_VERSION, canonical.CLAUDE_CODE_CLIENT_BILLING_VERSION);
});

test("Codex client version locksteps Dockerfile @openai/codex and env override", () => {
  const dockerfile = fs.readFileSync(path.join(process.cwd(), "Dockerfile"), "utf8");
  const match = dockerfile.match(/@openai\/codex@([0-9]+\.[0-9]+\.[0-9]+)/);
  assert.ok(match, "Dockerfile must pin @openai/codex@x.y.z");
  const pinned = match[1];
  assert.notEqual(pinned, "0.149.0");
  assert.equal(codexCfg.DEFAULT_CODEX_CLIENT_VERSION, pinned);
  assert.equal(codexCfg.getCodexClientVersion(), pinned);
  assert.equal(codexCfg.getCodexDefaultHeaders().Version, pinned);
  assert.equal(
    codexCfg.getCodexCliRsHeaders()["User-Agent"],
    `codex_cli_rs/${pinned}`,
  );
});

test("test 7: live-empty GitHub catalog path does not call persist", () => {
  const src = fs.readFileSync(
    path.join(process.cwd(), "src/app/api/providers/[id]/models/route.ts"),
    "utf8",
  );
  // The githubCatalogModels fallback must use buildResponse, not buildApiDiscoveryResponse.
  const idx = src.indexOf("Codex live catalog unavailable — using GitHub model catalog");
  assert.ok(idx > 0);
  const start = src.lastIndexOf("if (githubCatalogModels", idx);
  const end = src.indexOf("if (cachedDiscoveryModels", idx);
  assert.ok(start > 0 && end > start);
  const window = src.slice(start, end);
  assert.match(window, /buildResponse\s*\(/);
  assert.doesNotMatch(window, /buildApiDiscoveryResponse\s*\(/);

  const liveIdx = src.lastIndexOf("if (liveModels && liveModels.length > 0)");
  assert.ok(liveIdx > 0 && liveIdx < start);
  const liveWindow = src.slice(liveIdx, start);
  assert.match(liveWindow, /buildApiDiscoveryResponse\s*\(/);
});
