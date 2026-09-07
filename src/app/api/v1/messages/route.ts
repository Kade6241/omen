import { handleChat } from "@/sse/handlers/chat";
import { initTranslators } from "@omniroute/open-sse/translator/index.ts";
import { withInjectionGuard } from "@/middleware/promptInjectionGuard";
import { withChatAdmission } from "@/shared/middleware/withChatAdmission";
import { requireJsonContentType } from "@/shared/middleware/requireJsonContentType";
import {
  withEarlyStreamKeepalive,
  ANTHROPIC_PING_FRAME,
} from "@omniroute/open-sse/utils/earlyStreamKeepalive";
import { resolveKeepaliveThreshold } from "@omniroute/open-sse/utils/keepaliveThreshold";
import { resolveStreamFlag } from "@omniroute/open-sse/utils/aiSdkCompat";
import {
  getBifrostRoutingConfig,
  resolveRelayRoutingBackend,
  shouldTryBifrostForRequest,
  getActiveBifrostCooldown,
  recordBifrostFailure,
  clearBifrostFailure,
  getRoutingFallbackHeader,
  getRoutingFallbackReasonHeader,
} from "@/shared/services/bifrost/bifrostRouting.ts";
import { dispatchToBifrost } from "@/shared/services/bifrost/bifrostClient.ts";

let initialized = false;

/**
 * Initialize translators once
 */
async function ensureInitialized() {
  if (!initialized) {
    await initTranslators();
    initialized = true;
    console.log("[SSE] Translators initialized for /v1/messages");
  }
}

/**
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

/**
 * POST /v1/messages - Claude format (auto convert via handleChat)
 *
 * `preParsedBody` is threaded from withInjectionGuard (#4041) so the body is
 * parsed at most once per request.
 */
async function postHandler(request: any, context: any, preParsedBody: any = null) {
  // Reject non-JSON Content-Type with 415 before touching the body — mirrors OpenAI's
  // reference API and matches /v1/chat/completions (#6414).
  const ctRejection = requireJsonContentType(request);
  if (ctRejection) return ctRejection;

  await ensureInitialized();
  // Streaming Anthropic clients (Claude Code, the Anthropic SDK) drop the connection
  // when no bytes arrive while a large prompt is processed before the first token — a
  // big context can exceed the client's stream/first-token watchdog. OmniRoute holds
  // the response until the first useful upstream byte (ensureStreamReadiness), so keep
  // the connection warm with early keepalives during that gap — same wrapper used by
  // /v1/responses (#2544). Anthropic clients ignore SSE comments for their watchdog, so
  // emit a real `event: ping` (ANTHROPIC_PING_FRAME). Non-streaming callers keep the
  // verbatim path.
  let body = preParsedBody;
  if (body == null) {
    try {
      body = await request
        .clone()
        .json()
        .catch(() => null);
    } catch {
      // body unavailable / non-JSON — handleChat will return its normal validation error
    }
  }
  const accept = String(request.headers?.get?.("accept") || "");
  const wantsStreaming = resolveStreamFlag(body?.stream, accept, "claude");

  // Bifrost Go sidecar fast-path routing check
  const relayBackend = resolveRelayRoutingBackend();
  const bifrostConfig = getBifrostRoutingConfig();
  let fallbackHeaderValue: string | undefined = undefined;

  if (body && typeof body === "object" && bifrostConfig) {
    const bifrostDecision = shouldTryBifrostForRequest(relayBackend, bifrostConfig, body);

    if (bifrostDecision.tryBifrost) {
      const cooldown =
        relayBackend === "auto" ? getActiveBifrostCooldown(bifrostConfig.baseUrl) : null;
      if (cooldown) {
        fallbackHeaderValue = `bifrost-cooldown; remaining=${cooldown.remainingMs}`;
      } else {
        try {
          const bifrostResult = await dispatchToBifrost({
            request,
            body: body as Record<string, unknown>,
            config: bifrostConfig,
          });

          if (bifrostResult.statusCode < 500) {
            clearBifrostFailure(bifrostConfig.baseUrl);
            return bifrostResult.response;
          }

          recordBifrostFailure(bifrostConfig.baseUrl, `http_${bifrostResult.statusCode}`);
          fallbackHeaderValue = "bifrost-error";
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          recordBifrostFailure(bifrostConfig.baseUrl, message);
          fallbackHeaderValue = "bifrost-error";
        }
      }
    }
  }

  const applyFallbackHeaders = (res: Response) => {
    if (!bifrostConfig) return res;
    const fallbackHeader = getRoutingFallbackHeader(relayBackend, bifrostConfig);
    if (fallbackHeader || fallbackHeaderValue) {
      res.headers.set("X-Routing-Fallback", fallbackHeaderValue || fallbackHeader || "bifrost");
      const reasonCode = getRoutingFallbackReasonHeader(fallbackHeaderValue);
      if (reasonCode) {
        res.headers.set("X-Routing-Fallback-Reason", reasonCode);
      }
    }
    return res;
  };

  if (wantsStreaming) {
    return applyFallbackHeaders(
      await withEarlyStreamKeepalive(handleChat(request, null, body), {
        signal: request.signal,
        thresholdMs: resolveKeepaliveThreshold(body?.model),
        keepaliveFrame: ANTHROPIC_PING_FRAME,
      })
    );
  }
  return applyFallbackHeaders(await handleChat(request, null, body));
}

// `logger: null` — the guardrail registry re-evaluates this request inside
// handleChat with the pino logger (#11936 dedupe).
export const POST = withChatAdmission(withInjectionGuard(postHandler, { logger: null }));
