import type { Plugin } from "@opencode-ai/plugin"

type PluginConfig = Parameters<NonNullable<Awaited<ReturnType<Plugin>>["config"]>>[0]

export function applyAnthropicProxyConfig(input: PluginConfig, baseURL: string): void {
  const anthropic = input.provider?.anthropic
  if (!anthropic) return

  const options = (anthropic.options ??= {})
  options.baseURL = baseURL
}
