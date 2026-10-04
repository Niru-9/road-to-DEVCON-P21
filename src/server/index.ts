/**
 * The API.
 *
 * A server-side boundary exists for one reason: the model credentials must never reach the
 * browser. The bundle contains no API key, no provider endpoint and no RPC URL. Everything
 * below runs in Node.
 *
 * Routes
 *   GET  /api/health     configuration the UI needs, redacted, plus the discovery state
 *   GET  /api/agents     the current discovered agent set (no chain read)
 *   POST /api/agents/refresh  re-run every enabled discovery strategy
 *   POST /api/route      ask a question; returns an attributed answer or an explicit no-agent
 *   GET  /api/cases      the recorded routing cases, for one-click demo
 *
 * Read-only discovery and routing never require a connected wallet. MetaMask is an optional
 * convenience in the UI; nothing on this server reads it.
 */

import { existsSync } from 'node:fs'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'

import express from 'express'
import type { Request, Response } from 'express'
import { z } from 'zod'

import { ConfigError, getConfig, toPublicConfigView, type AppConfig } from './config'
import { AgentDiscovery, describeDiscovery, type DevRegistry, type DiscoveryState } from './discovery'
import { createEnsClient, READ_RECORD_KEYS, type EnsTextReader } from './ens'
import {
  CandidateLimitError,
  ModelProviderError,
  ModelTimeoutError,
  PromptLeakageError,
} from './llm'
import { AgentReplyError, AgentTimeoutError } from './forward'
import { routeRequest, type RouteDeps } from './route'
import { ModelOutputError } from '../shared/routing-decision'
import { ROUTING_CASES, ROUTING_CASE_LIST } from '../shared/routing-cases'
import {
  AGENT_RECORD_FORMAT_VERSION,
  AGENT_RECORD_KEYS,
  REGISTRY_RECORD_KEY,
  checkEndpointPolicy,
} from '../shared/agent-record'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolvePath(here, '..', '..')

// ---------------------------------------------------------------------------
// Request validation
// ---------------------------------------------------------------------------

const MAX_QUESTION_LENGTH = 2_000
const MAX_BODY = '32kb'

const routeSchema = z.object({
  question: z
    .string()
    .trim()
    .min(3, 'Ask a question of at least 3 characters.')
    .max(MAX_QUESTION_LENGTH, `Keep the question under ${MAX_QUESTION_LENGTH} characters.`),
  /**
   * Refresh discovery first. Explicit rather than implicit, so a slow chain read never
   * silently happens inside a question.
   */
  refreshFirst: z.boolean().optional().default(false),
})

function fail(res: Response, status: number, code: string, message: string, extra?: unknown): void {
  res.status(status).json({ error: { code, message, ...(extra ? { detail: extra } : {}) } })
}

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

function discoverySummary(state: DiscoveryState) {
  return {
    status: state.status,
    root: state.root,
    strategies: state.strategies,
    reports: state.reports,
    agentCount: state.agents.length,
    rejectedCount: state.rejected.length,
    rejected: state.rejected,
    emptyProfiles: state.emptyProfiles,
    usedDevRegistry: state.usedDevRegistry,
    devRegistryNotice: state.devRegistryNotice,
    refreshedAt: state.refreshedAt,
    durationMs: state.durationMs,
    fromCache: state.fromCache,
    error: state.error,
    notices: state.notices,
    agents: state.agents.map((agent) => ({
      ensName: agent.ensName,
      address: agent.address,
      capability: agent.capability,
      // The endpoint host is safe to show; the full URL is not, in case a record carries a
      // query string. The router always fetches the full value.
      endpointHost: hostOf(agent.endpoint),
      endpointProtocol: protocolOf(agent.endpoint),
      accepts: agent.accepts,
      version: agent.version,
      source: agent.source,
      warnings: agent.warnings,
      recordStatus: agent.recordStatus,
    })),
  }
}

function hostOf(endpoint: string): string {
  try {
    return new URL(endpoint).host
  } catch {
    return 'unknown'
  }
}

