import type { Plugin } from "@opencode-ai/plugin"

import { applyAnthropicProxyConfig } from "./anthropic-proxy-config"
import { createLogger } from "./logger"
import { loadMeridianConfig, summarizeMeridianConfig } from "./meridian-config"
import { loadPrompt } from "./prompts"
import { getProxyBaseURL, registerCleanup, startProxy } from "./proxy"

type AgentMode = "primary" | "subagent" | "all"

function readAgentName(agent: unknown): string | undefined {
  if (typeof agent === "string") return agent
  if (!agent || typeof agent !== "object") return undefined
  const name = (agent as { name?: unknown }).name
  return typeof name === "string" ? name : undefined
}

function readAgentMode(agent: unknown): AgentMode | undefined {
  if (!agent || typeof agent !== "object") return undefined
  const mode = (agent as { mode?: unknown }).mode
  return mode === "primary" || mode === "subagent" || mode === "all" ? mode : undefined
}

function rememberAgentModes(input: unknown, agentModes: Map<string, AgentMode>): void {
  const agents = (input as { agent?: unknown }).agent
  if (!agents || typeof agents !== "object") return

  for (const [name, agent] of Object.entries(agents)) {
    const mode = readAgentMode(agent)
    if (mode) agentModes.set(name, mode)
  }
}

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

  const agentModes = new Map<string, AgentMode>()
  const sessionAgents = new Map<string, string>()

  return {
    async config(input) {
      applyAnthropicProxyConfig(input, baseURL)
      rememberAgentModes(input, agentModes)
    },

    async "chat.message"(incoming, output) {
      if (incoming.model?.providerID !== "anthropic") return
      const agent = readAgentName(incoming.agent) ?? output.message.agent
      if (agent) sessionAgents.set(incoming.sessionID, agent)
    },

    async "experimental.chat.system.transform"(input, output) {
      if (input.model.providerID !== "anthropic") return
      const agent = input.sessionID ? sessionAgents.get(input.sessionID) : undefined
      output.system.unshift(loadPrompt(agent ?? "build"))
    },

    async "chat.headers"(incoming, output) {
      if (incoming.model.providerID !== "anthropic") return
      output.headers["x-opencode-session"] = incoming.sessionID
      output.headers["x-opencode-request"] = incoming.message.id
      const agentMode = agentModes.get(incoming.agent)
      if (agentMode) output.headers["x-opencode-agent-mode"] = agentMode
    },
  }
}
