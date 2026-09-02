/**
 * System Prompt Injection — Phase 10.1
 *
 * Injects TWO global system prompts into all requests at proxy level:
 *   - prefixPrompt: prepended BEFORE existing system/agent content
 *   - suffixPrompt: appended AFTER existing system/agent content
 *
 * This gives the user full control over instruction priority (#2468):
 *   prefix → agent/provider instructions → suffix (highest recency priority)
 *
 * Uses globalThis to share config across Turbopack module instances (#2470).
 */

const GLOBAL_KEY = "__omniroute_systemPrompt_config__";

interface SystemPromptConfig {
  enabled: boolean;
  prefixPrompt: string;
  suffixPrompt: string;
  prompt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSystemMessage(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && (value.role === "system" || value.role === "developer");
}

// Typed accessor for globalThis storage — avoids `as any` casts (#2470)
const _store = globalThis as unknown as Record<string, SystemPromptConfig | undefined>;

function getConfig(): SystemPromptConfig {
  if (!_store[GLOBAL_KEY]) {
    _store[GLOBAL_KEY] = {
      enabled: false,
      prefixPrompt: "",
      suffixPrompt: "",
      prompt: "",
    };
  }
  return _store[GLOBAL_KEY]!;
}

function setConfig(cfg: SystemPromptConfig): void {
  _store[GLOBAL_KEY] = cfg;
}

/**
 * Set system prompt config (supports legacy `prompt` field for migration)
 */
export function setSystemPromptConfig(config: Partial<SystemPromptConfig>) {
  const current = getConfig();
  const base = { ...current };
  if ("prefixPrompt" in config || "suffixPrompt" in config) {
    base.prompt = "";
  }
  const merged = { ...base, ...config };
  if (merged.prompt && !merged.suffixPrompt && !("suffixPrompt" in config)) {
    merged.suffixPrompt = merged.prompt;
  }
  setConfig(merged);
}

/**
 * Get system prompt config
 */
export function getSystemPromptConfig() {
  const cfg = getConfig();
  return {
    enabled: cfg.enabled,
    prefixPrompt: cfg.prefixPrompt,
    suffixPrompt: cfg.suffixPrompt,
  };
}

/**
 * Inject system prompts into request body.
 *
 * prefixPrompt is prepended before existing system content.
 * suffixPrompt is appended after existing system content.
 * This ensures: prefix → agent instructions → suffix (#2468).
 *
 * @param body - Request body
 * @returns Modified body
 */
export function injectSystemPrompt<T>(body: T): T {
  const cfg = getConfig();
  if (!cfg.enabled) return body;
  const prefix = cfg.prefixPrompt || "";
  const suffix = cfg.suffixPrompt || "";
  if (!prefix && !suffix) return body;
  if (!isRecord(body)) return body;
  if (body._skipSystemPrompt) return body;
  if (body._systemPromptInjected) return body;

  const result: Record<string, unknown> = { ...body };

  // OpenAI/Claude format (messages[])
  if (result.messages && Array.isArray(result.messages)) {
    const messages: unknown[] = result.messages;
    const sysIdx = messages.findIndex(isSystemMessage);
    const nextMessages = [...messages];
    if (sysIdx >= 0) {
      const existingMessage = nextMessages[sysIdx];
      if (isRecord(existingMessage)) {
        const msg = { ...existingMessage };
        if (Array.isArray(msg.content)) {
          const content: unknown[] = [...msg.content];
          if (prefix) content.unshift({ type: "text", text: prefix });
          if (suffix) content.push({ type: "text", text: suffix });
          msg.content = content;
        } else {
          let content = String(msg.content || "");
          if (prefix) content = prefix + "\n\n" + content;
          if (suffix) content = content + "\n\n" + suffix;
          msg.content = content;
        }
        nextMessages[sysIdx] = msg;
      }
    } else {
      // No existing system message — combine both into one
      const combined = [prefix, suffix].filter(Boolean).join("\n\n");
      if (combined) {
        nextMessages.unshift({ role: "system", content: combined });
      }
    }
    result.messages = nextMessages;
  }

  // Claude format (system field)
  if (result.system !== undefined) {
    if (typeof result.system === "string") {
      let sys = result.system;
      if (prefix) sys = prefix + "\n\n" + sys;
      if (suffix) sys = sys + "\n\n" + suffix;
      result.system = sys;
    } else if (Array.isArray(result.system)) {
      let arr: unknown[] = [...result.system];
      if (prefix) arr = [{ type: "text", text: prefix }, ...arr];
      if (suffix) arr = [...arr, { type: "text", text: suffix }];
      result.system = arr;
    }
  }

  markInjected(result);
  return result;
}

/**
 * Prepend `text` to a message content (string or array form).
 */
function prependToContent(msg: Record<string, unknown>, text: string): void {
  if (Array.isArray(msg.content)) {
    msg.content = [{ type: "text", text }, ...msg.content];
  } else {
    msg.content = text + "\n\n" + (msg.content || "");
  }
}

/**
 * Append `text` to a message content (string or array form).
 */
function appendToContent(msg: Record<string, unknown>, text: string): void {
  if (Array.isArray(msg.content)) {
    msg.content = [...msg.content, { type: "text", text }];
  } else {
    msg.content = (msg.content || "") + "\n\n" + text;
  }
}

// Non-enumerable marker: survives property access for the retry-loop guard,
// invisible to JSON.stringify so it never leaks into the upstream request body.
function markInjected(body: Record<string, unknown>): void {
  try {
    Object.defineProperty(body, "_systemPromptInjected", { value: true, enumerable: false });
  } catch {
    /* frozen/non-object edge — ignore */
  }
}

/**
 * Inject system prompts into a POST-TRANSLATION request body.
 *
 * Runs after translateRequest has resolved the body to its final target shape.
 * This is the path injectSystemPrompt misses: injectSystemPrompt runs
 * pre-translation (chatCore.ts) where non-chat bodies still lack their target
 * system carrier, so the global suffix/prefix never reached the provider.
 *
 * Format-aware (opts.targetFormat) system carriers per target:
 *   - claude: `system` field (string or {type:"text"} block array)
 *   - gemini: `systemInstruction` ({ role, parts: [{ text }] })
 *   - openai-responses: `instructions` string
 *   - openai/codex (default): messages[] system/developer roles — prefix on
 *     the FIRST and suffix on the LAST so the suffix retains the highest
 *     recency position, preserving the "After Prompt" semantics.
 *
 * @param {object} body - Translated request body (target shape resolved)
 * @param {object} [opts] - `{ targetFormat }` from the resolved wire target
 * @returns {object} Modified body
 */
export function injectSystemPromptPostTranslation(body, opts?: { targetFormat?: string }) {
  const cfg = getConfig();
  if (!cfg.enabled) return body;
  const prefix = cfg.prefixPrompt || "";
  const suffix = cfg.suffixPrompt || "";
  if (!prefix && !suffix) return body;
  if (!body || typeof body !== "object") return body;
  if (body._skipSystemPrompt) return body;
  if (body._systemPromptInjected) return body;
  const targetFormat = opts?.targetFormat || "";
  const combined = [prefix, suffix].filter(Boolean).join("\n\n");

  const result = { ...body };

  // Claude-format body (separate `system` field, or a claude target whose
  // translated body has no system-role message to carry the prompt): inject
  // into body.system — a system-role message inside claude messages[] is
  // invalid there. When the translated body has no system field at all, CREATE
  // it (combined) — previously this body shape fell through the messages[]
  // early-return and silently got zero injection.
  if (targetFormat === "claude" || result.system !== undefined) {
    const hasSystemRole =
      Array.isArray(result.messages) &&
      result.messages.some((m) => m && (m.role === "system" || m.role === "developer"));
    if (!hasSystemRole) {
      if (typeof result.system === "string") {
        let sys = result.system;
        if (prefix) sys = prefix + "\n\n" + sys;
        if (suffix) sys = sys + "\n\n" + suffix;
        result.system = sys;
      } else if (Array.isArray(result.system)) {
        let arr = [...result.system];
        if (prefix) arr = [{ type: "text", text: prefix }, ...arr];
        if (suffix) arr = [...arr, { type: "text", text: suffix }];
        result.system = arr;
      } else {
        result.system = combined;
      }
      markInjected(result);
      return result;
    }
  }

  // Gemini-format body (contents[] + systemInstruction): inject into the
  // systemInstruction parts (real translator shape: { role: "system",
  // parts: [{ text }] }, see translator/request/claude-to-gemini.ts:95). If
  // absent, create it — a messages-less gemini body previously fell through
  // the messages[] early-return and silently got zero injection.
  if (targetFormat === "gemini") {
    if (result.systemInstruction && typeof result.systemInstruction === "object") {
      const si = result.systemInstruction as { role?: string; parts?: unknown[] };
      const parts = Array.isArray(si.parts) ? [...si.parts] : [];
      if (prefix) parts.unshift({ text: prefix });
      if (suffix) parts.push({ text: suffix });
      result.systemInstruction = { ...si, role: si.role || "system", parts };
    } else {
      const texts = [prefix, suffix].filter(Boolean);
      result.systemInstruction = { role: "system", parts: texts.map((text) => ({ text })) };
    }
    markInjected(result);
    return result;
  }

  // OpenAI Responses-format body (input + instructions): instructions is a
  // plain string — wrap once. If absent, create it with the combined prompt.
  // Do NOT touch `input` (message items, not a system carrier).
  if (targetFormat === "openai-responses") {
    const base = typeof result.instructions === "string" ? result.instructions : "";
    const parts = [prefix, base, suffix].filter(Boolean);
    result.instructions = parts.join("\n\n");
    markInjected(result);
    return result;
  }

  // Kiro (conversationState/.../userInputMessage) has NO system carrier at all:
  // openai-to-kiro.ts folds system messages into user turns wrapped in
  // <system-reminder> tags (#2306) and the executor keeps no system slot.
  // Injection here would require inventing a carrier kiro upstreams reject —
  // so kiro intentionally receives no global-prompt injection at this seam.
  if (targetFormat === "kiro") {
    return result;
  }

  if (!result.messages || !Array.isArray(result.messages)) return result;

  result.messages = [...result.messages];
  const indices: number[] = [];
  for (let i = 0; i < result.messages.length; i++) {
    const m = result.messages[i] as { role?: string };
    if (m && (m.role === "system" || m.role === "developer")) indices.push(i);
  }

  if (indices.length === 0) {
    // No system message — combine both into one at the front (same as injectSystemPrompt).
    if (combined) {
      result.messages = [{ role: "system", content: combined }, ...result.messages];
    }
    markInjected(result);
    return result;
  }

  if (prefix) {
    const firstIdx = indices[0];
    result.messages[firstIdx] = { ...result.messages[firstIdx] };
    prependToContent(result.messages[firstIdx] as Record<string, unknown>, prefix);
  }
  if (suffix) {
    const lastIdx = indices[indices.length - 1];
    if (lastIdx !== indices[0]) {
      result.messages[lastIdx] = { ...result.messages[lastIdx] };
    }
    appendToContent(result.messages[lastIdx] as Record<string, unknown>, suffix);
  }
  markInjected(result);
  return result;
}

/**
 * Inject a per-request custom system prompt into the request body.
 *
 * Unlike injectSystemPrompt (which reads from globalThis config), this
 * function takes an explicit prompt string and appends it as a suffix
 * after any existing system content — mirroring the caveman/ponytail
 * injection pattern but driven by per-endpoint settings.
 *
 * @param body  - Translated request body (OpenAI/Claude/Gemini format)
 * @param prompt - The custom system prompt text to inject
 * @returns Modified body with prompt appended to the system message
 */
export function injectCustomSystemPrompt(body: Record<string, unknown>, prompt: string) {
  if (!prompt || typeof prompt !== "string") return body;
  if (!body || typeof body !== "object") return body;
  if (body._skipSystemPrompt) return body;

  const result = { ...body };

  // OpenAI/Claude messages[] format
  if (result.messages && Array.isArray(result.messages)) {
    const sysIdx = (result.messages as Array<{ role: string; content: unknown }>).findIndex(
      (m) => m.role === "system" || m.role === "developer"
    );
    result.messages = [...(result.messages as Array<{ role: string; content: unknown }>)];
    if (sysIdx >= 0) {
      const msg = { ...(result.messages as Array<{ role: string; content: unknown }>)[sysIdx] };
      if (Array.isArray(msg.content)) {
        msg.content = [...(msg.content as unknown[]), { type: "text", text: prompt }];
      } else {
        msg.content = (msg.content ? msg.content + "\n\n" : "") + prompt;
      }
      (result.messages as Array<{ role: string; content: unknown }>)[sysIdx] = msg;
    } else {
      result.messages = [
        { role: "system", content: prompt },
        ...(result.messages as Array<{ role: string; content: unknown }>),
      ];
    }
  }

  // Claude direct system field
  if (result.system !== undefined) {
    if (typeof result.system === "string") {
      result.system = result.system ? result.system + "\n\n" + prompt : prompt;
    } else if (Array.isArray(result.system)) {
      result.system = [...(result.system as unknown[]), { type: "text", text: prompt }];
    }
  }

  return result;
}
