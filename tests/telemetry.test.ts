import { afterEach, expect, mock, test } from "bun:test";
import { createTraceState, ROOT_CONTEXT, SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { ExportResultCode } from "@opentelemetry/core";
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  SamplingDecision,
  type ReadableSpan,
  type Sampler,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-base";
import type { InteractionStart, LlmStart, Observer, RunStart } from "../src/contract/observer.js";
import { createObserver, type ObserverOptions } from "../src/telemetry/observer.js";
import { createFinishedSpanRegistry } from "../src/telemetry/spans/common.js";
import type { ModelInput, ModelMessage } from "../src/contract/messages.js";

const observers: Observer[] = [];

afterEach(async () => {
  await Promise.all(
    observers.splice(0).map((observer) => observer.shutdown().catch(() => undefined)),
  );
});

function setup(
  options: Partial<Omit<ObserverOptions, "tracerProvider" | "instrumentationScope">> = {},
  exporting?: SpanExporter["export"],
  sampler?: Sampler,
) {
  const spans: ReadableSpan[] = [];
  const shutdown = mock(async () => {});
  const exporter: SpanExporter = {
    export(batch, callback) {
      spans.push(...batch);

      if (exporting) {
        exporting(batch, callback);
        return;
      }

      callback({ code: ExportResultCode.SUCCESS });
    },
    shutdown,
  };
  const tracerProvider = new BasicTracerProvider({
    sampler,
    spanProcessors: [
      new BatchSpanProcessor(exporter, { scheduledDelayMillis: 60_000, exportTimeoutMillis: 1000 }),
    ],
  });
  const observer = createObserver({
    tracerProvider,
    instrumentationScope: { name: "test" },
    captureContent: true,
    now: () => 3000,
    ...options,
  });
  observers.push(observer);

  return { observer, spans, shutdown };
}

function start(id = "u1", sessionID = "s1"): RunStart {
  return { id, sessionID, startedAt: 1000, parentTool: undefined, parentSessionID: undefined };
}

function interaction(id = "u1", run = start()): InteractionStart {
  return {
    run: { sessionID: run.sessionID, id: run.id },
    id,
    startedAt: 1000,
    input: "question",
    agentName: "build",
    agentType: undefined,
    parentSessionID: undefined,
  };
}

function llm(id = "a1", parent = interaction()): LlmStart {
  return {
    id,
    interaction: { id: parent.id, run: parent.run },
    startedAt: 1100,
    providerID: "custom-google",
    providerName: "gcp.gemini",
    model: "gemini",
    operation: "generate_content",
    stream: true,
    agentName: "build",
    fallbackInputText: "question",
    agentType: undefined,
    parentSessionID: undefined,
    compactionID: undefined,
  };
}

test.each([true, false])(
  "first chunk timing is independent of content=%s and survives failure",
  async (captureContent) => {
    const h = setup({ captureContent });
    h.observer.startRun(start());
    h.observer.startInteraction(interaction());
    h.observer.startLlm(llm());

    h.observer.updateLlm({
      id: "a1",
      interaction: llm().interaction,
      firstChunkEstimate: { firstSdkStepStartedAt: 1200, observedAt: 1550 },
    });
    h.observer.updateLlm({
      id: "a1",
      interaction: llm().interaction,
      request: {},
      firstChunkEstimate: { firstSdkStepStartedAt: 1600, observedAt: 2300 },
    });
    h.observer.finishLlm({
      ...llm(),
      endedAt: 2400,
      fallbackOutputText: undefined,
      error: { type: "APIError" },
    });
    await h.observer.flush();

    expect(h.spans[0]?.attributes["gen_ai.response.time_to_first_chunk"]).toBe(0.35);
    expect(h.spans[0]?.attributes["opencode.llm.time_to_first_chunk.source"]).toBe("step-start");
    expect(h.spans[0]?.status.code).toBe(SpanStatusCode.ERROR);
    expect(
      h.spans[0]?.attributes["opencode.llm.successful_attempt.time_to_first_chunk"],
    ).toBeUndefined();
  },
);

test.each([
  { firstSdkStepStartedAt: 1200, observedAt: 1200, expected: 0 },
  { firstSdkStepStartedAt: 1200, observedAt: 1100, expected: undefined },
  { firstSdkStepStartedAt: -1, observedAt: 1300, expected: undefined },
  { firstSdkStepStartedAt: Number.NaN, observedAt: 1300, expected: undefined },
  { firstSdkStepStartedAt: 1200, observedAt: Number.POSITIVE_INFINITY, expected: undefined },
])("first chunk timestamps are validated: %j", async (timing) => {
  const h = setup();
  h.observer.startRun(start());
  h.observer.startInteraction(interaction());
  h.observer.startLlm(llm());
  h.observer.updateLlm({ id: "a1", interaction: llm().interaction, firstChunkEstimate: timing });
  h.observer.finishLlm({ ...llm(), endedAt: 1400, fallbackOutputText: undefined });
  await h.observer.flush();

  expect(h.spans[0]?.attributes["gen_ai.response.time_to_first_chunk"]).toBe(timing.expected);
  expect(h.spans[0]?.attributes["opencode.llm.time_to_first_chunk.source"]).toBe(
    timing.expected === undefined ? undefined : "step-start",
  );
});

test("finished span registry isolates types and releases all child records when a run closes", () => {
  const finishedSpanRegistry = createFinishedSpanRegistry();
  const runs = [start(), start("u2"), start("u1", "s2")];
  const types = ["interaction", "llm", "tool", "compaction", "permission"] as const;
  runs.forEach((run) => {
    finishedSpanRegistry.add(run, "interaction", "same-child-id", ROOT_CONTEXT);
    expect(finishedSpanRegistry.has(run, "llm", "same-child-id")).toBe(false);
    types.slice(1).forEach((type) => finishedSpanRegistry.add(run, type, "same-child-id"));
    expect(finishedSpanRegistry.context(run, "interaction", "same-child-id")).toBe(ROOT_CONTEXT);
    expect(finishedSpanRegistry.context(run, "llm", "same-child-id")).toBeUndefined();
  });

  finishedSpanRegistry.markRunClosed({ ...start() });
  finishedSpanRegistry.markRunClosed({ ...start() });
  finishedSpanRegistry.add(start(), "interaction", "late", ROOT_CONTEXT);

  types.forEach((type) => {
    expect(runs.map((run) => finishedSpanRegistry.has(run, type, "same-child-id"))).toEqual([
      false,
      true,
      true,
    ]);
  });
  expect(
    runs.map((run) => finishedSpanRegistry.context(run, "interaction", "same-child-id")),
  ).toEqual([undefined, ROOT_CONTEXT, ROOT_CONTEXT]);
  expect(runs.map((run) => finishedSpanRegistry.isRunClosed(run))).toEqual([true, false, false]);
  expect(finishedSpanRegistry.has(start(), "interaction", "late")).toBe(false);
  expect(finishedSpanRegistry.context(start(), "interaction", "late")).toBeUndefined();

  finishedSpanRegistry.markRunClosed(start("u2"));
  finishedSpanRegistry.markRunClosed(start("u1", "s2"));

  types.forEach((type) => {
    expect(runs.some((run) => finishedSpanRegistry.has(run, type, "same-child-id"))).toBe(false);
  });
  expect(runs.every((run) => finishedSpanRegistry.isRunClosed(run))).toBe(true);
});

test("finished span registry keeps matching interaction and LLM IDs independent after steer", async () => {
  const h = setup();
  const parent = interaction("same-id");
  const call = llm("same-id", parent);
  h.observer.startRun(start());
  h.observer.startInteraction(parent);
  h.observer.finishInteraction({ ...parent, endedAt: 1100, status: "superseded" });

  h.observer.startLlm(call);
  h.observer.finishLlm({ ...call, endedAt: 1500, fallbackOutputText: "answer" });
  h.observer.startInteraction(parent);
  h.observer.startLlm(call);
  h.observer.finishRun({ ...start(), endedAt: 2000, output: undefined });
  await h.observer.flush();

  expect(h.spans.map((span) => span.name)).toEqual([
    "opencode.interaction",
    "opencode.llm",
    "opencode.run",
  ]);
  expect(h.spans[1]?.parentSpanContext?.spanId).toBe(h.spans[0]?.spanContext().spanId);
  expect(h.spans.every((span) => span.status.code === SpanStatusCode.UNSET)).toBe(true);
});

test.each([false, true])(
  "LLM deduplication uses the complete reference with the first call finished=%s",
  async (finishFirstEarly) => {
    const h = setup();
    const parents = [interaction("first"), interaction("second")];
    const calls = parents.map((parent) => llm("same-message", parent));
    h.observer.startRun(start());
    parents.forEach((parent) => h.observer.startInteraction(parent));
    h.observer.startLlm(calls[0]!);
    h.observer.updateLlm({ ...calls[0]!, request: { outputType: "text" } });

    if (finishFirstEarly) {
      h.observer.finishLlm({ ...calls[0]!, endedAt: 1400, fallbackOutputText: "first answer" });
    }

    h.observer.startLlm(calls[1]!);
    h.observer.updateLlm({ ...calls[1]!, request: { outputType: "json" } });
    const headers = calls.map((call) => h.observer.llmTraceHeaders(call));
    expect(headers[1]?.traceparent).toBeDefined();
    expect(headers[0]?.traceparent).not.toBe(headers[1]?.traceparent);
    expect(headers[0] === undefined).toBe(finishFirstEarly);

    calls.forEach((call, index) => {
      h.observer.startLlm({ ...call, model: "duplicate" });
      h.observer.finishLlm({
        ...call,
        endedAt: index === 0 ? 1400 : 1500,
        fallbackOutputText: index === 0 ? "first answer" : "second answer",
      });
      h.observer.startLlm(call);
      h.observer.updateLlm({ ...call, request: { outputType: index === 0 ? "json" : "text" } });
      h.observer.finishLlm({ ...call, endedAt: 9000, fallbackOutputText: "late" });
    });
    h.observer.finishRun({ ...start(), endedAt: 2000, output: undefined });
    await h.observer.flush();

    const spans = h.spans.filter((span) => span.name === "opencode.llm");
    expect(spans).toHaveLength(2);
    expect(spans.map((span) => span.attributes["gen_ai.output.type"])).toEqual(["text", "json"]);
    expect(spans.map((span) => span.attributes["gen_ai.request.model"])).toEqual([
      "gemini",
      "gemini",
    ]);
    expect(spans.map((span) => span.endTime)).toEqual([
      [1, 400_000_000],
      [1, 500_000_000],
    ]);
    spans.forEach((span, index) => {
      expect(span.attributes["gen_ai.output.messages"]).toContain(
        index === 0 ? "first answer" : "second answer",
      );
      expect(span.parentSpanContext?.spanId).toBe(
        h.spans
          .find((parent) => parent.attributes["opencode.interaction.id"] === parents[index]?.id)
          ?.spanContext().spanId,
      );
    });
  },
);

test("run cleanup preserves child deduplication in live runs and rejects closed-run replays", async () => {
  const h = setup();
  const first = interaction();
  const other = interaction("u1", start("u1", "s2"));

  function recordChildren(parent: InteractionStart) {
    const tool = {
      interaction: parent,
      messageID: "a1",
      callID: "tool1",
      name: "read",
      startedAt: 1200,
    };
    const permission = {
      tool,
      requestID: "permission1",
      startedAt: 1300,
      toolName: "read",
      name: "read",
      patterns: ["src/*"],
    };
    const compaction = {
      interaction: parent,
      id: "compaction1",
      startedAt: 1500,
      auto: true,
      overflow: false,
    };
    const summary = {
      ...llm("summary1", parent),
      startedAt: 1600,
      compactionID: compaction.id,
    };

    h.observer.startInteraction(parent);
    h.observer.startLlm(llm("a1", parent));
    h.observer.finishLlm({ ...llm("a1", parent), endedAt: 1200, fallbackOutputText: undefined });
    h.observer.startTool(tool);
    h.observer.startPermission(permission);
    h.observer.finishPermission({ ...permission, endedAt: 1400, reply: "once" });
    h.observer.startPermission(permission);
    h.observer.finishTool({ ...tool, endedAt: 1500 });
    h.observer.startCompaction(compaction);
    h.observer.startLlm(summary);
    h.observer.finishLlm({ ...summary, endedAt: 1700, fallbackOutputText: undefined });
    h.observer.finishCompaction({ ...compaction, endedAt: 1800 });
    h.observer.finishInteraction({ ...parent, endedAt: 1900, status: "superseded" });
  }

  h.observer.startRun(start());
  h.observer.startRun(start("u1", "s2"));
  recordChildren(first);
  recordChildren(other);
  h.observer.finishRun({ ...first.run, endedAt: 2000, output: undefined });
  await h.observer.flush();

  expect(h.spans).toHaveLength(13);
  const exported = h.spans.map((span) => span.spanContext().spanId);

  h.observer.startRun(start());
  recordChildren(first);
  recordChildren(other);
  recordChildren(interaction("late", start()));
  h.observer.finishRun({ ...first.run, endedAt: 9000, output: "late" });
  await h.observer.flush();

  expect(h.spans.map((span) => span.spanContext().spanId)).toEqual(exported);
  expect(h.observer.llmTraceHeaders(llm("a1", first))).toBeUndefined();

  h.observer.startRun(start("u2"));
  recordChildren(interaction("u1", start("u2")));
  h.observer.finishRun({ ...start("u2"), endedAt: 2000, output: undefined });
  h.observer.finishRun({ ...other.run, endedAt: 2000, output: undefined });
  await h.observer.flush();

  expect(h.spans).toHaveLength(21);
  expect(h.spans.every((span) => span.status.code === SpanStatusCode.UNSET)).toBe(true);
  expect(new Set(h.spans.map((span) => span.spanContext().traceId)).size).toBe(3);
});

test("permission keys keep provider tool call separators distinct from request IDs", async () => {
  const h = setup();
  const permissions = [
    { callID: "call:per_a", requestID: "per_b" },
    { callID: "call", requestID: "per_a:per_b" },
    { callID: "call%3Aper_a", requestID: "per_b" },
  ].map((ids) => ({
    tool: {
      interaction: interaction(),
      messageID: "a1",
      callID: ids.callID,
      name: "read",
      startedAt: 1100,
    },
    requestID: ids.requestID,
    startedAt: 1200,
    toolName: "read",
    name: "read",
    patterns: [],
  }));
  h.observer.startRun(start());
  h.observer.startInteraction(interaction());
  permissions.forEach((permission) => {
    h.observer.startTool(permission.tool);
    h.observer.startPermission(permission);
  });

  permissions.forEach((permission, index) => {
    h.observer.finishPermission({
      ...permission,
      endedAt: 1300,
      reply: index === 1 ? "reject" : "once",
    });
    h.observer.startPermission(permission);
    h.observer.finishTool({ ...permission.tool, endedAt: 1400 });
  });
  h.observer.finishRun({ ...start(), endedAt: 1500, output: undefined });
  await h.observer.flush();

  const checks = h.spans.filter((span) => span.name === "opencode.permission.check");
  expect(checks).toHaveLength(3);
  expect(checks.map((span) => span.attributes["opencode.permission.reply"])).toEqual([
    "once",
    "reject",
    "once",
  ]);
  expect(checks.map((span) => span.attributes["gen_ai.tool.call.id"])).toEqual(
    permissions.map((permission) => permission.tool.callID),
  );
  checks.forEach((check) => {
    const tool = h.spans.find(
      (span) =>
        span.name === "opencode.tool.read" &&
        span.attributes["gen_ai.tool.call.id"] === check.attributes["gen_ai.tool.call.id"],
    );
    expect(check.parentSpanContext?.spanId).toBe(tool?.spanContext().spanId);
  });
});

test.each([
  { state: undefined, decision: SamplingDecision.RECORD_AND_SAMPLED, flags: "01" },
  { state: "vendor=one,other=two", decision: SamplingDecision.RECORD_AND_SAMPLED, flags: "01" },
  { state: "", decision: SamplingDecision.RECORD_AND_SAMPLED, flags: "01" },
  { state: "vendor=unsampled", decision: SamplingDecision.NOT_RECORD, flags: "00" },
])("LLM propagation serializes the span's state and sampling: %j", async (input) => {
  const h = setup({}, undefined, {
    shouldSample: () => ({
      decision: input.decision,
      traceState: input.state === undefined ? undefined : createTraceState(input.state),
    }),
    toString: () => "PropagationTestSampler",
  });

  expect(h.observer.llmTraceHeaders(llm())).toBeUndefined();
  h.observer.startRun(start());
  h.observer.startInteraction(interaction());
  h.observer.startLlm(llm());
  const headers = h.observer.llmTraceHeaders(llm());

  expect(headers?.traceparent).toMatch(new RegExp(`^00-[0-9a-f]{32}-[0-9a-f]{16}-${input.flags}$`));
  expect(headers?.tracestate).toBe(input.state || undefined);
  expect(h.observer.llmTraceHeaders(llm("unknown"))).toBeUndefined();
  expect(h.observer.llmTraceHeaders(llm("a1", interaction("wrong")))).toBeUndefined();
  expect(h.observer.llmTraceHeaders(llm("a1", interaction("u1", start("wrong"))))).toBeUndefined();
  expect(
    h.observer.llmTraceHeaders(llm("a1", interaction("u1", start("u1", "wrong")))),
  ).toBeUndefined();
  expect(h.observer.llmTraceHeaders(llm())).toEqual(headers);
  expect(h.observer.llmTraceHeaders(llm())).not.toBe(headers);

  h.observer.finishLlm({ ...llm(), endedAt: 1500, fallbackOutputText: undefined });
  expect(h.observer.llmTraceHeaders(llm())).toBeUndefined();
  await h.observer.flush();

  if (input.flags === "01") {
    const span = h.spans.find((span) => span.name === "opencode.llm")!;
    expect(headers?.traceparent).toBe(
      `00-${span.spanContext().traceId}-${span.spanContext().spanId}-01`,
    );
    expect(span.spanContext().traceState?.serialize() || undefined).toBe(headers?.tracestate);
  }

  h.observer.startLlm(llm("unfinished"));
  await h.observer.shutdown();
  expect(h.observer.llmTraceHeaders(llm("unfinished"))).toBeUndefined();
});

test("LLM propagation isolates concurrent sessions with identical message IDs", async () => {
  const h = setup();
  const first = llm();
  const second = llm("a1", interaction("u1", start("u1", "s2")));

  [first, second].forEach((input) => {
    h.observer.startRun(start(input.interaction.run.id, input.interaction.run.sessionID));
    h.observer.startInteraction(
      interaction(input.interaction.id, start("u1", input.interaction.run.sessionID)),
    );
    h.observer.startLlm(input);
  });
  const firstHeaders = h.observer.llmTraceHeaders(first);
  const secondHeaders = h.observer.llmTraceHeaders(second);
  expect(firstHeaders?.traceparent).not.toBe(secondHeaders?.traceparent);
  await h.observer.shutdown();

  [first, second].forEach((input, index) => {
    const span = h.spans.find(
      (span) =>
        span.name === "opencode.llm" &&
        span.attributes["session.id"] === input.interaction.run.sessionID,
    )!;
    expect([firstHeaders, secondHeaders][index]?.traceparent).toBe(
      `00-${span.spanContext().traceId}-${span.spanContext().spanId}-01`,
    );
  });
});

test("structured LLM messages encode GenAI parts and take precedence over fallback text", async () => {
  const h = setup();
  const input: ModelInput = {
    messages: [
      {
        role: "user",
        parts: [
          { type: "text", text: "full history" },
          {
            type: "media",
            modality: "image",
            mimeType: "image/png",
            source: { type: "base64", data: "AQID" },
          },
        ],
      },
      {
        role: "tool",
        parts: [{ type: "tool-result", id: "read1", response: { content: "file contents" } }],
      },
    ],
    systemInstructions: [{ type: "text", text: "system" }],
  };
  const output: ModelMessage[] = [
    {
      role: "assistant",
      parts: [
        { type: "reasoning", text: "plan" },
        { type: "tool-call", id: "read2", name: "read", arguments: { path: "a.ts" } },
        {
          type: "media",
          modality: "image",
          source: { type: "uri", uri: "https://example.test/image.png" },
        },
      ],
    },
  ];
  h.observer.startRun(start());
  h.observer.startInteraction(interaction());
  h.observer.startLlm(llm());
  h.observer.updateLlm({ ...llm(), input, output });
  input.messages.length = 0;
  output.length = 0;
  h.observer.finishLlm({ ...llm(), endedAt: 2000, fallbackOutputText: "fallback output" });
  h.observer.updateLlm({ ...llm(), input: { messages: [] }, output: [] });
  await h.observer.flush();

  const attrs = h.spans[0]?.attributes;
  expect(JSON.parse(String(attrs?.["gen_ai.input.messages"]))).toEqual([
    {
      role: "user",
      parts: [
        { type: "text", content: "full history" },
        { type: "blob", modality: "image", mime_type: "image/png", content: "AQID" },
      ],
    },
    {
      role: "tool",
      parts: [{ type: "tool_call_response", id: "read1", response: { content: "file contents" } }],
    },
  ]);
  expect(JSON.parse(String(attrs?.["gen_ai.output.messages"]))).toEqual([
    {
      role: "assistant",
      parts: [
        { type: "reasoning", content: "plan" },
        { type: "tool_call", id: "read2", name: "read", arguments: { path: "a.ts" } },
        { type: "uri", modality: "image", uri: "https://example.test/image.png" },
      ],
    },
  ]);
  expect(attrs?.["gen_ai.system_instructions"]).toBe('[{"type":"text","content":"system"}]');
  expect(JSON.stringify(attrs)).not.toContain("fallback output");
});

test("a new LLM input clears previous step instructions/output and a known empty response wins", async () => {
  const h = setup();
  h.observer.startRun(start());
  h.observer.startInteraction(interaction());
  h.observer.startLlm(llm());
  h.observer.updateLlm({
    ...llm(),
    input: { messages: [], systemInstructions: [{ type: "text", text: "old" }] },
    output: [{ role: "assistant", parts: [{ type: "text", text: "old" }] }],
  });
  h.observer.updateLlm({
    ...llm(),
    input: { messages: [{ role: "user", parts: [{ type: "text", text: "retry" }] }] },
  });
  h.observer.updateLlm({ ...llm(), input: undefined, output: [] });
  h.observer.finishLlm({ ...llm(), endedAt: 2000, fallbackOutputText: "fallback" });
  await h.observer.flush();

  expect(h.spans[0]?.attributes["gen_ai.input.messages"]).toContain("retry");
  expect(h.spans[0]?.attributes["gen_ai.system_instructions"]).toBeUndefined();
  expect(h.spans[0]?.attributes["gen_ai.output.messages"]).toBe("[]");
  expect(JSON.stringify(h.spans[0]?.attributes)).not.toContain("old");
});

test("disabled content capture never reads structured LLM message payloads", async () => {
  const h = setup({ captureContent: false });
  h.observer.startRun(start());
  h.observer.startInteraction(interaction());
  h.observer.startLlm(llm());
  h.observer.updateLlm({
    ...llm(),
    get input(): ModelInput {
      throw new Error("must not read body");
    },
  });
  h.observer.finishLlm({ ...llm(), endedAt: 2000, fallbackOutputText: "secret" });
  await h.observer.flush();

  expect(h.spans[0]?.attributes["gen_ai.input.messages"]).toBeUndefined();
  expect(h.spans[0]?.attributes["gen_ai.output.messages"]).toBeUndefined();
  expect(h.spans[0]?.attributes["gen_ai.system_instructions"]).toBeUndefined();
});

test("contract calls create only run spans and deduplicate inputs, starts, ends and late updates", async () => {
  const h = setup();

  h.observer.startRun(start());
  h.observer.startRun({ ...start(), startedAt: 1500 });
  h.observer.updateRun({ ...start(), input: { id: "u1", text: "first" } });
  h.observer.updateRun({ ...start(), input: { id: "u1", text: "duplicate" } });
  h.observer.updateRun({ ...start(), input: { id: "u2", text: "steer" } });
  await h.observer.flush();

  expect(h.spans).toHaveLength(0);

  h.observer.finishRun({ ...start(), endedAt: 2000, output: "answer" });
  h.observer.startRun(start());
  h.observer.updateRun({ ...start(), input: { id: "u3", text: "late" } });
  h.observer.finishRun({ ...start(), endedAt: 9000, output: "changed", error: { type: "late" } });
  await h.observer.flush();

  expect(h.spans).toHaveLength(1);
  expect(h.spans[0]).toMatchObject({
    name: "opencode.run",
    kind: SpanKind.INTERNAL,
    startTime: [1, 0],
    endTime: [2, 0],
    status: { code: SpanStatusCode.UNSET },
  });
  expect(h.spans[0]?.attributes).toMatchObject({
    "session.id": "s1",
    "gen_ai.conversation.id": "s1",
    "gen_ai.operation.name": "invoke_workflow",
    "opencode.run.id": "u1",
    "gen_ai.input.messages":
      '[{"role":"user","parts":[{"type":"text","content":"first"}]},{"role":"user","parts":[{"type":"text","content":"steer"}]}]',
    "gen_ai.output.messages": '[{"role":"assistant","parts":[{"type":"text","content":"answer"}]}]',
  });
  expect(h.spans[0]?.attributes["opencode.session.parent_id"]).toBeUndefined();
  expect(h.spans[0]?.parentSpanContext).toBeUndefined();
  expect(h.spans[0]?.attributes["error.type"]).toBeUndefined();
});

test("run input aggregation does not inspect payloads when content capture is disabled", async () => {
  const h = setup({ captureContent: false });
  h.observer.startRun(start());
  const update = {
    ...start(),
    get input(): { id: string; text: string } {
      throw new Error("disabled input aggregation must not inspect or retain input");
    },
  };
  h.observer.updateRun(update);
  h.observer.updateRun(update);
  h.observer.finishRun({ ...start(), endedAt: 2000, output: "secret" });
  await h.observer.flush();

  expect(h.spans).toHaveLength(1);
  expect(h.spans[0]?.attributes["gen_ai.input.messages"]).toBeUndefined();
  expect(h.spans[0]?.attributes["gen_ai.output.messages"]).toBeUndefined();
});

test("run identity is scoped by session and unknown objects cannot create spans through updates", async () => {
  const h = setup();

  h.observer.updateRun({ ...start("missing"), input: { id: "missing", text: "ignored" } });
  h.observer.finishRun({ ...start("missing"), endedAt: 2000, output: "ignored" });
  h.observer.startRun(start("same", "s1"));
  h.observer.startRun(start("same", "s2"));
  h.observer.finishRun({ ...start("same", "s1"), endedAt: 2000, output: undefined });
  h.observer.finishRun({ ...start("same", "s2"), endedAt: 2000, output: undefined });
  await h.observer.flush();

  expect(h.spans.map((span) => span.attributes["session.id"])).toEqual(["s1", "s2"]);
  expect(new Set(h.spans.map((span) => span.spanContext().traceId)).size).toBe(2);
});

test("missing input suppresses partial content while known empty output is preserved", async () => {
  const h = setup();

  h.observer.startRun(start());
  h.observer.updateRun({ ...start(), input: { id: "u1", text: "known" } });
  h.observer.updateRun({ ...start(), input: { id: "u2", text: undefined } });
  h.observer.finishRun({ ...start(), endedAt: 2000, output: "" });
  await h.observer.flush();

  expect(h.spans[0]?.attributes["gen_ai.input.messages"]).toBeUndefined();
  expect(h.spans[0]?.attributes["gen_ai.output.messages"]).toBe(
    '[{"role":"assistant","parts":[{"type":"text","content":""}]}]',
  );
});

test("implementation enforces content capture even when a caller supplies content", async () => {
  const h = setup({
    captureContent: false,
    spanAttributes: {
      "gen_ai.input.messages": "leak",
      "gen_ai.output.messages": "leak",
      "opencode.session.parent_id": "fake",
      "error.type": "fake",
    },
  });

  h.observer.startRun(start());
  h.observer.updateRun({ ...start(), input: { id: "u1", text: "secret" } });
  h.observer.finishRun({ ...start(), endedAt: 2000, output: "secret" });
  await h.observer.flush();

  expect(h.spans[0]?.attributes["gen_ai.input.messages"]).toBeUndefined();
  expect(h.spans[0]?.attributes["gen_ai.output.messages"]).toBeUndefined();
  expect(h.spans[0]?.attributes["opencode.session.parent_id"]).toBeUndefined();
  expect(h.spans[0]?.attributes["error.type"]).toBeUndefined();
});

test("shutdown ends unfinished runs once and late observations do not alter exported spans", async () => {
  const h = setup();

  h.observer.startRun(start());
  h.observer.updateRun({ ...start(), input: { id: "u1", text: "question" } });
  const closing = h.observer.shutdown();

  expect(h.observer.shutdown()).toBe(closing);

  const late = interaction("late", start("late"));
  h.observer.startRun(start("late"));
  h.observer.startInteraction(late);
  h.observer.startLlm(llm("late", late));
  h.observer.updateRun({ ...start(), input: { id: "u2", text: "late" } });
  h.observer.finishRun({ ...start(), endedAt: 9000, output: "late" });
  h.observer.finishRun({ ...late.run, endedAt: 9000, output: "late" });
  await closing;
  await h.observer.flush();

  expect(h.spans).toHaveLength(1);
  expect(h.spans[0]).toMatchObject({
    endTime: [3, 0],
    status: { code: SpanStatusCode.ERROR, message: "plugin disposed before run completed" },
  });
  expect(h.spans[0]?.attributes["error.type"]).toBe("_OTHER");
  expect(h.spans[0]?.attributes["gen_ai.output.messages"]).toBeUndefined();
  expect(h.spans[0]?.attributes["gen_ai.input.messages"]).toContain("question");
  expect(h.shutdown).toHaveBeenCalledTimes(1);
});

test("overlapping flushes export new spans without waiting for an earlier export", async () => {
  const exporting = Promise.withResolvers<Parameters<SpanExporter["export"]>[1]>();
  const h = setup({}, (batch, callback) => {
    if (batch[0]?.attributes["opencode.run.id"] === "u1") {
      exporting.resolve(callback);
      return;
    }

    callback({ code: ExportResultCode.SUCCESS });
  });

  h.observer.startRun(start());
  h.observer.finishRun({ ...start(), endedAt: 2000, output: undefined });
  const flushing = h.observer.flush();
  const complete = await exporting.promise;

  try {
    h.observer.startRun(start("u2"));
    h.observer.finishRun({ ...start("u2"), endedAt: 2500, output: undefined });
    await h.observer.flush();

    expect(h.spans.map((span) => span.attributes["opencode.run.id"])).toEqual(["u1", "u2"]);
  } finally {
    complete({ code: ExportResultCode.SUCCESS });
    await flushing;
  }
});

test("shutdown delegates in-flight exports to the SDK without changing observed end times", async () => {
  const exporting = Promise.withResolvers<Parameters<SpanExporter["export"]>[1]>();
  const shuttingDown = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  const h = setup({}, (_batch, callback) => exporting.resolve(callback));
  h.shutdown.mockImplementation(() => {
    shuttingDown.resolve();
    return released.promise;
  });

  h.observer.startRun(start());
  h.observer.finishRun({ ...start(), endedAt: 2000, output: undefined });
  const flushing = h.observer.flush();
  const complete = await exporting.promise;
  const closing = h.observer.shutdown();

  try {
    await shuttingDown.promise;

    expect(h.observer.shutdown()).toBe(closing);
    expect(h.observer.flush()).toBe(closing);
    expect(h.spans[0]?.endTime).toEqual([2, 0]);
    expect(h.shutdown).toHaveBeenCalledTimes(1);
  } finally {
    complete({ code: ExportResultCode.SUCCESS });
    released.resolve();
    await Promise.all([flushing, closing]);
  }

  expect(h.shutdown).toHaveBeenCalledTimes(1);
});

test("failed export rejects flush but does not poison later flushes or shutdown", async () => {
  const failure = new Error("collector unavailable");
  const h = setup({}, (batch, callback) =>
    callback(
      batch[0]?.attributes["opencode.run.id"] === "u1"
        ? { code: ExportResultCode.FAILED, error: failure }
        : { code: ExportResultCode.SUCCESS },
    ),
  );

  h.observer.startRun(start());
  h.observer.finishRun({ ...start(), endedAt: 2000, output: undefined });

  await expect(h.observer.flush()).rejects.toBeDefined();

  h.observer.startRun(start("u2"));
  h.observer.finishRun({ ...start("u2"), endedAt: 2500, output: undefined });
  await h.observer.flush();
  await h.observer.shutdown();

  expect(h.spans.map((span) => span.attributes["opencode.run.id"])).toEqual(["u1", "u2"]);
  expect(h.spans.map((span) => span.status.code)).toEqual([
    SpanStatusCode.UNSET,
    SpanStatusCode.UNSET,
  ]);
  expect(h.shutdown).toHaveBeenCalledTimes(1);
});

test("interaction spans use explicit run ancestry and keep completed and superseded output distinct", async () => {
  const h = setup({ spanNamePrefix: "custom." });

  h.observer.startRun(start());
  h.observer.startInteraction(interaction());
  h.observer.finishInteraction({ ...interaction(), endedAt: 1500, status: "superseded" });
  h.observer.startInteraction({
    ...interaction("u2"),
    startedAt: 1500,
    input: "steer",
    agentName: "review",
  });
  h.observer.finishInteraction({
    ...interaction("u2"),
    endedAt: 1800,
    status: "completed",
    output: "final",
  });
  h.observer.finishRun({ ...start(), endedAt: 2000, output: "final" });
  await h.observer.flush();

  expect(h.spans.map((span) => span.name)).toEqual([
    "custom.interaction",
    "custom.interaction",
    "custom.run",
  ]);
  const run = h.spans[2];

  expect(h.spans.slice(0, 2).map((span) => span.parentSpanContext?.spanId)).toEqual([
    run?.spanContext().spanId,
    run?.spanContext().spanId,
  ]);
  expect(new Set(h.spans.map((span) => span.spanContext().traceId)).size).toBe(1);
  expect(h.spans[0]).toMatchObject({
    kind: SpanKind.INTERNAL,
    startTime: [1, 0],
    endTime: [1, 500_000_000],
    status: { code: SpanStatusCode.UNSET },
  });
  expect(h.spans[0]?.attributes).toMatchObject({
    "session.id": "s1",
    "gen_ai.conversation.id": "s1",
    "opencode.interaction.id": "u1",
    "gen_ai.operation.name": "invoke_agent",
    "gen_ai.agent.name": "build",
    "gen_ai.output.messages": "[]",
  });
  expect(h.spans[1]?.attributes).toMatchObject({
    "gen_ai.agent.name": "review",
    "gen_ai.input.messages": '[{"role":"user","parts":[{"type":"text","content":"steer"}]}]',
    "gen_ai.output.messages": '[{"role":"assistant","parts":[{"type":"text","content":"final"}]}]',
  });
  expect(h.spans[1]?.endTime).toEqual([1, 800_000_000]);
  expect(h.spans[1]?.attributes["opencode.agent.type"]).toBeUndefined();
  expect(h.spans[1]?.attributes["opencode.session.parent_id"]).toBeUndefined();
});

test("interaction starts need a live exact parent and repeated starts or ends cannot rewrite spans", async () => {
  const h = setup();

  h.observer.startInteraction(interaction());
  await h.observer.flush();

  expect(h.spans).toHaveLength(0);

  h.observer.startRun(start());
  h.observer.startInteraction({ ...interaction(), agentName: "build" });
  h.observer.startInteraction({ ...interaction(), agentName: "review", input: "replacement" });
  h.observer.finishInteraction({
    ...interaction(),
    endedAt: 1500,
    status: "completed",
    output: "answer",
  });
  h.observer.startInteraction(interaction());
  h.observer.finishInteraction({
    ...interaction(),
    endedAt: 9000,
    status: "failed",
    error: { type: "late" },
  });
  h.observer.finishRun({ ...start(), endedAt: 2000, output: "answer" });
  h.observer.startInteraction(interaction("after-run"));
  await h.observer.flush();

  expect(h.spans).toHaveLength(2);
  expect(h.spans[0]?.attributes["gen_ai.agent.name"]).toBe("build");
  expect(h.spans[0]?.attributes["error.type"]).toBeUndefined();
  expect(h.spans[0]?.endTime).toEqual([1, 500_000_000]);
});

test.each([true, false])(
  "interaction content distinguishes unknown, known empty and superseded with capture=%s",
  async (captureContent) => {
    const h = setup({
      captureContent,
      spanAttributes: {
        "gen_ai.input.messages": "leak",
        "gen_ai.output.messages": "leak",
        "gen_ai.agent.name": "fake",
        "opencode.interaction.id": "fake",
        "opencode.agent.type": "subagent",
        "opencode.session.parent_id": "fake",
      },
    });

    h.observer.startRun(start());
    h.observer.startInteraction({ ...interaction("empty"), input: "" });
    h.observer.finishInteraction({
      ...interaction("empty"),
      endedAt: 1500,
      status: "completed",
      output: "",
    });
    h.observer.startInteraction({ ...interaction("unknown"), input: undefined });
    h.observer.finishInteraction({
      ...interaction("unknown"),
      endedAt: 1500,
      status: "completed",
      output: undefined,
    });
    h.observer.startInteraction(interaction("steer"));
    h.observer.finishInteraction({ ...interaction("steer"), endedAt: 1500, status: "superseded" });
    await h.observer.flush();

    expect(h.spans).toHaveLength(3);
    expect(h.spans[0]?.attributes["gen_ai.output.messages"]).toBe(
      captureContent ? '[{"role":"assistant","parts":[{"type":"text","content":""}]}]' : undefined,
    );
    expect(h.spans[0]?.attributes["gen_ai.input.messages"]).toBe(
      captureContent ? '[{"role":"user","parts":[{"type":"text","content":""}]}]' : undefined,
    );
    expect(h.spans[1]?.attributes["gen_ai.input.messages"]).toBeUndefined();
    expect(h.spans[1]?.attributes["gen_ai.output.messages"]).toBeUndefined();
    expect(h.spans[2]?.attributes["gen_ai.output.messages"]).toBe(
      captureContent ? "[]" : undefined,
    );
    expect(h.spans.map((span) => span.attributes["opencode.agent.type"])).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    expect(h.spans[0]?.attributes["gen_ai.agent.name"]).toBe("build");
    expect(h.spans[0]?.attributes["opencode.interaction.id"]).toBe("empty");
  },
);

test("finishing a parent cleans only its unfinished interactions without changing the parent result", async () => {
  const h = setup();

  h.observer.startRun(start("u1", "s1"));
  h.observer.startRun(start("u1", "s2"));
  h.observer.startInteraction(interaction("u1", start("u1", "s1")));
  h.observer.startInteraction(interaction("u1", start("u1", "s2")));
  h.observer.finishRun({ ...start(), endedAt: 2000, output: undefined });
  await h.observer.flush();

  expect(h.spans.map((span) => [span.name, span.status.code])).toEqual([
    ["opencode.interaction", SpanStatusCode.ERROR],
    ["opencode.run", SpanStatusCode.UNSET],
  ]);
  expect(h.spans[0]?.status.message).toBe("run ended before interaction completed");
  expect(h.spans.every((span) => span.attributes["session.id"] === "s1")).toBe(true);

  h.observer.finishInteraction({
    ...interaction("u1", start("u1", "s2")),
    endedAt: 2100,
    status: "completed",
    output: "answer",
  });
  h.observer.finishRun({ ...start("u1", "s2"), endedAt: 2200, output: "answer" });
  await h.observer.flush();

  expect(h.spans[2]?.status.code).toBe(SpanStatusCode.UNSET);
  expect(h.spans[2]?.parentSpanContext?.spanId).toBe(h.spans[3]?.spanContext().spanId);
  expect(h.spans[0]?.spanContext().traceId).not.toBe(h.spans[2]?.spanContext().traceId);
});

test("shutdown ends interactions before runs exactly once and stops later child recording", async () => {
  const h = setup();

  h.observer.startRun(start());
  h.observer.startInteraction(interaction());
  const closing = h.observer.shutdown();

  expect(h.observer.shutdown()).toBe(closing);

  h.observer.startInteraction(interaction("ignored"));
  h.observer.finishInteraction({
    ...interaction(),
    endedAt: 9000,
    status: "completed",
    output: "late",
  });
  await closing;

  expect(h.spans.map((span) => span.name)).toEqual(["opencode.interaction", "opencode.run"]);
  expect(h.spans.map((span) => span.status.code)).toEqual([
    SpanStatusCode.ERROR,
    SpanStatusCode.ERROR,
  ]);
  expect(h.spans.map((span) => span.endTime)).toEqual([
    [3, 0],
    [3, 0],
  ]);
  expect(h.spans[0]?.status.message).toBe("plugin disposed before interaction completed");
  expect(h.spans[0]?.attributes["gen_ai.output.messages"]).toBeUndefined();
  expect(h.shutdown).toHaveBeenCalledTimes(1);
});

test.each([false, true])(
  "OpenCode retry metadata exports without content and survives terminal failure=%s",
  async (failed) => {
    const h = setup({ captureContent: false });
    h.observer.startRun(start());
    h.observer.startInteraction(interaction());
    h.observer.startLlm(llm());
    h.observer.updateLlm({
      id: llm().id,
      interaction: llm().interaction,
      retries: [
        { attempt: 1, reason: "busy", scheduledAt: 1200, observedAt: 1250 },
        { attempt: 3, reason: "unavailable", observedAt: 1400 },
      ],
    });
    h.observer.updateLlm({ id: llm().id, interaction: llm().interaction, request: {} });
    h.observer.finishLlm({
      ...llm(),
      endedAt: 1500,
      fallbackOutputText: undefined,
      error: failed ? { type: "APIError" } : undefined,
    });
    await h.observer.flush();

    expect(h.spans[0]?.attributes["opencode.llm.retry_count"]).toBe(2);
    expect(JSON.parse(String(h.spans[0]?.attributes["opencode.llm.retry_history"]))).toEqual([
      { attempt: 1, reason: "busy", scheduled_start_offset_ms: 100, observed_start_offset_ms: 150 },
      { attempt: 3, reason: "unavailable", observed_start_offset_ms: 300 },
    ]);
    expect(h.spans[0]?.attributes["gen_ai.input.messages"]).toBeUndefined();
    expect(h.spans[0]?.attributes["gen_ai.response.time_to_first_chunk"]).toBeUndefined();
    expect(h.spans[0]?.status.code).toBe(failed ? SpanStatusCode.ERROR : SpanStatusCode.UNSET);
  },
);

test("LLM contract maps client spans, request parameters and successful usage under an interaction", async () => {
  const h = setup({ spanNamePrefix: "custom." });
  h.observer.startRun(start());
  h.observer.startInteraction(interaction());
  h.observer.startLlm({
    ...llm(),
    parameters: { temperature: 0, topP: 0.9, topK: 10, maxOutputTokens: 100 },
  });
  h.observer.startLlm({ ...llm(), model: "duplicate" });
  h.observer.finishLlm({
    ...llm(),
    endedAt: 1300,
    fallbackOutputText: "answer",
    finishReason: "stop",
    cost: 0,
    usage: {
      inputTokens: 13,
      outputTokens: 7,
      reasoningTokens: 3,
      cacheReadTokens: 2,
      cacheWriteTokens: 1,
    },
  });
  h.observer.finishLlm({
    ...llm(),
    endedAt: 9999,
    fallbackOutputText: "late",
    error: { type: "late" },
  });
  h.observer.startLlm(llm());
  h.observer.finishInteraction({
    ...interaction(),
    endedAt: 1800,
    status: "completed",
    output: "answer",
  });
  h.observer.finishRun({ ...start(), endedAt: 2000, output: "answer" });
  await h.observer.flush();

  expect(h.spans.map((span) => span.name)).toEqual([
    "custom.llm",
    "custom.interaction",
    "custom.run",
  ]);
  const span = h.spans[0];

  expect(span).toMatchObject({
    kind: SpanKind.CLIENT,
    startTime: [1, 100_000_000],
    endTime: [1, 300_000_000],
    status: { code: SpanStatusCode.UNSET },
  });
  expect(span?.parentSpanContext?.spanId).toBe(h.spans[1]?.spanContext().spanId);
  expect(span?.spanContext().traceId).toBe(h.spans[2]?.spanContext().traceId);
  expect(span?.attributes).toMatchObject({
    "session.id": "s1",
    "gen_ai.conversation.id": "s1",
    "opencode.message.id": "a1",
    "gen_ai.provider.name": "gcp.gemini",
    "opencode.provider.id": "custom-google",
    "gen_ai.operation.name": "generate_content",
    "gen_ai.request.model": "gemini",
    "gen_ai.request.stream": true,
    "gen_ai.agent.name": "build",
    "gen_ai.request.temperature": 0,
    "gen_ai.request.top_p": 0.9,
    "gen_ai.request.top_k": 10,
    "gen_ai.request.max_tokens": 100,
    "gen_ai.usage.input_tokens": 13,
    "gen_ai.usage.output_tokens": 7,
    "gen_ai.usage.reasoning.output_tokens": 3,
    "gen_ai.usage.cache_read.input_tokens": 2,
    "gen_ai.usage.cache_write.input_tokens": 1,
    "opencode.llm.cost.total": 0,
    "gen_ai.response.finish_reasons": ["stop"],
    "opencode.llm.retry_count": 0,
    "opencode.llm.retry_history": "[]",
    "gen_ai.input.messages": '[{"role":"user","parts":[{"type":"text","content":"question"}]}]',
    "gen_ai.output.messages": '[{"role":"assistant","parts":[{"type":"text","content":"answer"}]}]',
  });
  expect(span?.attributes["gen_ai.response.id"]).toBeUndefined();
  expect(span?.attributes["gen_ai.response.model"]).toBeUndefined();
  expect(span?.attributes["gen_ai.response.time_to_first_chunk"]).toBeUndefined();
  expect(span?.attributes["opencode.llm.end_time_source"]).toBeUndefined();
  expect(span?.attributes["opencode.compaction.id"]).toBeUndefined();
  expect(span?.attributes["opencode.agent.type"]).toBeUndefined();
});

test("LLM ancestry survives steer and unknown or mismatched identities cannot attach to another parent", async () => {
  const h = setup();
  h.observer.startLlm(llm("missing-run"));
  h.observer.startRun(start());
  h.observer.startLlm(llm("missing-interaction"));
  h.observer.startInteraction(interaction());
  h.observer.startLlm(llm());
  h.observer.finishInteraction({ ...interaction(), endedAt: 1500, status: "superseded" });
  h.observer.startInteraction({ ...interaction("u2"), startedAt: 1500 });
  h.observer.startLlm({ ...llm("late-start"), startedAt: 1600 });
  h.observer.finishLlm({
    ...llm("a1", interaction("u2")),
    endedAt: 1700,
    fallbackOutputText: "wrong owner",
  });
  h.observer.finishLlm({ ...llm(), endedAt: 1800, fallbackOutputText: "old answer" });
  h.observer.finishLlm({ ...llm("late-start"), endedAt: 1900, fallbackOutputText: undefined });
  h.observer.finishRun({ ...start(), endedAt: 2000, output: undefined });
  h.observer.startLlm(llm("closed-run"));
  await h.observer.flush();

  const parent = h.spans.find((span) => span.attributes["opencode.interaction.id"] === "u1");
  const calls = h.spans.filter((span) => span.name === "opencode.llm");

  expect(calls).toHaveLength(2);
  expect(calls.map((span) => span.parentSpanContext?.spanId)).toEqual([
    parent?.spanContext().spanId,
    parent?.spanContext().spanId,
  ]);
  expect(calls[0]?.endTime).toEqual([1, 800_000_000]);
  expect(calls[0]?.attributes["gen_ai.output.messages"]).toContain("old answer");
  expect(parent?.endTime).toEqual([1, 500_000_000]);
});

test.each([true, false])(
  "LLM capture=%s preserves unknown versus empty output and protects unsupported attributes",
  async (captureContent) => {
    const h = setup({
      captureContent,
      spanAttributes: {
        "gen_ai.response.id": "invented",
        "gen_ai.response.model": "invented",
        "gen_ai.response.time_to_first_chunk": "0",
        "gen_ai.system_instructions": "secret",
        "gen_ai.tool.definitions": "secret",
        "gen_ai.output.messages": "secret",
        "http.request.header.authorization": "secret",
        "opencode.llm.retry_count": "42",
        "app.tag": "kept",
      },
    });
    h.observer.startRun(start());
    h.observer.startInteraction(interaction());
    h.observer.startLlm(llm());
    h.observer.startLlm(llm("a2"));
    h.observer.finishLlm({ ...llm(), endedAt: 1200, fallbackOutputText: undefined });
    h.observer.finishLlm({ ...llm("a2"), endedAt: 1300, fallbackOutputText: "" });
    await h.observer.flush();

    expect(h.spans[0]?.attributes["gen_ai.output.messages"]).toBeUndefined();
    expect(h.spans[1]?.attributes["gen_ai.output.messages"]).toBe(
      captureContent ? '[{"role":"assistant","parts":[{"type":"text","content":""}]}]' : undefined,
    );
    expect(h.spans[0]?.attributes["gen_ai.input.messages"] !== undefined).toBe(captureContent);
    expect(h.spans[0]?.attributes["app.tag"]).toBe("kept");
    expect(h.spans[0]?.attributes["opencode.llm.retry_count"]).toBe(0);
    expect(JSON.stringify(h.spans.map((span) => span.attributes))).not.toMatch(/secret|invented/);
    expect(h.spans[0]?.attributes["gen_ai.usage.input_tokens"]).toBeUndefined();
  },
);

test.each([true, false])(
  "LLM request settings enforce content=%s and snapshot exported headers",
  async (captureContent) => {
    const h = setup({ captureContent });
    const request = {
      outputType: "json" as const,
      toolDefinitions: [{ type: "function", name: "read", parameters: { type: "object" } }],
      headers: { "x-request": ["one,two"] },
    };
    const responseHeaders = { "set-cookie": ["first=1", "second=2"] };
    h.observer.startRun(start());
    h.observer.startInteraction(interaction());
    h.observer.startLlm(llm());

    if (!captureContent) {
      ["toolDefinitions", "headers"].forEach((key) => {
        Object.defineProperty(request, key, {
          get() {
            throw new Error("content must not be read");
          },
        });
      });
    }

    h.observer.updateLlm({ ...llm(), input: undefined, request });
    h.observer.updateLlm({ ...llm(), input: undefined, responseHeaders });
    responseHeaders["set-cookie"].push("later=3");
    h.observer.finishLlm({ ...llm(), endedAt: 1500, fallbackOutputText: undefined });
    await h.observer.flush();

    const attributes = h.spans[0]!.attributes;
    expect(attributes["gen_ai.output.type"]).toBe("json");
    expect(attributes["gen_ai.tool.definitions"]).toBe(
      captureContent
        ? '[{"type":"function","name":"read","parameters":{"type":"object"}}]'
        : undefined,
    );
    expect(attributes["http.request.header.x-request"]).toEqual(
      captureContent ? ["one,two"] : undefined,
    );
    expect(attributes["http.response.header.set-cookie"]).toEqual(
      captureContent ? ["first=1", "second=2"] : undefined,
    );
    expect(attributes["gen_ai.request.seed"]).toBeUndefined();
  },
);

test("new request snapshots clear stale tools, output types and both header directions", async () => {
  const h = setup();
  h.observer.startRun(start());
  h.observer.startInteraction(interaction());
  h.observer.startLlm(llm());
  h.observer.updateLlm({
    ...llm(),
    input: undefined,
    request: {
      outputType: "json",
      toolDefinitions: [{ type: "function", name: "old" }],
      headers: { old: ["request"] },
    },
  });
  h.observer.updateLlm({ ...llm(), input: undefined, responseHeaders: { old: ["response"] } });
  h.observer.updateLlm({
    ...llm(),
    input: undefined,
    request: { toolDefinitions: [], headers: {} },
  });
  h.observer.finishLlm({
    ...llm(),
    endedAt: 1500,
    fallbackOutputText: undefined,
    error: { type: "APIError" },
    responseHeaders: { "x-error": ["terminal"] },
  });
  await h.observer.flush();

  const attributes = h.spans[0]!.attributes;
  expect(attributes["gen_ai.output.type"]).toBeUndefined();
  expect(attributes["gen_ai.tool.definitions"]).toBe("[]");
  expect(attributes["http.request.header.old"]).toBeUndefined();
  expect(attributes["http.response.header.old"]).toBeUndefined();
  expect(attributes["http.response.header.x-error"]).toEqual(["terminal"]);
});

test("LLM failures omit time source and successful usage, and cleanup stays scoped", async () => {
  const h = setup();
  h.observer.startRun(start());
  h.observer.startInteraction(interaction());
  h.observer.startLlm(llm());
  h.observer.startLlm(llm("unfinished"));
  h.observer.startRun(start("u1", "s2"));
  h.observer.startInteraction(interaction("u1", start("u1", "s2")));
  h.observer.startLlm(llm("a1", interaction("u1", start("u1", "s2"))));
  h.observer.finishLlm({
    ...llm(),
    endedAt: 1200,
    fallbackOutputText: undefined,
    error: { type: "APIError", message: "failed" },
    cost: 99,
    usage: { inputTokens: 99 },
  });
  h.observer.finishRun({ ...start(), endedAt: 2000, output: undefined });
  await h.observer.flush();

  const calls = h.spans.filter((span) => span.name === "opencode.llm");

  expect(calls).toHaveLength(2);
  expect(calls[0]?.status).toEqual({ code: SpanStatusCode.ERROR, message: "failed" });
  expect(calls[0]?.attributes["error.type"]).toBe("APIError");
  expect(calls[0]?.attributes["gen_ai.response.finish_reasons"]).toEqual(["error"]);
  expect(calls[0]?.attributes["gen_ai.usage.input_tokens"]).toBeUndefined();
  expect(calls[0]?.attributes["opencode.llm.cost.total"]).toBeUndefined();
  expect(calls[0]?.attributes["opencode.llm.end_time_source"]).toBeUndefined();
  expect(calls[0]?.endTime).toEqual([1, 200_000_000]);
  expect(calls[1]?.status.message).toBe("session ended before message completed");
  expect(calls[1]?.attributes["opencode.llm.end_time_source"]).toBeUndefined();
  expect(calls[1]?.endTime).toEqual([2, 0]);
  expect(h.spans.find((span) => span.name === "opencode.run")?.status.code).toBe(
    SpanStatusCode.UNSET,
  );

  h.observer.finishLlm({
    ...llm("a1", interaction("u1", start("u1", "s2"))),
    endedAt: 2500,
    fallbackOutputText: "isolated",
  });
  await h.observer.flush();

  expect(h.spans.at(-1)?.attributes["session.id"]).toBe("s2");
  expect(h.spans.at(-1)?.status.code).toBe(SpanStatusCode.UNSET);
});

test("shutdown ends LLMs before interactions and runs and rejects all late model recording", async () => {
  const h = setup();
  h.observer.startRun(start());
  h.observer.startInteraction(interaction());
  h.observer.startLlm(llm());

  const closing = h.observer.shutdown();
  expect(h.observer.shutdown()).toBe(closing);
  h.observer.startLlm(llm("late"));
  h.observer.finishLlm({ ...llm(), endedAt: 9999, fallbackOutputText: "late" });
  await closing;

  expect(h.spans.map((span) => span.name)).toEqual([
    "opencode.llm",
    "opencode.interaction",
    "opencode.run",
  ]);
  expect(h.spans.map((span) => span.status.code)).toEqual([
    SpanStatusCode.ERROR,
    SpanStatusCode.ERROR,
    SpanStatusCode.ERROR,
  ]);
  expect(h.spans.map((span) => span.endTime)).toEqual([
    [3, 0],
    [3, 0],
    [3, 0],
  ]);
  expect(h.spans[0]?.attributes["gen_ai.response.finish_reasons"]).toEqual(["error"]);
  expect(h.spans[0]?.attributes["opencode.llm.end_time_source"]).toBeUndefined();
  expect(h.shutdown).toHaveBeenCalledTimes(1);
});
