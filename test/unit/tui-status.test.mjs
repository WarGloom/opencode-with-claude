import assert from "node:assert/strict"
import test from "node:test"
import { createServer } from "node:http"

import {
  STALE_AFTER_MS,
  findProfileEmail,
  formatStatusLine,
  isAnthropicSession,
  maskEmail,
  formatResetIn,
  parseQuotaResponse,
  resolveMeridianBaseURL,
} from "../../src/tui-status.ts"
import { createStatusController } from "../../src/tui-controller.ts"
import * as tuiModule from "../../dist/tui.js"
import * as serverModule from "../../dist/index.js"

const NOW = Date.parse("2026-09-24T12:00:00Z")
const EMAIL = "nikita.example@adversa.ai"

// Shape of Meridian 1.76 `GET /v1/usage/quota`; utilization is a 0..1 fraction.
const quotaBody = (profile, utilization, observedAt = NOW, status = "allowed") => ({
  profile,
  buckets: [
    { type: "five_hour", status: "allowed", utilization: 0.9, observedAt },
    ...(utilization === undefined ? [] : [{ type: "seven_day", status, utilization, observedAt }]),
  ],
  sources: { oauth: { fetchedAt: observedAt }, sdk: { entryCount: 0 } },
  asOf: NOW,
})

const ready = (overrides = {}) => ({
  reachable: true,
  profile: "work",
  email: EMAIL,
  quota: { profile: "work", weeklyRemaining: 62, readAt: NOW, rejected: false },
  ...overrides,
})

test("selected profile, masked account and weekly remaining render on one line", () => {
  const line = formatStatusLine(ready(), { maskEmail: true, now: NOW })
  assert.equal(line.text, "work · ni***@adversa.ai · 7d 62%")
  assert.equal(line.tone, "normal")
  assert.equal(line.text.includes(EMAIL), false)
})

test("the full address only appears when masking is switched off", () => {
  const line = formatStatusLine(ready(), { maskEmail: false, now: NOW })
  assert.equal(line.text, `work · ${EMAIL} · 7d 62%`)
})

test("remaining percent comes from the seven_day bucket, rounded down", () => {
  assert.equal(parseQuotaResponse(quotaBody("work", 0.38)).weeklyRemaining, 62)
  assert.equal(parseQuotaResponse(quotaBody("work", 0.29)).weeklyRemaining, 71)
  assert.equal(parseQuotaResponse(quotaBody("work", 0.999)).weeklyRemaining, 0)
  assert.equal(parseQuotaResponse(quotaBody(null, 0.05)).profile, null)
})

test("the five_hour bucket is read and shown before the weekly figure", () => {
  const reading = parseQuotaResponse(quotaBody("work", 0.38))
  assert.equal(reading.sessionRemaining, 10)
  const line = formatStatusLine(ready({ quota: reading }), { maskEmail: true, now: NOW })
  assert.equal(line.text, "work · ni***@adversa.ai · 5h 10% · 7d 62%")
  assert.equal(line.tone, "warning")
})

test("each window shows how long until it resets", () => {
  // given: Meridian reports both resetsAt values
  const body = quotaBody("work", 0.38)
  body.buckets[0].resetsAt = NOW + 3 * 3_600_000
  body.buckets[1].resetsAt = NOW + 2 * 86_400_000 + 3 * 3_600_000
  // when
  const line = formatStatusLine(ready({ quota: parseQuotaResponse(body) }), { maskEmail: true, now: NOW })
  // then
  assert.equal(line.text, "work · ni***@adversa.ai · 5h 10% resets in 3h · 7d 62% resets in 2d")
})

test("time left uses one unit and hides resets already past", () => {
  assert.equal(formatResetIn(NOW + 40 * 60_000, NOW), "40m")
  assert.equal(formatResetIn(NOW + 5 * 3_600_000 + 10 * 60_000, NOW), "5h")
  assert.equal(formatResetIn(NOW + 60 * 3_600_000, NOW), "3d")
  assert.equal(formatResetIn(NOW - 1, NOW), undefined)
  assert.equal(formatResetIn(null, NOW), undefined)
})

test("a rejected 5-hour window turns the line red even with weekly headroom", () => {
  const body = quotaBody("work", 0.1)
  body.buckets[0] = { type: "five_hour", status: "rejected", utilization: 1, observedAt: NOW }
  const reading = parseQuotaResponse(body)
  assert.equal(reading.rejected, true)
  assert.equal(formatStatusLine(ready({ quota: reading }), { maskEmail: true, now: NOW }).tone, "danger")
})