function protocolOf(endpoint: string): string {
  try {
    return new URL(endpoint).protocol.replace(/:$/, '')
  } catch {
    return 'unknown'
  }
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

/**
 * Injection seams.
 *
 * Production passes nothing and gets the real provider call, the real RPC and the real
 * subgraph. Tests pass a fake `decide` to exercise the full route path — including the
 * membership check against a deliberately hostile model — with no network, and a fake
 * `readText` to serve ENS records from memory.
 */
export interface AppDeps {
  readonly route?: RouteDeps
  readonly readText?: EnsTextReader
  readonly readDevRegistry?: () => DevRegistry | null
  /**
   * A pre-built discovery instance. Production passes one so the boot warm-up and the routes
   * share the SAME active set — otherwise the first page load would show zero agents until the
   * client triggered a refresh, which reads as "discovery is broken".
   */
  readonly discovery?: AgentDiscovery
}

export function createApp(config: AppConfig, deps: AppDeps = {}) {
  const app = express()
  app.use(express.json({ limit: MAX_BODY }))

  const ensClient = createEnsClient(config.sepoliaRpcUrl, config.rpcTimeoutMs)
  const discovery =
    deps.discovery ??
    new AgentDiscovery(ensClient, config, {
      ...(deps.readText === undefined ? {} : { readText: deps.readText }),
      ...(deps.readDevRegistry === undefined ? {} : { readDevRegistry: deps.readDevRegistry }),
    })

  app.get('/api/health', (_req: Request, res: Response) => {
    const state = discovery.getState()
    const view = toPublicConfigView(config)

    res.json({
      ok: true,
      chain: 'sepolia',
      chainId: 11155111,
      config: view,
      discovery: {
        status: state.status,
        agentCount: state.agents.length,
        rejectedCount: state.rejected.length,
        usedDevRegistry: state.usedDevRegistry,
        refreshedAt: state.refreshedAt,
      },
      recordFormat: {
        version: AGENT_RECORD_FORMAT_VERSION,
        registryKey: REGISTRY_RECORD_KEY,
        agentKeys: AGENT_RECORD_KEYS,
      },
      /** Wallet-free by design, stated so the UI can say it out loud. */
      walletRequired: false,
      notice:
        'ENS reads are eth_call through the Universal Resolver. No wallet is needed to discover agents or route a request.',
    })
  })

  app.get('/api/agents', (_req: Request, res: Response) => {
    res.json(discoverySummary(discovery.getState()))
  })

  app.post('/api/agents/refresh', (_req: Request, res: Response) => {
    void discovery
      .discover({ forceRefresh: true })
      .then((state) => res.json(discoverySummary(state)))
      .catch((error: unknown) => handleUnexpected(res, error))
  })

  app.get('/api/cases', (_req: Request, res: Response) => {
    res.json({
      problem: ROUTING_CASES.problem,
      problemSlug: ROUTING_CASES.problemSlug,
      discoveryRoot: ROUTING_CASES.discoveryRoot,
      status: ROUTING_CASES.status,
      notes: ROUTING_CASES.notes,
      cases: ROUTING_CASE_LIST,
    })
  })

  /**
   * The endpoint policy, exposed so the operator can verify a value before publishing it.
   * Read-only and side-effect free: it parses and applies the same rule the router applies.
   */
  app.post('/api/check-endpoint', (req: Request, res: Response) => {
    const parsed = z.object({ endpoint: z.string() }).safeParse(req.body)
    if (!parsed.success) {
      fail(res, 400, 'BAD_REQUEST', 'Provide {"endpoint":"https://…"}.')
      return
    }

    const decision = checkEndpointPolicy(parsed.data.endpoint, {
      allowInsecureLocal: config.allowInsecureLocalAgents,
    })
    res.json({
      endpoint: parsed.data.endpoint.slice(0, 300),
      accepted: decision.ok,
      protocol: decision.protocol,
      normalized: decision.url,
      reason: decision.reason,
      allowInsecureLocal: config.allowInsecureLocalAgents,
    })
  })

  app.post('/api/route', (req: Request, res: Response) => {
    const parsed = routeSchema.safeParse(req.body)
    if (!parsed.success) {
      fail(res, 400, 'BAD_REQUEST', 'Provide a question in plain language.', parsed.error.issues)
      return
    }

    const { question, refreshFirst } = parsed.data

    void routeRequest({
      question,
      discovery,
      config,
      refreshFirst,
      ...(deps.route === undefined ? {} : { deps: deps.route }),
    })
      .then((result) => res.json(result))
      .catch((error: unknown) => {
        // `routeRequest` converts expected failures into responses, so reaching here is a bug.
        handleUnexpected(res, error)
      })
  })

  /**
   * Map the errors `routeRequest` can still throw (an invariant violation rather than an
   * expected outcome) onto HTTP codes, so a bug is visible rather than hidden behind a 200.
   */
  function handleUnexpected(res: Response, error: unknown): void {
    if (error instanceof ModelTimeoutError) {
      fail(res, 504, 'MODEL_TIMEOUT', error.message, { timeoutMs: error.timeoutMs })
      return
    }
    if (error instanceof ModelProviderError) {
      fail(res, 502, 'MODEL_ERROR', error.message, { status: error.status })
      return
    }
    if (error instanceof ModelOutputError) {
      fail(res, 502, 'MODEL_OUTPUT_UNUSABLE', error.message, { detail: error.detail })
      return
    }
    if (error instanceof AgentTimeoutError) {
      fail(res, 504, 'AGENT_TIMEOUT', error.message, { timeoutMs: error.timeoutMs })
      return
    }
    if (error instanceof AgentReplyError) {
      fail(res, 502, 'AGENT_REPLY_UNUSABLE', error.message, { detail: error.detail })
      return
    }
    if (error instanceof CandidateLimitError) {
      fail(res, 500, 'CANDIDATE_LIMIT', error.message, { sent: error.sent, limit: error.limit })
      return
    }
    if (error instanceof PromptLeakageError) {
      fail(res, 500, 'PROMPT_LEAKAGE', error.message, { leaks: error.leaks })
      return
    }
    const message = error instanceof Error ? error.message : String(error)
    // RPC timeouts and Node network failures land here.
    fail(res, 502, 'UPSTREAM_ERROR', `Could not complete the request: ${message}`)
  }

  app.use('/api', (_req: Request, res: Response) => {
    fail(res, 404, 'NOT_FOUND', 'Unknown API route.')
  })

  // Serve the built UI when it exists (production / single-port demo).
  const webDist = join(repoRoot, 'dist', 'web')
  if (existsSync(webDist)) {
    app.use(express.static(webDist))
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(join(webDist, 'index.html'))
    })
  }

  return app
}

