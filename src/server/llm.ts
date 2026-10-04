/**
 * The routing model call.
 *
 * The model does exactly one thing here: name one of the candidates it was given, or `null`.
 * It has no authority. Whatever it returns still has to survive `verifyRoutingDecision`, which
 * is the only gate between a model string and a forwarded request.
 *
 * Every request is bounded by an explicit timeout, applied per attempt and always cleared in
 * `finally`, so a hung free tier can never hang the app and a pending timer can never hold the
 * event loop open.
 *
 * The API key builds an Authorization header and is never returned, logged or echoed back.
 */

import {
  ModelOutputError,
  parseRoutingDecision,
} from '../shared/routing-decision'
import {
  buildRoutingMessages,
  findPromptLeakage,
  type ChatMessage,
} from '../shared/routing-prompt'
import type { DiscoveredAgent } from '../shared/agent-record'
import { safeHost, type AppConfig } from './config'

export class ModelTimeoutError extends Error {
  readonly timeoutMs: number

  constructor(timeoutMs: number) {
    super(
      `The routing model did not respond within ${timeoutMs} ms. ` +
        `Free tiers are often slow or busy — try again, or raise LLM_TIMEOUT_MS.`,
    )
    this.name = 'ModelTimeoutError'
    this.timeoutMs = timeoutMs
  }
}

export class ModelProviderError extends Error {
  readonly status: number | null
  readonly providerHost: string

  constructor(message: string, status: number | null, providerHost: string) {
    super(message)
    this.name = 'ModelProviderError'
    this.status = status
    this.providerHost = providerHost
  }
}

/** Candidate text reached the system prompt. Structurally impossible; asserted anyway. */
export class PromptLeakageError extends Error {
  readonly leaks: readonly string[]

  constructor(leaks: readonly string[]) {
    super(
      `Refusing to call the model: untrusted record or request text reached the system prompt ` +
        `(${leaks.join('; ')}). This is a bug in the prompt builder.`,
    )
    this.name = 'PromptLeakageError'
    this.leaks = leaks
  }
}

/** The candidate limit was exceeded in code. Reaching this is a bug, so it fails loudly. */
export class CandidateLimitError extends Error {
  readonly sent: number
  readonly limit: number

  constructor(sent: number, limit: number) {
    super(
      `Refusing to call the model: ${sent} candidates were passed but the explicit limit is ${limit}. ` +
        `This is a bug in the discovery step.`,
    )
    this.name = 'CandidateLimitError'
    this.sent = sent
    this.limit = limit
  }
}

export interface ModelRoutingAnswer {
  /** Raw assistant content. Parsed and membership-checked by the caller before any forwarding. */
  readonly content: string
  readonly model: string
  /** Host only — never the full endpoint, query string or credentials. */
  readonly providerHost: string
  readonly durationMs: number
  readonly attempts: number
  readonly messages: readonly ChatMessage[]
}

export interface AskRoutingModelParams {
  readonly question: string
  readonly agents: readonly DiscoveredAgent[]
  readonly config: AppConfig
}

const MAX_ATTEMPTS = 3
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504])
const BASE_BACKOFF_MS = 600
const MAX_BACKOFF_MS = 8_000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Honour `Retry-After` when the provider sends it, bounded so we cannot hang. */
function backoffDelay(attempt: number, retryAfterHeader: string | null): number {
  const exponential = Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS)

  if (retryAfterHeader) {
    const seconds = Number(retryAfterHeader)
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, MAX_BACKOFF_MS)
    }
    const asDate = Date.parse(retryAfterHeader)
    if (!Number.isNaN(asDate)) {
      return Math.min(Math.max(asDate - Date.now(), 0), MAX_BACKOFF_MS)
    }
  }

  return exponential
}

/** Duck-typed abort check: undici raises a DOMException, not always an `Error`. */
function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name?: unknown }).name === 'AbortError'
  )
}

interface CompletionResponse {
  model?: string
  choices?: Array<{
    message?: { content?: string | null; reasoning?: string | null }
    finish_reason?: string | null
  }>
}

/**
 * Ask the configured OpenAI-compatible endpoint to choose one discovered agent, or none.
 *
 * Retries a bounded number of times on rate limits and transient provider errors, honouring
 * `Retry-After`. Each attempt is individually bounded by the configured timeout.
 */
