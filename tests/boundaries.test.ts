import { expect, test } from "bun:test";
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
