// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

const { default: DarioLocalProviderCard } =
  await import("../../../src/app/(dashboard)/dashboard/providers/components/DarioLocalProviderCard");

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

describe("DarioLocalProviderCard", () => {
  it("renders as a local provider tile and opens creation without navigation or toggle", () => {
    const onCreate = vi.fn();
    const element = document.createElement("div");
    document.body.appendChild(element);
    const root = createRoot(element);
    cleanups.push(() => {
      act(() => root.unmount());
      element.remove();
    });

    act(() => root.render(<DarioLocalProviderCard configured={false} onCreate={onCreate} />));

    const tile = element.querySelector<HTMLButtonElement>(
      '[data-testid="dario-local-provider-card"]'
    );
    expect(tile).not.toBeNull();
    expect(tile?.textContent).toContain("Dario");
    expect(tile?.textContent).toContain("localProviders");
    expect(element.querySelector('a[href="/dashboard/providers/dario"]')).toBeNull();
    expect(element.querySelector('input[type="checkbox"]')).toBeNull();

    act(() => tile?.click());
    expect(onCreate).toHaveBeenCalledOnce();
  });
});
