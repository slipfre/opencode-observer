import { SpanStatusCode, type Context, type Span, type Tracer } from "@opentelemetry/api";
import type {
  AgentContext,
  CompactionReference,
  LlmReference,
  ObservationError,
  RunReference,
  ToolReference,
} from "../../contract/observer.js";

export type SpanOptions = {
  tracer: Tracer;
  rootContext: Context;
  spanNamePrefix: string;
  captureContent: boolean;
  spanAttributes: Record<string, string>;
  finishedSpanRegistry: Pick<
    ReturnType<typeof createFinishedSpanRegistry>,
    "add" | "has" | "context"
  >;
};

type SpanType = "interaction" | "llm" | "tool" | "skill" | "compaction" | "permission";

export function encodeTextMessage(role: "user" | "assistant", text: string) {
  return JSON.stringify([{ role, parts: [{ type: "text", content: text }] }]);
}

export function operationKey(reference: ToolReference | CompactionReference | LlmReference) {
  const key = `${reference.interaction.run.sessionID}:${reference.interaction.run.id}:${reference.interaction.id}`;
  return "messageID" in reference
    ? `${key}:${reference.messageID}:${encodeURIComponent(reference.callID)}`
    : `${key}::${reference.id}`;
}

export function sameRun(first: RunReference, second: RunReference) {
  return first.sessionID === second.sessionID && first.id === second.id;
}

export function createFinishedSpanRegistry() {
  // A null entry retains only the closed run identity, releasing every child record.
  const runs = new Map<string, Map<string, Context | undefined> | null>();

  return {
    add(run: RunReference, type: SpanType, key: string, context?: Context) {
      const runKey = `${run.sessionID}:${run.id}`;

      if (runs.get(runKey) === null) {
        return;
      }

      const finished = runs.get(runKey) ?? new Map<string, Context | undefined>();
      finished.set(`${type}:${key}`, context);
      runs.set(runKey, finished);
    },
    has(run: RunReference, type: SpanType, key: string) {
      return runs.get(`${run.sessionID}:${run.id}`)?.has(`${type}:${key}`) ?? false;
    },
    context(run: RunReference, type: SpanType, key: string) {
      return runs.get(`${run.sessionID}:${run.id}`)?.get(`${type}:${key}`);
    },
    isRunClosed(run: RunReference) {
      return runs.get(`${run.sessionID}:${run.id}`) === null;
    },
    markRunClosed(run: RunReference) {
      runs.set(`${run.sessionID}:${run.id}`, null);
    },
  };
}

export function agentContextAttributes(run: RunReference, agentContext: AgentContext) {
  return {
    "session.id": run.sessionID,
    "gen_ai.conversation.id": run.sessionID,
    "gen_ai.agent.name": agentContext.agentName,
    "opencode.agent.type": agentContext.agentType,
    "opencode.session.parent_id": agentContext.parentSessionID,
  };
}

export function endSpan(span: Span, endedAt: number, error?: ObservationError) {
  if (error) {
    const message = error.message?.trim()
      ? error.message
      : `${error.type.trim() && error.type !== "_OTHER" ? error.type : "Operation failed"}: no error message provided`;
    span.setAttributes({ "error.type": error.type, "exception.message": message });
    span.setStatus({ code: SpanStatusCode.ERROR, message });
  }

  span.end(new Date(endedAt));
}
