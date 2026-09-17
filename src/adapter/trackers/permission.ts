import type { PermissionRequest } from "@opencode-ai/sdk/v2";
import type {
  Observer,
  ObservationError,
  PermissionFinish,
  PermissionReference,
  ToolReference,
  ToolStart,
  RunReference,
} from "../../contract/observer.js";
import { createRunStore } from "../shared/runs.js";

export function createPermissionTracker(options: { observer: Observer }) {
  const states = createRunStore(() => ({
    pending: new Map<string, PermissionReference>(),
    seen: new Set<string>(),
  }));

  function finish(input: PermissionFinish) {
    const state = states.get(input.tool.interaction.run);

    if (!state) {
      return;
    }

    if (!state.pending.delete(input.requestID)) {
      return;
    }

    options.observer.finishPermission(input);
  }

  return {
    open: states.open,
    release: states.release,
    asked(
      run: RunReference,
      request: PermissionRequest,
      observedAt: number,
      tool: ToolStart | undefined,
    ) {
      const state = states.get(run);

      if (!state) {
        return;
      }

      if (state.seen.has(request.id) || !request.tool) {
        return;
      }

      state.seen.add(request.id);

      if (!tool) {
        return;
      }

      const reference = {
        tool: {
          interaction: tool.interaction,
          messageID: tool.messageID,
          callID: tool.callID,
        },
        requestID: request.id,
      };
      state.pending.set(request.id, reference);
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

      if (state.pending.size > 1024) {
        const oldest = state.pending.values().next().value;

        if (oldest) {
          finish({
            ...oldest,
            endedAt: observedAt,
            error: { type: "_OTHER", message: "permission correlation capacity exceeded" },
          });
        }
      }
    },
    replied(
      run: RunReference,
      requestID: string,
      reply: "once" | "always" | "reject",
      observedAt: number,
    ) {
      const state = states.get(run);

      if (!state) {
        return;
      }

      const reference = state.pending.get(requestID);

      if (!reference) {
        state.seen.add(requestID);
        return;
      }

      finish({ ...reference, reply, endedAt: observedAt });
      return reply === "reject" ? reference.tool : undefined;
    },
    closeTool(tool: ToolReference, observedAt: number, error?: ObservationError) {
      const state = states.get(tool.interaction.run);

      if (!state) {
        return;
      }

      state.pending.forEach((reference) => {
        if (reference.tool.callID === tool.callID && reference.tool.messageID === tool.messageID) {
          finish({
            ...reference,
            endedAt: observedAt,
            error: error ?? { type: "_OTHER", message: "tool ended before permission replied" },
          });
        }
      });
    },
    close(run: RunReference, observedAt: number, error?: ObservationError) {
      const state = states.get(run);

      if (!state) {
        return;
      }

      state.pending.forEach((reference) =>
        finish({
          ...reference,
          endedAt: observedAt,
          error: error ?? { type: "_OTHER", message: "session ended before permission replied" },
        }),
      );
    },
  };
}
