import { describe, expect, it, vi } from "vitest";
import { rewindRetryGeneratedPrompt } from "./retry-rewind.js";

type FakeEntry = {
  type: string;
  id: string;
  parentId?: string | null;
  message?: {
    role?: string;
    content?: unknown;
    stopReason?: string;
  };
};

function createManager(entries: FakeEntry[], leafId: string | null) {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  let currentLeafId = leafId;
  return {
    getLeafEntry: () => (currentLeafId ? byId.get(currentLeafId) : undefined),
    getEntry: (id: string) => byId.get(id),
    branch: vi.fn((id: string) => {
      currentLeafId = id;
    }),
    resetLeaf: vi.fn(() => {
      currentLeafId = null;
    }),
    buildSessionContext: vi.fn(() => ({ messages: [{ role: "user", content: "rebuilt" }] })),
  };
}

describe("rewindRetryGeneratedPrompt", () => {
  it("rewinds a retry-generated user plus assistant error tail", () => {
    const manager = createManager(
      [
        { type: "message", id: "prev-assistant", message: { role: "assistant", content: "ok" } },
        {
          type: "message",
          id: "retry-user",
          parentId: "prev-assistant",
          message: { role: "user", content: "same prompt" },
        },
        {
          type: "message",
          id: "retry-error",
          parentId: "retry-user",
          message: { role: "assistant", stopReason: "error", content: "" },
        },
      ],
      "retry-error",
    );
    const replaceMessages = vi.fn();

    const rewound = rewindRetryGeneratedPrompt({
      sessionManager: manager,
      effectivePrompt: "same prompt",
      replaceMessages,
      runId: "run-1",
      sessionId: "session-1",
    });

    expect(rewound).toBe(true);
    expect(manager.branch).toHaveBeenCalledWith("prev-assistant");
    expect(manager.resetLeaf).not.toHaveBeenCalled();
    expect(replaceMessages).toHaveBeenCalledWith([{ role: "user", content: "rebuilt" }]);
  });

  it("rewinds a trailing duplicate user prompt before replay", () => {
    const manager = createManager(
      [
        { type: "message", id: "prev-assistant", message: { role: "assistant", content: "ok" } },
        {
          type: "message",
          id: "retry-user",
          parentId: "prev-assistant",
          message: { role: "user", content: "same prompt" },
        },
      ],
      "retry-user",
    );
    const replaceMessages = vi.fn();

    const rewound = rewindRetryGeneratedPrompt({
      sessionManager: manager,
      effectivePrompt: "same prompt",
      replaceMessages,
      runId: "run-2",
      sessionId: "session-2",
    });

    expect(rewound).toBe(true);
    expect(manager.branch).toHaveBeenCalledWith("prev-assistant");
    expect(replaceMessages).toHaveBeenCalledTimes(1);
  });

  it("ignores unrelated assistant errors", () => {
    const manager = createManager(
      [
        { type: "message", id: "prev-assistant", message: { role: "assistant", content: "ok" } },
        {
          type: "message",
          id: "other-user",
          parentId: "prev-assistant",
          message: { role: "user", content: "different prompt" },
        },
        {
          type: "message",
          id: "retry-error",
          parentId: "other-user",
          message: { role: "assistant", stopReason: "error", content: "" },
        },
      ],
      "retry-error",
    );
    const replaceMessages = vi.fn();

    const rewound = rewindRetryGeneratedPrompt({
      sessionManager: manager,
      effectivePrompt: "same prompt",
      replaceMessages,
      runId: "run-3",
      sessionId: "session-3",
    });

    expect(rewound).toBe(false);
    expect(manager.branch).not.toHaveBeenCalled();
    expect(manager.resetLeaf).not.toHaveBeenCalled();
    expect(replaceMessages).not.toHaveBeenCalled();
  });
});
