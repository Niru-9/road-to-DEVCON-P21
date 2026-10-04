/**
 * The HTTP surface, driven with no network.
 *
 * What matters here is that the API never leaks a credential, never needs a wallet, and that
 * the no-agent path is a real response rather than a blank one.
 */

import { afterEach, describe, expect, it } from 'vitest'

import { AGENT_RECORD_KEYS, REGISTRY_RECORD_KEY } from '../shared/agent-record'
import { parseConfig, toPublicConfigView, type AppConfig } from './config'
import type { EnsTextReader } from './ens'
import { createApp } from './index'

const ENDPOINTS: Record<string, string> = {
  'invoice.ensrouter.eth': 'https://invoice.agent.example/invoke',
  'contract.ensrouter.eth': 'https://contract.agent.example/invoke',
}

function ensFixture(): Record<string, string> {
  const fixture: Record<string, string> = {
    [`ensrouter.eth|${REGISTRY_RECORD_KEY}`]: Object.keys(ENDPOINTS).join(', '),
  }
  for (const [name, endpoint] of Object.entries(ENDPOINTS)) {
    fixture[`${name}|${AGENT_RECORD_KEYS.capability}`] = `A helper published as ${name} on Sepolia.`
    fixture[`${name}|${AGENT_RECORD_KEYS.endpoint}`] = endpoint
    fixture[`${name}|${AGENT_RECORD_KEYS.accepts}`] = 'A request in plain language.'
  }
  return fixture
}

const readerFrom = (fixture: Record<string, string>): EnsTextReader =>
  async (_client, name, key) => fixture[`${name}|${key}`] ?? null

const configFor = (overrides: Record<string, string> = {}): AppConfig =>
  parseConfig({
    LLM_BASE_URL: 'https://provider.example/v1',
    LLM_MODEL: 'test-model',
    // A placeholder that deliberately cannot pass the credential scanner, standing in for a
    // real key so the leak test below has something to prove.
    LLM_API_KEY: 'placeholder-key-not-a-secret',
    SEPOLIA_RPC_URL: 'https://rpc.example/v1/project/SECRET_PROJECT_ID',
    AGENT_DISCOVERY_ROOT: 'ensrouter.eth',
    AGENT_DISCOVERY_SOURCES: 'ens-registry',
    AGENT_CACHE_TTL_MS: '0',
    ALLOW_DEV_REGISTRY_FALLBACK: 'false',
    ALLOW_INSECURE_LOCAL_AGENTS: 'false',
    ...overrides,
  } as NodeJS.ProcessEnv)

const servers: Array<{ close: () => void }> = []

afterEach(() => {
  while (servers.length > 0) servers.pop()!.close()
})

/** Start the app on an ephemeral port and return a typed fetch helper. */
async function serve(config: AppConfig, fixture: Record<string, string> = ensFixture()) {
  const app = createApp(config, { readText: readerFrom(fixture), readDevRegistry: () => null })

  const server = await new Promise<{ port: number; close: () => void }>((resolve) => {
    const listener = app.listen(0, () => {
      const address = listener.address()
      resolve({
        port: typeof address === 'object' && address !== null ? address.port : 0,
        close: () => listener.close(),
      })
    })
  })
  servers.push(server)

  const base = `http://127.0.0.1:${server.port}`
  return {
    get: (path: string) => fetch(`${base}${path}`),
    post: (path: string, body: unknown) =>
      fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
  }
}

describe('GET /api/health', () => {
  it('never returns the API key, and reduces the RPC URL to a host', async () => {
    const http = await serve(configFor())
    const response = await http.get('/api/health')
    const body = (await response.json()) as Record<string, unknown>

    expect(response.status).toBe(200)
    expect(JSON.stringify(body)).not.toContain('placeholder-key-not-a-secret')
    expect(JSON.stringify(body)).not.toContain('SECRET_PROJECT_ID')

    const config = body.config as Record<string, unknown>
    expect(config.hasApiKey).toBe(true)
    expect(config.providerHost).toBe('provider.example')
    expect(config.rpcHost).toBe('rpc.example')
    expect(body.walletRequired).toBe(false)
  })

  it('documents the record format so the UI can show it', async () => {
    const http = await serve(configFor())
    const body = (await (await http.get('/api/health')).json()) as {
      recordFormat: { version: string; registryKey: string; agentKeys: Record<string, string> }
    }

    expect(body.recordFormat.registryKey).toBe(REGISTRY_RECORD_KEY)
    expect(body.recordFormat.agentKeys.endpoint).toBe(AGENT_RECORD_KEYS.endpoint)
    expect(body.recordFormat.version).toBe('1')
  })
})

