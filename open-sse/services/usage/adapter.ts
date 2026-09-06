import { isCompatibleProviderConnectionId } from "@/shared/utils/compatibleProviderId";

export type UsageAdapterConnection = {
  provider?: unknown;
  authType?: unknown;
  providerSpecificData?: unknown;
};

function providerSpecificData(connection: UsageAdapterConnection): Record<string, unknown> | null {
  const value = connection.providerSpecificData;
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function isDarioUsageConnection(connection: UsageAdapterConnection): boolean {
  return (
    typeof connection.provider === "string" &&
    isCompatibleProviderConnectionId(connection.provider) &&
    (connection.authType === "apikey" || connection.authType === "api_key") &&
    providerSpecificData(connection)?.usageAdapter === "dario"
  );
}

export function resolveUsageAdapter(connection: UsageAdapterConnection): string | null {
  if (isDarioUsageConnection(connection)) return "dario";
  return typeof connection.provider === "string" && connection.provider.trim()
    ? connection.provider
    : null;
}
