import type { Plugin } from "@opencode-ai/plugin"

import { applyAnthropicProxyConfig } from "./anthropic-proxy-config"
import { createLogger } from "./logger"
import { loadMeridianConfig, summarizeMeridianConfig } from "./meridian-config"
import { getProxyBaseURL, registerCleanup, startProxy } from "./proxy"

export const ClaudeMaxPlugin: Plugin = async ({ client }) => {
  const log = createLogger(client)

  const meridianConfig = loadMeridianConfig(log)
  const summary = summarizeMeridianConfig(meridianConfig)
  if (summary) void log("info", summary)

  const port = process.env.CLAUDE_PROXY_PORT || 3456
  const proxy = await startProxy({
    port,
    log,
    profiles: meridianConfig.profiles,
    defaultProfile: meridianConfig.defaultProfile,
  })

  const baseURL = getProxyBaseURL(proxy.port)
  void log("info", `proxy ready at ${baseURL}`)

  registerCleanup(proxy)

  return {
    async config(input) {
      applyAnthropicProxyConfig(input, baseURL)
    },

    async "chat.headers"(incoming, output) {
      if (incoming.model.providerID !== "anthropic") return
      delete output.headers["anthropic-beta"]
      
      output.headers["x-opencode-session"] = incoming.sessionID
      output.headers["x-opencode-request"] = incoming.message.id
    },
  }
}
