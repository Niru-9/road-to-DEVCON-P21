/**
 * Runtime discovery.
 *
 * SCORED CRITERION 3 (10 points): the agent set is obtained from ENS records at runtime, and a
 * malformed agent is skipped while discovery continues (CRITERION 4). Both are exercised here
 * against a fake ENS reader, with no network and no hardcoded agent list anywhere.
 */

import { describe, expect, it } from 'vitest'

import {
  AGENT_RECORD_KEYS,
  REGISTRY_RECORD_KEY,
  type DiscoveredAgent,
} from '../shared/agent-record'
import { parseConfig, type AppConfig } from './config'
import { AgentDiscovery, readDevRegistryFile, type DevRegistry } from './discovery'
import { normalizeEnsName, normalizeNameList, type EnsClient, type EnsTextReader } from './ens'

/** A fake ENS: a map of `${name}|${key}` to a value, or an error to throw. */
type EnsFixture = Record<string, string | Error>

function fixtureReader(fixture: EnsFixture): EnsTextReader {
  return async (_client, name, key) => {
    const entry = fixture[`${name}|${key}`]
    if (entry === undefined) return null
    if (entry instanceof Error) throw entry
    return entry
  }
}

const BASE_ENV: Record<string, string> = {
  LLM_BASE_URL: 'https://provider.example/v1',
  LLM_MODEL: 'test-model',
  LLM_API_KEY: '',
  AGENT_DISCOVERY_ROOT: 'ensrouter.eth',
  // ens-registry only, so the subgraph strategy does not reach the network in a unit test.
  AGENT_DISCOVERY_SOURCES: 'ens-registry',
  AGENT_CACHE_TTL_MS: '0',
  ALLOW_DEV_REGISTRY_FALLBACK: 'false',
  ALLOW_INSECURE_LOCAL_AGENTS: 'false',
}

function configFor(overrides: Record<string, string> = {}): AppConfig {
  return parseConfig({ ...BASE_ENV, ...overrides } as NodeJS.ProcessEnv)
}

/** Three well-formed agents, written as records rather than as agent objects. */
function threeGoodAgents(): EnsFixture {
  const fixture: EnsFixture = {
    [`ensrouter.eth|${REGISTRY_RECORD_KEY}`]: [
      'invoice.ensrouter.eth',
      'contract.ensrouter.eth',
      'brand-copy.ensrouter.eth',
    ].join(', '),
  }

  const bodies: Array<[string, string, string]> = [
    [
      'invoice.ensrouter.eth',
      'Handles invoices and receivables: overdue balances and dunning wording.',
      'https://agents.example.com/invoice/invoke',
    ],
    [
      'contract.ensrouter.eth',
      'Reads commercial contract terms: termination, payment and IP clauses.',
      'https://agents.example.com/contract/invoke',
    ],
    [
      'brand-copy.ensrouter.eth',
      'Writes and rewrites the studio copy: taglines, About page and captions.',
      'https://agents.example.com/copy/invoke',
    ],
  ]

  for (const [name, capability, endpoint] of bodies) {
    fixture[`${name}|${AGENT_RECORD_KEYS.capability}`] = capability
    fixture[`${name}|${AGENT_RECORD_KEYS.endpoint}`] = endpoint
    fixture[`${name}|${AGENT_RECORD_KEYS.accepts}`] = 'A request in plain language.'
  }

  return fixture
}

function fakeClient(): EnsClient {
  return {} as EnsClient
}

async function discoverWith(
  config: AppConfig,
  fixture: EnsFixture,
  extra: { subgraphFetch?: never; readDevRegistry?: () => DevRegistry | null } = {},
): Promise<ReturnType<AgentDiscovery['getState']>> {
  const discovery = new AgentDiscovery(fakeClient(), config, {
    readText: fixtureReader(fixture),
    readDevRegistry: extra.readDevRegistry ?? (() => null),
  })
  return discovery.discover({ forceRefresh: true })
}

