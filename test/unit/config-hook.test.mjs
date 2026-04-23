import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import * as pluginModule from "../../dist/index.js"

test("bundle exports only the real plugin entry", () => {
  assert.deepEqual(Object.keys(pluginModule).sort(), ["ClaudeMaxPlugin"])
  assert.equal(typeof pluginModule.ClaudeMaxPlugin, "function")
})

test("bundle does not expose helper functions that legacy loader would treat as plugins", () => {
  assert.equal("applyAnthropicProxyConfig" in pluginModule, false)
})

test("bundle preserves anthropic-beta handling for Anthropic requests", () => {
  const built = readFileSync(new URL("../dist/index.js", import.meta.url), "utf-8")

  assert.equal(built.includes('"anthropic-beta"'), true)
  assert.equal(built.includes('"x-opencode-session"'), true)
  assert.equal(built.includes('"x-opencode-request"'), true)
})
