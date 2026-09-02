import test from "node:test";
import { strict as assert } from "node:assert";

const {
  setSystemPromptConfig,
  injectSystemPromptPostTranslation,
} = await import("../../open-sse/services/systemPrompt.ts");

const PREFIX = "PREFIX-RULES";
const SUFFIX = "SUFFIX-RULES";

function resetConfig() {
  setSystemPromptConfig({ enabled: true, prefixPrompt: PREFIX, suffixPrompt: SUFFIX });
}

function countOccurrences(s, needle) {
  return s.split(needle).length - 1;
}

test("idempotence: second application is a no-op (ONE copy of prefix/suffix)", () => {
  resetConfig();
  const body = { messages: [{ role: "system", content: "ORIG" }, { role: "user", content: "hi" }] };
  const once = injectSystemPromptPostTranslation(body);
  const twice = injectSystemPromptPostTranslation(once);
  assert.equal(twice.messages.length, once.messages.length, "no message growth on second pass");
  assert.equal(countOccurrences(String(twice.messages[0].content), PREFIX), 1);
  assert.equal(countOccurrences(String(twice.messages[0].content), SUFFIX), 1);
});

test("no client system -> exactly one combined system inserted", () => {
  resetConfig();
  const body = { messages: [{ role: "user", content: "hi" }] };
  const out = injectSystemPromptPostTranslation(body);
  const systems = out.messages.filter((m) => m.role === "system");
  assert.equal(systems.length, 1);
  assert.ok(String(systems[0].content).startsWith(PREFIX));
  assert.ok(String(systems[0].content).endsWith(SUFFIX));
});

test("claude-format body: system field gets injection, messages untouched", () => {
  resetConfig();
  const body = { system: "CLIENT", messages: [{ role: "user", content: "hi" }] };
  const out = injectSystemPromptPostTranslation(body);
  assert.equal(out.system, "PREFIX-RULES\n\nCLIENT\n\nSUFFIX-RULES");
  assert.ok(!out.messages.some((m) => m.role === "system"), "no system-role message inside claude messages");
});

test("idempotence flag does not leak into upstream JSON", () => {
  resetConfig();
  const body = { messages: [{ role: "user", content: "hi" }] };
  const out = injectSystemPromptPostTranslation(body);
  assert.equal(JSON.stringify(out).includes("_systemPromptInjected"), false, "flag must stay non-enumerable");
});

test("multi-system codex semantics preserved: prefix on first, suffix on last", () => {
  resetConfig();
  const body = {
    messages: [
      { role: "system", content: "A" },
      { role: "developer", content: "B" },
      { role: "user", content: "hi" },
    ],
  };
  const out = injectSystemPromptPostTranslation(body);
  assert.equal(countOccurrences(String(out.messages[0].content), PREFIX), 1);
  assert.equal(countOccurrences(String(out.messages[1].content), SUFFIX), 1);
});

test("skip flag respected", () => {
  resetConfig();
  const body = { _skipSystemPrompt: true, messages: [{ role: "user", content: "hi" }] };
  const out = injectSystemPromptPostTranslation(body);
  assert.equal(out.messages.length, 1, "no injection when _skipSystemPrompt");
});
