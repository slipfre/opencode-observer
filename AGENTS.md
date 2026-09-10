## Project Overview

`opencode-observer` is an OpenCode observability plugin written in TypeScript and developed, built, and tested with Bun. It observes OpenCode hooks/events and supported AI SDK lifecycle callbacks, creates OpenTelemetry spans, and exports traces over OTLP HTTP/JSON. The current implementation covers run, interaction, LLM, tool, compaction, and permission.check spans.

### Goals

- Describe task execution with accurate lifecycles, parent-child relationships, usage, and errors, following the [Trace Schema](docs/schemas/trace.md). Omit or explicitly degrade unsupported measurements instead of inventing data.
- Keep OpenCode behavior recognition, observation contracts, and telemetry implementation separate, following the [Architecture Spec](docs/spec.md). The adapter and telemetry layers depend on the contract, never on each other; the contract is independent of third-party SDKs.
- Keep observation from changing OpenCode's behavior: isolate telemetry failures, export asynchronously, and keep telemetry and content capture disabled by default.

See [README.md](README.md) for features, local loading, configuration, and usage limits. Use the [Architecture Spec](docs/spec.md) for implementation details and the [Trace Schema](docs/schemas/trace.md) for exported data semantics.

## Main Directory Structure

```text
src/
├── index.ts             # Plugin entry point and dependency wiring
├── config.ts            # Plugin options and environment configuration
├── adapter/             # OpenCode hooks/events, behavior tracking, AI SDK integration
├── contract/            # SDK-independent observation interfaces and message types
└── telemetry/           # OpenTelemetry setup, contract implementation, export lifecycle
    └── spans/           # Span state and attribute/message encoding
tests/                   # Unit and in-process integration tests, including module boundaries
e2e/                     # Tests running real OpenCode CLI processes
└── support/             # Isolated fixtures, fake model server, OTLP receiver, assertions
docs/
├── spec.md              # Architecture, responsibilities, and dependency constraints
└── schemas/trace.md     # Trace topology, lifecycle semantics, and exported fields
dist/                    # Generated JavaScript, source maps, and type declarations
```

## Branch Names

Use a short branch name of at most three words, separated by hyphens. Do not use slashes or type prefixes such as `feat/` or `fix/`.

Examples: `trace-export`, `content-capture`, `permission-spans`.

## Commits and PR Titles

Use conventional commit-style messages and PR titles: `type(scope): summary`.

Valid types are `feat`, `fix`, `docs`, `chore`, `refactor`, and `test`. Scopes are optional; use the affected area when helpful, e.g. `adapter`, `contract`, `telemetry`, `config`, or `e2e`.

Examples: `fix(adapter): preserve tool ownership`, `docs: clarify trace lifecycle`, `test(e2e): cover permission denial`.

## Setup and Build

Use Bun 1.3.14 or newer and run commands from the repository root. Install dependencies before building or testing:

```sh
bun install --frozen-lockfile
bun run build
```

`build` bundles `src/index.ts` as Bun-targeted ESM with external package dependencies and a linked source map, then generates TypeScript declarations using `tsconfig.build.json`. Output is written to `dist/`; both package entry points (`opencode-observer` and `opencode-observer/server`) resolve to `dist/index.js`.

`bun run check` runs formatting, lint, and type checks. Use `bun run format`, `bun run format:check`, `bun run lint`, `bun run lint:fix`, or `bun run typecheck` for individual development tasks.

`bun pm pack` runs the prepack checks, unit tests, and build. The package includes `dist/`, `package.json`, README, and the MIT license.

## Testing and Verification

Install dependencies as described above before running tests from the repository root.

### Unit Tests (UT)

`tests/` contains unit and in-process integration tests. Run the full suite with:

```sh
bun run test
```

For a focused run during development, use `bun test ./tests/adapter.test.ts` or `bun run test --test-name-pattern 'pattern'`.

### End-to-End Tests (E2E)

`e2e/` launches real OpenCode CLI processes, loads the built plugin, and verifies exported traces using local fake-model and OTLP HTTP servers. No model API key or external collector is required. Tests need permission to listen on loopback ports and launch subprocesses.

Prepare an OpenCode source checkout with its dependencies installed and set `OPENCODE_E2E_ENTRY` to its `packages/opencode/src/index.ts` entry before running E2E tests:

```sh
bun run test:e2e
```

`test:e2e` rebuilds the plugin before running tests, so it always tests the current code. For a focused run, use `bun run test:e2e --test-name-pattern 'pattern'`. Use the explicit UT and E2E scripts; bare `bun test` discovers both suites and does not rebuild the plugin.