test("a rejected window without utilization remains visible when weekly quota is unknown", () => {
  const body = { profile: "work", buckets: [{ type: "five_hour", status: "rejected", utilization: null, resetsAt: NOW + 3_600_000 }] }
  const reading = parseQuotaResponse(body)
  assert.equal(reading.sessionRemaining, 0)
  assert.deepEqual(formatStatusLine(ready({ quota: reading }), { maskEmail: true, now: NOW }), {
    text: "work · ni***@adversa.ai · 5h 0% resets in 1h · 7d ?",
    tone: "danger",
  })
  assert.equal(parseQuotaResponse({ buckets: [{ type: "seven_day", status: "rejected", utilization: null }] }).weeklyRemaining, 0)
})

test("a reply without a weekly reading stays unknown instead of guessing", () => {
  const reading = parseQuotaResponse(quotaBody("work", undefined))
  assert.equal(reading.weeklyRemaining, null)
  assert.equal(parseQuotaResponse({ error: "nope" }), undefined)
  const line = formatStatusLine(ready({ quota: reading }), { maskEmail: true, now: NOW })
  assert.equal(line.text, "work · ni***@adversa.ai · 7d ?")
  assert.equal(line.tone, "unknown")
})

test("unreachable Meridian with no reading says unavailable", () => {
  const line = formatStatusLine(
    { reachable: false, profile: null, email: undefined, quota: undefined },
    { maskEmail: true, now: NOW },
  )
  assert.deepEqual(line, { text: "Claude · unavailable", tone: "unknown" })
})

test("an old reading is kept but marked stale", () => {
  const quota = { profile: "work", weeklyRemaining: 62, readAt: NOW - STALE_AFTER_MS - 1, rejected: false }
  const line = formatStatusLine(ready({ quota, reachable: false }), { maskEmail: true, now: NOW })
  assert.equal(line.text, "work · ni***@adversa.ai · 7d 62% stale")
  assert.equal(line.tone, "warning")
})

test("low and exhausted allowances escalate the tone", () => {
  const low = { profile: "work", weeklyRemaining: 12, readAt: NOW, rejected: false }
  const out = { profile: "work", weeklyRemaining: 40, readAt: NOW, rejected: true }
  assert.equal(formatStatusLine(ready({ quota: low }), { maskEmail: true, now: NOW }).tone, "warning")
  assert.equal(formatStatusLine(ready({ quota: out }), { maskEmail: true, now: NOW }).tone, "danger")
})

test("the implicit default profile is not shown as a label", () => {
  const line = formatStatusLine(ready({ profile: "default", email: undefined }), { maskEmail: true, now: NOW })
  assert.equal(line.text, "Claude · 7d 62%")
})

test("maskEmail never leaks a non-address value", () => {
  assert.equal(maskEmail("token-without-at"), "*****")
  assert.equal(maskEmail("a@b.c"), "a***@b.c")
})

test("profile email is looked up for the requested profile only", () => {
  const body = {
    activeProfile: "work",
    profiles: [{ id: "work", email: EMAIL }, { id: "home", email: "other@example.com" }],
  }
  assert.equal(findProfileEmail(body, "home"), "other@example.com")
  assert.equal(findProfileEmail(body, null), EMAIL)
  assert.equal(findProfileEmail(body, "missing"), undefined)
})

test("only Anthropic sessions show the line", () => {
  const openai = [{ role: "assistant", providerID: "openai" }]
  const claude = [{ role: "user" }, { role: "assistant", providerID: "anthropic" }]
  assert.equal(isAnthropicSession(openai, "anthropic/claude-sonnet-4-5"), false)
  assert.equal(isAnthropicSession(claude, "openai/gpt-5"), true)
  assert.equal(isAnthropicSession([], "anthropic/claude-sonnet-4-5"), true)
  assert.equal(isAnthropicSession([], "openai/gpt-5"), false)
  assert.equal(isAnthropicSession([], undefined), false)
})

test("Meridian URL comes from the Anthropic provider options and must be loopback", () => {
  const config = (baseURL) => ({ provider: { anthropic: { options: { baseURL } } } })
  assert.equal(resolveMeridianBaseURL({ config: config("http://127.0.0.1:43123") }), "http://127.0.0.1:43123")
  assert.equal(resolveMeridianBaseURL({ config: config("http://[::1]:3456/v1") }), "http://[::1]:3456")
  // The provider list is not the effective config this plugin wrote; it is never consulted.
  assert.equal(
    resolveMeridianBaseURL({ providers: [{ id: "anthropic", options: { baseURL: "http://localhost:9/" } }] }),
    undefined,
  )
  assert.equal(resolveMeridianBaseURL({ config: config("https://api.anthropic.com") }), undefined)
  assert.equal(resolveMeridianBaseURL({ config: config("http://10.0.0.5:3456") }), undefined)
  assert.equal(resolveMeridianBaseURL({ config: {} }), undefined)
})

