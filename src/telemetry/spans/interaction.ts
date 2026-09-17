import { SpanKind, SpanStatusCode, trace, type Context, type Span } from "@opentelemetry/api";
import type {
  InteractionFinish,
  InteractionReference,
  InteractionStart,
  ObservationError,
  RunReference,
} from "../../contract/observer.js";
import { encodeTextMessage, type SpanOptions } from "./common.js";

export function createInteractionSpans(
  options: SpanOptions & {
    parentContext: (run: RunReference) => Context | undefined;
  },
) {
  const interactions = new Map<string, { reference: InteractionReference; span: Span }>();

  function finish(input: InteractionFinish) {
    const key = JSON.stringify([input.run.sessionID, input.run.id, input.id]);
    const interaction = interactions.get(key);

    if (!interaction) {
      return;
    }

    interactions.delete(key);
    // Steer may end a parent before its model call is observed or completed.
    options.history.add(
      interaction.reference.run,
      "interaction",
      key,
      trace.setSpanContext(options.rootContext, interaction.span.spanContext()),
    );

    if (input.status === "failed") {
      interaction.span.setAttribute("error.type", input.error.type);
      interaction.span.setStatus({ code: SpanStatusCode.ERROR, message: input.error.message });
    }

    if (options.captureContent && input.status === "superseded") {
      interaction.span.setAttribute("gen_ai.output.messages", "[]");
    }

    if (options.captureContent && input.status === "completed" && input.output !== undefined) {
      interaction.span.setAttribute(
        "gen_ai.output.messages",
        encodeTextMessage("assistant", input.output),
      );
    }

    interaction.span.end(new Date(input.endedAt));
  }

  return {
    finish,
    start(input: InteractionStart) {
      const key = JSON.stringify([input.run.sessionID, input.run.id, input.id]);
      const parent = options.parentContext(input.run);

      if (!parent || interactions.has(key) || options.history.has(input.run, "interaction", key)) {
        return;
      }

      interactions.set(key, {
        reference: { run: { sessionID: input.run.sessionID, id: input.run.id }, id: input.id },
        span: options.tracer.startSpan(
          `${options.tracePrefix}interaction`,
          {
            kind: SpanKind.INTERNAL,
            startTime: new Date(input.startedAt),
            attributes: {
              ...options.spanAttributes,
              "session.id": input.run.sessionID,
              "gen_ai.conversation.id": input.run.sessionID,
              "opencode.interaction.id": input.id,
              "gen_ai.operation.name": "invoke_agent",
              "gen_ai.agent.name": input.agentName,
              "opencode.agent.type": input.agentType,
              "opencode.session.parent_id": input.parentSessionID,
              ...(input.userID ? { "user.id": input.userID } : {}),
              ...(options.captureContent && input.input !== undefined
                ? { "gen_ai.input.messages": encodeTextMessage("user", input.input) }
                : {}),
            },
          },
          parent,
        ),
      });
    },
    context(reference: InteractionReference) {
      const key = JSON.stringify([reference.run.sessionID, reference.run.id, reference.id]);
      const interaction = interactions.get(key);
      return interaction
        ? trace.setSpan(options.rootContext, interaction.span)
        : options.history.context(reference.run, "interaction", key);
    },
    closeRun(run: RunReference, endedAt: number, error?: ObservationError) {
      interactions.forEach((interaction) => {
        if (
          interaction.reference.run.sessionID === run.sessionID &&
          interaction.reference.run.id === run.id
        ) {
          finish({
            ...interaction.reference,
            endedAt,
            status: "failed",
            error: error ?? { type: "_OTHER", message: "run ended before interaction completed" },
          });
        }
      });
    },
    close(endedAt: number) {
      interactions.forEach((interaction) =>
        finish({
          ...interaction.reference,
          endedAt,
          status: "failed",
          error: { type: "_OTHER", message: "plugin disposed before interaction completed" },
        }),
      );
    },
  };
}
