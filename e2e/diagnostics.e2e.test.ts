import { expect, test } from "bun:test";
import { withE2EFixture } from "./support/fixture.js";

test("an unreachable OTLP endpoint logs a warning while OpenCode completes normally", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({}) });
  const endpoint = server.url.toString();
  await server.stop(true);

  await withE2EFixture(
    {
      pluginOptions: { endpoint, otlpTimeoutMillis: 100, batchExportTimeoutMillis: 200 },
      replies: [{ type: "text", text: "completed despite unreachable collector" }],
    },
    async (fixture) => {
      const result = await fixture.run("complete with an unavailable collector");
      expect(result.exitCode).toBe(0);
      expect(fixture.llm.errors).toEqual([]);
      expect(fixture.llm.remainingReplyCount()).toBe(0);
      expect(fixture.otlp.errors).toEqual([]);
      expect(fixture.otlp.spans()).toEqual([]);
      expect(result.stdout).toContain("completed despite unreachable collector");
      expect(result.stderr).toContain("Observer plugin initialized");
      expect(result.stderr).toContain("OTLP endpoint TCP unreachable; exports may fail");
      expect(result.stderr).toContain("ECONNREFUSED");
      expect(result.stderr).not.toContain("OTLP endpoint TCP reachable");
      expect(fixture.llm.mainHits()).toHaveLength(1);
    },
  );
});
