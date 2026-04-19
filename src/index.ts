import type { Plugin } from "@opencode-ai/plugin"

import { applyAnthropicProxyConfig } from "./anthropic-proxy-config"
import { createLogger } from "./logger"
import { registerCleanup, startProxy } from "./proxy"

export const ClaudeMaxPlugin: Plugin = async ({ client }) => {
  const log = createLogger(client)

  const port = process.env.CLAUDE_PROXY_PORT || 3456
  const proxy = await startProxy({ port, log })

  const baseURL = `http://127.0.0.1:${proxy.port}`
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
