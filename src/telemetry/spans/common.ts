import { SpanStatusCode, type Context, type Span, type Tracer } from "@opentelemetry/api";
import type {
  AgentIdentity,
  CompactionReference,
  ObservationError,
  RunReference,
  ToolReference,
} from "../../contract/observer.js";

export type SpanOptions = {
  tracer: Tracer;
  rootContext: Context;
  tracePrefix: string;
  captureContent: boolean;
  spanAttributes: Record<string, string>;
  history: Pick<ReturnType<typeof createSpanHistory>, "add" | "has" | "context">;
};

type SpanType = "interaction" | "llm" | "tool" | "compaction" | "permission";

export function encodeTextMessage(role: "user" | "assistant", text: string) {
  return JSON.stringify([{ role, parts: [{ type: "text", content: text }] }]);
}

export function operationKey(reference: ToolReference | CompactionReference) {
  return JSON.stringify([
    reference.interaction.run.sessionID,
    reference.interaction.run.id,
    reference.interaction.id,
    "messageID" in reference ? reference.messageID : undefined,
    "callID" in reference ? reference.callID : reference.id,
  ]);
}

export function sameRun(first: RunReference, second: RunReference) {
  return first.sessionID === second.sessionID && first.id === second.id;
}

export function createSpanHistory() {
  // A null entry retains only the closed run identity, releasing every child record.
  const runs = new Map<string, Map<string, Context | undefined> | null>();

  return {
    add(run: RunReference, type: SpanType, key: string, context?: Context) {
      const runKey = JSON.stringify([run.sessionID, run.id]);

      if (runs.get(runKey) === null) {
        return;
      }

      const finished = runs.get(runKey) ?? new Map<string, Context | undefined>();
      finished.set(JSON.stringify([type, key]), context);
      runs.set(runKey, finished);
    },
    has(run: RunReference, type: SpanType, key: string) {
      return (
        runs.get(JSON.stringify([run.sessionID, run.id]))?.has(JSON.stringify([type, key])) ?? false
      );
    },
    context(run: RunReference, type: SpanType, key: string) {
      return runs.get(JSON.stringify([run.sessionID, run.id]))?.get(JSON.stringify([type, key]));
    },
    isRunClosed(run: RunReference) {
      return runs.get(JSON.stringify([run.sessionID, run.id])) === null;
    },
    closeRun(run: RunReference) {
      runs.set(JSON.stringify([run.sessionID, run.id]), null);
    },
  };
}

export function identityAttributes(run: RunReference, identity: AgentIdentity) {
  return {
    "session.id": run.sessionID,
    "gen_ai.conversation.id": run.sessionID,
    "gen_ai.agent.name": identity.agentName,
    "opencode.agent.type": identity.agentType,
    "opencode.session.parent_id": identity.parentSessionID,
    ...(identity.userID ? { "user.id": identity.userID } : {}),
  };
}

export function endSpan(span: Span, endedAt: number, error?: ObservationError) {
  if (error) {
    span.setAttribute("error.type", error.type);
    span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
  }

  span.end(new Date(endedAt));
}
