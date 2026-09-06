// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

const { default: AddDarioProviderModal } =
  await import("../../../src/app/(dashboard)/dashboard/providers/components/AddDarioProviderModal");

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ root: ReturnType<typeof createRoot>; element: HTMLDivElement }> = [];

function inputByLabel(element: Element, label: string): HTMLInputElement {
  const input = Array.from(element.querySelectorAll<HTMLInputElement>("input")).find(
    (candidate) => {
      const labelElement =
        candidate.previousElementSibling || candidate.parentElement?.previousElementSibling;
      return labelElement?.textContent === label;
    }
  );
  if (!input) throw new Error(`Input not found: ${label}`);
  return input;
}

function setInput(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function waitFor(check: () => boolean): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > 2_000) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

afterEach(() => {
  for (const item of mounted.splice(0)) {
    act(() => item.root.unmount());
    item.element.remove();
  }
  vi.unstubAllGlobals();
});

describe("AddDarioProviderModal", () => {
  it("creates an Anthropic-compatible node followed by a Dario connection", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        requests.push({ url: String(url), init });
        if (String(url) === "/api/provider-nodes/validate") return Response.json({ valid: true });
        if (String(url) === "/api/provider-nodes") {
          return Response.json({
            node: {
              id: "anthropic-compatible-12345678-abcd-4abc-8abc-123456789abc",
              name: "Dario",
            },
          });
        }
        if (String(url) === "/api/providers") {
          return Response.json({ connection: { id: "conn-dario" } });
        }
        if (String(url) === "/api/providers/conn-dario/test") {
          return Response.json({ valid: true });
        }
        return Response.json({ error: "unexpected" }, { status: 500 });
      })
    );
    const onCreated = vi.fn();
    const element = document.createElement("div");
    document.body.appendChild(element);
    const root = createRoot(element);
    mounted.push({ root, element });
    act(() => {
      root.render(<AddDarioProviderModal isOpen onClose={() => {}} onCreated={onCreated} />);
    });

    const dialog = element.querySelector('[role="dialog"]')!;
    setInput(inputByLabel(dialog, "nameLabel"), "Dario");
    setInput(inputByLabel(dialog, "prefixLabel"), "dario");
    setInput(inputByLabel(dialog, "Inference Base URL"), "https://gateway.example/v1");
    setInput(inputByLabel(dialog, "apiKeyLabel"), "test-key");
    setInput(inputByLabel(dialog, "Usage Base URL"), "https://gateway.example");

    const submit = Array.from(dialog.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent === "Add Dario"
    );
    act(() => submit?.click());
    await waitFor(() => onCreated.mock.calls.length === 1);

    expect(requests.map((request) => request.url)).toEqual([
      "/api/provider-nodes/validate",
      "/api/provider-nodes",
      "/api/providers",
      "/api/providers/conn-dario/test",
    ]);
    expect(JSON.parse(String(requests[1].init?.body))).toMatchObject({
      type: "anthropic-compatible",
      baseUrl: "https://gateway.example/v1",
    });
    expect(JSON.parse(String(requests[2].init?.body))).toMatchObject({
      provider: "anthropic-compatible-12345678-abcd-4abc-8abc-123456789abc",
      providerSpecificData: {
        usageAdapter: "dario",
        usageBaseUrl: "https://gateway.example",
      },
    });
  });
});
