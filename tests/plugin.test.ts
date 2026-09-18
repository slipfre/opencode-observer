import { $, type Server } from "bun";
import { afterEach, expect, test } from "bun:test";
import type { Hooks, PluginInput } from "@opencode-ai/plugin";
import { createOpencodeClient, type AssistantMessage, type UserMessage } from "@opencode-ai/sdk";
import type { OpenCodeEvent } from "../src/adapter/opencode/coordinator.js";
import { ObserverPlugin } from "../src/index.js";
import { loadConfig } from "../src/config.js";
import { createTelemetry } from "../src/telemetry/factory.js";
import { streamText, jsonSchema } from "ai";
import { MockLanguageModelV3, convertArrayToReadableStream } from "ai/test";
import { name, version } from "../package.json";

type Attribute = {
  key: string;
  value: {
    stringValue?: string;
    intValue?: string | number;
    doubleValue?: number;
    boolValue?: boolean;
  };
};
type ExportedSpan = {
  name: string;
  spanId: string;
  traceId: string;
  traceState?: string;
  parentSpanId?: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Attribute[];
  kind: number;
  status: { code?: number };
};
type ExportPayload = {
  resourceSpans: {
    resource: { attributes: Attribute[] };
    scopeSpans: { scope: { name: string; version: string }; spans: ExportedSpan[] }[];
  }[];
};

const servers: Server<undefined>[] = [];
const hooks: Hooks[] = [];

afterEach(async () => {
  await Promise.all(hooks.splice(0).map((hook) => hook.dispose?.()));
  await Promise.all(servers.splice(0).map((server) => server.stop(true)));
});

function pluginInput(server: Server<undefined>): PluginInput {
  return {
    client: createOpencodeClient({ baseUrl: server.url.toString() }),
    project: { id: "project", worktree: "/test", time: { created: 1000 } },
    directory: "/test",
    worktree: "/test",
    serverUrl: server.url,
    $,
    experimental_workspace: {
      register() {
        throw new Error("Workspace registration is not used by tracing");
      },
    },
  };
}