export async function askRoutingModel(params: AskRoutingModelParams): Promise<ModelRoutingAnswer> {
  const { question, agents, config } = params
  const startedAt = Date.now()
  const providerHost = safeHost(config.llmBaseUrl)

  // Enforced at the HTTP boundary, so the bound cannot be bypassed by a future caller.
  if (agents.length > config.agentRouteMaxCandidates) {
    throw new CandidateLimitError(agents.length, config.agentRouteMaxCandidates)
  }

  const messages = buildRoutingMessages(question, agents)

  // Belt-and-braces: prove no untrusted text reached the instruction slot.
  const leaks = findPromptLeakage(messages[0]!.content, agents, question)
  if (leaks.length > 0) throw new PromptLeakageError(leaks)

  // The endpoint is assembled from configuration, never from a literal.
  const endpoint = `${config.llmBaseUrl}/chat/completions`

  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (config.llmApiKey.length > 0) headers.authorization = `Bearer ${config.llmApiKey}`

  let lastError: unknown = null

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    // EXPLICIT TIMEOUT, per attempt.
    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort()
    }, config.llmTimeoutMs)

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers,
        signal: controller.signal,
        body: JSON.stringify({
          model: config.llmModel,
          messages,
          temperature: 0,
          stream: false,
          // The candidate list is bounded by AGENT_ROUTE_MAX_CANDIDATES and the reply is a
          // two-field JSON object, so the cost of a routing decision is known on both sides.
          max_tokens: config.llmMaxTokens,
          // A reasoning model left thinking spends the whole budget on private reasoning and
          // returns an empty answer, which is indistinguishable from a broken provider.
          think: false,
        }),
      })

      if (!response.ok) {
        const detail = await response.text().catch(() => '')
        const error = new ModelProviderError(
          `Model provider (${providerHost}) returned ${response.status} ${response.statusText}. ${detail.slice(0, 300)}`,
          response.status,
          providerHost,
        )

        if (RETRYABLE_STATUS.has(response.status) && attempt < MAX_ATTEMPTS) {
          await sleep(backoffDelay(attempt, response.headers.get('retry-after')))
          lastError = error
          continue
        }
        throw error
      }

      const payload = (await response.json()) as CompletionResponse
      const choice = payload.choices?.[0]
      const content = choice?.message?.content

      if (typeof content !== 'string' || content.trim().length === 0) {
        const thoughtOnly =
          typeof choice?.message?.reasoning === 'string' && choice.message.reasoning.trim().length > 0

        throw new ModelProviderError(
          thoughtOnly
            ? `Model provider (${providerHost}) used the whole ${config.llmMaxTokens}-token budget on private reasoning and returned no answer` +
                ` (finish_reason ${choice?.finish_reason ?? 'unknown'}). Raise LLM_MAX_TOKENS, or use a model that answers directly.`
            : `Model provider (${providerHost}) returned an empty answer.`,
          response.status,
          providerHost,
        )
      }

      return {
        content: content.trim(),
        model:
          typeof payload.model === 'string' && payload.model.length > 0 ? payload.model : config.llmModel,
        providerHost,
        durationMs: Date.now() - startedAt,
        attempts: attempt,
        messages,
      }
    } catch (error) {
      // A timeout is a hard stop: retrying a call that already exceeded its budget would
      // defeat the bound.
      if (isAbortError(error)) throw new ModelTimeoutError(config.llmTimeoutMs)

      if (error instanceof ModelProviderError) throw error

      lastError = error

      if (attempt < MAX_ATTEMPTS) {
        await sleep(backoffDelay(attempt, null))
        continue
      }

      throw new ModelProviderError(
        `Could not reach the model provider (${providerHost}): ${
          error instanceof Error ? error.message : String(error)
        }. Check LLM_BASE_URL in your .env.`,
        null,
        providerHost,
      )
    } finally {
      // Always clear, so a pending timer can never hold the event loop open.
      clearTimeout(timer)
    }
  }

  throw new ModelProviderError(
    `Model provider (${providerHost}) failed after ${MAX_ATTEMPTS} attempts: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
    null,
    providerHost,
  )
}

/**
 * Ask the model and immediately parse its answer into a `{ agentName, reason }` decision.
 *
 * Split out so the caller cannot accidentally use an unparsed string, and so tests can drive
 * the full route path with one seam.
 */
export async function decideRoute(params: AskRoutingModelParams): Promise<{
  readonly decision: { readonly agentName: string | null; readonly reason: string }
  readonly answer: ModelRoutingAnswer
}> {
  const answer = await askRoutingModel(params)
  const decision = parseRoutingDecision(answer.content, answer.model)
  return { decision, answer }
}

export { ModelOutputError }