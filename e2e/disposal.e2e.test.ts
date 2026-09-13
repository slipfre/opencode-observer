import { expect, test } from "bun:test";
import path from "node:path";
import { expectUnset, requireSpans } from "./support/assertions.js";
import { withE2EFixture } from "./support/fixture.js";

test("OpenCode disposes observer subscriptions before process exit", () =>
  withE2EFixture(
    {
      pluginEntry: path.join(import.meta.dir, "support/disposal-plugin.ts"),
      pluginOptions: { captureContent: true },
      replies: [{ type: "text", text: "ready for disposal" }],
    },
    async (fixture) => {
      const result = await fixture.run("answer before disposing the instance");
      const spans = requireSpans(fixture, result, 3);
      const disposal = await Bun.file(
        path.join(fixture.directory, "observer-disposal.json"),
      ).json();

      expect(result.stdout).toContain("ready for disposal");
      spans.forEach(expectUnset);
      expect(disposal.installed).toEqual({
        captures: disposal.initial.captures + 1,
        exits: disposal.initial.exits + 1,
      });
      expect(disposal.before.captures).toBe(disposal.installed.captures);
      expect(disposal.after).toEqual({
        captures: disposal.before.captures - 1,
        exits: disposal.before.exits - 1,
      });
      expect(disposal.repeated).toEqual(disposal.after);
    },
  ));
