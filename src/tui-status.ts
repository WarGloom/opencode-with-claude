/**
 * Pure pieces of the TUI status line: reading Meridian's answers, deciding
 * whether a session is served by it, and turning a snapshot into one line.
 * No I/O and no OpenCode runtime imports, so it runs under plain Node tests.
 */

const ANTHROPIC = "anthropic"
const WEEKLY_BUCKET = "seven_day"
const SESSION_BUCKET = "five_hour"
const DEFAULT_PROFILE = "default"
const SEPARATOR = " · "

/** A reading older than this is shown, but marked stale. */
export const STALE_AFTER_MS = 15 * 60 * 1000
const WARNING_REMAINING_PERCENT = 20

export interface QuotaReading {
  /** Profile Meridian answered for; null when it runs a single account. */
  profile: string | null
  /** Whole percent of the 7-day allowance left, rounded down; null when unknown. */
  weeklyRemaining: number | null
  /** When the weekly figure was read (epoch ms); null when there is none. */
  readAt: number | null
  /** Meridian says the weekly or 5-hour bucket is refusing requests right now. */
  rejected: boolean
  /** Whole percent of the 5-hour allowance left, rounded down; null when unknown. */
  sessionRemaining: number | null
}

export interface StatusSnapshot {
  /** False after a failed request; undefined before the first attempt. */
  reachable: boolean | undefined
  profile: string | null
  email: string | undefined
  quota: QuotaReading | undefined
}

export type StatusTone = "unknown" | "normal" | "warning" | "danger"

export interface StatusLine {
  text: string
  tone: StatusTone
}

export const INITIAL_SNAPSHOT: StatusSnapshot = {
  reachable: undefined,
  profile: null,
  email: undefined,
  quota: undefined,
}

/** Parse `GET /v1/usage/quota`. Undefined means the body is not that shape. */
export function parseQuotaResponse(value: unknown): QuotaReading | undefined {
  if (!isRecord(value) || !Array.isArray(value.buckets)) return undefined
  const weekly = findBucket(value.buckets, WEEKLY_BUCKET)
  const session = findBucket(value.buckets, SESSION_BUCKET)
  const utilization = weekly ? finiteNumber(weekly.utilization) : undefined
  const sessionUtilization = session ? finiteNumber(session.utilization) : undefined
  return {
    profile: nonEmptyString(value.profile) ?? null,
    weeklyRemaining: utilization === undefined ? null : remainingPercent(utilization),
    readAt: utilization === undefined ? null : (finiteNumber(weekly?.observedAt) ?? null),
    rejected: weekly?.status === "rejected" || session?.status === "rejected",
    sessionRemaining: sessionUtilization === undefined ? null : remainingPercent(sessionUtilization),
  }
}

function findBucket(buckets: unknown[], type: string): Record<string, unknown> | undefined {
  return buckets.find(
    (bucket): bucket is Record<string, unknown> => isRecord(bucket) && bucket.type === type,
  )
}

/** Parse `GET /profiles/health` for the active profile id (null: none set). */
export function parseActiveProfile(value: unknown): string | null | undefined {
  if (!isRecord(value)) return undefined
  return nonEmptyString(value.activeProfile) ?? null
}

/** The address Meridian reports for a profile in `GET /profiles/list`. */
export function findProfileEmail(value: unknown, profile: string | null): string | undefined {
  if (!isRecord(value) || !Array.isArray(value.profiles)) return undefined
  const id = profile ?? nonEmptyString(value.activeProfile) ?? DEFAULT_PROFILE
  const entry = value.profiles.find(
    (candidate): candidate is Record<string, unknown> =>
      isRecord(candidate) && candidate.id === id,
  )
  return entry ? nonEmptyString(entry.email) : undefined
}

/**
 * Keep the first two characters of the local part and the domain. Anything
 * that is not an address is replaced outright rather than partly shown.
 */