test("tool, permission and compaction with summary LLM export through plugin events as one trace", async () => {
  const payloads: ExportPayload[] = [];
  const paths: string[] = [];
  const exporting = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      paths.push(new URL(request.url).pathname);

      if (new URL(request.url).pathname === "/global/health") {
        return Response.json({ healthy: true, version: "1.18.30" });
      }

      payloads.push((await request.json()) as ExportPayload);
      exporting.resolve();
      await release.promise;
      return Response.json({});
    },
  });
  servers.push(server);
  const hook = await ObserverPlugin(pluginInput(server), {
    enabled: true,
    captureContent: true,
    endpoint: new URL("/v1/traces", server.url).toString(),
  });
  hooks.push(hook);
  const user: UserMessage = {
    id: "u1",
    sessionID: "s1",
    role: "user",
    time: { created: 1000 },
    agent: "build",
    model: { providerID: "test", modelID: "test" },
  };
  const assistant: AssistantMessage = {
    id: "a1",
    parentID: "u1",
    sessionID: "s1",
    role: "assistant",
    mode: "build",
    modelID: "test",
    providerID: "test",
    path: { cwd: "/test", root: "/test" },
    time: { created: 1100 },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  };
  await hook["chat.message"]?.(
    { sessionID: "s1" },
    {
      message: user,
      parts: [{ id: "question", messageID: "u1", sessionID: "s1", type: "text", text: "question" }],
    },
  );
  const events: OpenCodeEvent[] = [
    { type: "message.updated", properties: { info: assistant } },
    {
      type: "message.part.updated",
      properties: {
        part: {
          type: "tool",
          id: "tool-part",
          sessionID: "s1",
          messageID: "a1",
          callID: "read1",
          tool: "read",
          state: { status: "running", input: { path: "file" }, time: { start: 1200 } },
        },
      },
    },
    {
      type: "permission.asked",
      properties: {
        id: "p1",
        sessionID: "s1",
        permission: "read",
        patterns: ["file"],
        always: [],
        metadata: {},
        tool: { messageID: "a1", callID: "read1" },
      },
    },
    { type: "permission.replied", properties: { sessionID: "s1", requestID: "p1", reply: "once" } },
    {
      type: "message.part.updated",
      properties: {
        part: {
          type: "tool",
          id: "tool-part",
          sessionID: "s1",
          messageID: "a1",
          callID: "read1",
          tool: "read",
          state: {
            status: "completed",
            input: { path: "file" },
            time: { start: 1200, end: 1400 },
            title: "read",
            metadata: {},
            output: "contents",
          },
        },
      },
    },
    {
      type: "message.updated",
      properties: { info: { ...user, id: "c1", time: { created: 1500 } } },
    },
    {
      type: "message.part.updated",
      properties: {
        part: { type: "compaction", id: "marker", sessionID: "s1", messageID: "c1", auto: true },
      },
    },
    {
      type: "message.updated",
      properties: {
        info: {
          ...assistant,
          id: "summary",
          parentID: "c1",
          mode: "compaction",
          summary: true,
          time: { created: 1600 },
        },
      },
    },
    {
      type: "message.part.updated",
      properties: {
        part: { type: "step-start", id: "step-start", sessionID: "s1", messageID: "summary" },
      },
    },
    {
      type: "message.part.updated",
      properties: {
        part: {
          type: "step-finish",
          id: "step-finish",
          sessionID: "s1",
          messageID: "summary",
          reason: "stop",
          cost: 0,
          tokens: { input: 10, output: 4, reasoning: 0, cache: { read: 2, write: 3 } },
        },
      },
    },
    {
      type: "message.updated",
      properties: {
        info: {
          ...assistant,
          id: "summary",
          parentID: "c1",
          mode: "compaction",
          summary: true,
          time: { created: 1600, completed: 1700 },
          tokens: { input: 10, output: 4, reasoning: 0, cache: { read: 2, write: 3 } },
        },
      },
    },
    { type: "session.compacted", properties: { sessionID: "s1" } },
    {
      type: "message.updated",
      properties: {
        info: {
          ...assistant,
          id: "final",
          time: { created: 1800, completed: 1900 },
          finish: "stop",
        },
      },
    },
    {
      type: "message.part.updated",
      properties: {
        part: {
          type: "text",
          id: "final-text",
          sessionID: "s1",
          messageID: "final",
          text: "answer",
        },
      },
    },
  ];

  for (const event of events) {
    // The plugin's root SDK declaration still uses the legacy permission event shape.
    await hook.event?.({ event: event as Parameters<NonNullable<Hooks["event"]>>[0]["event"] });
  }

  async function lateInputs() {
    const info = {
      id: "s1",
      projectID: "project",
      directory: "/test",
      title: "late session",
      version: "1",
      parentID: "late-parent",
      time: { created: 900, updated: 3000 },
    };

    for (const type of ["session.created", "session.updated"] as const) {
      await hook.event?.({ event: { type, properties: { info } } });
    }

    await hook["chat.message"]?.(
      { sessionID: "s1" },
      {
        message: { ...user, id: "late-user", time: { created: 3000 } },
        parts: [
          { id: "late-text", messageID: "late-user", sessionID: "s1", type: "text", text: "late" },
        ],
      },
    );

    for (const event of events) {
      await hook.event?.({ event: event as Parameters<NonNullable<Hooks["event"]>>[0]["event"] });
    }

    await hook.event?.({
      event: {
        type: "session.error",
        properties: {
          sessionID: "s1",
          error: { name: "UnknownError", data: { message: "late error" } },
        },
      },
    });
    await hook.event?.({ event: { type: "session.deleted", properties: { info } } });
  }

  const idle = hook.event?.({ event: { type: "session.idle", properties: { sessionID: "s1" } } });
  await exporting.promise;
  const exported = structuredClone(payloads);
  const disposal = hook.dispose?.();
  const late = lateInputs();
  release.resolve();
  await Promise.all([idle, disposal, late]);
  await lateInputs();

  expect(payloads).toEqual(exported);
  const spans = payloads.flatMap((payload) =>
    payload.resourceSpans.flatMap((resource) =>
      resource.scopeSpans.flatMap((scope) => scope.spans),
    ),
  );
  const byName = new Map(spans.map((span) => [span.name, span]));
  const attributes = (name: string) =>
    Object.fromEntries(
      (byName.get(name)?.attributes ?? []).map((attribute) => [
        attribute.key,
        attribute.value.stringValue ??
          attribute.value.intValue ??
          attribute.value.doubleValue ??
          attribute.value.boolValue,
      ]),
    );

  expect(spans).toHaveLength(6);
  expect(new Set(spans.map((span) => span.traceId)).size).toBe(1);
  expect(byName.get("opencode.permission.check")?.parentSpanId).toBe(
    byName.get("opencode.tool.read")?.spanId,
  );
  expect(byName.get("opencode.tool.read")?.parentSpanId).toBe(
    byName.get("opencode.interaction")?.spanId,
  );
  expect(byName.get("opencode.compaction")?.parentSpanId).toBe(
    byName.get("opencode.interaction")?.spanId,
  );
  expect(byName.get("opencode.llm")?.parentSpanId).toBe(byName.get("opencode.compaction")?.spanId);
  expect(attributes("opencode.permission.check")["opencode.permission.granted"]).toBe(true);
  expect(attributes("opencode.tool.read")["gen_ai.tool.call.result"]).toBe(
    '{"content":"contents"}',
  );
  expect(attributes("opencode.llm")["opencode.compaction.id"]).toBe("c1");
  expect(Number(attributes("opencode.compaction")["opencode.compaction.prompt_tokens"])).toBe(15);
  expect(paths).toEqual(["/global/health", "/v1/traces"]);
  const resources = payloads.flatMap((payload) => payload.resourceSpans);
  expect(resources.length).toBeGreaterThan(0);
  resources.forEach((resource) => {
    expect(resource.resource.attributes).toContainEqual({
      key: "service.name",
      value: { stringValue: "opencode" },
    });
    expect(resource.resource.attributes).toContainEqual({
      key: "service.version",
      value: { stringValue: "1.18.30" },
    });
    resource.scopeSpans.forEach((scope) => expect(scope.scope).toEqual({ name, version }));
  });
});

