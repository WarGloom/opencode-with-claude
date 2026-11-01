import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import type { Plugin } from "@opencode/plugin/tui"

import { createStatusController } from "./tui-controller.ts"
import {
  INITIAL_SNAPSHOT,
  formatStatusLine,
  isAnthropicSession,
  resolveMeridianBaseURL,
  type StatusSnapshot,
  type StatusTone,
} from "./tui-status.ts"
import { isV2AnthropicSession, resolveV2MeridianBaseURL } from "./tui-v2-status.ts"

/**
 * TUI entry point, published as the package's `./tui` export and listed in
 * `tui.json`. OpenCode v1 modules are target-exclusive (`server` or `tui`,
 * never both), which is why this lives apart from `index.ts`.
 *
 * It shows the Claude account Meridian is currently routing to and how much
 * of the weekly allowance is left, next to the prompt of Anthropic sessions.
 */

/** Staleness is a function of time, so the line is re-evaluated even when idle. */
const CLOCK_TICK_MS = 60_000

const tui: TuiPlugin = async (api, options) => {
  // Resolved by the host's OpenTUI runtime plugin, so the renderer and the
  // reactive graph are the host's own instances.
  const [{ createElement, spread }, { createSignal }] = await Promise.all([
    import("@opentui/solid"),
    import("solid-js"),
  ])
  const maskEmail = readMaskEmailOption(options)
  const prefix = readPrefixOption(options)
  const [snapshot, setSnapshot] = createSignal<StatusSnapshot>(INITIAL_SNAPSHOT)
  const [clock, setClock] = createSignal(Date.now())

  // Only the presence of MERIDIAN_API_KEY is read: a protected Meridian is not polled.
  const requiresKey = Boolean(process.env.MERIDIAN_API_KEY?.trim())
  const controller = createStatusController({
    fetch: globalThis.fetch,
    baseURL: () => resolveMeridianBaseURL({ config: api.state.config, requiresKey }),
    onChange: setSnapshot,
  })
  controller.start()
  const clockTimer = setInterval(() => setClock(Date.now()), CLOCK_TICK_MS)

  const servesAnthropic = (sessionID: string | undefined) =>
    isAnthropicSession(sessionID ? api.state.session.messages(sessionID) : [], api.state.config.model)

  // A finished Anthropic request is when the weekly figure can have moved.
  const nudgeFor = (sessionID: string | undefined) => {
    if (servesAnthropic(sessionID)) controller.nudge()
  }
  const offIdle = api.event.on("session.idle", (event) => nudgeFor(event.properties.sessionID))
  const offError = api.event.on("session.error", (event) => nudgeFor(event.properties.sessionID))

  api.lifecycle.onDispose(() => {
    offIdle()
    offError()
    clearInterval(clockTimer)
    controller.dispose()
  })

  const render = (sessionID: string) => {
    const line = () =>
      servesAnthropic(sessionID)
        ? formatStatusLine(snapshot(), { maskEmail, now: clock() })
        : undefined
    const node = createElement("text")
    spread(
      node,
      {
        get content() {
          const text = line()?.text
          return text ? `${prefix}${text}` : ""
        },
        get fg() {
          return toneColor(api, line()?.tone ?? "unknown")
        },
        alignSelf: "flex-start",
        selectable: false,
        truncate: true,
        wrapMode: "none",
      },
      false,
    )
    return node
  }

  api.slots.register({
    slots: {
      session_prompt_right: (_ctx: unknown, props: { session_id: string }) => render(props.session_id),
    },
  })
}

const setup: Plugin.Definition["setup"] = async (ctx) => {
  const [{ createElement, spread }, { createSignal }] = await Promise.all([
    import("@opentui/solid"),
    import("solid-js"),
  ])
  const maskEmail = readMaskEmailOption(ctx.options)
  const prefix = readPrefixOption(ctx.options)
  const [snapshot, setSnapshot] = createSignal<StatusSnapshot>(INITIAL_SNAPSHOT)
  const [clock, setClock] = createSignal(Date.now())
  const controller = createStatusController({
    fetch: globalThis.fetch,
    baseURL: () => resolveV2MeridianBaseURL(ctx),
    onChange: setSnapshot,
  })
  controller.start()
  const clockTimer = setInterval(() => setClock(Date.now()), CLOCK_TICK_MS)
  const nudgeFor = (sessionID: string) => {
    if (isV2AnthropicSession(ctx, sessionID)) controller.nudge()
  }
  const offIdle = ctx.data.on("session.idle", (event) => nudgeFor(event.data.sessionID))
  const offError = ctx.data.on("session.execution.failed", (event) => nudgeFor(event.data.sessionID))
  const unregister = ctx.ui.slot({
    append: "prompt.footer.status",
    render: (input) => {
      const line = () =>
        resolveV2MeridianBaseURL(ctx) && isV2AnthropicSession(ctx, input.sessionID)
          ? formatStatusLine(snapshot(), { maskEmail, now: clock() })
          : undefined
      const node = createElement("text")
      spread(
        node,
        {
          get content() {
            const text = line()?.text
            return text ? `${prefix}${text}` : ""
          },
          get fg() {
            switch (line()?.tone ?? "unknown") {
              case "danger": return ctx.theme.text.feedback.error.base
              case "warning": return ctx.theme.text.feedback.warning.base
              case "normal": return ctx.theme.text.feedback.success.base
              default: return ctx.theme.text.muted
            }
          },
          alignSelf: "flex-start",
          selectable: false,
          truncate: true,
          wrapMode: "none",
        },
        false,
      )
      return node
    },
  })
  return () => {
    offIdle()
    offError()
    clearInterval(clockTimer)
    controller.dispose()
    unregister()
  }
}

function toneColor(api: TuiPluginApi, tone: StatusTone) {
  const theme = api.theme.current
  if (tone === "danger") return theme.error
  if (tone === "warning") return theme.warning
  if (tone === "normal") return theme.success
  return theme.textMuted
}

/** `["…/dist/tui.js", { "maskEmail": false }]` in tui.json shows the full address. */
function readMaskEmailOption(options: unknown): boolean {
  if (typeof options !== "object" || options === null) return true
  return (options as { maskEmail?: unknown }).maskEmail !== false
}

/** `["…/dist/tui.js", { "prefix": "│ " }]` in tui.json separates this segment from a preceding plugin's. */
function readPrefixOption(options: unknown): string {
  if (typeof options !== "object" || options === null) return ""
  const prefix = (options as { prefix?: unknown }).prefix
  return typeof prefix === "string" ? prefix : ""
}

const plugin: TuiPluginModule & Plugin.Definition = {
  id: "opencode-with-claude.status",
  tui,
  setup,
}

export default plugin
