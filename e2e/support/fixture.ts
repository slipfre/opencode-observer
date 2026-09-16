import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { startFakeLlm, type LlmReply } from "./fake-llm.js";
import { startOtlpReceiver } from "./otlp-receiver.js";

type FixtureOptions = {
  replies: LlmReply[];
  pluginEntry?: string;
  pluginOptions?: Record<string, unknown>;
  otlpDelayMs?: number;
  autoCompact?: boolean;
  permission?: Record<string, "ask" | "allow" | "deny">;
  env?: Record<string, string>;
};
export type E2EFixture = Parameters<Parameters<typeof withE2EFixture>[1]>[0];
export type RunResult = Awaited<ReturnType<E2EFixture["run"]>>;

export async function withE2EFixture(
  options: FixtureOptions,
  test: (fixture: {
    directory: string;
    llm: ReturnType<typeof startFakeLlm>;
    otlp: ReturnType<typeof startOtlpReceiver>;
    run(
      prompt: string,
      args?: string[],
    ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  }) => Promise<void>,
) {
  const entry = process.env.OPENCODE_E2E_ENTRY
    ? path.resolve(process.env.OPENCODE_E2E_ENTRY)
    : undefined;
  const plugin = path.resolve(import.meta.dir, "../../dist/index.js");

  if (!entry) {
    throw new Error("Set OPENCODE_E2E_ENTRY to the OpenCode packages/opencode/src/index.ts entry.");
  }

  if (!(await Bun.file(entry).exists())) {
    throw new Error(
      `OpenCode entry not found: ${entry}. Set OPENCODE_E2E_ENTRY to its src/index.ts.`,
    );
  }

  if (!(await Bun.file(plugin).exists())) {
    throw new Error("Plugin build not found. Run bun run test:e2e to build it before testing.");
  }

  await using workspace = {
    directory: await mkdtemp(
      path.join(process.env.OPENCODE_E2E_TMPDIR ?? tmpdir(), "opencode-observer-e2e-"),
    ),
    async [Symbol.asyncDispose]() {
      await rm(this.directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    },
  };
  const directory = workspace.directory;
  using llm = startFakeLlm(options.replies);
  using otlp = startOtlpReceiver(options.otlpDelayMs);
  const processes = new Set<Bun.Subprocess>();
  const results: RunResult[] = [];

  try {
    const configDirectory = path.join(directory, ".config/opencode");
    await mkdir(path.join(configDirectory, "node_modules"), { recursive: true });
    // OpenCode checks this lockfile to avoid installing config-directory dependencies.
    await Bun.write(
      path.join(configDirectory, "package-lock.json"),
      JSON.stringify({ packages: { "": { dependencies: { "@opencode-ai/plugin": "0.0.0" } } } }),
    );
    const config = {
      formatter: false,
      lsp: false,
      share: "disabled",
      permission: options.permission,
      plugin: [
        [
          pathToFileURL(options.pluginEntry ?? plugin).href,
          {
            enabled: true,
            endpoint: otlp.endpoint,
            tracePrefix: "e2e.",
            resourceAttributes: { "e2e.resource": "opencode-observer" },
            spanAttributes: { "e2e.fixture": path.basename(directory) },
            ...options.pluginOptions,
          },
        ],
      ],
      provider: {
        test: {
          name: "Test",
          npm: "@ai-sdk/openai-compatible",
          options: { apiKey: "e2e-local-key", baseURL: llm.url },
          models: {
            "test-model": {
              name: "Test Model",
              tool_call: true,
              headers: { "X-Observer-Model": "request-one,two" },
              limit: { context: 100_000, output: 10_000 },
              cost: { input: 0, output: 0 },
            },
          },
        },
      },
    };

    await test({
      directory,
      llm,
      otlp,
      async run(prompt, args = []) {
        const proc = Bun.spawn(
          [
            process.execPath,
            "run",
            "--conditions=browser",
            entry,
            "--print-logs",
            "--log-level",
            "DEBUG",
            "run",
            "--model",
            "test/test-model",
            "--format",
            "json",
            ...args,
          ],
          {
            cwd: directory,
            env: {
              ...Object.fromEntries(
                Object.entries(process.env).filter(
                  ([key, value]) =>
                    value !== undefined &&
                    ["PATH", "TMPDIR", "TEMP", "TMP", "SystemRoot", "ComSpec", "PATHEXT"].includes(
                      key,
                    ),
                ),
              ),
              ...options.env,
              HOME: directory,
              PWD: directory,
              XDG_CONFIG_HOME: path.join(directory, ".config"),
              XDG_DATA_HOME: path.join(directory, ".local/share"),
              XDG_STATE_HOME: path.join(directory, ".local/state"),
              XDG_CACHE_HOME: path.join(directory, ".cache"),
              OPENCODE_TEST_HOME: directory,
              OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
              OPENCODE_AUTH_CONTENT: "{}",
              OPENCODE_DISABLE_PROJECT_CONFIG: "1",
              OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
              OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
              OPENCODE_DISABLE_AUTOUPDATE: "1",
              OPENCODE_DISABLE_MODELS_FETCH: "1",
              OPENCODE_DISABLE_AUTOCOMPACT: options.autoCompact ? "0" : "1",
            },
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        processes.add(proc);
        // Piped input preserves text verbatim; OpenCode quotes CLI arguments containing spaces.
        proc.stdin.write(prompt);
        proc.stdin.end();
        const stdout = new Response(proc.stdout).text();
        const stderr = new Response(proc.stderr).text();
        const timeout = setTimeout(() => proc.kill("SIGKILL"), 45_000);

        try {
          const exitCode = await proc.exited;
          const result = { exitCode, stdout: await stdout, stderr: await stderr };
          results.push(result);

          if (proc.signalCode) {
            throw new Error(
              `OpenCode terminated (${proc.signalCode}, timeout 45000ms):\n${JSON.stringify(result, null, 2)}`,
            );
          }

          return result;
        } finally {
          clearTimeout(timeout);
          processes.delete(proc);
        }
      },
    });
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\nOpenCode results:\n${JSON.stringify(results, null, 2)}\nModel errors:\n${JSON.stringify(llm.errors)}\nModel requests:\n${JSON.stringify(llm.hits, null, 2)}\nOTLP errors:\n${JSON.stringify(otlp.errors)}\nOTLP payloads:\n${JSON.stringify(otlp.payloads, null, 2)}`,
      { cause: error },
    );
  } finally {
    await Promise.all(
      Array.from(processes, async (proc) => {
        if (proc.exitCode === null) {
          proc.kill("SIGKILL");
        }

        await proc.exited;
      }),
    );
  }
}