test("AI SDK history and generated tool calls reach OTLP through the plugin", async () => {
  const payloads: ExportPayload[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname === "/v1/traces") {
        payloads.push((await request.json()) as ExportPayload);
      }
      return Response.json({});
    },
  });
  servers.push(server);
  const hook = await ObserverPlugin(pluginInput(server), {
    enabled: true,
    captureContent: true,
    endpoint: server.url.toString(),
  });
  hooks.push(hook);
  const user = {
    id: "u1",
    sessionID: "s1",
    role: "user" as const,
    agent: "build",
    model: { providerID: "test", modelID: "test" },
    time: { created: Date.now() },
  };
  await hook["chat.message"]?.(
    { sessionID: "s1" },
    {
      message: user,
      parts: [
        { id: "user-text", sessionID: "s1", messageID: "u1", type: "text", text: "owner input" },
      ],
    },
  );
  await hook.event?.({
    event: {
      type: "message.updated",
      properties: {
        info: {
          id: "a1",
          sessionID: "s1",
          parentID: "u1",
          role: "assistant",
          time: { created: Date.now() },
          modelID: "test",
          providerID: "test",
          mode: "build",
          path: { cwd: "/test", root: "/test" },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      },
    },
  });
  const output = { headers: {} };
  await hook["chat.headers"]?.(
    {
      sessionID: "s1",
      agent: "build",
      message: user,
      model: { id: "test", providerID: "test" } as Parameters<
        NonNullable<Hooks["chat.headers"]>
      >[0]["model"],
      provider: {} as Parameters<NonNullable<Hooks["chat.headers"]>>[0]["provider"],
    },
    output,
  );
  const model = new MockLanguageModelV3({
    doStream: async () => ({
      stream: convertArrayToReadableStream([
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "text" },
        { type: "text-delta", id: "text", delta: "checking" },
        { type: "text-end", id: "text" },
        { type: "tool-call", toolCallId: "read2", toolName: "read", input: '{"path":"b.ts"}' },
        {
          type: "finish",
          finishReason: { unified: "tool-calls", raw: "tool_calls" },
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 1, text: 1, reasoning: 0 },
          },
        },
      ]),
    }),
  });

  const response = streamText({
    model,
    headers: { ...output.headers },
    system: "model system",
    messages: [
      { role: "user", content: "model history" },
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "read1", toolName: "read", input: { path: "a.ts" } },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "read1",
            toolName: "read",
            output: { type: "text", value: "file contents" },
          },
        ],
      },
    ],
    tools: {
      read: {
        inputSchema: jsonSchema({
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        }),
      },
    },
    experimental_telemetry: { functionId: "session.llm", metadata: { sessionId: "s1" } },
  });
  await response.consumeStream();
  await hook.event?.({
    event: {
      type: "message.part.updated",
      properties: {
        part: { id: "step-start", sessionID: "s1", messageID: "a1", type: "step-start" },
      },
    },
  });
  await hook.event?.({
    event: {
      type: "message.part.updated",
      properties: {
        part: { id: "text", sessionID: "s1", messageID: "a1", type: "text", text: "fallback text" },
      },
    },
  });
  await hook.event?.({
    event: {
      type: "message.part.updated",
      properties: {
        part: {
          id: "step-finish",
          sessionID: "s1",
          messageID: "a1",
          type: "step-finish",
          reason: "tool-calls",
          cost: 0,
          tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      },
    },
  });
  await hook.dispose?.();

  const span = payloads
    .flatMap((payload) =>
      payload.resourceSpans.flatMap((resource) =>
        resource.scopeSpans.flatMap((scope) => scope.spans),
      ),
    )
    .find((span) => span.name === "opencode.llm");
  const attrs = Object.fromEntries(
    span?.attributes.map((attribute) => [attribute.key, attribute.value.stringValue]) ?? [],
  );
  expect(JSON.parse(attrs["gen_ai.input.messages"] ?? "null")).toEqual([
    { role: "user", parts: [{ type: "text", content: "model history" }] },
    {
      role: "assistant",
      parts: [{ type: "tool_call", id: "read1", name: "read", arguments: { path: "a.ts" } }],
    },
    {
      role: "tool",
      parts: [{ type: "tool_call_response", id: "read1", response: "file contents" }],
    },
  ]);
  expect(JSON.parse(attrs["gen_ai.output.messages"] ?? "null")).toEqual([
    {
      role: "assistant",
      parts: [
        { type: "text", content: "checking" },
        { type: "tool_call", id: "read2", name: "read", arguments: { path: "b.ts" } },
      ],
    },
  ]);
  expect(attrs["gen_ai.system_instructions"]).toBe('[{"type":"text","content":"model system"}]');
  expect(JSON.stringify(attrs)).not.toContain("fallback text");
  expect(model.doStreamCalls[0]?.headers?.["x-opencode-observer-request"]).toBeUndefined();
});

