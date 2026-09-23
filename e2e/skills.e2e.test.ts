import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { withE2EFixture } from "./support/fixture.js";
import { expectError, expectUnset, oneSpan, requireSpans } from "./support/assertions.js";

async function writeSkill(directory: string, content = "Observer skill instructions.") {
  const skillDirectory = path.join(directory, ".config/opencode/skills/observer-review");
  await mkdir(skillDirectory, { recursive: true });
  await Bun.write(
    path.join(skillDirectory, "SKILL.md"),
    `---\nname: observer-review\ndescription: Review the fixture.\n---\n${content}\n`,
  );
  return skillDirectory;
}

test.each([
  { captureContent: false, truncated: false },
  { captureContent: true, truncated: false },
  { captureContent: true, truncated: true },
])("skill loading exports independent spans with %j", (options) =>
  withE2EFixture(
    {
      pluginOptions: { captureContent: options.captureContent },
      replies: [
        { type: "tool", name: "skill", input: { name: "observer-review" } },
        { type: "text", text: "skill loaded" },
      ],
    },
    async (fixture) => {
      const directory = await writeSkill(
        fixture.directory,
        options.truncated ? "Observer skill instructions.\n".repeat(2200) : undefined,
      );
      const result = await fixture.run("load the observer-review skill", [
        "--dangerously-skip-permissions",
      ]);
      const spans = requireSpans(fixture, result, 5);
      const skill = oneSpan(spans, "e2e.skill.load");
      expectUnset(skill);
      expect(skill.kind).toBe(1);
      expect(skill.parentSpanId).toBe(oneSpan(spans, "e2e.interaction").spanId);
      expect(spans.some((span) => span.name === "e2e.tool.skill")).toBe(false);
      expect(skill.attributes).toMatchObject({
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.tool.name": "skill",
        "opencode.skill.name": "observer-review",
        "ai.agent.skill.name": "observer-review",
        "opencode.skill.directory": directory,
        "opencode.skill.output.truncated": options.truncated,
      });
      expect(skill.attributes["gen_ai.tool.call.id"]).toBeString();
      expect(skill.attributes["opencode.skill.trigger"]).toBeUndefined();
      expect(skill.attributes["gen_ai.tool.call.arguments"]).toBeUndefined();
      expect(skill.attributes["gen_ai.tool.description"]).toBeUndefined();
      expect(skill.attributes["gen_ai.tool.call.result"]).toBeUndefined();

      const messages = fixture.llm.mainHits()[1]!.body.messages as {
        role: string;
        tool_call_id?: string;
        content?: unknown;
      }[];
      const response = messages.find(
        (message) =>
          message.role === "tool" &&
          message.tool_call_id === skill.attributes["gen_ai.tool.call.id"],
      );
      expect(response?.content).toBeString();
      expect(String(response?.content)).toContain("Observer skill instructions.");
      expect(skill.attributes["opencode.skill.output"]).toBe(
        options.captureContent ? response?.content : undefined,
      );
      if (!options.captureContent) {
        expect(JSON.stringify(fixture.otlp.payloads)).not.toContain("Observer skill instructions.");
      }
    },
  ),
);

test("missing skills retain their requested name and report failure while the run recovers", () =>
  withE2EFixture(
    {
      pluginOptions: { captureContent: false },
      replies: [
        { type: "tool", name: "skill", input: { name: "missing-observer-skill" } },
        { type: "text", text: "skill unavailable" },
      ],
    },
    async (fixture) => {
      const result = await fixture.run("load the missing skill", [
        "--dangerously-skip-permissions",
      ]);
      const spans = requireSpans(fixture, result, 5);
      const skill = oneSpan(spans, "e2e.skill.load");
      expectError(skill, "ExecutionError");
      expect(skill.attributes["opencode.skill.name"]).toBe("missing-observer-skill");
      expect(skill.attributes["ai.agent.skill.name"]).toBe("missing-observer-skill");
      expect(skill.attributes["opencode.skill.directory"]).toBeUndefined();
      expect(skill.attributes["opencode.skill.output"]).toBeUndefined();
      spans.filter((span) => span !== skill).forEach(expectUnset);
    },
  ));

test("skill permission rejection is parented to the load span without capturing content", () =>
  withE2EFixture(
    {
      permission: { skill: "ask" },
      pluginOptions: { captureContent: false },
      replies: [{ type: "tool", name: "skill", input: { name: "observer-review" } }],
    },
    async (fixture) => {
      await writeSkill(fixture.directory);
      const result = await fixture.run("request permission to load observer-review");
      const spans = requireSpans(fixture, result, 5);
      const skill = oneSpan(spans, "e2e.skill.load");
      const permission = oneSpan(spans, "e2e.permission.check");
      expectError(skill, "PermissionRejectedError");
      expectUnset(permission);
      expect(permission.parentSpanId).toBe(skill.spanId);
      expect(permission.attributes).toMatchObject({
        "opencode.permission.tool.call.id": skill.attributes["gen_ai.tool.call.id"],
        "opencode.permission.tool.name": "skill",
        "opencode.permission.name": "skill",
        "opencode.permission.granted": false,
        "opencode.permission.reply": "reject",
      });
      expect(permission.attributes["gen_ai.operation.name"]).toBeUndefined();
      expect(permission.attributes["gen_ai.tool.call.id"]).toBeUndefined();
      expect(permission.attributes["gen_ai.tool.name"]).toBeUndefined();
      expect(skill.attributes["opencode.skill.name"]).toBe("observer-review");
      expect(skill.attributes["ai.agent.skill.name"]).toBe("observer-review");
      expect(skill.attributes["opencode.skill.output"]).toBeUndefined();
      expect(spans.some((span) => span.name === "e2e.tool.skill")).toBe(false);
    },
  ));
