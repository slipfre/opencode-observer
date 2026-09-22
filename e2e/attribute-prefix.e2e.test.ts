import { expect, test } from "bun:test";
import { expectUnset, oneSpan, requireSpans } from "./support/assertions.js";
import { withE2EFixture } from "./support/fixture.js";

test.each([
  { attributePrefix: "app.", useOption: true },
  { attributePrefix: "", useOption: false },
])("exports only built-in attributes with a configurable prefix: %j", (scenario) =>
  withE2EFixture(
    {
      env: {
        OPENCODE_ATTRIBUTE_PREFIX: scenario.useOption ? "ignored." : scenario.attributePrefix,
      },
      pluginOptions: {
        ...(scenario.useOption ? { attributePrefix: scenario.attributePrefix } : {}),
        resourceAttributes: { "opencode.resource.tag": "resource", "app.resource.tag": "custom" },
        spanAttributes: {
          "opencode.custom.tag": "opencode.literal-value",
          "app.custom.tag": "custom",
          "opencode.skill.output": "forged-content",
          [`${scenario.attributePrefix}skill.output`]: "forged-content",
          [`${scenario.attributePrefix}run.id`]: "forged-id",
          [`${scenario.attributePrefix}llm.retry_count`]: "42",
        },
      },
      replies: [{ type: "text", text: "prefix works", usage: { input: 5, output: 2 } }],
    },
    async (fixture) => {
      const result = await fixture.run("check the attribute prefix");
      const spans = requireSpans(fixture, result, 3);
      const run = oneSpan(spans, "e2e.run");
      const interaction = oneSpan(spans, "e2e.interaction");
      const llm = oneSpan(spans, "e2e.llm");

      expect(run.attributes[`${scenario.attributePrefix}run.id`]).toBeString();
      expect(run.attributes[`${scenario.attributePrefix}run.id`]).not.toBe("forged-id");
      expect(interaction.attributes[`${scenario.attributePrefix}interaction.id`]).toBe(
        run.attributes[`${scenario.attributePrefix}run.id`],
      );
      expect(llm.attributes[`${scenario.attributePrefix}message.id`]).toBeString();
      expect(llm.attributes).toMatchObject({
        [`${scenario.attributePrefix}agent.type`]: "primary",
        [`${scenario.attributePrefix}llm.retry_count`]: 0,
        [`${scenario.attributePrefix}llm.timing.source`]: "message",
        "gen_ai.operation.name": "chat",
        "gen_ai.usage.input_tokens": 5,
        "gen_ai.usage.output_tokens": 2,
      });
      expect(interaction.parentSpanId).toBe(run.spanId);
      expect(llm.parentSpanId).toBe(interaction.spanId);
      spans.forEach((span) => {
        expectUnset(span);
        expect(span.attributes["opencode.custom.tag"]).toBe("opencode.literal-value");
        expect(span.attributes["app.custom.tag"]).toBe("custom");
        expect(Object.keys(span.attributes).filter((key) => key.startsWith("opencode."))).toEqual([
          "opencode.custom.tag",
        ]);
        expect(Object.keys(span.attributes).some((key) => key.startsWith("ignored."))).toBe(false);
        expect(span.resource["opencode.resource.tag"]).toBe("resource");
        expect(span.resource["app.resource.tag"]).toBe("custom");
        expect(span.attributes["gen_ai.input.messages"]).toBeUndefined();
        expect(span.attributes["gen_ai.output.messages"]).toBeUndefined();
      });
      expect(JSON.stringify(fixture.otlp.payloads)).not.toContain("forged-content");
    },
  ),
);
