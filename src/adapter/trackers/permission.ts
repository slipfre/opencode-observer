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
import { createRunScopedStore } from "../shared/runs.js";

const MAX_PENDING_REQUESTS = 1024;

export function createPermissionTracker(options: { observer: Observer }) {
  const store = createRunScopedStore(() => ({
    pendingRequests: new Map<string, PermissionReference>(),
    seenRequestIDs: new Set<string>(),
  }));

  function finish(completion: PermissionFinish) {
    if (!store.get(completion.tool.interaction.run)?.pendingRequests.delete(completion.requestID)) {
      return;
    }

    options.observer.finishPermission(completion);
  }

  return {
    open: store.open,
    release: store.release,
    observeRequest(
      run: RunReference,
      request: PermissionRequest,
      observedAt: number,
      tool: ToolStart | undefined,
    ) {
      const state = store.get(run);

      if (!state) {
        return;
      }

      if (state.seenRequestIDs.has(request.id) || !request.tool) {
        return;
      }

      state.seenRequestIDs.add(request.id);

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
      state.pendingRequests.set(request.id, reference);
      options.observer.startPermission({
        ...reference,
        startedAt: observedAt,
        toolName: tool.name,
        name: request.permission,
        patterns: [...request.patterns],
        agentName: tool.agentName,
        agentType: tool.agentType,
        parentSessionID: tool.parentSessionID,
      });

      if (state.pendingRequests.size > MAX_PENDING_REQUESTS) {
        const oldest = state.pendingRequests.values().next().value;

        if (oldest) {
          finish({
            ...oldest,
            endedAt: observedAt,
            error: { type: "_OTHER", message: "permission correlation capacity exceeded" },
          });
        }
      }
    },
    observeReply(
      run: RunReference,
      requestID: string,
      reply: "once" | "always" | "reject",
      observedAt: number,
    ) {
      const state = store.get(run);

      if (!state) {
        return;
      }

      const reference = state.pendingRequests.get(requestID);

      if (!reference) {
        state.seenRequestIDs.add(requestID);
        return;
      }

      finish({ ...reference, reply, endedAt: observedAt });
      return reply === "reject" ? reference.tool : undefined;
    },
    finishPendingForTool(tool: ToolReference, observedAt: number, error?: ObservationError) {
      store.get(tool.interaction.run)?.pendingRequests.forEach((reference) => {
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
      store.get(run)?.pendingRequests.forEach((reference) =>
        finish({
          ...reference,
          endedAt: observedAt,
          error: error ?? { type: "_OTHER", message: "session ended before permission replied" },
        }),
      );
    },
  };
}
