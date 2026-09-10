import type { AgentIdentity, ToolReference } from "../contract/observer.js";

export function createSessionRegistry() {
  const parents = new Map<string, string | undefined>();
  const tasks = new Map<string, ToolReference>();

  return {
    observe(info: { id: string; parentID?: string }) {
      parents.set(info.id, info.parentID);
    },
    identity(sessionID: string): AgentIdentity {
      const parentSessionID =
        tasks.get(sessionID)?.interaction.run.sessionID ?? parents.get(sessionID);

      return {
        parentSessionID,
        agentType: parentSessionID ? "subagent" : parents.has(sessionID) ? "primary" : undefined,
      };
    },
    parent: (sessionID: string) => tasks.get(sessionID),
    bind(sessionID: string, reference: ToolReference) {
      if (sessionID !== reference.interaction.run.sessionID) {
        tasks.set(sessionID, {
          id: reference.id,
          messageID: reference.messageID,
          interaction: { id: reference.interaction.id, run: { ...reference.interaction.run } },
        });

        if (!parents.has(sessionID)) {
          parents.set(sessionID, reference.interaction.run.sessionID);
        }
      }
    },
    releaseTool(reference: ToolReference) {
      tasks.forEach((tool, sessionID) => {
        if (
          tool.id === reference.id &&
          tool.messageID === reference.messageID &&
          tool.interaction.id === reference.interaction.id &&
          tool.interaction.run.id === reference.interaction.run.id &&
          tool.interaction.run.sessionID === reference.interaction.run.sessionID
        ) {
          tasks.delete(sessionID);
        }
      });
    },
    remove(sessionID: string) {
      parents.delete(sessionID);
      tasks.delete(sessionID);
    },
    clear() {
      parents.clear();
      tasks.clear();
    },
  };
}
