/**
 * GitHub Copilot capability discovery.
 *
 * Builds a typed capability record for a connected GitHub account so that
 * routing, model selection, and the UI can behave appropriately for each
 * plan tier without scattering plan-check logic across the codebase.
 *
 * ## Verified facts (source: docs.github.com, accessed 2026-09-02)
 *
 * | Plan        | Credits/month (documented)    | Model selection   |
 * |-------------|-------------------------------|-------------------|
 * | Free        | Undisclosed "an allowance"    | Auto-only         |
 * | Student     | Undisclosed "an allowance"    | Auto-only         |
 * | Pro         | 1,000 base + 500 flex = 1,500 | Explicit          |
 * | Pro+        | 3,900 base + 3,100 flex = 7,000| Explicit         |
 * | Max         | 10,000 base + 10,000 flex = 20,000| Explicit      |
 * | Business    | 1,900/seat                    | Explicit          |
 * | Enterprise  | 3,900/seat                    | Explicit          |
 *
 * The Free plan credit quantity is NOT published by GitHub. Represent it
 * as `quotaState: "unknown"` rather than inventing a number.
 *
 * ## Policy status
 *
 * OmniRoute routes requests through `api.githubcopilot.com`, the same endpoint
 * used by the official GitHub Copilot CLI and VS Code extension. GitHub has not
 * published this endpoint as a general third-party inference API. Accordingly
 * every connection is classified `policyStatus: "ambiguous"` and the UI must
 * inform the user before connection is established.
 *
 * ## Model selection
 *
 * The `/models` response includes a `model_picker_enabled` field per entry.
 * When NO model has `model_picker_enabled: true`, the account is restricted to
 * automatic model selection (Free / Student). When at least one model has the
 * flag set, the account may use explicit model selection (paid plans).
 *
 * For auto-only accounts, OmniRoute presents a single virtual model
 * `COPILOT_AUTO_MODEL_ID` that sends `gpt-4o-2024-11-20` to the upstream
 * endpoint — the model ID GitHub historically accepts for Free / Student
 * plan requests. GitHub may still route to a different underlying model
 * at its discretion; do not promise a specific model to the user.
 *
 * ## Quota
 *
 * Quota is read from `https://api.github.com/copilot_internal/user`. The Free
 * plan uses `monthly_quotas` / `limited_user_quotas`; paid plans use
 * `quota_snapshots`. When neither is present or the fetch fails, the quota
 * state is `"unknown"`. Unknown quota MUST NOT be represented as zero or
 * as unlimited — it simply cannot be measured.
 */

/** Virtual model ID used when the account is restricted to auto-selection. */
export const COPILOT_AUTO_MODEL_ID = "copilot-auto";

/**
 * Upstream model ID sent for auto-selection requests. GitHub historically
 * uses GPT-4o as the default for Free / Student plans. Do not promise this
 * to the user — record the model from the upstream response when available.
 */
export const COPILOT_AUTO_UPSTREAM_MODEL_ID = "gpt-4o-2024-11-20";

/** Version string embedded in persisted records. Bump when the shape changes. */
export const CAPABILITY_WARNING_VERSION = "1.0";

export type CopilotPlan =
  "free" | "student" | "pro" | "pro_plus" | "max" | "business" | "enterprise" | "unknown";

/** Whether the account may select models explicitly or must use GitHub's auto-pick. */
export type CopilotModelSelectionMode = "auto" | "explicit";

/**
 * Observable quota states. "unknown" means the quota exists but cannot be
 * measured — it must never be treated as zero or as unlimited.
 */
export type CopilotQuotaState =
  "unknown" | "available" | "low" | "exhausted" | "temporarily_unavailable";

/** Policy classification for the Copilot inference endpoint used by OmniRoute. */
export type CopilotPolicyStatus = "ambiguous" | "caution" | "ok" | "unknown";

/**
 * Internal error classifications for Copilot account operations.
 * Used for structured logging and routing decisions — never surfaced raw to users.
 */
export type CopilotErrorCode =
  | "authorization_pending"
  | "device_authorization_denied"
  | "device_code_expired"
  | "oauth_token_invalid_or_revoked"
  | "copilot_entitlement_missing"
  | "plan_restriction"
  | "model_unavailable"
  | "quota_exhausted"
  | "rate_limited"
  | "upstream_unavailable"
  | "policy_capability_unknown";

