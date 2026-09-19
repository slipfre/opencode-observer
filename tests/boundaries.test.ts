import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, relative, resolve } from "node:path";

test("runtime imports stay within each layer and its allowed dependencies", async () => {
  const root = resolve(import.meta.dir, "..");
  const source = resolve(root, "src");
  const scanner = new Bun.Transpiler({ loader: "ts" });
  const files = Array.from(new Bun.Glob("**/*.ts").scanSync({ cwd: source }));
  const violations = (
    await Promise.all(
      files.map(async (file) => {
        if (file === "index.ts" || file === "config.ts") {
          return [];
        }

        const layer = file.split(/[\\/]/)[0];

        if (!layer || !["adapter", "contract", "telemetry", "user"].includes(layer)) {
          return [`${file} is outside the source layers and user module`];
        }

        return scanner
          .scan(await Bun.file(resolve(source, file)).text())
          .imports.flatMap((dependency) => {
            if (dependency.path.startsWith(".")) {
              const target = resolve(source, dirname(file), dependency.path);
              const destination = relative(source, target).split(/[\\/]/)[0];

              if (layer === "adapter" && destination === "adapter") {
                const module = file.split(/[\\/]/)[1];
                const targetModule = relative(source, target).split(/[\\/]/)[1];
                const allowed: Record<string, string[]> = {
                  opencode: ["opencode", "trackers", "model", "shared"],
                  trackers: ["trackers", "model", "shared"],
                  model: ["model", "shared"],
                  shared: ["shared"],
                };

                return module && targetModule && allowed[module]?.includes(targetModule)
                  ? []
                  : [`${file} -> ${dependency.path}`];
              }

              if (destination === layer || (destination === "contract" && layer !== "user")) {
                return [];
              }

              if (layer === "telemetry" && target === resolve(root, "package.json")) {
                return [];
              }
            }

            if (
              layer === "adapter" &&
              (dependency.path.startsWith("@opencode-ai/") || dependency.path === "ai")
            ) {
              return [];
            }

            if (
              layer === "telemetry" &&
              (dependency.path.startsWith("@opentelemetry/") || dependency.path.startsWith("node:"))
            ) {
              return [];
            }

            if (layer === "user" && dependency.path.startsWith("node:")) {
              return [];
            }

            return [`${file} -> ${dependency.path}`];
          });
      }),
    )
  ).flat();

  expect(violations).toEqual([]);
});

test("lint applies the same SDK and telemetry import boundaries to every tracker", async () => {
  await using workspace = {
    directory: await mkdtemp(resolve(tmpdir(), "opencode-observer-lint-")),
    async [Symbol.asyncDispose]() {
      await rm(this.directory, { recursive: true, force: true });
    },
  };
  const files = ["run", "interaction", "llm", "tool", "compaction", "permission"].map((name) =>
    resolve(workspace.directory, "src/adapter/trackers", `${name}.ts`),
  );
  await Bun.write(
    resolve(workspace.directory, ".oxlintrc.json"),
    Bun.file(resolve(import.meta.dir, "../.oxlintrc.json")),
  );
  await Promise.all(
    files.map((file) =>
      Bun.write(
        file,
        `import type { UserMessage } from "@opencode-ai/sdk";
import { nonNegativeNumber } from "../shared/number.js";
export type { Observer } from "../../contract/observer.js";
export { normalizeOpenCodeUsage } from "../model/usage.js";
export function observedTime(input: UserMessage) {
  return nonNegativeNumber(input.time.created);
}
`,
      ),
    ),
  );
  const command = [
    resolve(
      import.meta.dir,
      "../node_modules/.bin",
      process.platform === "win32" ? "oxlint.exe" : "oxlint",
    ),
    "--deny-warnings",
    "--format=json",
    ...files,
  ];

  const allowed = Bun.spawnSync(command, {
    cwd: workspace.directory,
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(allowed.exitCode).toBe(0);
  expect(JSON.parse(allowed.stdout.toString()).diagnostics).toEqual([]);

  await Promise.all(
    files.map((file) =>
      Bun.write(file, 'export { createTelemetry } from "../../telemetry/factory.js";\n'),
    ),
  );

  const forbidden = Bun.spawnSync(command, {
    cwd: workspace.directory,
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(forbidden.exitCode).toBe(1);
  expect(JSON.parse(forbidden.stdout.toString()).diagnostics).toEqual(
    files.map(() => expect.objectContaining({ code: "eslint(no-restricted-imports)" })),
  );
});
