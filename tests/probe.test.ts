import { expect, spyOn, test } from "bun:test";
import { Socket } from "node:net";
import { probeEndpoint } from "../src/telemetry/probe.js";

test.each(["localhost:4317", "not a URL", "ftp://localhost", "file:///tmp/collector"])(
  "probe rejects invalid endpoint %s without connecting",
  async (endpoint) => {
    using connect = spyOn(Socket.prototype, "connect");

    expect(await probeEndpoint(endpoint)).toEqual({
      ok: false,
      ms: 0,
      error: "Invalid OTLP endpoint URL",
    });
    expect(connect).not.toHaveBeenCalled();
  },
);

test.each([
  { endpoint: "http://collector.test/v1/traces", host: "collector.test", port: 80 },
  { endpoint: "https://collector.test/v1/traces", host: "collector.test", port: 443 },
  { endpoint: "http://[::1]:4317", host: "::1", port: 4317 },
])("probe connects to $host:$port and closes its socket", async (scenario) => {
  using connect = spyOn(Socket.prototype, "connect").mockImplementation(function (this: Socket) {
    queueMicrotask(() => this.emit("connect"));
    return this;
  });

  const result = await probeEndpoint(scenario.endpoint);

  expect(result.ok).toBe(true);
  expect(result.ms).toBeGreaterThanOrEqual(0);
  expect(connect).toHaveBeenCalledWith({ host: scenario.host, port: scenario.port });
  expect(connect.mock.results[0]?.value).toMatchObject({ destroyed: true });
});

test("probe checks a listening TCP port without sending HTTP or trace data", async () => {
  const requests: string[] = [];
  using server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      requests.push(request.url);
      return Response.json({});
    },
  });

  expect((await probeEndpoint(server.url.toString())).ok).toBe(true);
  expect(requests).toEqual([]);
});

test("probe reports connection refusal", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({}) });
  const endpoint = server.url.toString();
  await server.stop(true);

  const result = await probeEndpoint(endpoint);

  expect(result.ok).toBe(false);
  expect(result.ms).toBeGreaterThanOrEqual(0);
  expect(result.error).toContain("ECONNREFUSED");
});

test("probe cleans up after a synchronous socket failure", async () => {
  const sockets: Socket[] = [];
  using connect = spyOn(Socket.prototype, "connect").mockImplementation(function (this: Socket) {
    sockets.push(this);
    throw new Error("Cannot open socket");
  });

  expect(await probeEndpoint("http://collector.test:4318")).toMatchObject({
    ok: false,
    error: "Cannot open socket",
  });
  expect(connect).toHaveBeenCalledTimes(1);
  expect(sockets[0]?.destroyed).toBe(true);
});

test.each([false, true])(
  "probe cancellation closes its socket, already cancelled=%s",
  async (before) => {
    using connect = spyOn(Socket.prototype, "connect").mockImplementation(function (this: Socket) {
      return this;
    });
    const controller = new AbortController();
    if (before) {
      controller.abort();
    }

    const probing = probeEndpoint("http://collector.test:4318", controller.signal);
    controller.abort();
    const result = await probing;

    expect(result.ok).toBe(false);
    expect(result.error).toBe("TCP probe cancelled");
    expect(connect).toHaveBeenCalledTimes(before ? 0 : 1);
    if (!before) {
      expect(connect.mock.results[0]?.value).toMatchObject({ destroyed: true });
    }
  },
);

test("probe bounds pending DNS and connection establishment to five seconds", async () => {
  // Keep the test process active while the probe's own deadline is intentionally unref'ed.
  using server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({}) });
  using connect = spyOn(Socket.prototype, "connect").mockImplementation(function (this: Socket) {
    return this;
  });

  const result = await probeEndpoint(server.url.toString());

  expect(result.ok).toBe(false);
  expect(result.error).toBe("TCP probe timed out after 5000 ms");
  expect(result.ms).toBeGreaterThanOrEqual(4900);
  expect(connect.mock.results[0]?.value).toMatchObject({ destroyed: true });
}, 10_000);