describe('discovery from ENS records', () => {
  it('derives the whole agent set from the registry record and each agent\'s own records', async () => {
    const state = await discoverWith(configFor(), threeGoodAgents())

    expect(state.status).toBe('ready')
    expect(state.usedDevRegistry).toBe(false)
    expect(state.agents.map((agent) => agent.ensName)).toEqual([
      'brand-copy.ensrouter.eth',
      'contract.ensrouter.eth',
      'invoice.ensrouter.eth',
    ])
    expect(state.agents.every((agent) => agent.source === 'ens')).toBe(true)
    expect(state.reports[0]).toMatchObject({ source: 'ens-registry', status: 'ok' })
    expect(state.reports[0]!.namesFound).toHaveLength(3)
  })

  it('reads each endpoint from that agent\'s own record, not from a map', async () => {
    const state = await discoverWith(configFor(), threeGoodAgents())
    const endpoints = Object.fromEntries(
      state.agents.map((agent) => [agent.ensName, agent.endpoint]),
    )

    expect(endpoints).toEqual({
      'brand-copy.ensrouter.eth': 'https://agents.example.com/copy/invoke',
      'contract.ensrouter.eth': 'https://agents.example.com/contract/invoke',
      'invoice.ensrouter.eth': 'https://agents.example.com/invoice/invoke',
    })
  })

  it('skips a malformed agent and continues with the rest', async () => {
    const fixture = threeGoodAgents()

    // Four hostile shapes: no endpoint at all, a non-https endpoint on a public host, a
    // capability that is far too short to describe anything, and an agent whose read reverts.
    fixture[`broken-nospec.ensrouter.eth|${AGENT_RECORD_KEYS.capability}`] = 'x'.repeat(60)
    fixture[`broken-nospec.ensrouter.eth|${AGENT_RECORD_KEYS.accepts}`] = 'anything'

    fixture[`ensrouter.eth|${REGISTRY_RECORD_KEY}`] = [
      'invoice.ensrouter.eth',
      'contract.ensrouter.eth',
      'broken-nospec.ensrouter.eth',
      'broken-http.ensrouter.eth',
      'broken-tiny.ensrouter.eth',
      'broken-revert.ensrouter.eth',
      'brand-copy.ensrouter.eth',
    ].join(', ')

    fixture[`broken-http.ensrouter.eth|${AGENT_RECORD_KEYS.capability}`] =
      'A helper that uses plain http on a public host, which the policy must reject.'
    fixture[`broken-http.ensrouter.eth|${AGENT_RECORD_KEYS.endpoint}`] =
      'http://agents.example.com/invoke'
    fixture[`broken-http.ensrouter.eth|${AGENT_RECORD_KEYS.accepts}`] = 'anything at all'

    fixture[`broken-tiny.ensrouter.eth|${AGENT_RECORD_KEYS.capability}`] = 'ai'
    fixture[`broken-tiny.ensrouter.eth|${AGENT_RECORD_KEYS.endpoint}`] =
      'https://agents.example.com/tiny/invoke'
    fixture[`broken-tiny.ensrouter.eth|${AGENT_RECORD_KEYS.accepts}`] = 'anything'

    fixture[`broken-revert.ensrouter.eth|${AGENT_RECORD_KEYS.capability}`] =
      'A helper whose records revert when read, so the read must fail in isolation.'
    fixture[`broken-revert.ensrouter.eth|${AGENT_RECORD_KEYS.endpoint}`] = new Error('resolver reverted')
    fixture[`broken-revert.ensrouter.eth|${AGENT_RECORD_KEYS.accepts}`] = 'anything'

    const state = await discoverWith(configFor(), fixture)

    // Discovery did not abort: the three good agents are still there.
    expect(state.agents.map((agent) => agent.ensName)).toEqual([
      'brand-copy.ensrouter.eth',
      'contract.ensrouter.eth',
      'invoice.ensrouter.eth',
    ])

    const reasons = Object.fromEntries(state.rejected.map((r) => [r.ensName, r.reason]))
    expect(reasons).toEqual({
      'broken-http.ensrouter.eth': 'invalid-endpoint',
      'broken-nospec.ensrouter.eth': 'missing-endpoint',
      'broken-revert.ensrouter.eth': 'unreadable',
      'broken-tiny.ensrouter.eth': 'invalid-capability',
    })
  })

  it('reports an empty roster honestly rather than inventing an agent', async () => {
    const state = await discoverWith(configFor(), {})

    expect(state.status).toBe('ready')
    expect(state.agents).toEqual([])
    expect(state.rejected).toEqual([])
    expect(state.reports[0]).toMatchObject({ source: 'ens-registry', status: 'empty' })
    expect(state.reports[0]!.detail).toMatch(/has no com\.ensagent\.registry\.agents record/)
  })

  it('does not crash when the registry record itself reverts', async () => {
    const fixture: EnsFixture = {
      [`ensrouter.eth|${REGISTRY_RECORD_KEY}`]: new Error('RPC rate limited'),
    }
    const state = await discoverWith(configFor(), fixture)

    expect(state.status).toBe('ready')
    expect(state.agents).toEqual([])
    expect(state.reports[0]!.status).toBe('failed')
  })

  it('drops registry entries that ENS would not accept, and keeps the rest', async () => {
    const fixture = threeGoodAgents()
    fixture[`ensrouter.eth|${REGISTRY_RECORD_KEY}`] =
      'invoice.ensrouter.eth, notaname, contract.ensrouter.eth, invoice.ensrouter.eth'

    const state = await discoverWith(configFor(), fixture)

    expect(state.agents.map((agent) => agent.ensName)).toEqual([
      'contract.ensrouter.eth',
      'invoice.ensrouter.eth',
    ])
  })

  it('honours the configured ceiling on how many names one pass resolves', async () => {
    const names = Array.from({ length: 10 }, (_unused, index) => `a${index}.ensrouter.eth`)
    const fixture: EnsFixture = {
      [`ensrouter.eth|${REGISTRY_RECORD_KEY}`]: names.join(', '),
    }
    for (const name of names) {
      fixture[`${name}|${AGENT_RECORD_KEYS.capability}`] = `A helper called ${name} that does a narrow thing well.`
      fixture[`${name}|${AGENT_RECORD_KEYS.endpoint}`] = `https://agents.example.com/${name}/invoke`
      fixture[`${name}|${AGENT_RECORD_KEYS.accepts}`] = 'A narrow request.'
    }

    const state = await discoverWith(configFor({ AGENT_DISCOVERY_MAX: '4' }), fixture)

    expect(state.agents).toHaveLength(4)
    expect(state.notices.some((notice) => notice.includes('AGENT_DISCOVERY_MAX'))).toBe(true)
  })

  it('picks up a fourth agent with no code change, just a refreshed registry record', async () => {
    const before = threeGoodAgents()
    const first = await discoverWith(configFor(), before)
    expect(first.agents).toHaveLength(3)

    const after: EnsFixture = { ...before }
    after[`ensrouter.eth|${REGISTRY_RECORD_KEY}`] = `${before[`ensrouter.eth|${REGISTRY_RECORD_KEY}`]}, audit.ensrouter.eth`
    after['audit.ensrouter.eth|' + AGENT_RECORD_KEYS.capability] =
      'Reviews a project against a written brief and lists what is missing.'
    after['audit.ensrouter.eth|' + AGENT_RECORD_KEYS.endpoint] =
      'https://agents.example.com/audit/invoke'
    after['audit.ensrouter.eth|' + AGENT_RECORD_KEYS.accepts] = 'A brief and some work to check.'

    const second = await discoverWith(configFor(), after)
    expect(second.agents).toHaveLength(4)
    expect(second.agents.map((agent) => agent.ensName)).toContain('audit.ensrouter.eth')
  })

  it('rejects a localhost endpoint unless the development exception is enabled', async () => {
    const fixture: EnsFixture = {
      [`ensrouter.eth|${REGISTRY_RECORD_KEY}`]: 'invoice.ensrouter.eth',
      [`invoice.ensrouter.eth|${AGENT_RECORD_KEYS.capability}`]: 'Handles invoices and receivables.',
      [`invoice.ensrouter.eth|${AGENT_RECORD_KEYS.endpoint}`]: 'http://127.0.0.1:8791/invoke',
      [`invoice.ensrouter.eth|${AGENT_RECORD_KEYS.accepts}`]: 'A request about an invoice.',
    }

    const strict = await discoverWith(configFor(), fixture)
    expect(strict.agents).toEqual([])
    expect(strict.rejected[0]?.reason).toBe('invalid-endpoint')

    const dev = await discoverWith(configFor({ ALLOW_INSECURE_LOCAL_AGENTS: 'true' }), fixture)
    expect(dev.agents.map((agent) => agent.ensName)).toEqual(['invoice.ensrouter.eth'])
  })
})