/**
 * Full capability record for a connected GitHub Copilot account.
 * Stored in `providerSpecificData` and refreshed periodically.
 */
export interface CopilotCapabilityRecord {
  /** Detected or inferred plan tier. */
  plan: CopilotPlan;
  /** Whether this account may select models explicitly or must use auto-selection. */
  modelSelectionMode: CopilotModelSelectionMode;
  /**
   * Observable quota state. "unknown" when the account has credits but the
   * quantity cannot be measured (e.g., Free plan). Never zero or infinity.
   */
  quotaState: CopilotQuotaState;
  /**
   * Whether the account has additional paid usage enabled beyond its base
   * allowance. `null` means this could not be determined.
   */
  paidOverageEnabled: boolean | null;
  /** True when the `/copilot_internal/v2/token` fetch confirmed entitlement. */
  entitlementVerified: boolean;
  /** ISO timestamp of the last successful capability refresh, or null if never. */
  lastCapabilityRefreshAt: string | null;
  /** ISO timestamp of the last observed usage event, or null if never. */
  lastUsageObservedAt: string | null;
  /** Policy classification for the inference endpoint (always "ambiguous" currently). */
  policyStatus: CopilotPolicyStatus;
  /** Version string; bump CAPABILITY_WARNING_VERSION when the shape changes. */
  policyWarningVersion: string;
  /** True when the account reached the Copilot inference endpoint successfully. */
  endpointCompatible: boolean;
}

export type RawRecord = Record<string, unknown>;

function asRecord(v: unknown): RawRecord {
  return v != null && typeof v === "object" && !Array.isArray(v) ? (v as RawRecord) : {};
}

function asString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/**
 * Infer the plan tier from the `/copilot_internal/user` API response.
 * Priority: exact `copilot_plan` string → `access_type_sku` SKU → entitlement heuristics.
 */
export function inferPlanFromApiResponse(data: unknown): CopilotPlan {
  const d = asRecord(data);
  const raw = asString(d["copilot_plan"] ?? d["plan"]).toLowerCase();

  const PLAN_MAP: Record<string, CopilotPlan> = {
    free: "free",
    student: "student",
    pro: "pro",
    "pro+": "pro_plus",
    pro_plus: "pro_plus",
    max: "max",
    business: "business",
    enterprise: "enterprise",
  };
  if (raw && PLAN_MAP[raw]) return PLAN_MAP[raw];

  const sku = asString(d["access_type_sku"] ?? d["sku"]).toLowerCase();
  if (sku.includes("free")) return "free";
  if (sku.includes("student")) return "student";
  if (sku.includes("pro_plus") || sku.includes("pro+")) return "pro_plus";
  if (sku.includes("max")) return "max";
  if (sku.includes("pro")) return "pro";
  if (sku.includes("business")) return "business";
  if (sku.includes("enterprise")) return "enterprise";

  return "unknown";
}

/**
 * True when the given plan tier requires GitHub's automatic model selection.
 * Free and Student plans are restricted to auto-selection per official docs
 * (docs.github.com/en/copilot/about-github-copilot/subscription-plans-for-github-copilot,
 * accessed 2026-09-02).
 */
export function planRequiresAutoModelSelection(plan: CopilotPlan): boolean {
  return plan === "free" || plan === "student";
}

/**
 * Determine the model selection mode from the `/models` API response.
 *
 * If at least one model has `model_picker_enabled: true`, explicit selection
 * is allowed. If none do (or the field is absent for all), the account is
 * auto-only. "Unknown" falls back to auto to be conservative.
 */
export function inferModelSelectionMode(modelsData: unknown): CopilotModelSelectionMode {
  const payload = asRecord(modelsData);
  const items = Array.isArray(payload["data"])
    ? (payload["data"] as unknown[])
    : Array.isArray(payload["models"])
      ? (payload["models"] as unknown[])
      : [];

  for (const item of items) {
    const rec = asRecord(item);
    if (rec["model_picker_enabled"] === true) return "explicit";
  }
  return "auto";
}

/**
 * Derive quota state from the `/copilot_internal/user` response.
 *
 * Free / limited-plan accounts: uses `monthly_quotas` and `limited_user_quotas`.
 * Paid plan accounts: uses `quota_snapshots`.
 *
 * When neither structure is present, or the amounts cannot be parsed, the state
 * is `"unknown"` — NOT zero or unlimited.
 */
