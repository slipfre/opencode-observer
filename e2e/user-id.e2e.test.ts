import { expect, test } from "bun:test";
import { expectUnset, oneSpan, requireSpans } from "./support/assertions.js";
import { withE2EFixture } from "./support/fixture.js";

function startIdentityServer(status = 200, delayMs = 0, userID: string | null = " e2e-user ") {
  const requests: Array<{ method: string; path: string; auth: string | null; body: unknown }> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      requests.push({
        method: request.method,
        path: new URL(request.url).pathname,
        auth: request.headers.get("X-Blackbox-Auth"),
        body: await request.json(),
      });

      if (delayMs > 0) {
        await Bun.sleep(delayMs);
      }

      return Response.json({ code: 0, result: { ssicNo: userID } }, { status });
    },
  });

  return {
    env: {
      OPENCODE_USER_ID_ENDPOINT: new URL("/queryUserByToken", server.url).toString(),
      "OPENCODE_USER_ID_X-Blackbox-Auth": "identity-auth-secret",
      OPENCODE_USER_ID_RETRY_COUNT: "0",
    },
    requests,
    [Symbol.dispose]: () => server.stop(true),
  };
}

test("OpenCode sends resolved identity in tracestate without changing the exported span context", async () => {
  using identity = startIdentityServer(200, 100);

  await withE2EFixture(
    {
      env: identity.env,
      pluginOptions: { spanAttributes: { team: "identity" } },
      replies: [
        {
          type: "tool",
          name: "bash",
          input: { command: "echo identity-test", description: "Print deterministic output" },
        },
        { type: "text", text: "identity resolved" },
      ],
    },
    async (fixture) => {
      const result = await fixture.run("use the bash tool", ["--dangerously-skip-permissions"]);
      const spans = requireSpans(fixture, result, 5, 0, "e2e-user");

      expect(identity.requests).toEqual([
        {
          method: "POST",
          path: "/queryUserByToken",
          auth: "identity-auth-secret",
          body: { token: "e2e-local-key" },
        },
      ]);
      expect(oneSpan(spans, "e2e.tool.bash").attributes["user.id"]).toBe("e2e-user");
      expect(spans.filter((span) => span.name === "e2e.llm").at(-1)?.attributes["user.id"]).toBe(
        "e2e-user",
      );
      spans.forEach((span) => {
        expectUnset(span);
        expect(span.attributes["user.id"]).toBe("e2e-user");
        expect(span.attributes.team).toBe("identity");
        expect(span.attributes["gen_ai.input.messages"]).toBeUndefined();
        expect(span.resource["user.id"]).toBeUndefined();
      });
      expect(JSON.stringify(fixture.otlp.payloads)).not.toContain("e2e-local-key");
      expect(JSON.stringify(fixture.otlp.payloads)).not.toContain("identity-auth-secret");
      expect(result.stdout).toContain("identity resolved");
      spans.forEach((span) => expect(span.traceState).toBeUndefined());
      fixture.llm.hits.forEach((hit) => {
        expect(hit.headers.get("tracestate") ?? "").not.toContain("e2e-local-key");
        expect(JSON.stringify(Object.fromEntries(hit.headers))).not.toContain(
          "identity-auth-secret",
        );
      });
    },
  );
});

