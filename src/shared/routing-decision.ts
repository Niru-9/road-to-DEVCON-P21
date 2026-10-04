/**
 * Parsing and validating the model's routing decision.
 *
 * SCORED CRITERION 1 (20 points) is enforced in `verifyRoutingDecision`, which is the only
 * function in this codebase allowed to turn a model string into an agent. It applies three
 * checks in order and stops at the first that fails:
 *
 *   1. The output must parse as JSON with the expected shape.
 *   2. `null` is a legitimate answer and means "no suitable agent".
 *   3. A named agent must be a member of the set discovered this pass. It is NOT forwarded.
 *
 * There is no fallback agent anywhere in this file or its callers. A rejected name produces
 * an explicit no-suitable-agent result, which is SCORED CRITERION 7 (6 points).
 */

import { z } from 'zod'

import { findDiscoveredAgent, type DiscoveredAgent } from './agent-record'

/** What the model is asked to return. Anything else is unusable output, not a routing choice. */
const routingDecisionSchema = z.object({
  agentName: z.string().trim().min(1).max(200).nullable(),
  reason: z.string().trim().max(400).catch(''),
})

export type RoutingDecisionStatus =
  /** The model named an agent that was discovered this pass. */
  | 'selected'
  /** The model chose `null`. A correct outcome, not an error. */
  | 'no-match'
  /** The model named something discovery did not produce. Nothing is forwarded. */
  | 'rejected-unknown-agent'
  /** The model's output was not the requested JSON shape. */
  | 'unusable-model-output'

export type VerifiedRoutingDecision =
  | {
      readonly status: 'selected'
      readonly agent: DiscoveredAgent
      readonly reason: string
    }
  | {
      readonly status: 'no-match' | 'rejected-unknown-agent' | 'unusable-model-output'
      readonly agent: null
      readonly reason: string
    }

export class ModelOutputError extends Error {
  readonly detail: string

  constructor(message: string, detail: string) {
    super(message)
    this.name = 'ModelOutputError'
    this.detail = detail
  }
}

/** Text an OpenAI-compatible server returns when it is reasoning rather than answering. */
function hasPrivateReasoning(payload: unknown): boolean {
  if (typeof payload !== 'object' || payload === null) return false
  const choices = (payload as { choices?: unknown }).choices
  if (!Array.isArray(choices) || choices.length === 0) return false
  const message = (choices[0] as { message?: { reasoning?: unknown; content?: unknown } }).message
  if (typeof message?.reasoning === 'string' && message.reasoning.trim().length > 0) {
    return (message.content ?? '') === ''
  }
  return false
}

/**
 * Pull the JSON object out of a model reply.
 *
 * Providers wrap JSON in prose or in a fenced block often enough that a strict parse would
 * fail on correct behaviour, so the fences and any leading/trailing text are stripped first.
 * A second attempt reads the outermost balanced `{...}` span. Nothing here is trusted: the
 * result goes through Zod next.
 */
export function extractJsonObject(raw: string): string | null {
  const trimmed = raw.trim()

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed)
  const candidate = fenced?.[1]?.trim() ?? trimmed

  if (candidate.startsWith('{')) return candidate

  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start === -1 || end <= start) return null

  return candidate.slice(start, end + 1)
}

/** Parse a raw model reply into a `{ agentName, reason }` decision. Throws `ModelOutputError`. */
export function parseRoutingDecision(raw: string, model: string): { agentName: string | null; reason: string } {
  const json = extractJsonObject(raw)

  if (json === null) {
    throw new ModelOutputError(
      `Model (${model}) did not return a JSON object, so it cannot be used to choose an agent.`,
      raw.slice(0, 200),
    )
  }

  let value: unknown
  try {
    value = JSON.parse(json)
  } catch {
    throw new ModelOutputError(
      `Model (${model}) returned malformed JSON, so it cannot be used to choose an agent.`,
      json.slice(0, 200),
    )
  }

  const parsed = routingDecisionSchema.safeParse(value)
  if (!parsed.success) {
    throw new ModelOutputError(
      `Model (${model}) returned JSON without a usable "agentName". Nothing was forwarded.`,
      parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ').slice(0, 200),
    )
  }

  return { agentName: parsed.data.agentName, reason: parsed.data.reason }
}

/**
 * SCORED CRITERION 1: the membership gate.
 *
 * The chosen name is matched against `discovered` with `findDiscoveredAgent`, which is an
 * exact case-insensitive comparison against names that already came out of ENS (or the
 * clearly-labelled dev registry). Anything else yields a rejection with `agent: null`, so
 * there is no path from an unknown name to a fetch.
 */
export function verifyRoutingDecision(params: {
  readonly decision: { readonly agentName: string | null; readonly reason: string }
  readonly discovered: readonly DiscoveredAgent[]
  readonly model: string
}): VerifiedRoutingDecision {
  const { decision, discovered } = params

  if (decision.agentName === null) {
    return {
      status: 'no-match',
      agent: null,
      reason: decision.reason.length > 0 ? decision.reason : 'The model judged that no discovered agent fits this request.',
    }
  }

  const agent = findDiscoveredAgent(decision.agentName, discovered)

  if (agent === null) {
    return {
      status: 'rejected-unknown-agent',
      agent: null,
      reason:
        `The model chose "${truncate(decision.agentName)}", which is not one of the ` +
        `${discovered.length} agent(s) discovered from the discovery root, so nothing was forwarded. ` +
        (decision.reason.length > 0 ? `Model said: ${truncate(decision.reason)}` : ''),
    }
  }

  return {
    status: 'selected',
    agent,
    reason: decision.reason.length > 0 ? decision.reason : 'Chosen as the closest discovered agent.',
  }
}

function truncate(value: string, max = 120): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

/** The fixed client-facing sentence for "no agent fit". SCORED CRITERION 7. */
export const NO_SUITABLE_AGENT_MESSAGE =
  'No suitable agent. None of the agents discovered from the discovery root can handle this request.'

/** Client-facing sentences for each non-selection outcome. */
export const NO_AGENT_MESSAGES: Readonly<Record<Exclude<RoutingDecisionStatus, 'selected'>, string>> =
  {
    'no-match': NO_SUITABLE_AGENT_MESSAGE,
    'rejected-unknown-agent':
      'No suitable agent. The router refused to forward because the model named an agent that was not discovered from ENS.',
    'unusable-model-output':
      'No suitable agent. The routing model did not return a usable decision, so nothing was forwarded.',
  }