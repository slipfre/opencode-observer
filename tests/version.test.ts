import { expect, test } from "bun:test";
import { createOpencodeClient } from "@opencode-ai/sdk";
import { getOpenCodeVersion } from "../src/adapter/opencode/version.js";

test("reads the running OpenCode version using the client transport and authentication", async () => {
  const requests: Request[] = [];
  const client = createOpencodeClient({
    baseUrl: "http://opencode.invalid",
    headers: { authorization: "Basic test-auth" },
    fetch: async (request) => {
      requests.push(request as Request);
      return Response.json({ healthy: true, version: " 1.18.30-dev.123 " });
    },
  });

  expect(await getOpenCodeVersion(client)).toBe("1.18.30-dev.123");
  expect(requests).toHaveLength(1);
  expect(requests[0]?.url).toBe("http://opencode.invalid/global/health");
  expect(requests[0]?.method).toBe("GET");
  expect(requests[0]?.headers.get("authorization")).toBe("Basic test-auth");
});

test("aborts version lookup when the OpenCode health endpoint does not respond", async () => {
  const requests: Request[] = [];
  const client = createOpencodeClient({
    baseUrl: "http://opencode.invalid",
    fetch: async (request) => {
      requests.push(request as Request);

      // In-process transports may ignore abort signals; lookup must still finish.
      return new Promise<Response>(() => {});
    },
  });

  expect(await getOpenCodeVersion(client)).toBeUndefined();
  expect(requests[0]?.signal.aborted).toBe(true);
});
