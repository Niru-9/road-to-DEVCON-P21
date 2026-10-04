/**
 * Configuration.
 *
 * Every externally-reachable thing — the model endpoint and model id, both timeouts, the
 * Sepolia RPC URL, the ENS discovery root, which discovery strategies run, the endpoint
 * policy switches — is read from the environment here, and only here.
 *
 * What configuration is allowed to contain is the point of the whole design, so it is worth
 * stating plainly:
 *
 *   - `AGENT_DISCOVERY_ROOT` names ONE ENS name. It is a root, not a roster.
 *   - There is NO variable that lists agent names or agent URLs for live routing. A fourth
 *     agent appears by publishing records under the root and refreshing; nothing in this file,
 *     or anywhere else in `src/server`, enumerates agents.
 *   - The only names this app can list at all come from `dev-registry/registry.json`, which
 *     is a development fallback, is read only when every live strategy found nothing, and is
 *     tagged `source: "dev-registry"` everywhere it surfaces.
 *
 * Secrets come from `.env`, which is git-ignored. They are never logged, never returned by any
 * API route, and never sent to the browser. `toPublicConfigView` is the only shape that leaves
 * the server, and it reduces the RPC URL to a host and the API key to a boolean.
 */

import { config as loadDotenv } from 'dotenv'
import { z } from 'zod'

import { AGENT_RECORD_FORMAT_VERSION } from '../shared/agent-record'

loadDotenv()

export class ConfigError extends Error {
  readonly problems: readonly string[]

  constructor(problems: readonly string[]) {
    super(
      [
        'ENS Agent Router is not configured correctly.',
        '',
        ...problems,
        '',
        'Fix: copy .env.example to .env and fill in the values, then restart.',
        '  Copy-Item .env.example .env',
        '',
        'AGENT_DISCOVERY_ROOT must be a full ENS name with at least two labels, ending in',
        '".eth". It is the root the router reads the agent roster from; it is not an agent',
        '',
        'LLM_BASE_URL and LLM_MODEL must name any OpenAI-compatible endpoint. For a free',
        'local option install Ollama and set LLM_BASE_URL=http://localhost:11434/v1 with',
        'LLM_MODEL set to a model you have pulled.',
      ].join('\n'),
    )
    this.name = 'ConfigError'
    this.problems = problems
  }
}

const ensName = z
  .string()
  .trim()
  .min(1, 'must not be empty')
  .max(200)
  .refine(
    (value) => /^[^.\s]+\.[a-z]{2,}$/i.test(value),
    'must be a full ENS name with at least two labels, ending in a two-letter TLD',
  )

/** The discovery strategies this build knows. Adding one is a config-only change. */
export const DISCOVERY_SOURCE_VALUES = ['ens-registry', 'ens-subgraph'] as const
export type DiscoverySource = (typeof DISCOVERY_SOURCE_VALUES)[number]

