import assert from "node:assert/strict"
import test, { before, after } from "node:test"
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

// Tier-2 coverage: drive each plugin hook with a fake OpenCode client.
// Runs a single real proxy instance for the whole file; the OS cleans it up
// when the Node test runner exits (registerCleanup is wired to process exit).

let hooks
let fakeHomeDir
let logEntries = []
let previousEnv = {}

function makeClient() {
  return {
    app: {
      log: async ({ body }) => {
        // Capture log output so we can assert against it if needed.
        logEntries.push(body)
        return {}
      },
    },
  }
}

before(async () => {
  // Isolate ~/.config/meridian and ~/.config/opencode so tests don't read
  // the developer's real files.
  fakeHomeDir = mkdtempSync(join(tmpdir(), "owc-hooks-"))
  mkdirSync(join(fakeHomeDir, ".config", "meridian"), { recursive: true })
  const opencodeDir = join(fakeHomeDir, ".config", "opencode")
  mkdirSync(opencodeDir, { recursive: true })
  // Plant an AGENTS.md we can look for in the transform-hook assertions.
  writeFileSync(
    join(opencodeDir, "AGENTS.md"),
    "# Fake agents marker\nproject-specific instructions here.",
  )

  previousEnv = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    OPENCODE_CONFIG_DIR: process.env.OPENCODE_CONFIG_DIR,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    CLAUDE_PROXY_PORT: process.env.CLAUDE_PROXY_PORT,
  }

  process.env.HOME = fakeHomeDir
  process.env.USERPROFILE = fakeHomeDir
  delete process.env.OPENCODE_CONFIG_DIR
  delete process.env.XDG_CONFIG_HOME

  // Use a random OS-assigned port so multiple runs don't collide.
  process.env.CLAUDE_PROXY_PORT = "0"

  const { ClaudeMaxPlugin } = await import(
    `../../dist/index.js?t=${Date.now()}${Math.random()}`
  )
  hooks = await ClaudeMaxPlugin({ client: makeClient() })
})

after(async () => {
  // ClaudeMaxPlugin starts the proxy internally but doesn't return its
  // handle, so we trigger its registerCleanup() hook by emitting SIGINT
  // and waiting a short tick for the async close() to drain the event loop.
  // Without this, the open server keeps node:test from exiting.
  process.emit("SIGINT")
  await new Promise((resolve) => setTimeout(resolve, 250))

  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }

  rmSync(fakeHomeDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// config hook
// ---------------------------------------------------------------------------

test("config hook rewrites provider.anthropic.options.baseURL to the proxy URL", async () => {
  const input = {
    provider: { anthropic: { options: { baseURL: "https://api.anthropic.com" } } },
  }
  await hooks.config(input)
  assert.match(input.provider.anthropic.options.baseURL, /^http:\/\/.+:\d+$/)
})

test("config hook creates options when missing on the anthropic provider", async () => {
  const input = { provider: { anthropic: {} } }
  await hooks.config(input)
  assert.ok(input.provider.anthropic.options)
  assert.match(input.provider.anthropic.options.baseURL, /^http:\/\//)
})

test("config hook is a no-op when no anthropic provider exists", async () => {
  const input = { provider: { openai: { options: { baseURL: "other" } } } }
  await hooks.config(input)
  assert.deepEqual(input, {
    provider: { openai: { options: { baseURL: "other" } } },
  })
})

// ---------------------------------------------------------------------------
// chat.headers — strip anthropic-beta, add session/request headers
// ---------------------------------------------------------------------------

test("chat.headers preserves anthropic-beta and adds session + request IDs", async () => {
  const output = { headers: { "anthropic-beta": "some-flag", keep: "me" } }
  await hooks["chat.headers"](
    {
      sessionID: "sess-123",
      model: { providerID: "anthropic" },
      message: { id: "msg-abc" },
    },
    output,
  )
  assert.equal(output.headers["anthropic-beta"], "some-flag")
  assert.equal(output.headers["x-opencode-session"], "sess-123")
  assert.equal(output.headers["x-opencode-request"], "msg-abc")
  assert.equal(output.headers.keep, "me", "other headers should be preserved")
})

test("chat.headers adds session + request IDs when no other headers present", async () => {
  const output = { headers: {} }
  await hooks["chat.headers"](
    {
      sessionID: "s",
      model: { providerID: "anthropic" },
      message: { id: "m" },
    },
    output,
  )
  assert.equal(output.headers["x-opencode-session"], "s")
  assert.equal(output.headers["x-opencode-request"], "m")
})

test("chat.headers forwards configured OpenCode agent mode", async () => {
  await hooks.config({
    provider: { anthropic: { options: {} } },
    agent: {
      explore: { mode: "subagent" },
      build: { mode: "primary" },
    },
  })

  const output = { headers: {} }
  await hooks["chat.headers"](
    {
      sessionID: "s",
      agent: "explore",
      model: { providerID: "anthropic" },
      message: { id: "m" },
    },
    output,
  )

  assert.equal(output.headers["x-opencode-agent-mode"], "subagent")
})

test("chat.headers is a no-op for non-anthropic providers", async () => {
  const output = { headers: { "anthropic-beta": "still-here" } }
  await hooks["chat.headers"](
    {
      sessionID: "s",
      model: { providerID: "openai" },
      message: { id: "m" },
    },
    output,
  )
  assert.deepEqual(output.headers, { "anthropic-beta": "still-here" })
})

// ---------------------------------------------------------------------------
// Logger instrumentation
// ---------------------------------------------------------------------------

test("plugin logs 'proxy ready' during startup", () => {
  // The before-hook already invoked ClaudeMaxPlugin. One of the startup log
  // entries should announce the proxy URL.
  assert.ok(
    logEntries.some(
      (e) =>
        e.service === "opencode-with-claude" &&
        typeof e.message === "string" &&
        e.message.startsWith("proxy ready at http://"),
    ),
    "expected a 'proxy ready at ...' log entry from startup",
  )
})

test("system transform preserves existing OpenCode system prompts", async () => {
  const output = { system: ["OMO Sisyphus prompt", "Project instructions"] }

  await hooks["experimental.chat.system.transform"](
    { model: { providerID: "anthropic" } },
    output,
  )

  assert.equal(output.system.length, 3)
  assert.match(output.system[0], /You are Anthropic's Claude Code/)
  assert.equal(output.system[1], "OMO Sisyphus prompt")
  assert.equal(output.system[2], "Project instructions")
})

test("system transform uses the agent captured for its session", async () => {
  await hooks["chat.message"](
    {
      sessionID: "plan-session",
      agent: "plan",
      model: { providerID: "anthropic" },
    },
    { message: {}, parts: [] },
  )
  await hooks["chat.message"](
    {
      sessionID: "build-session",
      agent: "build",
      model: { providerID: "anthropic" },
    },
    { message: {}, parts: [] },
  )

  const output = { system: [] }
  await hooks["experimental.chat.system.transform"](
    { sessionID: "plan-session", model: { providerID: "anthropic" } },
    output,
  )

  assert.match(output.system[0], /Plan mode is ENABLED/)
})

test("system transform does not touch non-anthropic providers", async () => {
  const output = { system: ["OMO Sisyphus prompt"] }

  await hooks["experimental.chat.system.transform"](
    { model: { providerID: "openai" } },
    output,
  )

  assert.deepEqual(output.system, ["OMO Sisyphus prompt"])
})