test.each([
  { name: "identity disabled", enabled: true, userIDEnabled: "false", status: 200, requests: 0 },
  {
    name: "identity disabled with zero",
    enabled: true,
    userIDEnabled: "0",
    status: 200,
    requests: 0,
  },
  { name: "telemetry disabled", enabled: false, userIDEnabled: "true", status: 200, requests: 0 },
  {
    name: "token missing",
    enabled: true,
    userIDEnabled: "true",
    status: 200,
    requests: 0,
    token: "",
  },
  {
    name: "endpoint invalid",
    enabled: true,
    userIDEnabled: "true",
    status: 200,
    requests: 0,
    endpoint: "not-a-url",
  },
  {
    name: "identity missing",
    enabled: true,
    userIDEnabled: "true",
    status: 200,
    requests: 1,
    resultUserID: null,
  },
  {
    name: "identity empty",
    enabled: true,
    userIDEnabled: "true",
    status: 200,
    requests: 1,
    resultUserID: "",
  },
  { name: "identity unavailable", enabled: true, userIDEnabled: "true", status: 503, requests: 1 },
  {
    name: "identity retries exhausted",
    enabled: true,
    userIDEnabled: "true",
    status: 503,
    requests: 2,
    retryCount: "1",
  },
  {
    name: "identity timed out",
    enabled: true,
    userIDEnabled: "true",
    status: 200,
    requests: 1,
    delayMs: 500,
  },
])("OpenCode applies the identity fallback when $name", async (input) => {
  using identity = startIdentityServer(input.status, input.delayMs, input.resultUserID);

  await withE2EFixture(
    {
      env: {
        ...identity.env,
        ...(input.endpoint === undefined ? {} : { OPENCODE_USER_ID_ENDPOINT: input.endpoint }),
        OPENCODE_USER_ID_ENABLED: input.userIDEnabled,
        OPENCODE_USER_ID_TIMEOUT: input.delayMs ? "50" : "3000",
        OPENCODE_USER_ID_RETRY_COUNT: input.retryCount ?? "0",
      },
      pluginOptions: { enabled: input.enabled },
      provider: { test: { options: { apiKey: input.token ?? "e2e-local-key" } } },
      replies: [{ type: "text", text: "continued without identity" }],
    },
    async (fixture) => {
      const result = await fixture.run("answer the question");
      const spans = requireSpans(
        fixture,
        result,
        input.enabled ? 3 : 0,
        0,
        ["false", "0"].includes(input.userIDEnabled) ? false : "unknown",
      );

      expect(identity.requests).toHaveLength(input.requests);
      spans.forEach((span) => {
        expectUnset(span);
        expect(span.attributes["user.id"]).toBe(input.requests ? "unknown" : undefined);
        expect(span.resource["user.id"]).toBeUndefined();
        expect(span.traceState).toBeUndefined();
      });
      expect(result.stdout).toContain("continued without identity");
    },
  );
});

test("OpenCode resolves identity from the first configured API key instead of the active model provider", async () => {
  using identity = startIdentityServer();

  await withE2EFixture(
    {
      env: { ...identity.env, OPENCODE_USER_ID_TOKEN: "ignored-legacy-token" },
      provider: {
        empty: { options: { apiKey: "  " } },
        identity: { options: { apiKey: " first-provider-key " } },
      },
      replies: [{ type: "text", text: "provider identity resolved" }],
    },
    async (fixture) => {
      const result = await fixture.run("answer the question");
      const spans = requireSpans(fixture, result, 3, 0, "e2e-user");

      expect(identity.requests.map((request) => request.body)).toEqual([
        { token: "first-provider-key" },
      ]);
      spans.forEach((span) => expect(span.attributes["user.id"]).toBe("e2e-user"));
      expect(JSON.stringify(fixture.otlp.payloads)).not.toContain("first-provider-key");
      expect(JSON.stringify(fixture.otlp.payloads)).not.toContain("ignored-legacy-token");
      expect(result.stdout).toContain("provider identity resolved");
    },
  );
});

test.each(
  ["options", "environment"].flatMap((source) => [200, 503].map((status) => ({ source, status }))),
)(
  "OpenCode prioritizes static span user.id from $source when identity lookup returns $status",
  async (input) => {
    using identity = startIdentityServer(input.status);

    await withE2EFixture(
      {
        env: {
          ...identity.env,
          OPENCODE_SPAN_ATTRIBUTES: "user.id=environment-user,team=environment",
        },
        // The fixture supplies spanAttributes by default; omit it for the environment case.
        pluginOptions: {
          spanAttributes:
            input.source === "options" ? { "user.id": "options-user", team: "options" } : undefined,
        },
        replies: [{ type: "text", text: "configured identity" }],
      },
      async (fixture) => {
        const result = await fixture.run("answer the question");
        const spans = requireSpans(
          fixture,
          result,
          3,
          0,
          input.status === 200 ? "e2e-user" : "unknown",
        );

        expect(identity.requests).toHaveLength(1);
        spans.forEach((span) => {
          expectUnset(span);
          expect(span.attributes["user.id"]).toBe(`${input.source}-user`);
          expect(span.attributes.team).toBe(input.source);
          expect(span.resource["user.id"]).toBeUndefined();
        });
        expect(result.stdout).toContain("configured identity");
      },
    );
  },
);
