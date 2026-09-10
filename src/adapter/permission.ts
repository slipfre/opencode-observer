import type { PermissionRequest } from "@opencode-ai/sdk/v2";
import type {
  Observer,
  ObservationError,
  PermissionFinish,
  PermissionReference,
  ToolReference,
  ToolStart,
} from "../contract/observer.js";

export function createPermissionTracker(options: {
  observer: Observer;
  tool(messageID: string, callID: string): ToolStart | undefined;
}) {
  const pending = new Map<string, PermissionReference>();
  const seen = new Set<string>();

  function finish(input: PermissionFinish) {
    if (!pending.delete(input.id)) {
      return;
    }

    options.observer.finishPermission(input);
  }

  return {
    asked(request: PermissionRequest, observedAt: number) {
      if (seen.has(request.id) || !request.tool) {
        return;
      }

      seen.add(request.id);
      const tool = options.tool(request.tool.messageID, request.tool.callID);

      if (!tool) {
        return;
      }

      const reference = {
        tool: { interaction: tool.interaction, messageID: tool.messageID, id: tool.id },
        id: request.id,
      };
      pending.set(request.id, reference);
      options.observer.startPermission({
        ...reference,
        startedAt: observedAt,
        toolName: tool.name,
        name: request.permission,
        patterns: [...request.patterns],
        agentName: tool.agentName,
        agentType: tool.agentType,
        parentSessionID: tool.parentSessionID,
        userID: tool.userID,
      });

      if (pending.size > 1024) {
        const oldest = pending.values().next().value;

        if (oldest) {
          finish({
            ...oldest,
            endedAt: observedAt,
            error: { type: "_OTHER", message: "permission correlation capacity exceeded" },
          });
        }
      }
    },
    replied(requestID: string, reply: "once" | "always" | "reject", observedAt: number) {
      const reference = pending.get(requestID);

      if (!reference) {
        seen.add(requestID);
        return;
      }

      finish({ ...reference, reply, endedAt: observedAt });

      return reply === "reject" ? reference.tool : undefined;
    },
    closeTool(tool: ToolReference, observedAt: number, error?: ObservationError) {
      pending.forEach((reference) => {
        if (reference.tool.id === tool.id && reference.tool.messageID === tool.messageID) {
          finish({
            ...reference,
            endedAt: observedAt,
            error: error ?? { type: "_OTHER", message: "tool ended before permission replied" },
          });
        }
      });
    },
    close(observedAt: number, error?: ObservationError) {
      pending.forEach((reference) =>
        finish({
          ...reference,
          endedAt: observedAt,
          error: error ?? { type: "_OTHER", message: "session ended before permission replied" },
        }),
      );
      seen.clear();
    },
    clear() {
      pending.clear();
      seen.clear();
    },
  };
}
