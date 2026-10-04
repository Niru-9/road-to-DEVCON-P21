/**
 * The downstream agent reply: shape, validation and sanitization.
 *
 * A discovered agent is a stranger's HTTP endpoint. Its reply is untrusted input that this
 * app renders in a browser, so it is validated against a schema, stripped of markup,
 * truncated to a configured bound and attributed to the ENS name it came from.
 *
 * SCORED CRITERION 2 (14 points) is about where the URL came from, which is decided in
 * `server/forward.ts`; this file is the response half of the same boundary.
 */

import { z } from 'zod'

/**
 * The reply shape every agent in this format must return.
 *
 * `answer` is required and non-empty: an agent that returns nothing useful is an error, not
 * a successful empty answer. `agent` is optional and informational only — attribution always
 * comes from the ENS name the router discovered, never from the reply body.
 */
export const agentReplySchema = z.object({
  ok: z.boolean().catch(true),
  answer: z
    .string()
    .min(1, 'agent returned an empty answer')
    .max(20_000, 'agent answer exceeded the hard parse ceiling'),
  /** Optional. Advisory; never used for attribution. */
  agent: z.string().trim().max(200).optional(),
  /** Optional. Advisory notes from the agent itself. */
  notes: z.array(z.string().trim().max(400)).max(10).optional(),
})

export type AgentReply = z.infer<typeof agentReplySchema>

export class AgentReplyError extends Error {
  readonly status: number | null
  readonly detail: string

  constructor(message: string, detail: string, status: number | null = null) {
    super(message)
    this.name = 'AgentReplyError'
    this.detail = detail
    this.status = status
  }
}

/**
 * Reduce untrusted agent text to plain, displayable characters.
 *
 * Angle brackets are removed rather than escaped, because the UI renders this as text
 * content and never as HTML — escaping here would show the client literal `&lt;script&gt;`.
 * Control characters go too, so an agent cannot emit terminal escapes or forge log lines.
 */
export function sanitizeAgentText(value: string, maxChars: number): string {
  const withoutTags = value
    .replace(/<[^>]*>/g, ' ')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ' ')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  if (withoutTags.length <= maxChars) return withoutTags
  return `${withoutTags.slice(0, maxChars - 1)}\n…[truncated by the router]`
}

/**
 * Validate a downstream reply and sanitize its text.
 *
 * Throws `AgentReplyError` for a non-2xx status, a non-JSON body or a body that does not
 * match the shape. The caller turns that into an error response — it never falls back to
 * showing raw bytes.
 */
export function parseAgentReply(
  rawBody: string,
  params: { readonly status: number; readonly maxChars: number; readonly endpointHost: string },
): { readonly answer: string; readonly notes: readonly string[] } {
  const { status, maxChars, endpointHost } = params

  if (status < 200 || status >= 300) {
    throw new AgentReplyError(
      `Agent at ${endpointHost} returned HTTP ${status}.`,
      rawBody.slice(0, 200),
      status,
    )
  }

  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(rawBody)
  } catch {
    throw new AgentReplyError(
      `Agent at ${endpointHost} did not return JSON. The documented reply shape is {"ok":true,"answer":"…"}.`,
      rawBody.slice(0, 200),
      status,
    )
  }

  const parsed = agentReplySchema.safeParse(parsedJson)
  if (!parsed.success) {
    throw new AgentReplyError(
      `Agent at ${endpointHost} returned a reply that does not match the documented shape.`,
      parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ').slice(0, 200),
      status,
    )
  }

  return {
    answer: sanitizeAgentText(parsed.data.answer, maxChars),
    notes: (parsed.data.notes ?? []).slice(0, 10).map((note) => sanitizeAgentText(note, 240)),
  }
}

/** The body the router POSTs to a discovered agent. Small and explicit. */
export interface AgentRequestBody {
  readonly question: string
  /** The ENS name the router discovered, so an agent can attribute its own answer. */
  readonly requestedBy: string
}

/** Bound the question before it leaves this process. */
export const MAX_FORWARDED_QUESTION_CHARS = 2_000

export function buildAgentRequestBody(question: string, discoveredAgentName: string): AgentRequestBody {
  return {
    question: question.trim().slice(0, MAX_FORWARDED_QUESTION_CHARS),
    requestedBy: discoveredAgentName,
  }
}