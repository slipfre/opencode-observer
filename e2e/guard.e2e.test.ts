import { expect, test } from "bun:test";
import path from "node:path";
import { expectUnset, oneSpan, requireSpans } from "./support/assertions.js";
import { withE2EFixture } from "./support/fixture.js";

test.each(["throw", "reject"])(
  "OpenCode completes model and tool calls when observation fails and logging %s",
  (mode) =>
    withE2EFixture(
      {
        pluginEntry: path.join(import.meta.dir, "support/failing-plugin.ts"),
        pluginOptions: { captureContent: true, testLogFailure: mode },
        replies: [
          {
            type: "tool",
            name: "bash",
            input: { command: "echo guard-tool-completed", description: "Verify tool execution" },
          },
          { type: "text", text: "guard-model-completed" },
        ],
      },
      async (fixture) => {
        const result = await fixture.run("run the tool and answer", [
          "--dangerously-skip-permissions",
        ]);
        const spans = requireSpans(fixture, result, 5);

        expect(result.stdout).toContain("guard-model-completed");
        expect(result.stderr).toContain("observer fixture: parameter observation failed");
        expect(result.stderr).toContain("observer fixture: logging failed");
        expect(result.stderr).not.toMatch(/unhandled.*(?:rejection|promise)/i);
        expect(fixture.llm.mainHits()).toHaveLength(2);
        expect(oneSpan(spans, "e2e.tool.bash").attributes["gen_ai.tool.call.result"]).toContain(
          "guard-tool-completed",
        );
        spans.forEach(expectUnset);
      },
    ),
);
