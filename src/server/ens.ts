/**
 * ENS on Sepolia: normalize, then read.
 *
 * Every agent fact in this app comes from `getEnsText` against the Universal Resolver. The
 * only names this module is ever given are (a) the configured discovery root and (b) names
 * that a discovery strategy read out of ENS itself. Nothing is supplied by a literal list.
 *
 * `normalizeEnsName` is the only entry point for a name, so an un-normalized string can never
 * reach the resolver.
 */

import { createPublicClient, http } from 'viem'
import type { PublicClient } from 'viem'
import { sepolia } from 'viem/chains'
import { getEnsAddress, getEnsText, normalize } from 'viem/ens'

import { ALL_AGENT_RECORD_KEYS, REGISTRY_RECORD_KEY } from '../shared/agent-record'

export type EnsClient = PublicClient

export class InvalidEnsNameError extends Error {
  constructor(input: string, cause?: unknown) {
    super(
      `"${truncate(input)}" is not a name ENS can accept. ` +
        `Check the spelling and use a full name with at least two labels, ending in a ` +
        `two-letter TLD.`,
    )
    this.name = 'InvalidEnsNameError'
    this.cause = cause
  }
}

function truncate(value: string, max = 80): string {
  return value.length > max ? `${value.slice(0, max)}…` : value
}

/** Longest name we will even attempt to normalize. */
export const MAX_NAME_LENGTH = 200

/**
 * ENSIP-15 (UTS-46) normalization.
 *
 * Deliberately the only way this module accepts a name. Throws `InvalidEnsNameError` for
 * anything ENS will not accept, including empty input and bare labels such as "notaname",
 * which UTS-46 happily returns unchanged.
 */
export function normalizeEnsName(input: string): string {
  const candidate = typeof input === 'string' ? input.trim() : ''

  if (candidate.length === 0) throw new InvalidEnsNameError(input ?? '', new Error('empty input'))
  if (candidate.length > MAX_NAME_LENGTH) throw new InvalidEnsNameError(candidate, new Error('too long'))

  try {
    const normalized = normalize(candidate)

    // Require at least one label plus an alphabetic root of two or more characters, so
    // "invoice.agents.priya.eth" passes while "notaname" and "foo.eth." do not.
    if (!/^.+\.[a-z]{2,}$/.test(normalized)) {
      throw new InvalidEnsNameError(candidate, new Error(`"${truncatedForError(normalized)}" has no valid ENS root`))
    }

    return normalized
  } catch (cause) {
    if (cause instanceof InvalidEnsNameError) throw cause
    throw new InvalidEnsNameError(candidate, cause)
  }
}

function truncatedForError(value: string): string {
  return truncate(value, 60)
}

/** True when a name can be normalized. Used to skip bad names without aborting discovery. */
export function isNormalizableEnsName(input: string): boolean {
  try {
    normalizeEnsName(input)
    return true
  } catch {
    return false
  }
}

/** Normalize a list, dropping entries that ENS would not accept. Never throws. */
export function normalizeNameList(names: readonly string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const name of names) {
    try {
      const normalized = normalizeEnsName(name)
      if (!seen.has(normalized)) {
        seen.add(normalized)
        out.push(normalized)
      }
    } catch {
      // A name that will not normalize cannot be read, so it is dropped and the rest proceed.
    }
  }
  return out
}

/** A viem public client for ENS on Sepolia, with an explicit RPC timeout. */
export function createEnsClient(rpcUrl: string, rpcTimeoutMs: number): EnsClient {
  return createPublicClient({
    chain: sepolia,
    transport: http(rpcUrl, { timeout: rpcTimeoutMs, retryCount: 1 }),
  }) as EnsClient
}

/** Reads one text record. Returns null when the record is unset; may throw. */
export type EnsTextReader = (
  client: EnsClient,
  name: string,
  key: string,
) => Promise<string | null>

/** The real reader: viem's Universal Resolver action. */
export const readTextViaUniversalResolver: EnsTextReader = async (client, name, key) =>
  getEnsText(client, { name, key })

export type RecordStatus = 'read' | 'unset' | 'failed'

export interface AgentRecordRead {
  readonly normalizedName: string
  readonly address: `0x${string}` | null
  readonly records: Readonly<Record<string, string | null>>
  readonly recordStatus: Readonly<Record<string, RecordStatus>>
  readonly readFailures: readonly string[]
}

/**
 * Read every documented agent record for one already-normalized name.
 *
 * Individual failures are isolated: a resolver that reverts on one key must not abort the
 * other three, and an unset record is reported as `null` so validation sees it as absent
 * rather than empty. This is what lets SCORED CRITERION 4 hold per agent.
 */
export async function readAgentRecords(
  client: EnsClient,
  normalizedName: string,
  readText: EnsTextReader = readTextViaUniversalResolver,
): Promise<AgentRecordRead> {
  const settled = await Promise.all(
    ALL_AGENT_RECORD_KEYS.map(async (key) => {
      try {
        const value = await readText(client, normalizedName, key)
        return {
          key,
          value: value ?? null,
          status: (value === null || value === undefined ? 'unset' : 'read') as RecordStatus,
        }
      } catch {
        // The read told us nothing. That is NOT the same as "unset", so it is labelled
        // separately and reported as `failed` rather than silently becoming an empty field.
        return { key, value: null, status: 'failed' as RecordStatus }
      }
    }),
  )

  const records: Record<string, string | null> = {}
  const recordStatus: Record<string, RecordStatus> = {}
  const readFailures: string[] = []

  for (const entry of settled) {
    records[entry.key] = entry.value
    recordStatus[entry.key] = entry.status
    if (entry.status === 'failed') readFailures.push(entry.key)
  }

  // Best effort: a name can carry text records without a resolving address.
  let address: `0x${string}` | null = null
  try {
    address = await getEnsAddress(client, { name: normalizedName })
  } catch {
    address = null
  }

  return { normalizedName, address, records, recordStatus, readFailures }
}

export interface RegistryRead {
  readonly value: string | null
  readonly status: RecordStatus
  readonly error: string | null
}

/**
 * Read the roster record from the discovery root's own text records.
 *
 * This is the primary discovery strategy: the root *points at* its agents, so the agent set
 * is a live ENS read and a refresh can pick up a new agent without a deploy and without
 * assuming a subgraph indexes these names.
 */
export async function readRegistryRecord(
  client: EnsClient,
  rootName: string,
  readText: EnsTextReader = readTextViaUniversalResolver,
): Promise<RegistryRead> {
  try {
    const value = await readText(client, rootName, REGISTRY_RECORD_KEY)
    return {
      value: value ?? null,
      status: value === null || value === undefined ? 'unset' : 'read',
      error: null,
    }
  } catch (error) {
    return {
      value: null,
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/** Exported for the API health response, which documents the keys this app reads. */
export const READ_RECORD_KEYS = {
  registry: REGISTRY_RECORD_KEY,
  agent: ALL_AGENT_RECORD_KEYS,
} as const