import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveAuthProfileOrder } from "./auth-profiles.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";

const BASE_NOW = 480000 * 60 * 60 * 1000 + 12_345;

function createCodexStore(): AuthProfileStore {
  return {
    version: 1,
    order: {
      "openai-codex": [
        "openai-codex:default",
        "openai-codex:roxi",
        "openai-codex:oai38",
        "openai-codex:cyberlink38",
      ],
    },
    profiles: {
      "openai-codex:default": {
        type: "oauth",
        provider: "openai-codex",
        access: "access-default",
        refresh: "refresh-default",
        expires: BASE_NOW + 60_000,
      },
      "openai-codex:roxi": {
        type: "oauth",
        provider: "openai-codex",
        access: "access-roxi",
        refresh: "refresh-roxi",
        expires: BASE_NOW + 60_000,
      },
      "openai-codex:oai38": {
        type: "oauth",
        provider: "openai-codex",
        access: "access-oai38",
        refresh: "refresh-oai38",
        expires: BASE_NOW + 60_000,
      },
      "openai-codex:cyberlink38": {
        type: "oauth",
        provider: "openai-codex",
        access: "access-cyber",
        refresh: "refresh-cyber",
        expires: BASE_NOW + 60_000,
      },
    },
  };
}

describe("resolveAuthProfileOrder - openai-codex hourly rotation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps a stable rotated order within the same hour and changes next hour", () => {
    const store = createCodexStore();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(BASE_NOW);
    const first = resolveAuthProfileOrder({
      store,
      provider: "openai-codex",
    });
    const second = resolveAuthProfileOrder({
      store,
      provider: "openai-codex",
    });

    expect(first).toEqual([
      "openai-codex:oai38",
      "openai-codex:default",
      "openai-codex:roxi",
      "openai-codex:cyberlink38",
    ]);
    expect(second).toEqual(first);

    nowSpy.mockReturnValue(BASE_NOW + 60 * 60 * 1000);
    const nextHour = resolveAuthProfileOrder({
      store,
      provider: "openai-codex",
    });
    expect(nextHour).toEqual([
      "openai-codex:default",
      "openai-codex:roxi",
      "openai-codex:oai38",
      "openai-codex:cyberlink38",
    ]);
  });

  it("keeps preferredProfile first after hourly rotation", () => {
    const store = createCodexStore();
    vi.spyOn(Date, "now").mockReturnValue(BASE_NOW);

    const order = resolveAuthProfileOrder({
      store,
      provider: "openai-codex",
      preferredProfile: "openai-codex:cyberlink38",
    });

    expect(order[0]).toBe("openai-codex:cyberlink38");
    expect(order.slice(1)).toEqual([
      "openai-codex:oai38",
      "openai-codex:default",
      "openai-codex:roxi",
    ]);
  });

  it("still pushes cooldowned codex profiles to the end", () => {
    const store = createCodexStore();
    vi.spyOn(Date, "now").mockReturnValue(BASE_NOW);
    store.usageStats = {
      "openai-codex:default": {
        cooldownUntil: BASE_NOW + 60_000,
      },
    };

    const order = resolveAuthProfileOrder({
      store,
      provider: "openai-codex",
    });

    expect(order).toEqual([
      "openai-codex:oai38",
      "openai-codex:roxi",
      "openai-codex:cyberlink38",
      "openai-codex:default",
    ]);
  });
});
