import type { AgentContext, RunReference, ToolReference } from "../../contract/observer.js";

export function createSessionRegistry() {
  const parentSessionIDs = new Map<string, string | undefined>();
  const parentToolsBySessionID = new Map<string, ToolReference>();

  return {
    observe(info: { id: string; parentID?: string }) {
      parentSessionIDs.set(info.id, info.parentID);
    },
    agentContext(sessionID: string): AgentContext {
      const parentSessionID =
        parentToolsBySessionID.get(sessionID)?.interaction.run.sessionID ??
        parentSessionIDs.get(sessionID);
      return {
        parentSessionID,
        agentType: parentSessionID
          ? "subagent"
          : parentSessionIDs.has(sessionID)
            ? "primary"
            : undefined,
      };
    },
    parentTool: (sessionID: string) => parentToolsBySessionID.get(sessionID),
    bindParentTool(sessionID: string, reference: ToolReference) {
      if (sessionID !== reference.interaction.run.sessionID) {
        parentToolsBySessionID.set(sessionID, {
          callID: reference.callID,
          messageID: reference.messageID,
          interaction: { id: reference.interaction.id, run: { ...reference.interaction.run } },
        });

        if (!parentSessionIDs.has(sessionID)) {
          parentSessionIDs.set(sessionID, reference.interaction.run.sessionID);
        }
      }
    },
    unbindTool(reference: ToolReference) {
      parentToolsBySessionID.forEach((tool, sessionID) => {
        if (
          tool.callID === reference.callID &&
          tool.messageID === reference.messageID &&
          tool.interaction.id === reference.interaction.id &&
          tool.interaction.run.id === reference.interaction.run.id &&
          tool.interaction.run.sessionID === reference.interaction.run.sessionID
        ) {
          parentToolsBySessionID.delete(sessionID);
        }
      });
    },
    remove(sessionID: string) {
      parentSessionIDs.delete(sessionID);
      parentToolsBySessionID.delete(sessionID);
    },
    unbindRun(run: RunReference) {
      parentToolsBySessionID.forEach((tool, sessionID) => {
        if (
          tool.interaction.run.sessionID === run.sessionID &&
          tool.interaction.run.id === run.id
        ) {
          parentToolsBySessionID.delete(sessionID);
        }
      });
    },
  };
}