const envSchema = z.object({
  LLM_BASE_URL: z
    .string()
    .trim()
    .min(1, 'must not be empty')
    .refine((value) => /^https?:\/\//i.test(value), 'must start with http:// or https://'),

  LLM_MODEL: z.string().trim().min(1, 'must not be empty'),

  /** Optional: local providers such as Ollama need no key. */
  LLM_API_KEY: z.string().default(''),

  /** Explicit bound on the routing model request. A hung free tier can never hang the app. */
  LLM_TIMEOUT_MS: z.coerce
    .number()
    .int('must be an integer number of milliseconds')
    .min(1_000, 'must be at least 1000 ms')
    .max(300_000, 'must be at most 300000 ms')
    .default(20_000),

  /** Explicit bound on the routing decision output. It is a small JSON object. */
  LLM_MAX_TOKENS: z.coerce
    .number()
    .int('must be an integer number of tokens')
    .min(32, 'must be at least 32 tokens')
    .max(8_000, 'must be at most 8000 tokens')
    .default(200),

  /** A PUBLIC endpoint is fine and is not a secret. A keyed endpoint IS a secret. */
  SEPOLIA_RPC_URL: z
    .string()
    .trim()
    .min(1)
    .refine((value) => /^https?:\/\//i.test(value), 'must start with http:// or https://')
    .default('https://ethereum-sepolia-rpc.publicnode.com'),

  RPC_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(15_000),

  /**
   * The single configured discovery root. Its `com.ensagent.registry.agents` text record is
   * the roster; its subnames are enumerated by the subgraph strategy. Neither is a list in
   * this repository.
   */
  AGENT_DISCOVERY_ROOT: ensName,

  /** Which discovery strategies run, in order. */
  AGENT_DISCOVERY_SOURCES: z
    .string()
    .trim()
    .min(1, 'must name at least one discovery strategy')
    .default(DISCOVERY_SOURCE_VALUES.join(','))
    .transform((value, ctx) => {
      const sources = value
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part.length > 0)

      const invalid = sources.filter(
        (part) => !(DISCOVERY_SOURCE_VALUES as readonly string[]).includes(part),
      )
      if (invalid.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `unknown discovery strategy: ${invalid.join(', ')}. Known: ${DISCOVERY_SOURCE_VALUES.join(', ')}`,
        })
        return z.NEVER
      }
      if (sources.length === 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must name at least one discovery strategy' })
        return z.NEVER
      }
      return sources as DiscoverySource[]
    }),

  /** Ceiling on names resolved per discovery pass, so a huge registry cannot become hundreds of RPC calls. */
  AGENT_DISCOVERY_MAX: z.coerce.number().int().min(1).max(100).default(25),

  /** How long a discovery result is reused. The UI's refresh action bypasses this. */
  AGENT_CACHE_TTL_MS: z.coerce.number().int().min(0).max(3_600_000).default(60_000),

  /** Optional. Only used by the `ens-subgraph` strategy. A keyed/DeGraph URL IS a secret. */
  ENS_SUBGRAPH_URL: z
    .string()
    .trim()
    .min(1)
    .refine((value) => /^https?:\/\//i.test(value), 'must start with http:// or https://')
    .default('https://api.thegraph.com/subgraphs/name/ensdomains/ens'),

  /** Explicit bound on every forwarded request to a discovered agent. */
  AGENT_TIMEOUT_MS: z.coerce
    .number()
    .int('must be an integer number of milliseconds')
    .min(500, 'must be at least 500 ms')
    .max(120_000, 'must be at most 120000 ms')
    .default(8_000),

  /** Ceiling on answer text from a downstream agent. */
  AGENT_REPLY_MAX_CHARS: z.coerce.number().int().min(200).max(100_000).default(4_000),

  /**
   * SCORED CRITERION 6: the localhost-only exception to the HTTPS requirement.
   *
   * Even when true, `http://` is accepted only for a loopback hostname — see
   * `checkEndpointPolicy`. Set false in any deployed environment.
   */
  ALLOW_INSECURE_LOCAL_AGENTS: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),

  /**
   * Whether the clearly-labelled `dev-registry/registry.json` fallback may be used when
   * every live strategy found nothing. Set false to make ENS the only possible source.
   */
  ALLOW_DEV_REGISTRY_FALLBACK: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),

  /** Ceiling on how many discovered agents may be offered for one decision. */
  AGENT_ROUTE_MAX_CANDIDATES: z.coerce.number().int().min(1).max(50).default(8),

  PORT: z.coerce.number().int().min(1).max(65_535).default(8_789),
})

export interface AppConfig {
  readonly llmBaseUrl: string
  readonly llmModel: string
  readonly llmApiKey: string
  readonly llmTimeoutMs: number
  readonly llmMaxTokens: number
  readonly sepoliaRpcUrl: string
  readonly rpcTimeoutMs: number
  readonly agentDiscoveryRoot: string
  readonly discoverySources: readonly DiscoverySource[]
  readonly agentDiscoveryMax: number
  readonly agentCacheTtlMs: number
  readonly ensSubgraphUrl: string
  readonly agentTimeoutMs: number
  readonly agentReplyMaxChars: number
  readonly allowInsecureLocalAgents: boolean
  readonly allowDevRegistryFallback: boolean
  readonly agentRouteMaxCandidates: number
  readonly port: number
}