test("plugin exports run, interaction and LLM in a new trace without querying sessions", async () => {
  const payloads: ExportPayload[] = [];
  const requests: string[] = [];
  const headers: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      requests.push(path);

      if (path === "/global/health") {
        return Response.json({ healthy: true, version: "1.18.30" });
      }

      if (path === "/v1/traces") {
        headers.push(request.headers.get("x-test") ?? "");
        payloads.push((await request.json()) as ExportPayload);
        return Response.json({});
      }

      return Response.json(null);
    },
  });
  servers.push(server);

  const hook = await ObserverPlugin(pluginInput(server), {
    enabled: true,
    captureContent: true,
    endpoint: server.url.toString(),
    otlpHeaders: { "x-test": "present" },
    resourceAttributes: { "service.name": "test-opencode", "service.version": "custom-version" },
  });
  hooks.push(hook);

  const created = 1_789_000_000_000;
  const start = hook["chat.message"]?.(
    { sessionID: "s1" },
    {
      message: {
        id: "u1",
        sessionID: "s1",
        role: "user",
        time: { created },
        agent: "build",
        model: { providerID: "test", modelID: "test" },
      },
      parts: [{ id: "u1-text", messageID: "u1", sessionID: "s1", type: "text", text: "question" }],
    },
  );

  // Dispatch subsequent events without awaiting the chat hook, as OpenCode's event bridge can do.
  const observedBefore = Date.now();
  const llmStart = hook.event?.({
    event: {
      type: "message.part.updated",
      properties: {
        part: { id: "step-start", messageID: "a1", sessionID: "s1", type: "step-start" },
      },
    },
  });
  const part = hook.event?.({
    event: {
      type: "message.part.updated",
      properties: {
        part: {
          id: "a1-text",
          messageID: "a1",
          sessionID: "s1",
          type: "text",
          text: "answer",
        },
      },
    },
  });
  const llmFinish = hook.event?.({
    event: {
      type: "message.part.updated",
      properties: {
        part: {
          id: "step-finish",
          messageID: "a1",
          sessionID: "s1",
          type: "step-finish",
          reason: "stop",
          cost: 0.02,
          tokens: { input: 10, output: 4, reasoning: 3, cache: { read: 2, write: 1 } },
        },
      },
    },
  });
  const observedAfter = Date.now();
  const message = hook.event?.({
    event: {
      type: "message.updated",
      properties: {
        info: {
          id: "a1",
          parentID: "u1",
          sessionID: "s1",
          role: "assistant",
          time: { created: created + 100, completed: created + 200 },
          modelID: "test",
          providerID: "test",
          mode: "build",
          path: { cwd: "/test", root: "/test" },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          finish: "stop",
        },
      },
    },
  });
  const idle = hook.event?.({
    event: { type: "session.status", properties: { sessionID: "s1", status: { type: "idle" } } },
  });

  await Promise.all([start, llmStart, part, llmFinish, message, idle]);

  await hook.event?.({ event: { type: "session.idle", properties: { sessionID: "s1" } } });
  await hook.dispose?.();

  expect(payloads).toHaveLength(1);
  expect(requests).toEqual(["/global/health", "/v1/traces"]);
  expect(headers).toEqual(["present"]);

  const resource = payloads[0]?.resourceSpans[0];

  expect(resource?.resource.attributes).toContainEqual({
    key: "service.name",
    value: { stringValue: "test-opencode" },
  });
  expect(resource?.resource.attributes).toContainEqual({
    key: "service.version",
    value: { stringValue: "custom-version" },
  });

  const scope = resource?.scopeSpans[0];

  expect(scope?.scope).toEqual({ name, version });
  expect(scope?.spans).toHaveLength(3);

  const span = scope?.spans.find((item) => item.name === "opencode.run");
  const interaction = scope?.spans.find((item) => item.name === "opencode.interaction");
  const llm = scope?.spans.find((item) => item.name === "opencode.llm");

  expect(span).toMatchObject({
    name: "opencode.run",
    kind: 1,
  });
  expect(span?.parentSpanId).toBeUndefined();
  expect(span?.traceId).toMatch(/^[0-9a-f]{32}$/);
  expect(span?.startTimeUnixNano).toBe(String(BigInt(created) * 1_000_000n));

  const attrs = Object.fromEntries(
    span?.attributes.map((attribute) => [attribute.key, attribute.value.stringValue]) ?? [],
  );

  expect(attrs).toMatchObject({
    "session.id": "s1",
    "gen_ai.conversation.id": "s1",
    "opencode.run.id": "u1",
  });
  expect(attrs["opencode.session.parent_id"]).toBeUndefined();
  expect(attrs["gen_ai.output.messages"]).toContain("answer");
  expect(span?.status.code ?? 0).toBe(0);
  expect(interaction).toMatchObject({
    traceId: span?.traceId,
    parentSpanId: span?.spanId,
    kind: 1,
  });
  expect(interaction?.startTimeUnixNano).toBe(String(BigInt(created) * 1_000_000n));
  expect(interaction?.endTimeUnixNano).toBe(span?.endTimeUnixNano);
  expect(interaction?.status.code ?? 0).toBe(0);
  expect(
    Object.fromEntries(
      interaction?.attributes.map((attribute) => [attribute.key, attribute.value.stringValue]) ??
        [],
    ),
  ).toMatchObject({
    "opencode.interaction.id": "u1",
    "gen_ai.agent.name": "build",
    "gen_ai.operation.name": "invoke_agent",
    "gen_ai.input.messages": '[{"role":"user","parts":[{"type":"text","content":"question"}]}]',
    "gen_ai.output.messages": '[{"role":"assistant","parts":[{"type":"text","content":"answer"}]}]',
  });
  expect(llm).toMatchObject({ traceId: span?.traceId, parentSpanId: interaction?.spanId, kind: 3 });
  expect(llm?.status.code ?? 0).toBe(0);
  expect(BigInt(llm?.startTimeUnixNano ?? "0")).toBeGreaterThanOrEqual(
    BigInt(observedBefore) * 1_000_000n,
  );
  expect(BigInt(llm?.endTimeUnixNano ?? "0")).toBeLessThanOrEqual(
    BigInt(observedAfter) * 1_000_000n,
  );
  expect(
    Object.fromEntries(
      llm?.attributes.map((attribute) => [attribute.key, attribute.value.stringValue]) ?? [],
    ),
  ).toMatchObject({
    "gen_ai.operation.name": "chat",
    "gen_ai.provider.name": "test",
    "opencode.message.id": "a1",
    "gen_ai.input.messages": '[{"role":"user","parts":[{"type":"text","content":"question"}]}]',
    "gen_ai.output.messages": '[{"role":"assistant","parts":[{"type":"text","content":"answer"}]}]',
  });
  expect(
    Number(
      llm?.attributes.find((attribute) => attribute.key === "gen_ai.usage.input_tokens")?.value
        .intValue,
    ),
  ).toBe(13);
  expect(
    Number(
      llm?.attributes.find((attribute) => attribute.key === "gen_ai.usage.output_tokens")?.value
        .intValue,
    ),
  ).toBe(7);
});

