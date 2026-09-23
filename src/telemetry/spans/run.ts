import { SpanKind, trace, type Context, type Span } from "@opentelemetry/api";
import type {
  RunFinish,
  RunReference,
  RunStart,
  RunUpdate,
  ToolReference,
} from "../../contract/observer.js";
import { encodeTextMessage, endSpan, type SpanOptions } from "./common.js";

type RunSpanState = {
  reference: RunReference;
  span: Span;
  inputTextsByMessageID?: Map<string, string | undefined>;
};

export function createRunSpans(
  options: SpanOptions & {
    parentContext?(reference: ToolReference): Context | undefined;
  },
) {
  const activeSpans = new Map<string, RunSpanState>();

  function finish(input: RunFinish) {
    const key = `${input.sessionID}:${input.id}`;
    const spanState = activeSpans.get(key);

    if (!spanState) {
      return;
    }

    activeSpans.delete(key);

    if (spanState.inputTextsByMessageID?.size) {
      const texts = Array.from(spanState.inputTextsByMessageID.values());

      if (texts.every((text) => text !== undefined)) {
        spanState.span.setAttribute(
          "gen_ai.input.messages",
          JSON.stringify(
            texts.map((text) => ({ role: "user", parts: [{ type: "text", content: text }] })),
          ),
        );
      }
    }

    if (!input.error && options.captureContent && input.output !== undefined) {
      spanState.span.setAttribute(
        "gen_ai.output.messages",
        encodeTextMessage("assistant", input.output),
      );
    }

    endSpan(spanState.span, input.endedAt, input.error);
  }

  return {
    finish,
    start(input: RunStart) {
      const key = `${input.sessionID}:${input.id}`;
      const parent = input.parentTool
        ? options.parentContext?.(input.parentTool)
        : options.rootContext;

      if (!parent || activeSpans.has(key)) {
        return;
      }

      activeSpans.set(key, {
        reference: { sessionID: input.sessionID, id: input.id },
        inputTextsByMessageID: options.captureContent ? new Map() : undefined,
        span: options.tracer.startSpan(
          `${options.spanNamePrefix}run`,
          {
            kind: SpanKind.INTERNAL,
            startTime: new Date(input.startedAt),
            attributes: {
              ...options.spanAttributes,
              "session.id": input.sessionID,
              "gen_ai.conversation.id": input.sessionID,
              "gen_ai.operation.name": "invoke_workflow",
              [`${options.attributePrefix}run.id`]: input.id,
              [`${options.attributePrefix}session.parent_id`]: input.parentSessionID,
            },
          },
          parent,
        ),
      });
      return true;
    },
    update(input: RunUpdate) {
      const inputs = activeSpans.get(`${input.sessionID}:${input.id}`)?.inputTextsByMessageID;

      if (!inputs || inputs.has(input.input.id)) {
        return;
      }

      inputs.set(input.input.id, input.input.text);
    },
    context(reference: RunReference) {
      const spanState = activeSpans.get(`${reference.sessionID}:${reference.id}`);
      return spanState ? trace.setSpan(options.rootContext, spanState.span) : undefined;
    },
    finishAllOnShutdown(endedAt: number) {
      activeSpans.forEach((spanState) =>
        finish({
          ...spanState.reference,
          endedAt,
          output: undefined,
          error: { type: "_OTHER", message: "plugin disposed before run completed" },
        }),
      );
    },
  };
}