test("a protected (keyed) Meridian is never polled and reads as unavailable", async () => {
  const config = { provider: { anthropic: { options: { baseURL: "http://127.0.0.1:43123" } } } }
  assert.equal(resolveMeridianBaseURL({ config, requiresKey: true }), undefined)
  assert.equal(resolveMeridianBaseURL({ config, requiresKey: false }), "http://127.0.0.1:43123")
  let calls = 0
  const controller = createStatusController({
    fetch: async () => {
      calls += 1
      throw new Error("unexpected")
    },
    baseURL: () => resolveMeridianBaseURL({ config, requiresKey: true }),
    onChange: () => {},
  })
  await controller.checkProfile()
  await controller.refresh()
  assert.equal(calls, 0)
  assert.equal(formatStatusLine(controller.snapshot(), { maskEmail: true, now: NOW }).text, "Claude · unavailable")
})

test("status requests never follow a redirect and never carry an API key", async () => {
  const sinkRequests = []
  const redirectorKeys = []
  const sink = createServer((req, res) => {
    sinkRequests.push({ url: req.url, apiKey: req.headers["x-api-key"] })
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(quotaBody("work", 0.38)))
  })
  await new Promise((resolve) => sink.listen(0, "127.0.0.1", resolve))
  const sinkURL = `http://127.0.0.1:${sink.address().port}`
  const redirector = createServer((req, res) => {
    redirectorKeys.push(req.headers["x-api-key"])
    res.writeHead(307, { location: `${sinkURL}${req.url}` }).end()
  })
  await new Promise((resolve) => redirector.listen(0, "127.0.0.1", resolve))
  const controller = createStatusController({
    fetch,
    baseURL: () => `http://127.0.0.1:${redirector.address().port}`,
    apiKey: "sk-test-key",
    now: () => NOW,
    onChange: () => {},
  })
  try {
    await controller.checkProfile()
    await controller.refresh()
    assert.ok(redirectorKeys.length > 0)
    // A caller-supplied key is ignored: the controller has no way to send one.
    assert.ok(redirectorKeys.every((key) => key === undefined))
    assert.deepEqual(sinkRequests, [])
    assert.equal(controller.snapshot().reachable, false)
  } finally {
    controller.dispose()
    await new Promise((resolve) => redirector.close(resolve))
    await new Promise((resolve) => sink.close(resolve))
  }
})

// --- controller against a fake Meridian over real HTTP -------------------