test("idle and disposal await a slow collector while chat hooks remain independent", async () => {
  const payloads: ExportPayload[] = [];
  const exporting = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname === "/v1/traces") {
        payloads.push((await request.json()) as ExportPayload);
        exporting.resolve();
        await release.promise;
        return Response.json({});
      }

      return Response.json({ id: "s1" });
    },
  });
  servers.push(server);

  const hook = await ObserverPlugin(pluginInput(server), {
    enabled: true,
    endpoint: server.url.toString(),
  });
  hooks.push(hook);

  const message = (id: string) =>
    hook["chat.message"]?.(
      { sessionID: "s1" },
      {
        message: {
          id,
          sessionID: "s1",
          role: "user",
          time: { created: Date.now() },
          agent: "build",
          model: { providerID: "test", modelID: "test" },
        },
        parts: [
          { id: `${id}-text`, messageID: id, sessionID: "s1", type: "text", text: "question" },
        ],
      },
    );

  await message("u1");
  const settled = { idle: false, late: false, complete: false, repeated: false };
  const idle = hook
    .event?.({ event: { type: "session.idle", properties: { sessionID: "s1" } } })
    .then(() => {
      settled.idle = true;
    });
  await exporting.promise;

  const timeout = setTimeout(() => release.resolve(), 500);
  const before = performance.now();
  await message("u2");
  const elapsed = performance.now() - before;

  expect(hook.dispose).toBeFunction();
  const disposal = hook.dispose?.().then(() => {
    settled.complete = true;
  });
  const repeated = hook.dispose?.().then(() => {
    settled.repeated = true;
  });
  await message("ignored");
  const late = hook
    .event?.({ event: { type: "session.idle", properties: { sessionID: "s1" } } })
    .then(() => {
      settled.late = true;
    });

  expect(settled).toEqual({ idle: false, late: false, complete: false, repeated: false });
  clearTimeout(timeout);
  release.resolve();
  await Promise.all([idle, disposal, repeated, late]);

  const spans = payloads.flatMap((payload) =>
    payload.resourceSpans.flatMap((resource) =>
      resource.scopeSpans.flatMap((scope) => scope.spans),
    ),
  );

  expect(settled).toEqual({ idle: true, late: true, complete: true, repeated: true });
  expect(elapsed).toBeLessThan(400);
  expect(spans.map((span) => [span.name, span.status.code ?? 0])).toEqual([
    ["opencode.interaction", 2],
    ["opencode.run", 0],
    ["opencode.interaction", 2],
    ["opencode.run", 2],
  ]);
  expect(
    spans
      .filter((span) => span.name === "opencode.run")
      .map(
        (span) =>
          span.attributes.find((attribute) => attribute.key === "opencode.run.id")?.value
            .stringValue,
      ),
  ).toEqual(["u1", "u2"]);
});

