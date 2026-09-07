"use client";

import { useTranslations } from "next-intl";

import { Badge, Card } from "@/shared/components";
import { providerText } from "../[id]/providerPageHelpers";

export default function DarioLocalProviderCard({
  configured,
  onCreate,
}: {
  configured: boolean;
  onCreate: () => void;
}) {
  const t = useTranslations("providers");

  return (
    <button
      type="button"
      data-testid="dario-local-provider-card"
      onClick={onCreate}
      className="h-full text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary/60"
    >
      <Card
        padding="xs"
        className="h-full cursor-pointer transition-colors hover:border-primary/40 hover:bg-black/5 dark:hover:bg-white/5"
      >
        <div className="flex h-full flex-col gap-2">
          <div className="flex items-start gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10 text-sm font-bold text-emerald-600 dark:text-emerald-400">
              D
            </div>
            <h3 className="min-w-0 flex-1 text-sm font-semibold leading-snug">Dario</h3>
            <span
              className="mt-1 size-2.5 shrink-0 rounded-full bg-emerald-500"
              title={t("localProviders")}
            />
          </div>
          <div className="flex flex-wrap items-center gap-1">
            <Badge variant={configured ? "success" : "default"}>
              {configured
                ? providerText(t, "configured", "Configured")
                : providerText(t, "add", "Add")}
            </Badge>
            <span className="text-[10px] text-text-muted">{t("localProviders")}</span>
          </div>
          <p className="line-clamp-2 text-xs text-text-muted">
            {providerText(
              t,
              "darioDescription",
              "Anthropic-compatible gateway with connection-scoped quota reporting."
            )}
          </p>
        </div>
      </Card>
    </button>
  );
}