/** Exposed so tests can inspect the same discovery the routes use. */
export type AppContext = ReturnType<typeof createApp>

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function main(): void {
  let config: AppConfig
  try {
    config = getConfig()
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`\n${error.message}\n`)
      process.exit(1)
    }
    throw error
  }

  const ensClient = createEnsClient(config.sepoliaRpcUrl, config.rpcTimeoutMs)
  // One instance, shared with `createApp`, so the warm-up below is what the first page load sees.
  const discovery = new AgentDiscovery(ensClient, config)
  const app = createApp(config, { discovery })
  const view = toPublicConfigView(config)

  app.listen(config.port, () => {
    console.log('')
    console.log('  ENS Agent Router')
    console.log('  ENS:      Sepolia (chain id 11155111)')
    console.log(`  Root:     ${view.discoveryRoot}  (roster via ${REGISTRY_RECORD_KEY})`)
    console.log(`  Sources:  ${view.discoverySources.join(', ')}  — order as configured`)
    console.log(`  Model:    ${view.model} @ ${view.providerHost}`)
    console.log(`  Timeouts: model ${view.timeoutMs} ms, downstream agent ${view.agentTimeoutMs} ms`)
    console.log(`  Bound:    at most ${view.routeMaxCandidates} candidates per decision, ${view.maxAgents} names per discovery pass`)
    console.log(`  Endpoint: https required${view.allowInsecureLocalAgents ? ', with the localhost-only dev exception enabled' : ' (no exception)'}`)
    console.log(`  API key:  ${view.hasApiKey ? 'present (server-side only)' : 'not set (local provider is fine)'}`)
    console.log(`  RPC:      ${view.rpcHost}`)
    console.log('  Wallet:   not required — ENS reads are eth_call')
    console.log(`  Dev fallback: ${view.allowDevRegistryFallback ? 'allowed when live discovery is empty (always labelled)' : 'disabled'}`)
    console.log('')
    console.log(`  ready on http://localhost:${config.port}`)
    console.log('')
    void warmUp(discovery)
  })
}

/**
 * Run one discovery pass at boot so the first question is fast.
 *
 * Failure is non-fatal: the state carries the error and the UI offers a refresh button.
 */
async function warmUp(discovery: AgentDiscovery): Promise<void> {
  try {
    const state = await discovery.discover()
    console.log(`  discovery: ${describeDiscovery(state)}`)
    if (state.usedDevRegistry) {
      console.log('  NOTE: no agent records are published on Sepolia yet; showing the labelled dev fallback.')
    }
  } catch (error) {
    console.log(
      `  discovery: could not warm up (${error instanceof Error ? error.message : String(error)})`,
    )
  }
}

// Only start listening when executed directly, so tests can import createApp.
const invokedDirectly =
  process.argv[1] !== undefined &&
  resolvePath(process.argv[1]) === resolvePath(fileURLToPath(import.meta.url))

if (invokedDirectly) {
  main()
}

/** Documented format constants, re-exported for docs scripts. */
export { AGENT_RECORD_KEYS, REGISTRY_RECORD_KEY, AGENT_RECORD_FORMAT_VERSION }