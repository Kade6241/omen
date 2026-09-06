"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";

import { Badge, Button, Input, Modal } from "@/shared/components";
import { providerText } from "../[id]/providerPageHelpers";
import {
  createDarioProvider,
  testOnboardingConnection,
  type CompatibleProviderNode,
  type OnboardingConnection,
} from "./onboarding/providerOnboardingApi";

type DarioFormState = {
  name: string;
  prefix: string;
  baseUrl: string;
  usageBaseUrl: string;
  apiKey: string;
  modelId: string;
};

const EMPTY_FORM: DarioFormState = {
  name: "",
  prefix: "",
  baseUrl: "",
  usageBaseUrl: "",
  apiKey: "",
  modelId: "",
};

export default function AddDarioProviderModal({
  isOpen,
  onClose,
  onCreated,
}: {
  isOpen: boolean;
  onClose: () => void;
  onCreated: (node: CompatibleProviderNode, connection: OnboardingConnection) => void;
}) {
  const t = useTranslations("providers");
  const [form, setForm] = useState<DarioFormState>(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [valid, setValid] = useState<boolean | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setForm(EMPTY_FORM);
    setSubmitting(false);
    setError(null);
    setValid(null);
  }, [isOpen]);

  const updateBaseUrl = (baseUrl: string) => {
    let usageBaseUrl = form.usageBaseUrl;
    try {
      const url = new URL(baseUrl);
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts.pop() === "v1") {
        url.pathname = `/${parts.join("/")}`;
        usageBaseUrl = url.toString().replace(/\/$/, "");
      }
    } catch {
      // Keep the operator's current usage URL until the inference URL is complete.
    }
    setForm({ ...form, baseUrl, usageBaseUrl });
  };

  const submit = async () => {
    if (!form.name.trim() || !form.prefix.trim() || !form.baseUrl.trim() || !form.apiKey.trim()) {
      return;
    }
    setSubmitting(true);
    setError(null);
    setValid(null);
    try {
      const response = await fetch("/api/provider-nodes/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "anthropic-compatible",
          baseUrl: form.baseUrl.trim(),
          apiKey: form.apiKey.trim(),
          modelId: form.modelId.trim() || undefined,
        }),
      });
      const validation = await response.json().catch(() => ({}));
      if (!response.ok || validation.valid === false) {
        throw new Error(
          typeof validation.error === "string"
            ? validation.error
            : "Dario inference validation failed"
        );
      }
      const { node, connection } = await createDarioProvider({
        name: form.name.trim(),
        prefix: form.prefix.trim(),
        baseUrl: form.baseUrl.trim(),
        usageBaseUrl: form.usageBaseUrl.trim(),
        apiKey: form.apiKey.trim(),
      });
      const test = await testOnboardingConnection(connection.id);
      setValid(test.valid === true);
      onCreated(node, connection);
    } catch (submitError) {
      setError(
        submitError instanceof Error
          ? submitError.message
          : providerText(t, "darioCreateFailed", "Failed to create Dario provider")
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal isOpen={isOpen} title={providerText(t, "addDario", "Add Dario")} onClose={onClose}>
      <div className="flex flex-col gap-4">
        <p className="text-sm text-text-muted">
          {providerText(
            t,
            "darioDescription",
            "Anthropic-compatible gateway with connection-scoped quota reporting."
          )}
        </p>
        <Input
          label={t("nameLabel")}
          value={form.name}
          onChange={(event) => setForm({ ...form, name: event.target.value })}
        />
        <Input
          label={t("prefixLabel")}
          value={form.prefix}
          onChange={(event) => setForm({ ...form, prefix: event.target.value })}
        />
        <Input
          label={providerText(t, "darioInferenceBaseUrlLabel", "Inference Base URL")}
          value={form.baseUrl}
          onChange={(event) => updateBaseUrl(event.target.value)}
          placeholder="https://gateway.example/v1"
        />
        <Input
          label={providerText(t, "darioUsageBaseUrlLabel", "Usage Base URL")}
          value={form.usageBaseUrl}
          onChange={(event) => setForm({ ...form, usageBaseUrl: event.target.value })}
          placeholder="https://gateway.example"
          hint={providerText(t, "darioUsageBaseUrlHint", "OmniRoute requests /accounts here.")}
        />
        <Input
          label={t("apiKeyLabel")}
          type="password"
          value={form.apiKey}
          onChange={(event) => setForm({ ...form, apiKey: event.target.value })}
        />
        <Input
          label={t("testModelIdLabel")}
          value={form.modelId}
          onChange={(event) => setForm({ ...form, modelId: event.target.value })}
          hint={t("testModelIdHint")}
        />
        {valid !== null && (
          <Badge variant={valid ? "success" : "error"}>{valid ? t("valid") : t("invalid")}</Badge>
        )}
        {error && (
          <div role="alert" className="text-sm text-red-500">
            {error}
          </div>
        )}
        <div className="flex gap-2">
          <Button
            fullWidth
            onClick={submit}
            disabled={
              submitting ||
              !form.name.trim() ||
              !form.prefix.trim() ||
              !form.baseUrl.trim() ||
              !form.usageBaseUrl.trim() ||
              !form.apiKey.trim()
            }
          >
            {submitting ? t("creating") : providerText(t, "addDario", "Add Dario")}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            {t("cancel")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