export function inferQuotaState(data: unknown): CopilotQuotaState {
  const d = asRecord(data);

  // Free / limited plan path
  const monthly = asRecord(d["monthly_quotas"]);
  const limited = asRecord(d["limited_user_quotas"]);
  if (Object.keys(monthly).length > 0 || Object.keys(limited).length > 0) {
    // If any quota bucket is explicitly 0 remaining, report exhausted.
    for (const key of Object.keys(limited)) {
      const remaining = Number(limited[key] ?? monthly[key]);
      if (!Number.isNaN(remaining)) {
        if (remaining === 0) return "exhausted";
        return "available";
      }
    }
    // monthly_quotas present but no per-key data readable → "unknown" (credits exist)
    return "unknown";
  }

  // Paid plan path: `quota_snapshots` object with named buckets
  const snapshots = asRecord(d["quota_snapshots"]);
  const keys = Object.keys(snapshots);
  if (keys.length === 0) {
    // No quota data at all. If there is a copilot_plan or entitlement field, credits
    // exist but the amount is unreadable (e.g., newly-created account). Return unknown.
    const hasPlan =
      typeof d["copilot_plan"] === "string" ||
      typeof d["quota"] === "object" ||
      typeof d["entitlement"] === "object";
    return hasPlan ? "unknown" : "unknown";
  }

  let allExhausted = true;
  for (const key of keys) {
    const snap = asRecord(snapshots[key]);
    const remaining = Number(snap["remaining"] ?? snap["entitlement"]);
    const percentRemaining = Number(snap["percent_remaining"]);
    if (!Number.isNaN(remaining)) {
      if (remaining > 0) {
        allExhausted = false;
        if (!Number.isNaN(percentRemaining) && percentRemaining <= 10) return "low";
        return "available";
      }
    } else if (!Number.isNaN(percentRemaining) && percentRemaining > 0) {
      allExhausted = false;
      if (percentRemaining <= 10) return "low";
      return "available";
    }
  }
  return allExhausted ? "exhausted" : "unknown";
}

export type DiscoverCopilotCapabilitiesOptions = {
  /** GitHub OAuth access token. */
  accessToken: string;
  /** Copilot bearer token (from copilot_internal/v2/token), if available. */
  copilotToken?: string | null;
  /** Injectable fetch for testing. */
  fetchImpl?: typeof fetch;
  /** GitHub API version header value. */
  apiVersion?: string;
  /** User-agent for GitHub API requests. */
  userAgent?: string;
};

/**
 * Discover the full capability record for a connected GitHub account.
 *
 * Makes two requests:
 * 1. `GET /copilot_internal/user` — plan, quota, entitlement.
 * 2. `GET api.githubcopilot.com/models` — model selection mode.
 *
 * Returns a safe "minimum-capability" record on any failure rather than
 * throwing, so callers can degrade gracefully.
 */