test.each([
  { label: "missing", body: {} },
  { label: "null", body: null },
  { label: "empty", body: { version: "  " } },
  { label: "invalid", body: { version: 123 } },
  { label: "HTTP error", body: { version: "untrusted" }, status: 503 },
  { label: "invalid JSON", body: "not JSON" },
  { label: "network error", body: undefined },
])("plugin still exports spans when the OpenCode version is $label", async (scenario) => {
  const payloads: ExportPayload[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      payloads.push((await request.json()) as ExportPayload);
      return Response.json({});
    },
  });
  servers.push(server);
  const input = pluginInput(server);
  input.client = createOpencodeClient({
    baseUrl: "http://opencode.invalid",
    fetch: async () => {
      if (scenario.body === undefined) {
        throw new Error("OpenCode health endpoint unavailable");
      }

      if (typeof scenario.body === "string") {
        return new Response(scenario.body, { headers: { "content-type": "application/json" } });
      }

      return Response.json(scenario.body, { status: scenario.status ?? 200 });
    },
  });
  const hook = await ObserverPlugin(input, { enabled: true, endpoint: server.url.toString() });
  hooks.push(hook);

  await hook["chat.message"]?.(
    { sessionID: "s1" },
    {
      message: {
        id: "u1",
        sessionID: "s1",
        role: "user",
        time: { created: Date.now() },
        agent: "build",
        model: { providerID: "test", modelID: "test" },
      },
      parts: [{ id: "u1-text", messageID: "u1", sessionID: "s1", type: "text", text: "question" }],
    },
  );
  await hook.dispose?.();

  expect(payloads).toHaveLength(1);
  payloads[0]?.resourceSpans.forEach((resource) => {
    expect(resource.resource.attributes).toContainEqual({
      key: "service.name",
      value: { stringValue: "opencode" },
    });
    expect(
      resource.resource.attributes.some((attribute) => attribute.key === "service.version"),
    ).toBe(false);
    resource.scopeSpans.forEach((scope) => {
      expect(scope.scope).toEqual({ name, version });
      expect(scope.spans.length).toBeGreaterThan(0);
    });
  });
});

