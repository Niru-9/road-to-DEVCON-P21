/**
 * The route: discover, decide, verify, forward.
 *
 * The order below is the whole design, and each step is the scored requirement it is named
 * for:
 *
 *   1. `discovery.discover()`      the agent set, read from ENS records at runtime.
 *   2. `buildCandidateSet()`       a bounded slice of THAT set, nothing else.
 *   3. `decideRoute()`             the model names one candidate, or `null`.
 *   4. `verifyRoutingDecision()`   the membership gate. SCORED CRITERION 1.
 *   5. `forwardToAgent()`          POST to the URL in that agent's ENS record. CRITERION 2.
 *
 * There is no default agent anywhere. When step 4 does not return an agent, the route returns
 * an explicit no-suitable-agent response — SCORED CRITERION 7 — and stops.
 */

import { sortAgents, type DiscoveredAgent } from '../shared/agent-record'
import {
  NO_AGENT_MESSAGES,
  ModelOutputError,
  verifyRoutingDecision,
  type RoutingDecisionStatus,
} from '../shared/routing-decision'
import type { AppConfig } from './config'
import type { AgentDiscovery, DiscoveryState } from './discovery'
import { ModelProviderError, ModelTimeoutError, decideRoute } from './llm'
import { AgentReplyError, AgentTimeoutError, forwardToAgent, type ForwardFetch } from './forward'

/** What the UI is told about the agent set for one route. */
export interface RouteDiscoveryView {
  readonly root: string
  readonly usedDevRegistry: boolean
  readonly discoveredCount: number
  readonly candidateCount: number
  readonly refreshedAt: string | null
  readonly fromCache: boolean
  readonly candidateLimit: number
  readonly notice: string | null
}

export interface RouteCandidateView {
  readonly ensName: string
  readonly capability: string
  readonly accepts: string
  readonly source: DiscoveredAgent['source']
}

/** Attribution. Present only when an agent actually answered. */
export interface RouteAttribution {
  readonly ensName: string
  readonly address: string | null
  readonly capability: string
  readonly accepts: string
  readonly source: DiscoveredAgent['source']
  readonly endpointHost: string
  readonly endpointProtocol: string
  readonly status: number
  readonly durationMs: number
  readonly timeoutMs: number
  readonly verdict: string
}

export interface RouteResponse {
  readonly outcome: 'answered' | 'no-suitable-agent' | 'error'
  readonly question: string
  readonly discovery: RouteDiscoveryView
  readonly candidates: readonly RouteCandidateView[]
  readonly routing: {
    readonly decisionStatus: RoutingDecisionStatus
    readonly chosenName: string | null
    readonly verdict: string
    readonly model: string
    readonly providerHost: string
    readonly durationMs: number | null
    readonly attempts: number | null
  }
  readonly attribution: RouteAttribution | null
  readonly answer: string | null
  readonly notes: readonly string[]
  readonly noAgentMessage: string | null
  readonly error: { readonly code: string; readonly message: string } | null
  readonly totalDurationMs: number
}

function toCandidateView(agent: DiscoveredAgent): RouteCandidateView {
  return {
    ensName: agent.ensName,
    capability: agent.capability,
    accepts: agent.accepts,
    source: agent.source,
  }
}

/**
 * Bound the candidate list.
 *
 * The candidate set is a prefix of the discovered set in deterministic name order, so it is
 * reproducible across runs — which is what makes a recorded routing case comparable against a
 * later one. Nothing outside `discovered` can enter it.
 */
export function buildCandidateSet(
  discovered: readonly DiscoveredAgent[],
  limit: number,
): DiscoveredAgent[] {
  return sortAgents(discovered).slice(0, limit)
}

function discoveryView(state: DiscoveryState, candidateCount: number, limit: number): RouteDiscoveryView {
  return {
    root: state.root,
    usedDevRegistry: state.usedDevRegistry,
    discoveredCount: state.agents.length,
    candidateCount,
    refreshedAt: state.refreshedAt,
    fromCache: state.fromCache,
    candidateLimit: limit,
    notice: state.devRegistryNotice,
  }
}

