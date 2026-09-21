type Usage = { input: number; output: number; cacheRead?: number; reasoning?: number };

export type LlmReply =
  | { type: "text"; text: string; reasoning?: string; usage?: Usage; tailDelayMs?: number }
  | {
      type: "tool";
      name: string;
      input: Record<string, unknown>;
      usage?: Usage;
      tailDelayMs?: number;
    }
  | { type: "error"; message: string; code: string; status?: number; retryAfterMs?: number };

function completionChunk(delta: Record<string, unknown>, finish?: string, usage?: Usage) {
  return {
    id: "chatcmpl-observer-e2e",
    object: "chat.completion.chunk",
    model: "test-response-model",
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
    isTitleRequest: boolean;
    receivedAt: number;
    finishedAt?: number;
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
      const isTitleRequest = JSON.stringify(body.messages).includes(
        "Generate a title for this conversation",
      );
      const hit = {
        body,
        headers: new Headers(request.headers),
        isTitleRequest,
        receivedAt,
        finishedAt: undefined as number | undefined,
      };
      hits.push(hit);
      const reply = isTitleRequest
        ? { type: "text" as const, text: "Observer E2E" }
        : pending.shift();

      if (!reply) {
        errors.push("Model reply queue exhausted");
        return Response.json({ error: { message: "No scripted response" } }, { status: 400 });
      }

      if (reply.type === "error") {
        hit.finishedAt = Date.now();
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
        completionChunk({ role: "assistant" }),
        ...(reply.type === "text"
          ? [
              ...(reply.reasoning ? [completionChunk({ reasoning_content: reply.reasoning })] : []),
              completionChunk({ content: reply.text }),
            ]
          : [
              completionChunk({
                tool_calls: [
                  {
                    index: 0,
                    id: `call_observer_${hits.length}`,
                    type: "function",
                    function: { name: reply.name, arguments: "" },
                  },
                ],
              }),
              completionChunk({
                tool_calls: [{ index: 0, function: { arguments: JSON.stringify(reply.input) } }],
              }),
            ]),
        completionChunk({}, reply.type === "text" ? "stop" : "tool_calls", reply.usage),
      ];
      const bodyChunks = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`);
      const tailDelayMs = "tailDelayMs" in reply ? reply.tailDelayMs : undefined;
      if (!tailDelayMs) {
        hit.finishedAt = Date.now();
      }

      return new Response(
        tailDelayMs
          ? new ReadableStream<Uint8Array>({
              async start(controller) {
                const encoder = new TextEncoder();
                controller.enqueue(encoder.encode(bodyChunks.slice(0, -1).join("")));
                await Bun.sleep(tailDelayMs);
                hit.finishedAt = Date.now();
                controller.enqueue(encoder.encode(bodyChunks.at(-1) + "data: [DONE]\n\n"));
                controller.close();
              },
            })
          : bodyChunks.join("") + "data: [DONE]\n\n",
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
    remainingReplyCount: () => pending.length,
    mainHits: () => hits.filter((hit) => !hit.isTitleRequest),
    [Symbol.dispose]: () => server.stop(true),
  };
}
