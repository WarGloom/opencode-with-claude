import assert from "node:assert/strict"
import test from "node:test"

import { isV2AnthropicSession, resolveV2MeridianBaseURL } from "../../src/tui-v2-status.ts"

function context({ baseURL, messages = [], selected, sessions = {}, families = {} } = {}) {
  const location = { directory: "/project" }
  return {
    location,
    data: {
      location: { provider: { list: (input) => {
        assert.equal(input, location)
        return [{ id: "anthropic", settings: { baseURL } }]
      } } },
      session: {
        get: (id) => sessions[id],
        family: (id) => families[id] ?? [id],
        message: { list: (id) => sessions[id]?.messages ?? messages },
      },
    },
    ui: { model: { current: () => selected } },
  }
}

test("V2 provider settings use the shared loopback policy and discard the API suffix", (t) => {
  const previous = process.env.MERIDIAN_API_KEY
  t.after(() => {
    if (previous === undefined) delete process.env.MERIDIAN_API_KEY
    else process.env.MERIDIAN_API_KEY = previous
  })
  process.env.MERIDIAN_API_KEY = ""
  for (const [baseURL, expected] of [
    ["http://127.0.0.1:43123/v1", "http://127.0.0.1:43123"],
    ["http://[::1]:3456/v1", "http://[::1]:3456"],
    ["https://api.anthropic.com/v1", undefined],
    ["http://10.0.0.5:3456/v1", undefined],
    [undefined, undefined],
  ]) {
    assert.equal(resolveV2MeridianBaseURL(context({ baseURL })), expected)
  }
})

test("V2 never polls a keyed Meridian", (t) => {
  const previous = process.env.MERIDIAN_API_KEY
  t.after(() => {
    if (previous === undefined) delete process.env.MERIDIAN_API_KEY
    else process.env.MERIDIAN_API_KEY = previous
  })
  process.env.MERIDIAN_API_KEY = "secret"
  assert.equal(resolveV2MeridianBaseURL(context({ baseURL: "http://127.0.0.1:3456/v1" })), undefined)
})

test("V2 maps the newest assistant provider and uses the session model before the first reply", () => {
  const anthropic = { providerID: "anthropic", modelID: "claude-sonnet-4-5" }
  const openai = { providerID: "openai", modelID: "gpt-5" }
  for (const [messages, selected, expected] of [
    [[], anthropic, true],
    [[], openai, false],
    [[], undefined, false],
    [[{ type: "user" }, { type: "assistant", model: openai }], anthropic, false],
    [[{ type: "assistant", model: openai }, { type: "assistant", model: anthropic }], openai, true],
  ]) {
    assert.equal(isV2AnthropicSession(context({ messages, sessions: { "session-1": { model: selected } } }), "session-1"), expected)
  }
})

test("V2 uses the selected model on the home screen", () => {
  assert.equal(isV2AnthropicSession(context({ selected: { providerID: "anthropic", modelID: "claude" } }), undefined), true)
  assert.equal(isV2AnthropicSession(context({ selected: { providerID: "openai", modelID: "gpt" } }), undefined), false)
})

test("V2 includes the whole family and respects each session's latest reply or own model", () => {
  const openai = { providerID: "openai", modelID: "gpt" }
  const anthropic = { providerID: "anthropic", modelID: "claude" }
  const assistant = (model) => ({ type: "assistant", model })
  const root = { model: openai, messages: [assistant(openai)] }
  const families = { root: ["root", "child"], child: ["root", "child"] }
  for (const [child, expected] of [
    [{ parentID: "root", model: openai, messages: [assistant(anthropic)] }, true],
    [{ parentID: "root", model: openai, messages: [assistant(openai)] }, false],
    [{ parentID: "root", model: anthropic, messages: [] }, true],
    [{ parentID: "root", model: anthropic, messages: [assistant(openai)] }, false],
  ]) {
    assert.equal(isV2AnthropicSession(context({ sessions: { root, child }, families }), "root"), expected)
  }
  assert.equal(isV2AnthropicSession(context({ sessions: { root: { model: anthropic }, child: { parentID: "root", model: openai } }, families }), "child"), true)
  const siblings = { child: ["root", "child", "sibling"] }
  const sessions = { root, child: { parentID: "root", model: openai }, sibling: { parentID: "root", model: anthropic } }
  assert.equal(isV2AnthropicSession(context({ sessions, families: siblings }), "child"), true)
})
