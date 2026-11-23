import assert from "node:assert/strict"
import test from "node:test"
import { fileURLToPath } from "node:url"
import plugin from "../../dist/index.js"

test("MERIDIAN_URL selects an external origin or falls back to the in-process path", async () => {
  const previous = {
    MERIDIAN_URL: process.env.MERIDIAN_URL,
    MERIDIAN_PATH: process.env.MERIDIAN_PATH,
    CLAUDE_PROXY_PORT: process.env.CLAUDE_PROXY_PORT,
    MERIDIAN_HOST: process.env.MERIDIAN_HOST,
  }
  const originalFetch = globalThis.fetch
  const originalError = console.error
  const errors = []
  globalThis.fakeMeridianStarts = 0
  globalThis.fetch = async () => new Response(JSON.stringify({ status: "healthy" }))
  console.error = (...args) => errors.push(args.join(" "))
  process.env.MERIDIAN_PATH = fileURLToPath(new URL("./helpers/fake-meridian.mjs", import.meta.url))
  process.env.CLAUDE_PROXY_PORT = "0"
  process.env.MERIDIAN_HOST = "127.0.0.1"

  async function setup() {
    let request
    let transform
    const registration = { dispose: async () => {} }
    const dispose = await plugin.setup({
      provider: { transform: async (callback) => { transform = callback; return registration } },
      agent: { transform: async () => registration },
      session: { hook: async (name, callback) => { if (name === "model.request") request = callback; return registration } },
    })
    const input = { sessionID: "test", agent: "build", kind: "primary", headers: {} }
    request(input)
    const provider = { settings: {} }
    transform({ update: (_id, update) => update(provider) })
    return { dispose, baseURL: input.baseURL, providerURL: provider.settings.baseURL }
  }

  try {
    process.env.MERIDIAN_URL = "  http://127.0.0.1:43210/  "
    const external = await setup()
    assert.equal(external.baseURL, "http://127.0.0.1:43210/v1")
    assert.equal(external.providerURL, external.baseURL)
    assert.equal(globalThis.fakeMeridianStarts, 0)
    await external.dispose()
    await external.dispose()
    assert.equal(globalThis.fakeMeridianStarts, 0)

    delete process.env.MERIDIAN_URL
    const internal = await setup()
    assert.match(internal.baseURL, /^http:\/\/127\.0\.0\.1:[1-9]\d*\/v1$/)
    assert.equal(globalThis.fakeMeridianStarts, 1)
    await internal.dispose()

    process.env.MERIDIAN_URL = "http://127.0.0.1:3456/v1"
    const fallback = await setup()
    assert.match(fallback.baseURL, /^http:\/\/127\.0\.0\.1:[1-9]\d*\/v1$/)
    assert.equal(globalThis.fakeMeridianStarts, 2)
    assert.ok(errors.some((line) => line.includes("Invalid MERIDIAN_URL")))
    await fallback.dispose()
  } finally {
    globalThis.fetch = originalFetch
    console.error = originalError
    delete globalThis.fakeMeridianStarts
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})
