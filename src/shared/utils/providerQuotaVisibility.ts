import { USAGE_SUPPORTED_PROVIDERS } from "@/shared/constants/providers";
import { isDarioUsageConnection } from "@omniroute/open-sse/services/usage/adapter.ts";

export interface ProviderQuotaVisibilityConnection {
  quotaVisible?: boolean;
  provider?: string;
  providerSpecificData?: unknown;
}

export function isProviderQuotaVisible(connection: ProviderQuotaVisibilityConnection): boolean {
  return connection.quotaVisible !== false;
}

export function supportsProviderQuota(
  providerId: string,
  connection?: { provider?: string; providerSpecificData?: unknown }
): boolean {
  return (
    USAGE_SUPPORTED_PROVIDERS.includes(providerId) ||
    Boolean(connection && isDarioUsageConnection(connection))
  );
}