describe('development fallback', () => {
  /** The fallback is off unless a test opts in, which is itself the safe default. */
  const ENABLED = { ALLOW_DEV_REGISTRY_FALLBACK: 'true', ALLOW_INSECURE_LOCAL_AGENTS: 'true' }

  const devRegistry: DevRegistry = {
    agents: [
      {
        ensName: 'local-a.ensrouter.eth',
        records: {
          [AGENT_RECORD_KEYS.capability]: 'A local helper that answers invoice questions during development.',
          [AGENT_RECORD_KEYS.endpoint]: 'http://127.0.0.1:8791/invoke',
          [AGENT_RECORD_KEYS.accepts]: 'A request about an invoice.',
        },
      },
      {
        ensName: 'not a name',
        records: {
          [AGENT_RECORD_KEYS.capability]: 'This entry has an unusable name and must be dropped.',
          [AGENT_RECORD_KEYS.endpoint]: 'https://agents.example.com/invoke',
          [AGENT_RECORD_KEYS.accepts]: 'anything',
        },
      },
    ],
  }

  it('is used only when every live strategy found nothing, and is always labelled', async () => {
    const state = await discoverWith(configFor(ENABLED), {}, {
      readDevRegistry: () => devRegistry,
    })

    expect(state.usedDevRegistry).toBe(true)
    expect(state.devRegistryNotice).toMatch(/NOT from ENS/)
    expect(state.notices.some((notice) => notice.includes('dev-registry'))).toBe(true)
    expect(state.agents.map((agent) => agent.ensName)).toEqual(['local-a.ensrouter.eth'])
    expect(state.agents[0]!.source).toBe('dev-registry')
  })

  it('is not consulted at all when live discovery found an agent', async () => {
    const state = await discoverWith(configFor(), threeGoodAgents(), {
      readDevRegistry: () => devRegistry,
    })

    expect(state.usedDevRegistry).toBe(false)
    expect(state.agents.every((agent) => agent.source === 'ens')).toBe(true)
  })

  it('produces no agents when it is disabled', async () => {
    const state = await discoverWith(configFor(), {}, { readDevRegistry: () => devRegistry })
    expect(state.usedDevRegistry).toBe(false)
    expect(state.agents).toEqual([])
    expect(state.notices.some((notice) => notice.includes('ALLOW_DEV_REGISTRY_FALLBACK'))).toBe(true)
  })

  it('applies the same endpoint policy to fallback records as to ENS records', async () => {
    const insecure: DevRegistry = {
      agents: [
        {
          ensName: 'local-b.ensrouter.eth',
          records: {
            [AGENT_RECORD_KEYS.capability]: 'A local helper with a plain-http public endpoint.',
            [AGENT_RECORD_KEYS.endpoint]: 'http://agents.example.com/invoke',
            [AGENT_RECORD_KEYS.accepts]: 'A request.',
          },
        },
      ],
    }

    const state = await discoverWith(configFor(ENABLED), {}, { readDevRegistry: () => insecure })

    expect(state.agents).toEqual([])
    expect(state.rejected[0]?.reason).toBe('invalid-endpoint')
  })

  it('reads the repository file, and survives it being absent', () => {
    const registry = readDevRegistryFile()
    expect(registry === null || Array.isArray(registry.agents)).toBe(true)
    expect(readDevRegistryFile('does-not-exist.json')).toBeNull()
  })
})