export function maskEmail(email: string): string {
  const trimmed = email.trim()
  const at = trimmed.indexOf("@")
  if (at <= 0) return "*****"
  // Code points, not UTF-16 units, so a surrogate pair is never split.
  const prefix = Array.from(trimmed.slice(0, at)).slice(0, 2).join("")
  return `${prefix}***${trimmed.slice(at)}`
}

/**
 * Meridian's root URL, taken only from the effective Anthropic provider
 * config this plugin's v1 config hook wrote. The provider list is not
 * consulted: it is not what this plugin set. Only loopback HTTP is accepted.
 *
 * Fail-closed policy: the TUI cannot prove which process owns a loopback
 * port (under `opencode attach` it is the attaching machine's loopback), so
 * it never sends credentials. A protected Meridian (`requiresKey`) is
 * therefore not polled at all and the status reads as unavailable.
 */
export function resolveMeridianBaseURL(state: { config?: unknown; requiresKey?: boolean }): string | undefined {
  if (state.requiresKey) return undefined
  const raw = providerBaseURL(
    isRecord(state.config) && isRecord(state.config.provider)
      ? state.config.provider[ANTHROPIC]
      : undefined,
  )
  if (!raw) return undefined
  try {
    const url = new URL(raw)
    if (url.protocol !== "http:" || !isLoopbackHost(url.hostname)) return undefined
    return `${url.protocol}//${url.host}`
  } catch {
    return undefined
  }
}

/**
 * Whether the session is served by the Anthropic provider: the newest
 * assistant message says what actually ran, the configured default covers a
 * session that has not run anything yet. Unknown stays hidden.
 */
export function isAnthropicSession(
  messages: ReadonlyArray<unknown>,
  configuredModel: unknown,
): boolean {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!isRecord(message) || message.role !== "assistant") continue
    const providerID = nonEmptyString(message.providerID)
    if (providerID) return providerID === ANTHROPIC
  }
  const model = nonEmptyString(configuredModel)
  return model?.split("/", 1)[0] === ANTHROPIC
}

export function formatStatusLine(
  snapshot: StatusSnapshot,
  options: { maskEmail: boolean; now: number },
): StatusLine {
  const email = snapshot.email && (options.maskEmail ? maskEmail(snapshot.email) : snapshot.email)
  const shown = snapshot.profile === DEFAULT_PROFILE ? null : snapshot.profile
  // A profile id may itself be an address; it gets the same masking as the email.
  const profile = shown && options.maskEmail && shown.includes("@") ? maskEmail(shown) : shown
  const label = [profile, email].filter(Boolean).join(SEPARATOR) || "Claude"
  const quota = snapshot.quota

  if (!quota || quota.weeklyRemaining === null) {
    const detail = snapshot.reachable === false ? "unavailable" : "7d ?"
    return { text: `${label}${SEPARATOR}${detail}`, tone: "unknown" }
  }

  const stale = quota.readAt === null || options.now - quota.readAt > STALE_AFTER_MS
  const session = quota.sessionRemaining
  const sessionPart = session != null ? `5h ${session}%${SEPARATOR}` : ""
  const text = `${label}${SEPARATOR}${sessionPart}7d ${quota.weeklyRemaining}%${stale ? " stale" : ""}`
  const lowest = Math.min(quota.weeklyRemaining, session ?? 100)
  if (quota.rejected || lowest <= 0) return { text, tone: "danger" }
  if (stale || lowest < WARNING_REMAINING_PERCENT) return { text, tone: "warning" }
  return { text, tone: "normal" }
}

function remainingPercent(utilization: number): number {
  // Rounded to hundredths first so 0.29 does not read as 70.999… and floor to 70.
  const left = Math.floor(Math.round((1 - utilization) * 10_000) / 100)
  return Math.min(100, Math.max(0, left))
}

function providerBaseURL(provider: unknown): string | undefined {
  if (!isRecord(provider) || !isRecord(provider.options)) return undefined
  return nonEmptyString(provider.options.baseURL)
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "")
  return host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}
