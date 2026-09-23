import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const workflow = Bun.YAML.parse(
  await Bun.file(new URL("../.github/workflows/release.yml", import.meta.url)).text(),
) as { jobs: { release: { steps: Array<{ id?: string; run?: string }> } } };

test.each([
  { version: "0.1.0", tag: "v0.1.0", prerelease: false },
  { version: "0.2.0-beta.1", tag: "v0.2.0-beta.1", prerelease: true },
  { version: "0.1.0+build-1", tag: "v0.1.0+build-1", prerelease: false },
])("release metadata recognizes $tag", async ({ version, tag, prerelease }) => {
  const result = await runReleaseStep("version", { version, tag });

  expect(result.exitCode).toBe(0);
  expect(result.output).toBe(`version=${version}\nprerelease=${prerelease}\n`);
  expect(result.calls).toEqual([]);
});

test.each(["v0.2.0", "v0.1.0; exit 0"])("release rejects mismatched tag %s", async (tag) => {
  const result = await runReleaseStep("version", { tag });

  expect(result.exitCode).not.toBe(0);
  expect(result.stdout).toContain("must match package.json version");
  expect(result.output).toBe("");
  expect(result.calls).toEqual([]);
});

test.each([false, true])(
  "release uploads all assets before publishing, prerelease=%s",
  async (pre) => {
    const version = pre ? "0.2.0-beta.1" : "0.1.0";
    const result = await runReleaseStep("publish", {
      version,
      tag: `v${version}`,
      prerelease: pre,
    });

    expect(result.exitCode).toBe(0);
    expect(result.calls.map((args) => args[1])).toEqual(["view", "create", "upload", "edit"]);
    expect(result.calls[1]).toContain("--verify-tag");
    expect(result.calls[1]).toContain("--draft");
    expect(result.calls[2]).toEqual([
      "release",
      "upload",
      `v${version}`,
      "opencode-observer.js",
      `opencode-observer-${version}.tgz`,
      "SHA256SUMS",
      "--clobber",
    ]);
    expect(result.calls[3]).toContain("--draft=false");
    [result.calls[1]!, result.calls[3]!].forEach((args) => {
      expect(args).toContain(`--prerelease=${pre}`);
      expect(args.includes("--latest=false")).toBe(pre);
    });
  },
);

test("release resumes an existing draft", async () => {
  const result = await runReleaseStep("publish", { release: "draft" });

  expect(result.exitCode).toBe(0);
  expect(result.calls.map((args) => args[1])).toEqual(["view", "upload", "edit"]);
});

test("release never overwrites an already published version", async () => {
  const result = await runReleaseStep("publish", { release: "published" });

  expect(result.exitCode).not.toBe(0);
  expect(result.stdout).toContain("already published");
  expect(result.calls.map((args) => args[1])).toEqual(["view"]);
});

test.each(["create", "upload"])("release stops when %s fails", async (failure) => {
  const result = await runReleaseStep("publish", { failure });

  expect(result.exitCode).not.toBe(0);
  expect(result.calls.map((args) => args[1])).toEqual(
    failure === "create" ? ["view", "create"] : ["view", "create", "upload"],
  );
});

async function runReleaseStep(
  id: string,
  options: {
    version?: string;
    tag?: string;
    prerelease?: boolean;
    release?: "draft" | "published";
    failure?: string;
  },
) {
  const script = workflow.jobs.release.steps.find((step) => step.id === id)?.run;
  if (!script) {
    throw new Error(`Release step ${id} is missing its script`);
  }

  await using workspace = {
    directory: await mkdtemp(path.join(tmpdir(), "opencode-observer-release-")),
    async [Symbol.asyncDispose]() {
      await rm(this.directory, { recursive: true, force: true });
    },
  };
  await mkdir(path.join(workspace.directory, "bin"));
  await Bun.write(
    path.join(workspace.directory, "package.json"),
    JSON.stringify({ version: options.version ?? "0.1.0" }),
  );
  // Exercise the workflow's actual shell scripts without making GitHub requests.
  await Bun.write(
    path.join(workspace.directory, "bin/gh"),
    `#!${process.execPath}
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.RELEASE_TEST_LOG, JSON.stringify(args) + "\\n");
if (args[1] === process.env.RELEASE_TEST_FAILURE) {
  process.exit(1);
}
if (args[1] === "view") {
  if (!process.env.RELEASE_TEST_STATE) {
    process.exit(1);
  }
  console.log(process.env.RELEASE_TEST_STATE === "draft");
}
`,
  );
  await chmod(path.join(workspace.directory, "bin/gh"), 0o755);

  const proc = Bun.spawn(["bash", "--noprofile", "--norc", "-eo", "pipefail", "-c", script], {
    cwd: workspace.directory,
    env: {
      ...process.env,
      PATH: `${path.join(workspace.directory, "bin")}:${path.dirname(process.execPath)}:${process.env.PATH ?? ""}`,
      RELEASE_TAG: options.tag ?? "v0.1.0",
      RELEASE_VERSION: options.version ?? "0.1.0",
      PRERELEASE: String(options.prerelease ?? false),
      GITHUB_OUTPUT: path.join(workspace.directory, "output"),
      RELEASE_TEST_LOG: path.join(workspace.directory, "calls.jsonl"),
      RELEASE_TEST_STATE: options.release ?? "",
      RELEASE_TEST_FAILURE: options.failure ?? "",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const output = await Bun.file(path.join(workspace.directory, "output"))
    .text()
    .catch(() => "");
  const calls = await Bun.file(path.join(workspace.directory, "calls.jsonl"))
    .text()
    .catch(() => "");
  return {
    exitCode,
    stdout,
    stderr,
    output,
    calls: calls.trim()
      ? calls
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as string[])
      : [],
  };
}