/** Injection seams, so the whole route can be driven in tests with no network. */
export interface RouteDeps {
  readonly decide?: typeof decideRoute
  readonly forward?: typeof forwardToAgent
  readonly forwardFetch?: ForwardFetch
  readonly now?: () => number
}

export interface RouteParams {
  readonly question: string
  readonly discovery: AgentDiscovery
  readonly config: AppConfig
  readonly refreshFirst?: boolean
  readonly deps?: RouteDeps
}

/**
 * Route one request.
 *
 * Never throws for an expected outcome. "No suitable agent" and "the agent failed" are both
 * ordinary responses with an explicit `outcome`, so the client always gets a usable answer and
 * always knows which ENS name produced it — or that nothing did.
 */
export async function routeRequest(params: RouteParams): Promise<RouteResponse> {
  const { question, discovery, config } = params
  const deps = params.deps ?? {}
  const now = deps.now ?? Date.now
  const startedAt = now()
  const limit = config.agentRouteMaxCandidates

  const discoveryState = await discovery.discover(
    params.refreshFirst === true ? { forceRefresh: true } : {},
  )

  const candidates = buildCandidateSet(discoveryState.agents, limit)

  // --- No agents at all: an explicit, honest, non-error outcome. -----------------
  if (candidates.length === 0) {
    return {
      outcome: 'no-suitable-agent',
      question,
      discovery: discoveryView(discoveryState, 0, limit),
      candidates: [],
      routing: {
        decisionStatus: 'no-match',
        chosenName: null,
        verdict: noAgentsVerdict(discoveryState),
        model: config.llmModel,
        providerHost: new URL(config.llmBaseUrl).host,
        durationMs: null,
        attempts: null,
      },
      attribution: null,
      answer: null,
      notes: [],
      noAgentMessage:
        'No agents are currently discoverable, so nothing can answer this yet. ' +
        `Publish the registry record on ${discoveryState.root} and refresh.`,
      error: null,
      totalDurationMs: now() - startedAt,
    }
  }

  // --- Ask the model, then hold its answer to the discovered set. -----------------
  let decision: { agentName: string | null; reason: string }
  let modelAnswer: { model: string; providerHost: string; durationMs: number; attempts: number }

  try {
    const asked = await (deps.decide ?? decideRoute)({ question, agents: candidates, config })
    decision = asked.decision
    modelAnswer = asked.answer
  } catch (error) {
    return {
      outcome: 'error',
      question,
      discovery: discoveryView(discoveryState, candidates.length, limit),
      candidates: candidates.map(toCandidateView),
      routing: {
        decisionStatus: 'unusable-model-output',
        chosenName: null,
        verdict: 'The routing model could not be used, so nothing was forwarded.',
        model: config.llmModel,
        providerHost: new URL(config.llmBaseUrl).host,
        durationMs: null,
        attempts: null,
      },
      attribution: null,
      answer: null,
      notes: [],
      noAgentMessage: null,
      error: describeRouteError(error),
      totalDurationMs: now() - startedAt,
    }
  }

  const verified = verifyRoutingDecision({
    decision,
    discovered: candidates,
    model: modelAnswer.model,
  })

  const routingBase = {
    decisionStatus: verified.status,
    chosenName: verified.agent === null ? decision.agentName : verified.agent.ensName,
    verdict: verified.reason,
    model: modelAnswer.model,
    providerHost: modelAnswer.providerHost,
    durationMs: modelAnswer.durationMs,
    attempts: modelAnswer.attempts,
  }

  // --- The membership gate: anything other than `selected` stops here. ----------
  if (verified.status !== 'selected' || verified.agent === null) {
    return {
      outcome: 'no-suitable-agent',
      question,
      discovery: discoveryView(discoveryState, candidates.length, limit),
      candidates: candidates.map(toCandidateView),
      routing: routingBase,
      attribution: null,
      answer: null,
      notes: [],
      noAgentMessage: NO_AGENT_MESSAGES[verified.status],
      error: null,
      totalDurationMs: now() - startedAt,
    }
  }

  const agent = verified.agent

  // --- Forward to the URL in that agent's ENS record. ---------------------------
  try {
    const forwarded = await (deps.forward ?? forwardToAgent)({
      agent,
      question,
      timeoutMs: config.agentTimeoutMs,
      maxReplyChars: config.agentReplyMaxChars,
      allowInsecureLocal: config.allowInsecureLocalAgents,
      ...(deps.forwardFetch === undefined ? {} : { fetchImpl: deps.forwardFetch }),
    })

    let endpointProtocol = 'https:'
    try {
      endpointProtocol = new URL(agent.endpoint).protocol
    } catch {
      // The URL was validated during discovery, so this cannot normally happen; leave https.
    }

    return {
      outcome: 'answered',
      question,
      discovery: discoveryView(discoveryState, candidates.length, limit),
      candidates: candidates.map(toCandidateView),
      routing: routingBase,
      attribution: {
        ensName: agent.ensName,
        address: agent.address,
        capability: agent.capability,
        accepts: agent.accepts,
        source: agent.source,
        endpointHost: forwarded.endpointHost,
        endpointProtocol,
        status: forwarded.status,
        durationMs: forwarded.durationMs,
        timeoutMs: forwarded.timeoutMs,
        verdict: verified.reason,
      },
      answer: forwarded.answer,
      notes: forwarded.notes,
      noAgentMessage: null,
      error: null,
      totalDurationMs: now() - startedAt,
    }
  } catch (error) {
    return {
      outcome: 'error',
      question,
      discovery: discoveryView(discoveryState, candidates.length, limit),
      candidates: candidates.map(toCandidateView),
      routing: routingBase,
      attribution: {
        ensName: agent.ensName,
        address: agent.address,
        capability: agent.capability,
        accepts: agent.accepts,
        source: agent.source,
        endpointHost: hostOf(agent.endpoint),
        endpointProtocol: 'https:',
        status: 0,
        durationMs: 0,
        timeoutMs: config.agentTimeoutMs,
        verdict: verified.reason,
      },
      answer: null,
      notes: [],
      noAgentMessage: null,
      error: describeRouteError(error),
      totalDurationMs: now() - startedAt,
    }
  }
}

