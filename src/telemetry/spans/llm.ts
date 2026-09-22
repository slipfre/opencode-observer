import { defaultTextMapSetter, SpanKind, trace, type Context, type Span } from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import type {
  LlmFinish,
  LlmReference,
  LlmStart,
  LlmUpdate,
  ModelHeaders,
  ObservationError,
  RunReference,
  TraceHeaders,
} from "../../contract/observer.js";
import { encodeTextMessage, endSpan, operationKey, type SpanOptions } from "./common.js";
import { encodeModelMessages } from "./messages.js";

export function createLlmSpans(
  options: SpanOptions & {
    captureHttpHeaders: boolean;
    parentContext: (input: LlmStart) => Context | undefined;
    spanStartTimes?: WeakMap<object, number>;
  },
) {
  const activeSpans = new Map<
    string,
    {
      reference: LlmReference;
      compactionID?: string;
      span: Span;
      spanStartedAt: number;
      firstChunkObservedAt?: number;
      inputMessagesJson?: string;
      outputMessagesJson?: string;
      outputType?: string;
      responseModel?: string;
      toolDefinitionsJson?: string;
      requestHeaders?: ModelHeaders;
      responseHeaders?: ModelHeaders;
    }
  >();
  const propagator = new W3CTraceContextPropagator();

  function finish(input: LlmFinish) {
    const key = operationKey(input);
    const spanState = activeSpans.get(key);

    if (!spanState) {
      return;
    }

    activeSpans.delete(key);
    options.finishedSpanRegistry.add(spanState.reference.interaction.run, "llm", key);
    const timing =
      input.timing?.source === "fetch" &&
      options.spanStartTimes &&
      Number.isFinite(input.timing.startedAt) &&
      input.timing.startedAt >= spanState.spanStartedAt &&
      Number.isFinite(input.timing.endedAt) &&
      input.timing.endedAt >= input.timing.startedAt
        ? input.timing
        : undefined;
    if (timing) {
      options.spanStartTimes?.set(spanState.span, timing.startedAt);
      spanState.spanStartedAt = timing.startedAt;
    }
    const firstChunkElapsedMs =
      spanState.firstChunkObservedAt === undefined
        ? undefined
        : spanState.firstChunkObservedAt - spanState.spanStartedAt;
    const timeToFirstChunkSeconds =
      firstChunkElapsedMs !== undefined &&
      spanState.spanStartedAt >= 0 &&
      Number.isFinite(firstChunkElapsedMs) &&
      firstChunkElapsedMs >= 0
        ? firstChunkElapsedMs / 1000
        : undefined;
    spanState.span.setAttributes({
      [`${options.attributePrefix}llm.timing.source`]: timing ? "fetch" : "message",
      [`${options.attributePrefix}llm.timing.fallback_reason`]:
        input.timing?.source === "message"
          ? input.timing.fallbackReason
          : input.timing && !timing
            ? "fetch-incomplete"
            : undefined,
      "gen_ai.response.time_to_first_chunk": timeToFirstChunkSeconds,
      "gen_ai.output.type": spanState.outputType,
      "gen_ai.response.model": spanState.responseModel,
      "gen_ai.response.finish_reasons": input.finishReason
        ? [input.finishReason]
        : input.error
          ? ["error"]
          : undefined,
      ...(!input.error
        ? {
            "gen_ai.usage.input_tokens": input.usage?.inputTokens,
            "gen_ai.usage.output_tokens": input.usage?.outputTokens,
            "gen_ai.usage.reasoning.output_tokens": input.usage?.reasoningTokens,
            "gen_ai.usage.cache_read.input_tokens": input.usage?.cacheReadTokens,
            "gen_ai.usage.cache_write.input_tokens": input.usage?.cacheWriteTokens,
            [`${options.attributePrefix}llm.cost.total`]: input.cost,
          }
        : {}),
    });

    if (options.captureContent) {
      spanState.span.setAttributes({
        "gen_ai.tool.definitions": spanState.toolDefinitionsJson,
        "gen_ai.input.messages": spanState.inputMessagesJson,
        "gen_ai.output.messages":
          spanState.outputMessagesJson ??
          (input.fallbackOutputText !== undefined
            ? encodeTextMessage("assistant", input.fallbackOutputText)
            : undefined),
      });
    }

    if (options.captureContent && options.captureHttpHeaders) {
      spanState.span.setAttributes({
        ...Object.fromEntries(
          Object.entries(spanState.requestHeaders ?? {}).map(([key, value]) => [
            `http.request.header.${key}`,
            value,
          ]),
        ),
        ...Object.fromEntries(
          Object.entries(input.responseHeaders ?? spanState.responseHeaders ?? {}).map(
            ([key, value]) => [`http.response.header.${key}`, value],
          ),
        ),
      });
    }

    endSpan(spanState.span, timing?.endedAt ?? input.endedAt, input.error);
  }

  return {
    finish,
    traceHeaders(input: LlmReference): TraceHeaders | undefined {
      const spanState = activeSpans.get(operationKey(input));

      if (!spanState) {
        return;
      }

      const headers: Record<string, string> = {};
      propagator.inject(
        trace.setSpan(options.rootContext, spanState.span),
        headers,
        defaultTextMapSetter,
      );
      return headers.traceparent
        ? {
            traceparent: headers.traceparent,
            ...(headers.tracestate ? { tracestate: headers.tracestate } : {}),
          }
        : undefined;
    },
    update(input: LlmUpdate) {
      const spanState = activeSpans.get(operationKey(input));

      if (!spanState) {
        return;
      }

      if (spanState.firstChunkObservedAt === undefined) {
        spanState.firstChunkObservedAt = input.firstChunkObservedAt;
      }

      if (input.retryCount !== undefined) {
        spanState.span.setAttribute(`${options.attributePrefix}llm.retry_count`, input.retryCount);
      }

      if (input.request) {
        spanState.outputType = input.request.outputType;
        delete spanState.outputMessagesJson;
        delete spanState.responseModel;
        delete spanState.responseHeaders;
      }

      if (input.responseModel !== undefined) {
        spanState.responseModel = input.responseModel;
      }

      if (!options.captureContent) {
        return;
      }

      if (input.request) {
        spanState.toolDefinitionsJson =
          input.request.toolDefinitions === undefined
            ? undefined
            : JSON.stringify(input.request.toolDefinitions);
        spanState.requestHeaders =
          options.captureHttpHeaders && input.request.headers !== undefined
            ? structuredClone(input.request.headers)
            : undefined;
      }

      if (options.captureHttpHeaders && input.responseHeaders !== undefined) {
        spanState.responseHeaders = structuredClone(input.responseHeaders);
      }

      if (input.input) {
        spanState.inputMessagesJson = encodeModelMessages(input.input.messages);
        delete spanState.outputMessagesJson;
      }

      if (input.output !== undefined) {
        spanState.outputMessagesJson = encodeModelMessages(input.output);
      }
    },
    start(input: LlmStart) {
      const key = operationKey(input);
      const parent = options.parentContext(input);

      if (
        !parent ||
        activeSpans.has(key) ||
        options.finishedSpanRegistry.has(input.interaction.run, "llm", key)
      ) {
        return;
      }

      activeSpans.set(key, {
        spanStartedAt: input.startedAt,
        compactionID: input.compactionID,
        reference: {
          id: input.id,
          interaction: {
            id: input.interaction.id,
            run: { ...input.interaction.run },
          },
        },
        span: options.tracer.startSpan(
          `${options.spanNamePrefix}llm`,
          {
            kind: SpanKind.CLIENT,
            startTime: new Date(input.startedAt),
            attributes: {
              ...options.spanAttributes,
              "session.id": input.interaction.run.sessionID,
              "gen_ai.conversation.id": input.interaction.run.sessionID,
              "gen_ai.operation.name": input.operation,
              "gen_ai.provider.name": input.providerName,
              "gen_ai.request.model": input.model,
              [`${options.attributePrefix}message.id`]: input.id,
              "gen_ai.agent.name": input.agentName,
              [`${options.attributePrefix}agent.type`]: input.agentType,
              [`${options.attributePrefix}session.parent_id`]: input.parentSessionID,
              [`${options.attributePrefix}compaction.id`]: input.compactionID,
              "gen_ai.request.stream": input.stream,
              "gen_ai.request.temperature": input.parameters?.temperature,
              "gen_ai.request.top_p": input.parameters?.topP,
              "gen_ai.request.top_k": input.parameters?.topK,
              "gen_ai.request.max_tokens": input.parameters?.maxOutputTokens,
              [`${options.attributePrefix}llm.retry_count`]: 0,
              ...(options.captureContent && input.fallbackInputText !== undefined
                ? { "gen_ai.input.messages": encodeTextMessage("user", input.fallbackInputText) }
                : {}),
            },
          },
          parent,
        ),
      });
    },
    finishPendingForRun(run: RunReference, endedAt: number, error?: ObservationError) {
      activeSpans.forEach((spanState) => {
        if (
          spanState.reference.interaction.run.sessionID === run.sessionID &&
          spanState.reference.interaction.run.id === run.id
        ) {
          finish({
            ...spanState.reference,
            endedAt,
            fallbackOutputText: undefined,
            error: error ?? { type: "_OTHER", message: "session ended before message completed" },
          });
        }
      });
    },
    finishForCompaction(
      interaction: LlmReference["interaction"],
      compactionID: string,
      endedAt: number,
      error?: ObservationError,
    ) {
      activeSpans.forEach((spanState) => {
        if (
          spanState.compactionID === compactionID &&
          spanState.reference.interaction.id === interaction.id &&
          spanState.reference.interaction.run.id === interaction.run.id &&
          spanState.reference.interaction.run.sessionID === interaction.run.sessionID
        ) {
          finish({
            ...spanState.reference,
            endedAt,
            fallbackOutputText: undefined,
            error: error ?? {
              type: "_OTHER",
              message: "compaction ended before message completed",
            },
          });
        }
      });
    },
    finishAllOnShutdown(endedAt: number) {
      activeSpans.forEach((spanState) =>
        finish({
          ...spanState.reference,
          endedAt,
          fallbackOutputText: undefined,
          error: { type: "_OTHER", message: "plugin disposed before message completed" },
        }),
      );
    },
  };
}
