import assert from "node:assert/strict"
import test from "node:test"

import { isV2AnthropicSession, resolveV2MeridianBaseURL } from "../../src/tui-v2-status.ts"

function context({ baseURL, messages = [], selected } = {}) {
  const location = { directory: "/project" }
  return {
    location,
    data: {
      location: { provider: { list: (input) => {
        assert.equal(input, location)
        return [{ id: "anthropic", settings: { baseURL } }]
      } } },
      session: { message: { list: () => messages } },
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

test("V2 maps the newest assistant provider and falls back to the selected prompt model", () => {
  const anthropic = { providerID: "anthropic", modelID: "claude-sonnet-4-5" }
  const openai = { providerID: "openai", modelID: "gpt-5" }
  for (const [messages, selected, expected] of [
    [[], anthropic, true],
    [[], openai, false],
    [[], undefined, false],
    [[{ type: "user" }, { type: "assistant", model: openai }], anthropic, false],
    [[{ type: "assistant", model: openai }, { type: "assistant", model: anthropic }], openai, true],
  ]) {
    assert.equal(isV2AnthropicSession(context({ messages, selected }), "session-1"), expected)
  }
})
