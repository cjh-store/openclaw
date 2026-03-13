import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { log } from "../logger.js";

type SessionRetryEntryLike = {
  type: string;
  id: string;
  parentId?: string | null;
  message?: {
    role?: string;
    content?: unknown;
    stopReason?: string;
  };
};

type SessionRetryManagerLike = {
  getLeafEntry: () => SessionRetryEntryLike | undefined;
  getEntry: (id: string) => SessionRetryEntryLike | undefined;
  branch: (id: string) => void;
  resetLeaf: () => void;
  buildSessionContext: () => { messages: AgentMessage[] };
};

function extractRetryMessageText(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((block) => {
      if (!block || typeof block !== "object") {
        return "";
      }
      const candidate = block as { type?: unknown; text?: unknown };
      return candidate.type === "text" && typeof candidate.text === "string" ? candidate.text : "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function resolveRetryRewindTarget(params: {
  sessionManager: SessionRetryManagerLike;
  effectivePrompt: string;
}): string | null | undefined {
  const normalizedPrompt = params.effectivePrompt.trim();
  if (!normalizedPrompt) {
    return undefined;
  }

  let leaf = params.sessionManager.getLeafEntry();
  while (leaf && leaf.type !== "message" && leaf.parentId) {
    leaf = params.sessionManager.getEntry(leaf.parentId);
  }
  if (!leaf || leaf.type !== "message") {
    return undefined;
  }

  const leafMessage = leaf.message;
  if (leafMessage?.role === "user") {
    return extractRetryMessageText(leafMessage.content) === normalizedPrompt
      ? (leaf.parentId ?? null)
      : undefined;
  }

  if (
    leafMessage?.role === "assistant" &&
    (leafMessage.stopReason === "error" || leafMessage.stopReason === "aborted") &&
    leaf.parentId
  ) {
    const parent = params.sessionManager.getEntry(leaf.parentId);
    if (parent?.type !== "message" || parent.message?.role !== "user") {
      return undefined;
    }
    return extractRetryMessageText(parent.message.content) === normalizedPrompt
      ? (parent.parentId ?? null)
      : undefined;
  }

  return undefined;
}

export function rewindRetryGeneratedPrompt(params: {
  sessionManager: SessionRetryManagerLike;
  effectivePrompt: string;
  replaceMessages: (messages: AgentMessage[]) => void;
  runId: string;
  sessionId: string;
}): boolean {
  const branchTarget = resolveRetryRewindTarget(params);
  if (branchTarget === undefined) {
    return false;
  }

  if (branchTarget === null) {
    params.sessionManager.resetLeaf();
  } else {
    params.sessionManager.branch(branchTarget);
  }
  params.replaceMessages(params.sessionManager.buildSessionContext().messages);
  log.warn(
    `Rewound retry-generated prompt before replay. runId=${params.runId} sessionId=${params.sessionId}`,
  );
  return true;
}