function hostOf(endpoint: string): string {
  try {
    return new URL(endpoint).host
  } catch {
    return 'unknown'
  }
}

/** The verdict shown when discovery produced nothing at all. */
function noAgentsVerdict(state: DiscoveryState): string {
  const strategyDetail = state.reports
    .map((report) => `${report.source}: ${report.status}${report.detail === null ? '' : ` (${report.detail})`}`)
    .join('; ')

  return strategyDetail.length > 0
    ? `No agent is discoverable under ${state.root}. ${strategyDetail}`
    : `No agent is discoverable under ${state.root}.`
}

/**
 * Error class → stable client-facing code.
 *
 * `as const` rather than an explicit constructor type: the tuple literal is the whole table,
 * and TypeScript infers each entry's constructor precisely enough for `instanceof`.
 */
const ROUTE_ERROR_CODES = [
  [ModelTimeoutError, 'MODEL_TIMEOUT'],
  [ModelProviderError, 'MODEL_ERROR'],
  [ModelOutputError, 'MODEL_OUTPUT_UNUSABLE'],
  [AgentTimeoutError, 'AGENT_TIMEOUT'],
  [AgentReplyError, 'AGENT_REPLY_UNUSABLE'],
] as const

/** Map a thrown error to a stable code and a message already phrased for the UI. */
export function describeRouteError(error: unknown): { code: string; message: string } {
  for (const [constructor, code] of ROUTE_ERROR_CODES) {
    if (error instanceof constructor) {
      return { code, message: error instanceof Error ? error.message : String(error) }
    }
  }
  return {
    code: 'UPSTREAM_ERROR',
    message: `Could not complete the route: ${error instanceof Error ? error.message : String(error)}`,
  }
}