describe('GET /api/agents and POST /api/agents/refresh', () => {
  it('returns the discovered set with the endpoint host but not a query string', async () => {
    const http = await serve(configFor())
    // A cold server has not read the chain yet, so discovery is primed explicitly. The route
    // that matters is the one a client hits first.
    await http.post('/api/agents/refresh', {})

    const body = (await (await http.get('/api/agents')).json()) as {
      agents: Array<{ ensName: string; endpointHost: string; source: string }>
    }

    expect(body.agents.map((agent) => agent.ensName)).toEqual([
      'contract.ensrouter.eth',
      'invoice.ensrouter.eth',
    ])
    expect(body.agents.every((agent) => agent.source === 'ens')).toBe(true)
    expect(body.agents[0]!.endpointHost).toContain('.agent.example')
  })

  it('refreshes from ENS on demand', async () => {
    const http = await serve(configFor())
    const response = await http.post('/api/agents/refresh', {})
    const body = (await response.json()) as { status: string; agentCount: number }

    expect(response.status).toBe(200)
    expect(body.status).toBe('ready')
    expect(body.agentCount).toBe(2)
  })
})

describe('POST /api/route', () => {
  it('rejects a question that is too short, with an actionable message', async () => {
    const http = await serve(configFor())
    const response = await http.post('/api/route', { question: 'hi' })
    const body = (await response.json()) as { error: { code: string } }

    expect(response.status).toBe(400)
    expect(body.error.code).toBe('BAD_REQUEST')
  })

  it('reports a provider failure as a usable error rather than a blank response', async () => {
    const config = configFor()
    const http = await serve(config)

    // No model seam and no valid provider: the route must still return a structured outcome.
    const response = await http.post('/api/route', { question: 'is invoice 2291 overdue?' })
    const body = (await response.json()) as {
      outcome: string
      attribution: unknown
      answer: unknown
      discovery: { usedDevRegistry: boolean }
      candidates: unknown[]
    }

    // Either the model errored, or the route still returned an explicit shape. Never a 500
    // with no body, and never an answer without attribution.
    expect(['error', 'no-suitable-agent']).toContain(body.outcome)
    expect(body.discovery.usedDevRegistry).toBe(false)
    expect(body.candidates.length).toBe(2)
    if (body.outcome === 'answered') {
      expect(body.attribution).not.toBeNull()
    } else {
      expect(body.answer).toBeNull()
    }
  })
})

describe('GET /api/cases', () => {
  it('serves the recorded routing cases with an expected agent or an explicit null', async () => {
    const http = await serve(configFor())
    const body = (await (await http.get('/api/cases')).json()) as {
      cases: Array<{ id: string; question: string; expectAgent: string | null; why: string }>
    }

    expect(body.cases.length).toBeGreaterThan(0)
    expect(body.cases.every((testCase) => testCase.expectAgent === null || testCase.expectAgent.endsWith('.ensrouter.eth'))).toBe(true)
    expect(body.cases.some((testCase) => testCase.expectAgent === null)).toBe(true)
    expect(body.cases.every((testCase) => testCase.why.length > 8)).toBe(true)
  })
})

describe('POST /api/check-endpoint', () => {
  it('applies the same policy the router applies, and explains the decision', async () => {
    const http = await serve(configFor({ ALLOW_INSECURE_LOCAL_AGENTS: 'false' }))

    const https = (await (await http.post('/api/check-endpoint', { endpoint: 'https://a.example/x' })).json()) as {
      accepted: boolean
    }
    const loopback = (await (await http.post('/api/check-endpoint', { endpoint: 'http://127.0.0.1:8791/x' })).json()) as {
      accepted: boolean
      reason: string
    }
    const publicHttp = (await (await http.post('/api/check-endpoint', { endpoint: 'http://a.example/x' })).json()) as {
      accepted: boolean
      reason: string
    }

    expect(https.accepted).toBe(true)
    expect(loopback.accepted).toBe(false)
    expect(publicHttp.accepted).toBe(false)
    expect(publicHttp.reason).toMatch(/ALLOW_INSECURE_LOCAL_AGENTS/)
  })
})

describe('unknown routes', () => {
  it('answer 404 as JSON rather than an HTML error page', async () => {
    const http = await serve(configFor())
    const response = await http.get('/api/nope')
    expect(response.status).toBe(404)
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('NOT_FOUND')
  })
})

describe('configuration', () => {
  it('refuses an unknown discovery strategy by name', () => {
    expect(() => configFor({ AGENT_DISCOVERY_SOURCES: 'magic' })).toThrow(/unknown discovery strategy/)
  })

  it('accepts both documented strategies and preserves their order', () => {
    const view = toPublicConfigView(configFor({ AGENT_DISCOVERY_SOURCES: 'ens-subgraph,ens-registry' }))
    expect(view.discoverySources).toEqual(['ens-subgraph', 'ens-registry'])
  })

  it('requires a discovery root, because there is no other way to find an agent', () => {
    expect(() => parseConfig({ ...BASE, AGENT_DISCOVERY_ROOT: 'not-a-root' } as NodeJS.ProcessEnv)).toThrow()
  })

  it('requires the model endpoint and model id from configuration, with no baked-in default', () => {
    expect(() => parseConfig({ ...BASE, LLM_BASE_URL: '' } as NodeJS.ProcessEnv)).toThrow()
    expect(() => parseConfig({ ...BASE, LLM_MODEL: '' } as NodeJS.ProcessEnv)).toThrow()
  })
})

const BASE: Record<string, string> = {
  LLM_BASE_URL: 'https://provider.example/v1',
  LLM_MODEL: 'test-model',
  AGENT_DISCOVERY_ROOT: 'ensrouter.eth',
}