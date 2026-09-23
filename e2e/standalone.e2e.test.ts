import { expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { name, version } from "../package.json";
import { expectUnset, messages, oneSpan, requireSpans } from "./support/assertions.js";
import { withE2EFixture } from "./support/fixture.js";

test.each(
  (["project", "global"] as const).flatMap((scope) =>
    (["http/json", "http/protobuf", "grpc"] as const).map((protocol) => ({ scope, protocol })),
  ),
)("loads the standalone plugin from $scope plugins and exports $protocol", ({ scope, protocol }) =>
  withE2EFixture(
    {
      standalone: scope,
      otlpProtocol: protocol,
      env: {
        OPENCODE_ENABLE_TELEMETRY: "true",
        OPENCODE_CAPTURE_CONTENT: "true",
        OPENCODE_OTLP_PROTOCOL: protocol,
        OPENCODE_OTLP_HEADERS: "x-e2e-collector=standalone-test",
      },
      replies: [{ type: "text", text: "hello from standalone", usage: { input: 11, output: 7 } }],
    },
    async (fixture) => {
      const directory = path.join(
        fixture.directory,
        scope === "project" ? ".opencode" : ".config/opencode",
      );
      expect(await readdir(path.join(directory, "plugins"))).toEqual(["opencode-observer.js"]);
      expect(await readdir(path.join(directory, "node_modules"))).toEqual([]);

      const result = await fixture.run("say hello from the standalone plugin");
      const spans = requireSpans(fixture, result, 3);
      const run = oneSpan(spans, "e2e.run");
      const interaction = oneSpan(spans, "e2e.interaction");
      const llm = oneSpan(spans, "e2e.llm");

      expect(result.stdout).toContain("hello from standalone");
      expect(result.stderr).toContain("Observer plugin initialized");
      expect(await readdir(path.join(directory, "node_modules"))).toEqual([]);
      expect(run.parentSpanId ?? "").toBe("");
      expect(interaction.parentSpanId).toBe(run.spanId);
      expect(llm.parentSpanId).toBe(interaction.spanId);
      spans.forEach((span) => {
        expect(span.traceId).toBe(run.traceId);
        expect(span.scope).toEqual({ name, version });
        expectUnset(span);
      });
      // SDK callbacks must remain shared with the host when the AI SDK is bundled.
      expect(llm.attributes).toMatchObject({
        "gen_ai.output.type": "text",
        "gen_ai.response.model": "test-response-model",
        "gen_ai.usage.input_tokens": 11,
        "gen_ai.usage.output_tokens": 7,
      });
      expect(messages(llm, "input")).toContainEqual({
        role: "user",
        parts: [{ type: "text", content: "say hello from the standalone plugin" }],
      });
      expect(messages(llm, "output")).toEqual([
        { role: "assistant", parts: [{ type: "text", content: "hello from standalone" }] },
      ]);
      expect(JSON.parse(String(llm.attributes["gen_ai.tool.definitions"]))).toContainEqual(
        expect.objectContaining({ name: "read", parameters: expect.any(Object) }),
      );
      expect(fixture.otlp.headers.length).toBeGreaterThan(0);
      fixture.otlp.headers.forEach((headers) =>
        expect(headers.get("x-e2e-collector")).toBe("standalone-test"),
      );
    },
  ),
);

test("standalone plugins keep telemetry disabled by default", () =>
  withE2EFixture(
    {
      standalone: "global",
      replies: [{ type: "text", text: "telemetry is disabled" }],
    },
    async (fixture) => {
      const result = await fixture.run("say hello without telemetry");

      requireSpans(fixture, result, 0);
      expect(result.stdout).toContain("telemetry is disabled");
      expect(result.stderr).not.toContain("Observer plugin initialized");
      expect(fixture.otlp.headers).toEqual([]);
    },
  ));

test("standalone plugins keep content disabled by default", () =>
  withE2EFixture(
    {
      standalone: "global",
      env: { OPENCODE_ENABLE_TELEMETRY: "true" },
      replies: [{ type: "text", text: "private standalone response" }],
    },
    async (fixture) => {
      const result = await fixture.run("private standalone prompt");
      const spans = requireSpans(fixture, result, 3);

      expect(oneSpan(spans, "e2e.llm").attributes["gen_ai.output.type"]).toBe("text");
      spans.forEach((span) => {
        expect(span.attributes["gen_ai.input.messages"]).toBeUndefined();
        expect(span.attributes["gen_ai.output.messages"]).toBeUndefined();
        expect(span.attributes["gen_ai.tool.definitions"]).toBeUndefined();
      });
      expect(JSON.stringify(fixture.otlp.payloads)).not.toContain("private standalone");
    },
  ));
