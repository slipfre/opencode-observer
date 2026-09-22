import { expect, test } from "bun:test";
import { startOtlpReceiver } from "../e2e/support/otlp-receiver.js";
import { loadConfig } from "../src/config.js";
import { createTelemetry } from "../src/telemetry/factory.js";

test.each(["http/json", "http/protobuf", "grpc"])(
  "OTLP %s exports a span and collector headers through the selected transport",
  async (otlpProtocol) => {
    using receiver = await startOtlpReceiver(0, otlpProtocol);
    const config = loadConfig(
      {
        enabled: true,
        otlpProtocol,
        endpoint: receiver.endpoint,
        otlpHeaders: { authorization: "Bearer local-test-token" },
      },
      {},
    );
    if (!config.enabled) {
      throw new Error("Expected enabled telemetry");
    }

    const observer = await createTelemetry(config);
    try {
      observer.startRun({
        sessionID: "s1",
        id: "u1",
        startedAt: 1000,
        parentTool: undefined,
        parentSessionID: undefined,
      });
      observer.finishRun({ sessionID: "s1", id: "u1", endedAt: 2000, output: undefined });
      await observer.flush();

      expect(receiver.errors).toEqual([]);
      expect(receiver.spans()).toMatchObject([
        {
          name: "opencode.run",
          startTimeUnixNano: "1000000000",
          endTimeUnixNano: "2000000000",
          attributes: { "session.id": "s1" },
        },
      ]);
      expect(receiver.spans()[0]!.traceId).toMatch(/^[0-9a-f]{32}$/);
      expect(receiver.headers).toHaveLength(1);
      expect(receiver.headers[0]!.get("authorization")).toBe("Bearer local-test-token");
    } finally {
      await observer.shutdown();
    }
  },
);

test.each([
  { option: "otlpTimeoutMillis", error: "Request timed out" },
  { option: "batchExportTimeoutMillis", error: "Timeout" },
  { option: "forceFlushTimeoutMillis", error: "timeout period of 100 ms" },
])("$option controls its SDK timeout boundary", async (scenario) => {
  const requests: unknown[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      requests.push(await request.json());
      await Bun.sleep(500);
      return Response.json({});
    },
  });
  const config = loadConfig(
    {
      enabled: true,
      endpoint: server.url.toString(),
      otlpTimeoutMillis: 2000,
      batchExportTimeoutMillis: 2000,
      forceFlushTimeoutMillis: 2000,
      [scenario.option]: 100,
    },
    {},
  );
  if (!config.enabled) {
    throw new Error("Expected enabled telemetry");
  }

  const observer = await createTelemetry(config);
  try {
    observer.startRun({
      sessionID: "s1",
      id: "u1",
      startedAt: 1000,
      parentTool: undefined,
      parentSessionID: undefined,
    });
    observer.finishRun({ sessionID: "s1", id: "u1", endedAt: 2000, output: undefined });
    const error = await observer.flush().then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(requests).toHaveLength(1);
    expect(error).toEqual([
      expect.objectContaining({ message: expect.stringContaining(scenario.error) }),
    ]);
  } finally {
    await observer.shutdown().catch(() => undefined);
    await server.stop(true);
  }
});

test("configured export budget permits retrying the same batch after a temporary failure", async () => {
  const requests: unknown[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      requests.push(await request.json());
      return Response.json({}, { status: requests.length === 1 ? 503 : 200 });
    },
  });
  const config = loadConfig(
    { enabled: true, endpoint: server.url.toString(), otlpTimeoutMillis: 2000 },
    {},
  );
  if (!config.enabled) {
    throw new Error("Expected enabled telemetry");
  }

  const observer = await createTelemetry(config);
  try {
    observer.startRun({
      sessionID: "s1",
      id: "u1",
      startedAt: 1000,
      parentTool: undefined,
      parentSessionID: undefined,
    });
    observer.finishRun({ sessionID: "s1", id: "u1", endedAt: 2000, output: undefined });
    await observer.flush();

    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
  } finally {
    await observer.shutdown().catch(() => undefined);
    await server.stop(true);
  }
});
