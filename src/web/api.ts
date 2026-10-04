/**
 * Typed client for this app's own API.
 *
 * Everything the browser needs comes through here. The bundle contains no model API key, no RPC
 * URL and no ENS record data: the wallet module is the only thing that touches an injected
 * provider, and it only asks which account and chain it is on.
 */

export interface PublicConfigView {
  providerHost: string
  model: string
  timeoutMs: number
  maxTokens: number
  hasApiKey: boolean
  rpcHost: string
  rpcTimeoutMs: number
  discoveryRoot: string
  discoverySources: string[]
  recordFormatVersion: string
  maxAgents: number
  cacheTtlMs: number
  agentTimeoutMs: number
  agentReplyMaxChars: number
  allowInsecureLocalAgents: boolean
  allowDevRegistryFallback: boolean
  routeMaxCandidates: number
}

export interface HealthResponse {
  ok: boolean
  chain: string
  chainId: number
  config: PublicConfigView
  discovery: {
    status: string
    agentCount: number
    rejectedCount: number
    usedDevRegistry: boolean
    refreshedAt: string | null
  }
  recordFormat: { version: string; registryKey: string; agentKeys: Record<string, string> }
  walletRequired: boolean
  notice: string
}

export interface StrategyReport {
  source: string
  status: string
  namesFound: string[]
  detail: string | null
}

export interface DiscoveredAgentView {
  ensName: string
  address: string | null
  capability: string
  endpointHost: string
  endpointProtocol: string
  accepts: string
  version: string | null
  source: 'ens' | 'dev-registry'
  warnings: string[]
}

export interface RejectedAgentView {
  ensName: string
  reason: string
  detail: string
  source: string
}

export interface DiscoveryResponse {
  status: string
  root: string
  strategies: string[]
  reports: StrategyReport[]
  agentCount: number
  rejectedCount: number
  rejected: RejectedAgentView[]
  emptyProfiles: number
  usedDevRegistry: boolean
  devRegistryNotice: string | null
  refreshedAt: string | null
  durationMs: number | null
  fromCache: boolean
  error: string | null
  notices: string[]
  agents: DiscoveredAgentView[]
}

export interface RouteCandidateView {
  ensName: string
  capability: string
  accepts: string
  source: string
}

export interface RouteResponse {
  outcome: 'answered' | 'no-suitable-agent' | 'error'
  question: string
  discovery: {
    root: string
    usedDevRegistry: boolean
    discoveredCount: number
    candidateCount: number
    refreshedAt: string | null
    fromCache: boolean
    candidateLimit: number
    notice: string | null
  }
  candidates: RouteCandidateView[]
  routing: {
    decisionStatus: string
    chosenName: string | null
    verdict: string
    model: string
    providerHost: string
    durationMs: number | null
    attempts: number | null
  }
  attribution: {
    ensName: string
    address: string | null
    capability: string
    accepts: string
    source: string
    endpointHost: string
    endpointProtocol: string
    status: number
    durationMs: number
    timeoutMs: number
    verdict: string
  } | null
  answer: string | null
  notes: string[]
  noAgentMessage: string | null
  error: { code: string; message: string } | null
  totalDurationMs: number
}

export interface RoutingCase {
  id: string
  question: string
  expectAgent: string | null
  why: string
}

export interface CasesResponse {
  problem: string
  problemSlug: string
  discoveryRoot: string
  status: string
  notes: string[]
  cases: RoutingCase[]
}

export class ApiError extends Error {
  readonly code: string

  constructor(message: string, code = 'REQUEST_FAILED') {
    super(message)
    this.name = 'ApiError'
    this.code = code
  }
}

async function getJson<T>(path: string): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, { headers: { accept: 'application/json' } })
  } catch (error) {
    throw new ApiError(
      `Could not reach the router API. Is it running on port 8789? (${
        error instanceof Error ? error.message : String(error)
      })`,
      'API_UNREACHABLE',
    )
  }

  const text = await response.text()
  let payload: unknown
  try {
    payload = text.length === 0 ? null : JSON.parse(text)
  } catch {
    throw new ApiError(`The router API returned a non-JSON response (HTTP ${response.status}).`)
  }

  if (!response.ok) {
    const error = (payload as { error?: { code?: string; message?: string } } | null)?.error
    throw new ApiError(error?.message ?? `HTTP ${response.status}`, error?.code ?? 'HTTP_ERROR')
  }

  return payload as T
}

export const api = {
  health: () => getJson<HealthResponse>('/api/health'),
  agents: () => getJson<DiscoveryResponse>('/api/agents'),
  refreshAgents: async () => {
    const response = await fetch('/api/agents/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
    })
    if (!response.ok) throw new ApiError(`Refresh failed (HTTP ${response.status}).`)
    return (await response.json()) as DiscoveryResponse
  },
  route: async (question: string, refreshFirst: boolean) => {
    const response = await fetch('/api/route', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ question, refreshFirst }),
    })
    const text = await response.text()
    let payload: unknown
    try {
      payload = text.length === 0 ? null : JSON.parse(text)
    } catch {
      throw new ApiError(`The router returned a non-JSON response (HTTP ${response.status}).`)
    }
    if (!response.ok) {
      const error = (payload as { error?: { code?: string; message?: string } } | null)?.error
      throw new ApiError(error?.message ?? `HTTP ${response.status}`, error?.code ?? 'HTTP_ERROR')
    }
    return payload as RouteResponse
  },
  cases: () => getJson<CasesResponse>('/api/cases'),
}