Each E2E case uses isolated HOME/XDG temporary directories and random loopback ports, then cleans up processes, servers, and files. Set `OPENCODE_E2E_TMPDIR` to an existing parent directory to control temporary file placement. Each CLI invocation has a 45-second timeout; each test has a 60-second timeout. Missing OpenCode source or build output causes a failure rather than a skipped test. Failure diagnostics include CLI output, model requests, and OTLP payloads. E2E files participate in type checking but are excluded from the published build.

Coverage includes trace structure, content and usage, disabled telemetry/content capture, retries and terminal errors, repeated session runs, real tools and failures, permission denial, foreground subtasks, remote W3C parents, collector headers, and compaction success/failure. Assertions must reflect current measurement limits: normal status is `UNSET`, LLM spans require model-step evidence, and retry counts or first-chunk timing must not be presented as measured without precise attempt boundaries.

### Required Checks After Changes

- After changing source code, tests, build/test configuration, or dependencies, run all of the following before reporting the work complete:

  ```sh
  bun run check
  bun run test
  bun run test:e2e
  ```

- Focused tests are useful while developing, but do not replace the full UT and E2E runs after the final code change. Fix failures and rerun the affected checks; if a fix changes code, run the full verification sequence again.
- Add or update regression coverage when changing behavior or fixing a bug. Use UT for isolated logic and E2E for behavior that depends on actual OpenCode hooks, events, tool execution, or trace export.
- For documentation-only changes, run `bun run format:check`; UT and E2E runs are not required.
- If a required check cannot run, report the command and the concrete blocker. Do not silently skip tests or describe an unexecuted suite as passing. Include the checks run and their results in the final response.

## Style Guide

### General Principles

- Keep things in one function unless composable or reusable
- Do not extract single-use helpers preemptively. Inline the logic at the call site unless the helper is reused, hides a genuinely complex boundary, or has a clear independent name that improves the caller.
- Avoid `try`/`catch` where possible
- Avoid using the `any` type
- Separate semantic blocks with exactly one blank line: setup, validation, processing, cleanup. Keep closely related declarations, assignments, and assertions together; do not add a blank line after every statement. In tests, separate setup, actions, and assertions, including distinct lifecycle phases.
- Use Bun APIs when possible, like `Bun.file()`
- Rely on type inference when possible; avoid explicit type annotations or interfaces unless necessary for exports or clarity
- Prefer functional array methods (flatMap, filter, map) over for loops; use type guards on filter to maintain type inference downstream

Reduce total variable count by inlining when a value is only used once.

```ts
// Good
const journal = await Bun.file(path.join(dir, "journal.json")).json();

// Bad
const journalPath = path.join(dir, "journal.json");
const journal = await Bun.file(journalPath).json();
```

### Destructuring

Avoid unnecessary destructuring. Use dot notation to preserve context.

```ts
// Good
obj.a;
obj.b;

// Bad
const { a, b } = obj;
```

### Imports

- Never alias imports. Do not use `import { foo as bar } from "..."` or renamed imports like `resolve as pathResolve`.
- Never use star imports. Do not use `import * as Foo from "..."` or `import type * as Foo from "..."`.
- Prefer dynamic imports for heavy modules that are only needed in selected code paths, especially in startup-sensitive entrypoints. Destructure dynamic import bindings near the top of the narrowest scope that needs them so they read like normal imports. Avoid inline chains such as `await import("./module").then((mod) => mod.value())` or `(await import("./module")).value()`. Keep branch-specific imports inside the branch that needs them to preserve lazy loading.

### Variables

Prefer `const` over `let`. Use ternaries or early returns instead of reassignment.

```ts
// Good
const foo = condition ? 1 : 2;

// Bad
let foo;

if (condition) {
  foo = 1;
} else {
  foo = 2;
}
```

### Control Flow

Avoid `else` statements. Prefer early returns.

Always use braces for `if`, `else`, and loop bodies. Write each body on multiple lines, even for a single statement. Oxlint enforces braces with `curly: ["error", "all"]`; oxfmt expands blocks onto multiple lines.

```ts
// Good
function foo() {
  if (condition) {
    return 1;
  }

  return 2;
}

// Bad
function foo() {
  if (condition) {
    return 1;
  } else {
    return 2;
  }
}
```

### Complex Logic

When a function has several validation branches or supporting details, make the main function read as the happy path and move supporting details into small helpers below it.

```ts
// Good
export function loadThing(input: unknown) {
  const config = requireConfig(input)
  const metadata = readMetadata(input)

  return createThing({ config, metadata })
}

function requireConfig(input: unknown) {
  ...
}
```

- Keep helpers close to the code they support, below the main export when that improves readability.
- Do not over-abstract simple expressions into many single-use helpers; extract only when it names a real concept like `requireConfig` or `readMetadata`.
- Add comments for non-obvious constraints and surprising behavior, not for obvious assignments or control flow.