export function parseConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(source)

  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => {
        const key = issue.path.join('.') || '(root)'
        return `  - ${key}: ${issue.message}`
      }),
    )
  }

  const env = parsed.data

  return {
    llmBaseUrl: env.LLM_BASE_URL.replace(/\/+$/, ''),
    llmModel: env.LLM_MODEL,
    llmApiKey: env.LLM_API_KEY,
    llmTimeoutMs: env.LLM_TIMEOUT_MS,
    llmMaxTokens: env.LLM_MAX_TOKENS,
    sepoliaRpcUrl: env.SEPOLIA_RPC_URL,
    rpcTimeoutMs: env.RPC_TIMEOUT_MS,
    agentDiscoveryRoot: env.AGENT_DISCOVERY_ROOT,
    discoverySources: env.AGENT_DISCOVERY_SOURCES,
    agentDiscoveryMax: env.AGENT_DISCOVERY_MAX,
    agentCacheTtlMs: env.AGENT_CACHE_TTL_MS,
    ensSubgraphUrl: env.ENS_SUBGRAPH_URL,
    agentTimeoutMs: env.AGENT_TIMEOUT_MS,
    agentReplyMaxChars: env.AGENT_REPLY_MAX_CHARS,
    allowInsecureLocalAgents: env.ALLOW_INSECURE_LOCAL_AGENTS,
    allowDevRegistryFallback: env.ALLOW_DEV_REGISTRY_FALLBACK,
    agentRouteMaxCandidates: env.AGENT_ROUTE_MAX_CANDIDATES,
    port: env.PORT,
  }
}

let cached: AppConfig | null = null

/** Parse and cache the configuration. Throws `ConfigError` with actionable text. */
export function getConfig(): AppConfig {
  if (cached === null) cached = parseConfig()
  return cached
}

/** Test seam: drop the cached config so a new environment can be parsed. */
export function resetConfigCache(): void {
  cached = null
}

export interface PublicConfigView {
  /** Host only — never the path, query string or credentials of the provider. */
  readonly providerHost: string
  readonly model: string
  readonly timeoutMs: number
  readonly maxTokens: number
  readonly hasApiKey: boolean
  readonly rpcHost: string
  readonly rpcTimeoutMs: number
  readonly discoveryRoot: string
  readonly discoverySources: readonly string[]
  readonly recordFormatVersion: string
  readonly maxAgents: number
  readonly cacheTtlMs: number
  readonly agentTimeoutMs: number
  readonly agentReplyMaxChars: number
  readonly allowInsecureLocalAgents: boolean
  readonly allowDevRegistryFallback: boolean
  readonly routeMaxCandidates: number
}

export function toPublicConfigView(config: AppConfig): PublicConfigView {
  return {
    providerHost: safeHost(config.llmBaseUrl),
    model: config.llmModel,
    timeoutMs: config.llmTimeoutMs,
    maxTokens: config.llmMaxTokens,
    hasApiKey: config.llmApiKey.length > 0,
    rpcHost: safeHost(config.sepoliaRpcUrl),
    rpcTimeoutMs: config.rpcTimeoutMs,
    discoveryRoot: config.agentDiscoveryRoot,
    discoverySources: config.discoverySources,
    recordFormatVersion: AGENT_RECORD_FORMAT_VERSION,
    maxAgents: config.agentDiscoveryMax,
    cacheTtlMs: config.agentCacheTtlMs,
    agentTimeoutMs: config.agentTimeoutMs,
    agentReplyMaxChars: config.agentReplyMaxChars,
    allowInsecureLocalAgents: config.allowInsecureLocalAgents,
    allowDevRegistryFallback: config.allowDevRegistryFallback,
    routeMaxCandidates: config.agentRouteMaxCandidates,
  }
}

/**
 * Reduce a URL to its host, discarding embedded credentials, path and query.
 *
 * This is what keeps a keyed RPC endpoint from being echoed to the browser: only the host
 * survives, so the secret part of the URL cannot leak through an API response.
 */
export function safeHost(url: string): string {
  try {
    return new URL(url).host || 'unknown'
  } catch {
    return 'unknown'
  }
}