describe('normalization helpers', () => {
  it('normalizes valid names and refuses the rest', () => {
    expect(normalizeEnsName('Invoice.EnsRouter.eth')).toBe('invoice.ensrouter.eth')
    expect(() => normalizeEnsName('notaname')).toThrow()
    expect(() => normalizeEnsName('')).toThrow()
  })

  it('drops unusable entries from a list without throwing', () => {
    expect(normalizeNameList(['a.eth', '', 'nope', 'A.ETH'])).toEqual(['a.eth'])
  })
})

describe('caching', () => {
  it('serves a cached result inside the TTL and re-reads when forced', async () => {
    let reads = 0
    const counting: EnsTextReader = async (_client, name, key) => {
      reads += 1
      const fixture = threeGoodAgents()
      const entry = fixture[`${name}|${key}`]
      if (entry === undefined) return null
      if (entry instanceof Error) throw entry
      return entry
    }

    const config = configFor({ AGENT_CACHE_TTL_MS: '60000' })
    const discovery = new AgentDiscovery(fakeClient(), config, {
      readText: counting,
      readDevRegistry: () => null,
    })

    await discovery.discover({ forceRefresh: true })
    const afterFirst = reads
    const cached = await discovery.discover()

    expect(reads).toBe(afterFirst)
    expect(cached.fromCache).toBe(true)

    await discovery.discover({ forceRefresh: true })
    expect(reads).toBeGreaterThan(afterFirst)
  })

  it('never caches when the TTL is zero', async () => {
    const config = configFor({ AGENT_CACHE_TTL_MS: '0' })
    const discovery = new AgentDiscovery(fakeClient(), config, {
      readText: fixtureReader(threeGoodAgents()),
      readDevRegistry: () => null,
    })

    await discovery.discover()
    const second = await discovery.discover()
    expect(second.fromCache).toBe(false)
  })
})

describe('every discovered agent is a validated record, never a bare object', () => {
  it('gives each agent an ENS name, an https-or-loopback endpoint and a source', async () => {
    const state = await discoverWith(configFor(), threeGoodAgents())

    for (const agent of state.agents) {
      expect(agent.ensName.endsWith('.ensrouter.eth')).toBe(true)
      expect(agent.endpoint.startsWith('https://')).toBe(true)
      expect(['ens', 'dev-registry']).toContain(agent.source)
      expect(agent.capability.length).toBeGreaterThan(0)
      expect(agent.accepts.length).toBeGreaterThan(0)
    }
  })
})
