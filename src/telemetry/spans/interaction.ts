import { SpanKind, trace, type Context, type Span } from "@opentelemetry/api";
import type {
  InteractionFinish,
  InteractionReference,
  InteractionStart,
  ObservationError,
  RunReference,
} from "../../contract/observer.js";
import { encodeTextMessage, endSpan, type SpanOptions } from "./common.js";

export function createInteractionSpans(
  options: SpanOptions & {
    parentContext: (run: RunReference) => Context | undefined;
  },
) {
  const activeSpans = new Map<string, { reference: InteractionReference; span: Span }>();

  function finish(input: InteractionFinish) {
    const key = `${input.run.sessionID}:${input.run.id}:${input.id}`;
    const spanState = activeSpans.get(key);

    if (!spanState) {
      return;
    }

    activeSpans.delete(key);
    // Steer may end a parent before its model call is observed or completed.
    options.finishedSpanRegistry.add(
      spanState.reference.run,
      "interaction",
      key,
      trace.setSpanContext(options.rootContext, spanState.span.spanContext()),
    );

    if (options.captureContent && input.status === "superseded") {
      spanState.span.setAttribute("gen_ai.output.messages", "[]");
    }

    if (options.captureContent && input.status === "completed" && input.output !== undefined) {
      spanState.span.setAttribute(
        "gen_ai.output.messages",
        encodeTextMessage("assistant", input.output),
      );
    }

    endSpan(spanState.span, input.endedAt, input.status === "failed" ? input.error : undefined);
  }

  return {
    finish,
    start(input: InteractionStart) {
      const key = `${input.run.sessionID}:${input.run.id}:${input.id}`;
      const parent = options.parentContext(input.run);

      if (
        !parent ||
        activeSpans.has(key) ||
        options.finishedSpanRegistry.has(input.run, "interaction", key)
      ) {
        return;
      }

      activeSpans.set(key, {
        reference: { run: { sessionID: input.run.sessionID, id: input.run.id }, id: input.id },
        span: options.tracer.startSpan(
          `${options.spanNamePrefix}interaction`,
          {
            kind: SpanKind.INTERNAL,
            startTime: new Date(input.startedAt),
            attributes: {
              ...options.spanAttributes,
              "session.id": input.run.sessionID,
              "gen_ai.conversation.id": input.run.sessionID,
              [`${options.attributePrefix}interaction.id`]: input.id,
              "gen_ai.operation.name": "invoke_agent",
              "gen_ai.agent.name": input.agentName,
              [`${options.attributePrefix}agent.type`]: input.agentType,
              [`${options.attributePrefix}session.parent_id`]: input.parentSessionID,
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
      const key = `${reference.run.sessionID}:${reference.run.id}:${reference.id}`;
      const spanState = activeSpans.get(key);
      return spanState
        ? trace.setSpan(options.rootContext, spanState.span)
        : options.finishedSpanRegistry.context(reference.run, "interaction", key);
    },
    finishPendingForRun(run: RunReference, endedAt: number, error?: ObservationError) {
      activeSpans.forEach((spanState) => {
        if (
          spanState.reference.run.sessionID === run.sessionID &&
          spanState.reference.run.id === run.id
        ) {
          finish({
            ...spanState.reference,
            endedAt,
            status: "failed",
            error: error ?? { type: "_OTHER", message: "run ended before interaction completed" },
          });
        }
      });
    },
    finishAllOnShutdown(endedAt: number) {
      activeSpans.forEach((spanState) =>
        finish({
          ...spanState.reference,
          endedAt,
          status: "failed",
          error: { type: "_OTHER", message: "plugin disposed before interaction completed" },
        }),
      );
    },
  };
}