async function fakeMeridian() {
  const state = { active: "work", utilization: 0.38, fail: false, requests: [], routing: "manual", telemetry: [] }
  const server = createServer((req, res) => {
    state.requests.push({ url: req.url, apiKey: req.headers["x-api-key"] })
    if (state.fail) {
      res.writeHead(503).end()
      return
    }
    if (req.url === "/telemetry/requests?limit=100" && state.telemetry === null) {
      res.writeHead(503).end()
      return
    }
    const url = new URL(req.url, "http://localhost")
    const profile = url.searchParams.get("profile") ?? state.active
    const bodies = {
      "/profiles/health": { activeProfile: state.active, routing: state.routing, asOf: NOW },
      "/profiles/list": {
        activeProfile: state.active,
        profiles: [{ id: "work", email: EMAIL }, { id: "home", email: "home.user@example.com" }],
      },
      "/v1/usage/quota": quotaBody(profile, profile === "home" ? 0.9 : state.utilization),
      "/telemetry/requests": state.telemetry,
    }
    const body = bodies[url.pathname]
    res.writeHead(body ? 200 : 404, { "content-type": "application/json" })
    res.end(JSON.stringify(body ?? {}))
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const baseURL = `http://127.0.0.1:${server.address().port}`
  return { state, baseURL, close: () => new Promise((resolve) => server.close(resolve)) }
}

test("priority routing shows the newest successful OpenCode account and its quota", async () => {
  const meridian = await fakeMeridian()
  meridian.state.routing = "priority"
  meridian.state.telemetry = [
    { timestamp: 4, adapter: "other", status: 200, error: null, profileId: "work" },
    { timestamp: 3.5, adapter: "opencode", status: 200, error: "failed", profileId: "work" },
    { timestamp: 3, adapter: "opencode", status: 500, error: "failed", profileId: "work" },
    { timestamp: 1, adapter: "opencode", status: 200, error: null, profileId: "work" },
    { timestamp: 2, adapter: "opencode", status: 200, error: null, profileId: "home" },
  ]
  const controller = createStatusController({ fetch, baseURL: () => meridian.baseURL, now: () => NOW, onChange: () => {} })
  try {
    await controller.checkProfile()
    await controller.refresh()
    assert.equal(formatStatusLine(controller.snapshot(), { maskEmail: true, now: NOW }).text,
      "home · ho***@example.com · 5h 10% · 7d 10%")
  } finally {
    controller.dispose()
    await meridian.close()
  }
})

test("a priority profile poll refreshes after telemetry changes without an active-profile switch", async () => {
  const meridian = await fakeMeridian()
  meridian.state.routing = "priority"
  meridian.state.telemetry = [{ timestamp: 1, adapter: "opencode", status: 200, error: null, profileId: "work" }]
  const controller = createStatusController({ fetch, baseURL: () => meridian.baseURL, now: () => NOW, onChange: () => {} })
  try {
    await controller.checkProfile()
    await controller.refresh()
    meridian.state.telemetry.push({ timestamp: 2, adapter: "opencode", status: 200, error: null, profileId: "home" })
    meridian.state.requests.length = 0
    await controller.checkProfile()
    assert.equal(controller.snapshot().profile, "home")
    assert.equal(controller.snapshot().quota.weeklyRemaining, 10)
    assert.equal(meridian.state.requests.filter((request) => request.url.startsWith("/telemetry/")).length, 1)
    meridian.state.telemetry = null
    meridian.state.requests.length = 0
    const before = controller.snapshot()
    await controller.checkProfile()
    assert.deepEqual(controller.snapshot(), before)
    assert.equal(meridian.state.requests.filter((request) => request.url.startsWith("/v1/usage/quota")).length, 0)
  } finally {
    controller.dispose()
    await meridian.close()
  }
})

for (const telemetry of [null, []]) {
  test(`priority routing falls back to the active account when telemetry is ${telemetry === null ? "unavailable" : "empty"}`, async () => {
    const meridian = await fakeMeridian()
    meridian.state.routing = "priority"
    meridian.state.telemetry = telemetry
    const controller = createStatusController({ fetch, baseURL: () => meridian.baseURL, now: () => NOW, onChange: () => {} })
    try {
      await controller.checkProfile()
      await controller.refresh()
      assert.equal(formatStatusLine(controller.snapshot(), { maskEmail: true, now: NOW }).text,
        "work · ni***@adversa.ai · 5h 10% · 7d 62%")
    } finally {
      controller.dispose()
      await meridian.close()
    }
  })
}


test("controller follows an active-profile switch without showing the old quota", async () => {
  const meridian = await fakeMeridian()
  const seen = []
  const controller = createStatusController({
    fetch,
    baseURL: () => meridian.baseURL,
    apiKey: "sk-test-key",
    now: () => NOW,
    onChange: (snapshot) => seen.push(snapshot),
  })
  try {
    await controller.checkProfile()
    await controller.refresh()
    assert.equal(
      formatStatusLine(controller.snapshot(), { maskEmail: true, now: NOW }).text,
      "work · ni***@adversa.ai · 5h 10% · 7d 62%",
    )

    meridian.state.active = "home"
    meridian.state.utilization = 0.9
    seen.length = 0
    await controller.checkProfile()

    // The first update after the switch carries the new profile and no figures.
    assert.equal(seen[0].profile, "home")
    assert.equal(seen[0].quota, undefined)
    assert.equal(seen[0].email, undefined)
    assert.equal(
      formatStatusLine(controller.snapshot(), { maskEmail: true, now: NOW }).text,
      "home · ho***@example.com · 5h 10% · 7d 10%",
    )
    assert.ok(meridian.state.requests.every((request) => request.apiKey === undefined))
  } finally {
    controller.dispose()
    await meridian.close()
  }
})

test("controller keeps the last reading when Meridian stops answering", async () => {
  const meridian = await fakeMeridian()
  let now = NOW
  const controller = createStatusController({
    fetch,
    baseURL: () => meridian.baseURL,
    now: () => now,
    onChange: () => {},
  })
  try {
    await controller.refresh()
    meridian.state.fail = true
    now = NOW + STALE_AFTER_MS + 1
    await controller.refresh()
    const snapshot = controller.snapshot()
    assert.equal(snapshot.reachable, false)
    assert.equal(formatStatusLine(snapshot, { maskEmail: true, now }).text, "work · ni***@adversa.ai · 5h 10% · 7d 62% stale")
    assert.ok(meridian.state.requests.every((request) => request.apiKey === undefined))
  } finally {
    controller.dispose()
    await meridian.close()
  }
})

test("controller makes no request when the Meridian URL is unknown", async () => {
  let calls = 0
  const controller = createStatusController({
    fetch: async () => {
      calls += 1
      throw new Error("unexpected")
    },
    baseURL: () => undefined,
    onChange: () => {},
  })
  await controller.refresh()
  assert.equal(calls, 0)
  assert.equal(formatStatusLine(controller.snapshot(), { maskEmail: true, now: NOW }).text, "Claude · unavailable")
})

test("an email-shaped profile id is masked by default", () => {
  const snapshot = ready({ profile: "someone.else@example.com", email: undefined })
  const masked = formatStatusLine(snapshot, { maskEmail: true, now: NOW })
  assert.equal(masked.text, "so***@example.com · 7d 62%")
  assert.equal(masked.text.includes("someone.else@example.com"), false)
  const plain = formatStatusLine(snapshot, { maskEmail: false, now: NOW })
  assert.equal(plain.text, "someone.else@example.com · 7d 62%")
})

test("a quota reply still in flight when the profile switches never restores the old account", async () => {
  // No network: fetch is a local fake whose quota replies resolve only when the test says so.
  let active = "work"
  const pendingQuota = []
  const json = (body) => new Response(JSON.stringify(body), { status: 200 })
  const fakeFetch = (url) => {
    const path = new URL(url).pathname
    if (path === "/profiles/health") return Promise.resolve(json({ activeProfile: active }))
    if (path === "/profiles/list") {
      return Promise.resolve(json({ profiles: [{ id: "work", email: EMAIL }, { id: "home", email: "home.user@example.com" }] }))
    }
    return new Promise((resolve) => pendingQuota.push(resolve))
  }
  const seen = []
  const waiters = []
  const controller = createStatusController({
    fetch: fakeFetch,
    baseURL: () => "http://127.0.0.1:1",
    now: () => NOW,
    onChange: (snapshot) => {
      seen.push(snapshot)
      for (const waiter of waiters.splice(0)) waiter()
    },
  })
  const nextChange = () => new Promise((resolve) => waiters.push(resolve))
  const quotaRequested = async (count) => {
    while (pendingQuota.length < count) await new Promise(setImmediate)
  }
  try {
    await controller.checkProfile()
    const inFlight = controller.refresh()
    await quotaRequested(1)

    active = "home"
    const switched = nextChange()
    const check = controller.checkProfile()
    await switched
    const switchIndex = seen.length - 1
    assert.equal(seen[switchIndex].profile, "home")

    // The outgoing account's reply lands after the switch.
    pendingQuota[0](json(quotaBody("work", 0.38)))
    await quotaRequested(2)
    pendingQuota[1](json(quotaBody("home", 0.9)))
    await Promise.all([inFlight, check])

    const afterSwitch = seen.slice(switchIndex)
    assert.ok(afterSwitch.every((snapshot) => snapshot.profile === "home"), "old profile republished")
    assert.ok(afterSwitch.every((snapshot) => snapshot.quota?.profile !== "work"), "old quota republished")
    assert.equal(
      formatStatusLine(controller.snapshot(), { maskEmail: true, now: NOW }).text,
      "home · ho***@example.com · 5h 10% · 7d 10%",
    )
  } finally {
    controller.dispose()
  }
})

// --- loader contracts -------------------------------------------------------

test("TUI bundle exposes both host entry points without a server entry", () => {
  assert.deepEqual(Object.keys(tuiModule), ["default"])
  const plugin = tuiModule.default
  assert.equal(plugin.id, "opencode-with-claude.status")
  assert.equal(typeof plugin.tui, "function")
  assert.equal("server" in plugin, false, "v1 rejects a module that has both server() and tui()")
  assert.equal(typeof plugin.setup, "function")
})

test("server bundle still carries only the v1 server() and v2 setup() entry points", () => {
  const plugin = serverModule.default
  assert.equal(typeof plugin.server, "function")
  assert.equal(typeof plugin.setup, "function")
  assert.equal("tui" in plugin, false)
})