test("disabled plugin installs no hooks, listeners, or network requests", async () => {
  const requests: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      requests.push(request.url);
      return Response.json(null);
    },
  });
  servers.push(server);

  const listeners = process.listenerCount("beforeExit");

  expect(await ObserverPlugin(pluginInput(server), { enabled: false })).toEqual({});
  expect(process.listenerCount("beforeExit")).toBe(listeners);
  expect(requests).toEqual([]);
});

test.each(["options", "environment"])(
  "removed %s trace context does not affect new runs",
  async (source) => {
    const payloads: ExportPayload[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        payloads.push((await request.json()) as ExportPayload);
        return Response.json({});
      },
    });
    servers.push(server);

    // An unsampled parent would suppress export if the removed configuration were still honored.
    const traceparent = "00-12345678901234567890123456789012-1234567890123456-00";
    const config = loadConfig(
      {
        enabled: true,
        endpoint: server.url.toString(),
        ...(source === "options" ? { traceparent, tracestate: "vendor=value" } : {}),
      },
      source === "environment"
        ? { OPENCODE_TRACEPARENT: traceparent, OPENCODE_TRACESTATE: "vendor=value" }
        : {},
    );

    if (!config.enabled) {
      throw new Error("Expected enabled telemetry");
    }

    const telemetry = createTelemetry(config);

    for (const id of ["u1", "u2"]) {
      telemetry.startRun({
        sessionID: "s1",
        id,
        startedAt: 1000,
        parent: undefined,
        parentSessionID: undefined,
      });
      telemetry.finishRun({ sessionID: "s1", id, endedAt: 2000, output: undefined });
    }
    await telemetry.shutdown();

    const spans = payloads.flatMap((payload) =>
      payload.resourceSpans.flatMap((resource) =>
        resource.scopeSpans.flatMap((scope) => scope.spans),
      ),
    );

    expect(config).not.toHaveProperty("traceparent");
    expect(config).not.toHaveProperty("tracestate");
    expect(spans).toHaveLength(2);
    expect(new Set(spans.map((span) => span.traceId)).size).toBe(2);
    spans.forEach((span) => {
      expect(span.traceId).not.toBe("12345678901234567890123456789012");
      expect(span.parentSpanId).toBeUndefined();
      expect(span.traceState).toBeUndefined();
    });
  },
);
