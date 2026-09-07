/**
 * Request-level finalization for non-streaming chat.
 * Success and failure each write usage/cost/quota/attempt/pending once.
 */

import type {
  ChatCoreErrorResult,
  ProviderLegUsage,
  ServerOwnedToolLoopResult,
} from "@/lib/skills/toolLoopTypes.ts";

export type NonStreamingFinalizationPlan =
  | {
      kind: "success";
      usage: ProviderLegUsage | null;
      totalCostUsd: number;
      receiptCount: number;
    }
  | {
      kind: "failure";
      error: ChatCoreErrorResult;
      usage: ProviderLegUsage | null;
      totalCostUsd: number;
      receiptCount: number;
    };

export interface NonStreamingFinalizationDeps {
  writeUsage: (plan: NonStreamingFinalizationPlan) => void | Promise<void>;
  writeCost: (totalCostUsd: number) => void;
  scheduleQuota: (plan: NonStreamingFinalizationPlan) => void | Promise<void>;
  writeAttempt: (plan: NonStreamingFinalizationPlan) => void;
  finalizePending: (plan: NonStreamingFinalizationPlan) => void;
}

function missingError(): ChatCoreErrorResult {
  return {
    success: false,
    status: 500,
    response: new Response(null, { status: 500 }),
    error: "Missing tool-loop error result",
    errorCode: "internal_error",
  };
}

export function buildNonStreamingFinalizationPlan(
  loop: ServerOwnedToolLoopResult
): NonStreamingFinalizationPlan {
  const usage = loop.cumulativeUsage;
  const totalCostUsd = loop.totalCostUsd;
  const receiptCount = loop.receipts.length;
  if (loop.kind === "error") {
    return {
      kind: "failure",
      error: loop.errorResult ?? missingError(),
      usage,
      totalCostUsd,
      receiptCount,
    };
  }
  return {
    kind: "success",
    usage,
    totalCostUsd,
    receiptCount,
  };
}

export async function finalizeNonStreamingRequest(
  plan: NonStreamingFinalizationPlan,
  deps: NonStreamingFinalizationDeps
): Promise<void> {
  await deps.writeUsage(plan);
  deps.writeCost(plan.totalCostUsd);
  if (plan.kind === "success") {
    await deps.scheduleQuota(plan);
  }
  deps.writeAttempt(plan);
  deps.finalizePending(plan);
}