export async function discoverCopilotCapabilities(
  options: DiscoverCopilotCapabilitiesOptions
): Promise<CopilotCapabilityRecord> {
  const {
    accessToken,
    copilotToken,
    fetchImpl = fetch,
    apiVersion = "2022-11-28",
    userAgent = "OmniRoute/1.0 github-copilot-capabilities",
  } = options;

  const base: CopilotCapabilityRecord = {
    plan: "unknown",
    modelSelectionMode: "auto",
    quotaState: "unknown",
    paidOverageEnabled: null,
    entitlementVerified: false,
    lastCapabilityRefreshAt: null,
    lastUsageObservedAt: null,
    policyStatus: "ambiguous",
    policyWarningVersion: CAPABILITY_WARNING_VERSION,
    endpointCompatible: false,
  };

  // ── Step 1: Fetch user / entitlement from the GitHub API ────────────────
  let userApiData: unknown = null;
  try {
    const userRes = await fetchImpl("https://api.github.com/copilot_internal/user", {
      headers: {
        Authorization: `token ${accessToken}`,
        Accept: "application/json",
        "X-GitHub-Api-Version": apiVersion,
        "User-Agent": userAgent,
      },
    });
    if (userRes.ok) {
      userApiData = await userRes.json();
      base.entitlementVerified = true;
    } else if (userRes.status === 401 || userRes.status === 403 || userRes.status === 404) {
      // 403/404 from this endpoint typically means Copilot is not enabled for this account.
      base.entitlementVerified = false;
      return {
        ...base,
        lastCapabilityRefreshAt: new Date().toISOString(),
      };
    }
  } catch {
    // Network failure — return conservative record without marking refresh time
    return base;
  }

  if (userApiData) {
    base.plan = inferPlanFromApiResponse(userApiData);
    base.quotaState = inferQuotaState(userApiData);
    const d = asRecord(userApiData);
    // paidOverageEnabled: look for an explicit overage-enabled signal
    if (typeof d["additional_usage_allowed"] === "boolean") {
      base.paidOverageEnabled = d["additional_usage_allowed"] as boolean;
    } else if (typeof d["pay_as_you_go"] === "boolean") {
      base.paidOverageEnabled = d["pay_as_you_go"] as boolean;
    }
  }

  // ── Step 2: Fetch model picker eligibility from /models ─────────────────
  if (copilotToken || accessToken) {
    try {
      const { getGitHubCopilotChatHeaders } = await import("../config/providerHeaderProfiles.ts");
      const modelsRes = await fetchImpl("https://api.githubcopilot.com/models", {
        headers: {
          ...getGitHubCopilotChatHeaders("application/json"),
          Authorization: `Bearer ${copilotToken || accessToken}`,
        },
      });
      if (modelsRes.ok) {
        const modelsData = await modelsRes.json();
        base.endpointCompatible = true;
        const modeFromModels = inferModelSelectionMode(modelsData);
        // Plan-based check takes precedence when plan is definitively known.
        // For "unknown" plans, trust the model_picker_enabled signal.
        if (planRequiresAutoModelSelection(base.plan)) {
          base.modelSelectionMode = "auto";
        } else {
          base.modelSelectionMode = modeFromModels;
        }
      }
    } catch {
      // /models fetch failure: conservative auto mode
    }
  }

  // If plan is definitively auto-only, enforce regardless of /models result.
  if (planRequiresAutoModelSelection(base.plan)) {
    base.modelSelectionMode = "auto";
  }

  base.lastCapabilityRefreshAt = new Date().toISOString();
  return base;
}

/**
 * Filter a model list according to the account's capability record.
 *
 * For auto-only accounts: returns ONLY the virtual `copilot-auto` entry.
 * For explicit-capable accounts: returns all models as-is (the live /models
 * endpoint already enforces entitlement filtering).
 */
export function filterModelsForCapabilities<T extends { id: string }>(
  models: T[],
  capabilities: CopilotCapabilityRecord,
  autoModelEntry: T
): T[] {
  if (capabilities.modelSelectionMode === "auto") {
    return [autoModelEntry];
  }
  return models;
}

/**
 * Build a default (conservative) capability record for use when discovery is
 * unavailable. Auto-only, quota unknown, not endpoint-verified.
 */
export function buildDefaultCapabilityRecord(): CopilotCapabilityRecord {
  return {
    plan: "unknown",
    modelSelectionMode: "auto",
    quotaState: "unknown",
    paidOverageEnabled: null,
    entitlementVerified: false,
    lastCapabilityRefreshAt: null,
    lastUsageObservedAt: null,
    policyStatus: "ambiguous",
    policyWarningVersion: CAPABILITY_WARNING_VERSION,
    endpointCompatible: false,
  };
}

/**
 * True when the capability record should trigger a user-visible policy warning.
 * Currently always true since the endpoint is "ambiguous" for all accounts.
 */
export function shouldShowPolicyWarning(capabilities: CopilotCapabilityRecord): boolean {
  return capabilities.policyStatus === "ambiguous" || capabilities.policyStatus === "caution";
}

/**
 * True when the account's capabilities are fresh enough to use without re-discovery.
 * Capabilities are considered stale after 6 hours.
 */
export function areCapabilitiesFresh(
  capabilities: CopilotCapabilityRecord,
  nowMs: number = Date.now()
): boolean {
  if (!capabilities.lastCapabilityRefreshAt) return false;
  const refreshedAt = new Date(capabilities.lastCapabilityRefreshAt).getTime();
  const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
  return nowMs - refreshedAt < SIX_HOURS_MS;
}
