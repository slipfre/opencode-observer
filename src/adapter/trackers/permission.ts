import type { PermissionRequest } from "@opencode-ai/sdk/v2";
import type {
  Observer,
  ObservationError,
  PermissionFinish,
  PermissionReference,
  PermissionStart,
  ToolReference,
  ToolStart,
  RunReference,
} from "../../contract/observer.js";
import { createRunScopedStore } from "../shared/runs.js";

const MAX_PENDING_REQUESTS = 1024;

type PendingPermission = {
  requestID: string;
  messageID: string;
  callID: string;
  startedAt: number;
  name: string;
  patterns: string[];
  reference?: PermissionReference;
  completion?: { reply: "once" | "always" | "reject"; endedAt: number };
};

export function createPermissionTracker(options: { observer: Observer }) {
  const store = createRunScopedStore(() => ({
    pendingRequests: new Map<string, PendingPermission>(),
    seenRequestIDs: new Set<string>(),
  }));

  function finish(completion: PermissionFinish) {
    if (!store.get(completion.tool.interaction.run)?.pendingRequests.delete(completion.requestID)) {
      return;
    }

    options.observer.finishPermission(completion);
  }

  function associate(request: PendingPermission, tool: ToolStart) {
    if (request.reference) {
      return false;
    }

    const start: PermissionStart = {
      tool: { interaction: tool.interaction, messageID: tool.messageID, callID: tool.callID },
      requestID: request.requestID,
      startedAt: request.startedAt,
      toolName: tool.name,
      name: request.name,
      patterns: request.patterns,
      agentName: tool.agentName,
      agentType: tool.agentType,
      parentSessionID: tool.parentSessionID,
    };
    request.reference = { tool: start.tool, requestID: start.requestID };
    options.observer.startPermission(start);
    if (request.completion) {
      finish({ ...request.reference, ...request.completion });
      return request.completion.reply === "reject";
    }

    return false;
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

      // Permission events can precede the running tool part, notably for fast skill loads.
      const pending: PendingPermission = {
        requestID: request.id,
        messageID: request.tool.messageID,
        callID: request.tool.callID,
        startedAt: observedAt,
        name: request.permission,
        patterns: [...request.patterns],
      };
      state.pendingRequests.set(request.id, pending);
      if (tool) {
        associate(pending, tool);
      }

      if (state.pendingRequests.size > MAX_PENDING_REQUESTS) {
        const oldest = state.pendingRequests.values().next().value;

        if (oldest) {
          state.pendingRequests.delete(oldest.requestID);
          if (oldest.reference) {
            options.observer.finishPermission({
              ...oldest.reference,
              endedAt: observedAt,
              error: { type: "_OTHER", message: "permission correlation capacity exceeded" },
            });
          }
        }
      }
    },
    associate(tool: ToolStart) {
      const requests = Array.from(store.get(tool.interaction.run)?.pendingRequests.values() ?? []);
      return requests
        .filter((request) => request.messageID === tool.messageID && request.callID === tool.callID)
        .map((request) => associate(request, tool))
        .some(Boolean);
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

      const request = state.pendingRequests.get(requestID);

      if (!request) {
        state.seenRequestIDs.add(requestID);
        return;
      }

      if (request.completion) {
        return;
      }

      request.completion = { reply, endedAt: observedAt };
      if (request.reference) {
        finish({ ...request.reference, ...request.completion });
        return reply === "reject" ? request.reference.tool : undefined;
      }
    },
    finishPendingForTool(tool: ToolReference, observedAt: number, error?: ObservationError) {
      const state = store.get(tool.interaction.run);
      state?.pendingRequests.forEach((request) => {
        if (request.callID !== tool.callID || request.messageID !== tool.messageID) {
          return;
        }

        if (!request.reference) {
          state.pendingRequests.delete(request.requestID);
          return;
        }

        finish({
          ...request.reference,
          endedAt: observedAt,
          error: error ?? { type: "_OTHER", message: "tool ended before permission replied" },
        });
      });
    },
    close(run: RunReference, observedAt: number, error?: ObservationError) {
      const state = store.get(run);
      state?.pendingRequests.forEach((request) => {
        if (!request.reference) {
          state.pendingRequests.delete(request.requestID);
          return;
        }

        finish({
          ...request.reference,
          endedAt: observedAt,
          error: error ?? { type: "_OTHER", message: "session ended before permission replied" },
        });
      });
    },
  };
}
