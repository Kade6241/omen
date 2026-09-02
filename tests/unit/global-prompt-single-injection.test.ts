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

test("claude-format body WITHOUT system field: combined goes to body.system, not messages", () => {
  resetConfig();
  const body = { messages: [{ role: "user", content: "hi" }] };
  const out = injectSystemPromptPostTranslation(body, { targetFormat: "claude" });
  assert.equal(out.system, "PREFIX-RULES\n\nSUFFIX-RULES");
  assert.ok(!out.messages.some((m) => m.role === "system"), "claude target must never get a system-role message in messages");
});

test("claude-format array system: prefix/suffix as text blocks, once each", () => {
  resetConfig();
  const body = { system: [{ type: "text", text: "CLIENT" }], messages: [{ role: "user", content: "hi" }] };
  const out = injectSystemPromptPostTranslation(body, { targetFormat: "claude" });
  assert.deepEqual(out.system, [
    { type: "text", text: "PREFIX-RULES" },
    { type: "text", text: "CLIENT" },
    { type: "text", text: "SUFFIX-RULES" },
  ]);
  assert.ok(!out.messages.some((m) => m.role === "system"));
});

test("gemini-format body: systemInstruction parts get prefix/suffix once each", () => {
  resetConfig();
  // Real shape produced by open-sse/translator/request/claude-to-gemini.ts:95-97
  // and openai-to-gemini.ts:350-356: { role: "system", parts: [{ text }] }
  const body = {
    contents: [{ role: "user", parts: [{ text: "hi" }] }],
    systemInstruction: { role: "system", parts: [{ text: "CLIENT" }] },
  };
  const out = injectSystemPromptPostTranslation(body, { targetFormat: "gemini" });
  const texts = out.systemInstruction.parts.map((p) => p.text);
  assert.equal(texts.filter((t) => t === "PREFIX-RULES").length, 1);
  assert.equal(texts.filter((t) => t === "SUFFIX-RULES").length, 1);
  assert.ok(texts.includes("CLIENT"));
});

test("gemini-format body without systemInstruction: combined systemInstruction created", () => {
  resetConfig();
  const body = { contents: [{ role: "user", parts: [{ text: "hi" }] }] };
  const out = injectSystemPromptPostTranslation(body, { targetFormat: "gemini" });
  const texts = out.systemInstruction.parts.map((p) => p.text).join("|");
  assert.equal(countOccurrences(texts, "PREFIX-RULES"), 1);
  assert.equal(countOccurrences(texts, "SUFFIX-RULES"), 1);
  assert.equal(out.contents.length, 1, "contents untouched");
});

test("responses-format body: instructions wrapped once, input untouched", () => {
  resetConfig();
  // Real targetFormat value is FORMATS.OPENAI_RESPONSES = "openai-responses"
  // (open-sse/translator/formats.ts), not "responses".
  const body = { model: "m", input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }], instructions: "INSTR" };
  const out = injectSystemPromptPostTranslation(body, { targetFormat: "openai-responses" });
  assert.equal(out.instructions, "PREFIX-RULES\n\nINSTR\n\nSUFFIX-RULES");
  assert.equal(out.input.length, 1);
});

test("responses-format body without instructions: combined instructions created", () => {
  resetConfig();
  const body = { model: "m", input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }] };
  const out = injectSystemPromptPostTranslation(body, { targetFormat: "openai-responses" });
  assert.equal(out.instructions, "PREFIX-RULES\n\nSUFFIX-RULES");
});

// M3: reset config so this file's settings never leak into other test files.
test.after(() => setSystemPromptConfig({ enabled: false, prefixPrompt: "", suffixPrompt: "" }));
