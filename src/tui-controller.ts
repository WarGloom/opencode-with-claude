import {
  INITIAL_SNAPSHOT,
  findProfileEmail,
  parseActiveProfile,
  parseQuotaResponse,
  type StatusSnapshot,
} from "./tui-status.ts"

const REQUEST_TIMEOUT_MS = 5_000
/** In-memory on Meridian's side, so cheap enough to catch a profile switch quickly. */
const PROFILE_POLL_MS = 15_000
/** Meridian caches the OAuth usage reading for 30s; polling faster buys nothing. */
const QUOTA_POLL_MS = 2 * 60 * 1000
/** /profiles/list runs `claude auth status` per profile, so the address is re-read rarely. */
const EMAIL_REFRESH_MS = 5 * 60 * 1000
const NUDGE_DEBOUNCE_MS = 1_500

export interface StatusControllerOptions {
  fetch: typeof globalThis.fetch
  /** Re-read on every request: the host may learn the proxy URL after startup. */
  baseURL: () => string | undefined
  now?: () => number
  onChange: (snapshot: StatusSnapshot) => void
}

export interface StatusController {
  readonly snapshot: () => StatusSnapshot
  /** Re-read the quota (and the address when due). Concurrent calls coalesce. */
  refresh: () => Promise<void>
  /** Detect an active-profile switch; drops the old account's figures at once. */
  checkProfile: () => Promise<void>
  /** Debounced refresh for "a request just finished" events. */
  nudge: () => void
  start: () => void
  dispose: () => void
}

export function createStatusController(options: StatusControllerOptions): StatusController {
  const now = options.now ?? Date.now
  const timers: ReturnType<typeof setInterval>[] = []
  let snapshot: StatusSnapshot = INITIAL_SNAPSHOT
  let healthProfile: string | null | undefined
  let priorityRouting = false
  let email: { profile: string | null; value: string | undefined; at: number } | undefined
  let running: Promise<void> | undefined
  let rerun = false
  let nudgeTimer: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  // Bumped on every profile switch; a reply begun before the bump is obsolete.
  let generation = 0

  const publish = (next: Partial<StatusSnapshot>) => {
    if (disposed) return
    snapshot = { ...snapshot, ...next }
    options.onChange(snapshot)
  }

  const get = async (path: string): Promise<unknown> => {
    const base = options.baseURL()
    if (!base) throw new Error("Meridian URL unknown")
    const response = await options.fetch(`${base}${path}`, {
      // No credentials are ever sent, and a 3xx fails rather than being followed.
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!response.ok) throw new Error(`Meridian ${path} answered ${response.status}`)
    return response.json()
  }

  const readEmail = async (profile: string | null) => {
    if (email && email.profile === profile && now() - email.at < EMAIL_REFRESH_MS) return email.value
    // A failed read leaves the address unknown rather than borrowing another profile's.
    const value = await get("/profiles/list").then(
      (body) => findProfileEmail(body, profile),
      () => (email?.profile === profile ? email.value : undefined),
    )
    email = { profile, value, at: now() }
    return value
  }

  const refreshOnce = async () => {
    const started = generation
    const served = priorityRouting
      ? await get("/telemetry/requests?limit=100").then((body) => {
          if (!Array.isArray(body)) return undefined
          const entries: unknown[] = body
          return entries
            .filter((entry): entry is { adapter: string; status: number; error: null; profileId: string; timestamp: number } =>
              typeof entry === "object" && entry !== null && "adapter" in entry && entry.adapter === "opencode" &&
              "status" in entry &&
              typeof entry.status === "number" && entry.status >= 200 && entry.status < 300 &&
              "error" in entry && entry.error == null && "profileId" in entry &&
              typeof entry.profileId === "string" && entry.profileId.trim().length > 0 &&
              "timestamp" in entry && typeof entry.timestamp === "number" && Number.isFinite(entry.timestamp))
            .sort((a, b) => b.timestamp - a.timestamp)[0]?.profileId
        }, () => undefined)
      : undefined
    if (started !== generation) return
    const quotaPath = served ? `/v1/usage/quota?profile=${encodeURIComponent(served)}` : "/v1/usage/quota"
    const quota = await get(quotaPath).then(parseQuotaResponse, () => undefined)
    // The switch already queued a rerun, which reads the incoming account.
    if (started !== generation) return
    if (!quota) {
      // Keep the last reading: its own age decides whether it renders as stale.
      publish({ reachable: false })
      return
    }
    const profileChanged = quota.profile !== snapshot.profile
    publish({
      reachable: true,
      profile: quota.profile,
      quota,
      email: profileChanged ? undefined : snapshot.email,
    })
    const value = await readEmail(quota.profile)
    if (started === generation && snapshot.profile === quota.profile) publish({ email: value })
  }

  const refresh = async () => {
    if (running) {
      rerun = true
      return running
    }
    running = (async () => {
      do {
        rerun = false
        await refreshOnce()
      } while (rerun && !disposed)
    })().finally(() => {
      running = undefined
    })
    return running
  }

  const checkProfile = async () => {
    const health = await get("/profiles/health").then((body) => body, () => undefined)
    const active = parseActiveProfile(health)
    if (active === undefined) return
    const priority = typeof health === "object" && health !== null && "routing" in health && health.routing === "priority"
    const routingChanged = priorityRouting !== priority
    priorityRouting = priority
    const previous = healthProfile
    healthProfile = active
    if (previous === undefined || (previous === active && !routingChanged)) return
    // Never render the outgoing account's quota under the incoming label.
    generation += 1
    if (!priority) publish({ profile: active, quota: undefined, email: undefined })
    await refresh()
  }

  const nudge = () => {
    if (disposed) return
    if (nudgeTimer) clearTimeout(nudgeTimer)
    nudgeTimer = setTimeout(() => void refresh(), NUDGE_DEBOUNCE_MS)
  }

  return {
    snapshot: () => snapshot,
    refresh,
    checkProfile,
    nudge,
    start() {
      void checkProfile().then(refresh)
      timers.push(setInterval(() => void checkProfile(), PROFILE_POLL_MS))
      timers.push(setInterval(() => void refresh(), QUOTA_POLL_MS))
      for (const timer of timers) timer.unref?.()
    },
    dispose() {
      disposed = true
      if (nudgeTimer) clearTimeout(nudgeTimer)
      for (const timer of timers.splice(0)) clearInterval(timer)
    },
  }
}
