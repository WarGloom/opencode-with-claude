import type { Plugin } from "@opencode-ai/plugin"

import { applyAnthropicProxyConfig } from "./anthropic-proxy-config"
import { loadSystemPrompt } from "./prompts"
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

  let currentAgent: string

  return {
    // Set the base URL for the Anthropic provider
    async config(input) {
      applyAnthropicProxyConfig(input, baseURL)
    },

    // Track the current agent so we can inject the prompt for it into the system prompt
    async "chat.message"(incoming, output) {
      if (incoming.model?.providerID !== "anthropic") return
      currentAgent = output.message.agent
    },

    // Preserve OpenCode's agent system prompt and append the Claude bridge prompt plus global AGENTS.md content.
    async "experimental.chat.system.transform"(input, output) {
      if (input.model.providerID !== "anthropic") return
      output.system.push(...loadSystemPrompt(currentAgent))
    },

    // Delete the anthropic-beta header and add session and request headers to the request for the proxy to identify the session and request
    async "chat.headers"(incoming, output) {
      if (incoming.model.providerID !== "anthropic") return
      delete output.headers["anthropic-beta"]
      
      output.headers["x-opencode-session"] = incoming.sessionID
      output.headers["x-opencode-request"] = incoming.message.id
    },
  }
}
