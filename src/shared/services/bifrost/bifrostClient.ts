import { finalizeReadableStream } from "@/app/api/v1/relay/chat/completions/streamFinalizer";
import { getProviderPluginManifestHeader } from "@omniroute/open-sse/config/providerPluginManifestUrl.ts";
import type { BifrostRoutingConfig } from "./bifrostRouting";

export interface BifrostDispatchOptions {
  request: Request;
  body: Record<string, unknown>;
  config: BifrostRoutingConfig;
  targetPath?: string; // default: "/v1/chat/completions"
  onUsageRecorded?: (status: "success" | "error", statusCode: number) => void;
}

export interface BifrostForwardResult {
  response: Response;
  timedOut: boolean;
  statusCode: number;
}

export async function dispatchToBifrost({
  request,
  body,
  config,
  targetPath = "/v1/chat/completions",
  onUsageRecorded,
}: BifrostDispatchOptions): Promise<BifrostForwardResult> {
  const origin = new URL(request.url).origin;
  const upstreamHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    ...getProviderPluginManifestHeader(origin),
  };

  const reqId = request.headers.get("x-request-id") || request.headers.get("x-correlation-id");
  if (reqId) upstreamHeaders["x-request-id"] = reqId;

  if (config.apiKey) {
    upstreamHeaders["Authorization"] = `Bearer ${config.apiKey}`;
  }

  // Pass through client authorization header if no specific bifrost key is set
  const clientAuth = request.headers.get("authorization");
  if (!config.apiKey && clientAuth) {
    upstreamHeaders["Authorization"] = clientAuth;
  }

  const wantsStream = Boolean(body.stream) && config.streamingEnabled;

  const ac = new AbortController();
  let timedOut = false;
  const tid = setTimeout(() => {
    timedOut = true;
    ac.abort();
  }, config.timeoutMs);

  const cleanBase = config.baseUrl.replace(/\/$/, "");
  const cleanPath = targetPath.startsWith("/") ? targetPath : `/${targetPath}`;
  const targetUrl = `${cleanBase}${cleanPath}`;

  let upstream: Response;
  try {
    upstream = await fetch(targetUrl, {
      method: "POST",
      headers: upstreamHeaders,
      body: JSON.stringify(body),
      signal: ac.signal,
    });
  } catch (error) {
    clearTimeout(tid);
    throw error;
  }

  const responseHeaders = new Headers(upstream.headers);
  responseHeaders.set("X-Routed-By", "bifrost");
  if (!wantsStream) {
    responseHeaders.set("Content-Type", upstream.headers.get("Content-Type") ?? "application/json");
  }

  if (wantsStream && upstream.body) {
    const stream = finalizeReadableStream(upstream.body, (error) => {
      clearTimeout(tid);
      const statusCode = timedOut ? 504 : upstream.status;
      const status = error || statusCode >= 500 ? "error" : "success";
      onUsageRecorded?.(status, statusCode);
    });

    return {
      response: new Response(stream, {
        status: upstream.status,
        headers: responseHeaders,
      }),
      timedOut,
      statusCode: upstream.status,
    };
  }

  clearTimeout(tid);
  onUsageRecorded?.(upstream.status < 500 ? "success" : "error", upstream.status);

  return {
    response: new Response(upstream.body, {
      status: upstream.status,
      headers: responseHeaders,
    }),
    timedOut,
    statusCode: upstream.status,
  };
}
