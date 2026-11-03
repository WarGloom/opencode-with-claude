import type { Plugin } from "@opencode/plugin/tui"

import { isAnthropicSession, resolveMeridianBaseURL } from "./tui-status.ts"

/** Adapt the V2 provider catalog to the shared loopback-only URL policy. */
export function resolveV2MeridianBaseURL(ctx: Plugin.Context): string | undefined {
  const provider = ctx.data.location.provider.list(ctx.location)?.find((item) => item.id === "anthropic")
  return resolveMeridianBaseURL({
    config: { provider: { anthropic: { options: provider?.settings } } },
    requiresKey: Boolean(process.env.MERIDIAN_API_KEY?.trim()),
  })
}

/** V2 messages name the provider in model; V1 messages put it on the assistant. */
export function isV2AnthropicSession(ctx: Plugin.Context, sessionID: string | undefined): boolean {
  if (!sessionID) {
    const selected = ctx.ui.model.current()
    return isAnthropicSession([], selected ? `${selected.providerID}/${selected.modelID}` : undefined)
  }
  return [sessionID, ...ctx.data.session.family(sessionID)].some((id) => {
    const model = ctx.data.session.get(id)?.model
    return isAnthropicSession(
      ctx.data.session.message.list(id).filter((message) => message.type === "assistant").map((message) => ({
        role: "assistant",
        providerID: message.model.providerID,
      })),
      model?.providerID,
    )
  })
}
