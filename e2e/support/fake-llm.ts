type Usage = { input: number; output: number; cacheRead?: number; reasoning?: number };

export type LlmReply =
  | { type: "text"; text: string; reasoning?: string; usage?: Usage }
  | { type: "tool"; name: string; input: Record<string, unknown>; usage?: Usage }
  | { type: "error"; message: string; code: string; status?: number; retryAfterMs?: number };

function completion(delta: Record<string, unknown>, finish?: string, usage?: Usage) {
  return {
    id: "chatcmpl-observer-e2e",
    object: "chat.completion.chunk",
    model: "test-model",
    choices: [{ index: 0, delta, finish_reason: finish ?? null }],
    ...(usage
      ? {
          usage: {
            prompt_tokens: usage.input,
            completion_tokens: usage.output,
            total_tokens: usage.input + usage.output,
            prompt_tokens_details: { cached_tokens: usage.cacheRead ?? 0 },
            completion_tokens_details: { reasoning_tokens: usage.reasoning ?? 0 },
          },
        }
      : {}),
  };
}

export function startFakeLlm(replies: LlmReply[]) {
  const pending = [...replies];
  const hits: Array<{
    body: Record<string, unknown>;
    headers: Headers;
    title: boolean;
    receivedAt: number;
  }> = [];
  const errors: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const receivedAt = Date.now();
      if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/chat/completions") {
        errors.push(`Unexpected model route: ${request.method} ${request.url}`);
        return new Response("Not found", { status: 404 });
      }

      const body = (await request.json()) as Record<string, unknown>;
      const title = JSON.stringify(body.messages).includes(
        "Generate a title for this conversation",
      );
      hits.push({ body, headers: new Headers(request.headers), title, receivedAt });
      const reply = title ? { type: "text" as const, text: "Observer E2E" } : pending.shift();

      if (!reply) {
        errors.push("Model reply queue exhausted");
        return Response.json({ error: { message: "No scripted response" } }, { status: 400 });
      }

      if (reply.type === "error") {
        return Response.json(
          { error: { message: reply.message, code: reply.code, type: "invalid_request_error" } },
          {
            status: reply.status ?? 400,
            headers: {
              "retry-after-ms": String(reply.retryAfterMs ?? 10),
              "x-observer-response": "error-response",
            },
          },
        );
      }

      const chunks = [
        completion({ role: "assistant" }),
        ...(reply.type === "text"
          ? [
              ...(reply.reasoning ? [completion({ reasoning_content: reply.reasoning })] : []),
              completion({ content: reply.text }),
            ]
          : [
              completion({
                tool_calls: [
                  {
                    index: 0,
                    id: `call_observer_${hits.length}`,
                    type: "function",
                    function: { name: reply.name, arguments: "" },
                  },
                ],
              }),
              completion({
                tool_calls: [{ index: 0, function: { arguments: JSON.stringify(reply.input) } }],
              }),
            ]),
        completion({}, reply.type === "text" ? "stop" : "tool_calls", reply.usage),
      ];

      return new Response(
        chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n",
        {
          headers: {
            "content-type": "text/event-stream",
            "x-observer-response": "success-one,two",
          },
        },
      );
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}/v1`,
    hits,
    errors,
    pending: () => pending.length,
    mainHits: () => hits.filter((hit) => !hit.title),
    [Symbol.dispose]: () => server.stop(true),
  };
}
