import { parseAndValidateNonMetadataUrl } from "@/shared/network/outboundUrlGuard";
import { getProviderOutboundGuard } from "@/shared/network/outboundUrlGuardPolicy";
import { safeOutboundFetch } from "@/shared/network/safeOutboundFetch";
import type { UsageQuota } from "./quota.ts";
import { isDarioUsageConnection } from "./adapter.ts";

const DARIO_USAGE_TIMEOUT_MS = 8_000;
const DARIO_USAGE_MAX_RESPONSE_BYTES = 256 * 1024;
const DARIO_USAGE_STALE_AFTER_MS = 15 * 60_000;

type JsonRecord = Record<string, unknown>;

export type DarioUsageConnection = {
  provider?: string;
  authType?: string;
  apiKey?: string;
  providerSpecificData?: JsonRecord;
};

type DarioUsageResult = {
  plan?: string;
  quotas?: Record<string, UsageQuota>;
  message?: string;
  stale?: boolean;
};

type DarioFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function parseUsageBaseUrl(raw: unknown): URL {
  if (typeof raw !== "string" || !raw.trim()) throw new Error("Dario usage URL is missing");
  const url = new URL(raw);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Dario usage URL is invalid");
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Dario usage URL is invalid");
  }
  return url;
}

export function resolveDarioAccountsUrl(connection: DarioUsageConnection): string {
  if (!isDarioUsageConnection(connection)) throw new Error("Dario usage adapter is not enabled");
  const data = connection.providerSpecificData || {};
  let base: URL;
  if (data.usageBaseUrl !== undefined) {
    base = parseUsageBaseUrl(data.usageBaseUrl);
  } else {
    base = parseUsageBaseUrl(data.baseUrl);
    const parts = base.pathname.split("/").filter(Boolean);
    if (parts.pop() !== "v1") throw new Error("Dario usage URL is missing");
    base.pathname = `/${parts.join("/")}`;
  }
  base.pathname = `${base.pathname.replace(/\/+$/, "")}/accounts`;
  return base.toString();
}

function selectRepresentativeAccount(payload: JsonRecord): JsonRecord | null {
  if (!Array.isArray(payload.accounts) || payload.accounts.length === 0) return null;
  const accounts = payload.accounts.map(asRecord);
  if (accounts.some((entry) => entry === null)) return null;
  const validAccounts = accounts as JsonRecord[];
  if (validAccounts.length === 1) return validAccounts[0];
  if (typeof payload.bestAccount !== "string" || !payload.bestAccount) return null;
  return (
    validAccounts.find((account) =>
      [account.id, account.accountId, account.email, account.alias].includes(payload.bestAccount)
    ) || null
  );
}

function observationAgeMs(account: JsonRecord, now: number): number | null {
  if (typeof account.utilAgeMs === "number" && Number.isFinite(account.utilAgeMs)) {
    return Math.max(0, account.utilAgeMs);
  }
  const observedAt =
    typeof account.lastObservedAt === "number"
      ? account.lastObservedAt
      : typeof account.lastObservedAt === "string"
        ? Date.parse(account.lastObservedAt)
        : Number.NaN;
  return Number.isFinite(observedAt) ? Math.max(0, now - observedAt) : null;
}

function percentageQuota(value: unknown): UsageQuota | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const used = Math.max(0, Math.min(1, value)) * 100;
  return {
    used,
    total: 100,
    remaining: 100 - used,
    remainingPercentage: 100 - used,
    resetAt: null,
    unlimited: false,
  };
}

export function buildDarioUsage(payload: unknown, now: number = Date.now()): DarioUsageResult {
  const root = asRecord(payload);
  const account = root ? selectRepresentativeAccount(root) : null;
  if (!account) return { message: "Dario usage is unavailable" };
  if (typeof account.status === "string" && account.status !== "healthy") {
    return { message: "Dario usage is unavailable" };
  }
  const ageMs = observationAgeMs(account, now);
  if (ageMs === null || ageMs > DARIO_USAGE_STALE_AFTER_MS) {
    return { message: "Dario usage observation is stale", stale: true };
  }

  const quotas: Record<string, UsageQuota> = {};
  const session = percentageQuota(account.util5h);
  const weekly = percentageQuota(account.util7d);
  if (session) quotas["session (5h)"] = session;
  if (weekly) quotas["weekly (7d)"] = weekly;
  if (Object.keys(quotas).length === 0) return { message: "Dario usage is unavailable" };
  return { plan: "Dario pool", quotas };
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new Error("Dario usage response is not JSON");
  }
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > DARIO_USAGE_MAX_RESPONSE_BYTES) {
    throw new Error("Dario usage response is too large");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Dario usage response is empty");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > DARIO_USAGE_MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("Dario usage response is too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

function statusMessage(status: number): string {
  if (status === 401) return "Dario usage authentication failed";
  if (status === 403) return "Dario usage access denied";
  if (status === 429) return "Dario usage is rate limited";
  return status >= 500 ? "Dario usage service is unavailable" : "Dario usage request failed";
}

export async function getDarioUsage(
  connection: DarioUsageConnection,
  options: { fetchImpl?: DarioFetch; now?: number } = {}
): Promise<DarioUsageResult> {
  const credential = connection.apiKey;
  if (!credential) return { message: "Dario usage credential is missing" };

  try {
    const url = resolveDarioAccountsUrl(connection);
    parseAndValidateNonMetadataUrl(url);
    const fetchImpl =
      options.fetchImpl ||
      ((input, init) =>
        safeOutboundFetch(input, {
          ...init,
          timeoutMs: DARIO_USAGE_TIMEOUT_MS,
          allowRedirect: false,
          retry: false,
          guard: getProviderOutboundGuard(),
        }));
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${credential}`, Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(DARIO_USAGE_TIMEOUT_MS),
    });
    if (!response.ok) return { message: statusMessage(response.status) };
    return buildDarioUsage(await readBoundedJson(response), options.now);
  } catch {
    return { message: "Dario usage request failed" };
  }
}
