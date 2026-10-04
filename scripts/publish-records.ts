#!/usr/bin/env tsx
/**
 * `npm run publish:dry-run` — print exactly which ENS text records to publish, and where.
 *
 * THIS SCRIPT SENDS NO TRANSACTION. There is no `wallet_sendTransaction`, no signer, no key
 * material and no ENS write call anywhere in this repository's coding phase. It exists so the
 * publishing step at the front-end review is a copy-and-paste exercise rather than a puzzle,
 * and so the record values in the code, the running services and the registry on chain cannot
 * drift apart.
 *
 * Where the values come from:
 *   - the agent names and record values: `dev-registry/registry.json`
 *   - the discovery root and the record keys: `.env` and the format module
 *
 * So this file contains no agent name or endpoint literal either.
 *
 * To actually publish, sign each set of records with MetaMask at
 * sepolia.appens.domains (or another Sepolia ENS client), using the values printed here.
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ConfigError, getConfig } from '../src/server/config'
import {
  AGENT_RECORD_FORMAT_VERSION,
  AGENT_RECORD_KEYS,
  REGISTRY_RECORD_KEY,
  REGISTRY_VERSION_RECORD_KEY,
  checkEndpointPolicy,
  parseRegistryNames,
} from '../src/shared/agent-record'
import { normalizeEnsName } from '../src/server/ens'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolvePath(here, '..')
const registryPath = join(repoRoot, 'dev-registry', 'registry.json')

interface DevRegistry {
  readonly agents: ReadonlyArray<{
    readonly ensName: string
    readonly records: Readonly<Record<string, string>>
  }>
}

function rule(char = '='): string {
  return char.repeat(78)
}

function main(): number {
  let root: string
  try {
    const config = getConfig()
    root = normalizeEnsName(config.agentDiscoveryRoot)
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`\n${error.message}\n`)
      return 2
    }
    throw error
  }

  let registry: DevRegistry
  try {
    registry = JSON.parse(readFileSync(registryPath, 'utf8')) as DevRegistry
  } catch (error) {
    console.error(`\n  Could not read ${registryPath}: ${error instanceof Error ? error.message : String(error)}\n`)
    return 2
  }

  const agentNames = registry.agents.map((agent) => agent.ensName)

  console.log('')
  console.log(rule())
  console.log('  ENS publishing plan — DRY RUN, no transaction is sent')
  console.log(rule())
  console.log('')
  console.log(`  chain:      Sepolia (chain id 11155111)`)
  console.log(`  source of values: dev-registry/registry.json (${agentNames.length} agent(s))`)
  console.log('')

  // --- Step 1: the discovery root --------------------------------------------
  console.log('  STEP 1 — publish on the discovery root')
  console.log(`    name:  ${root}`)
  console.log('')
  console.log(`    ${REGISTRY_VERSION_RECORD_KEY.padEnd(34)} ${AGENT_RECORD_FORMAT_VERSION}`)
  console.log(`    ${REGISTRY_RECORD_KEY.padEnd(34)} ${agentNames.join(', ')}`)
  console.log('')
  console.log(`    parsed back as ${parseRegistryNames(agentNames.join(', ')).length} name(s)`)
  console.log('')

  // --- Step 2: each agent ----------------------------------------------------
  console.log('  STEP 2 — publish on each agent name')
  console.log('')

  let problems = 0

  for (const agent of registry.agents) {
    let normalized: string
    try {
      normalized = normalizeEnsName(agent.ensName)
    } catch {
      console.log(`    ${agent.ensName}`)
      console.log('      UNUSABLE NAME — not a name ENS can accept. Fix this before publishing.')
      console.log('')
      problems += 1
      continue
    }

    console.log(`    ${normalized}`)

    for (const key of [
      AGENT_RECORD_KEYS.capability,
      AGENT_RECORD_KEYS.endpoint,
      AGENT_RECORD_KEYS.accepts,
      AGENT_RECORD_KEYS.version,
    ] as const) {
      const value = agent.records[key]
      if (value === undefined) {
        console.log(`      ${key.padEnd(32)} (unset — optional, skipping)`)
        continue
      }
      console.log(`      ${key.padEnd(32)} ${value}`)
    }

    const endpoint = agent.records[AGENT_RECORD_KEYS.endpoint]
    if (endpoint !== undefined) {
      const decision = checkEndpointPolicy(endpoint, { allowInsecureLocal: true })
      const endpointIsLoopbackHttp =
        decision.ok && decision.url !== null && new URL(decision.url).protocol === 'http:'
      const suffix = endpointIsLoopbackHttp
        ? 'LOOPBACK — fine for local development, must be an https:// URL for a public demo'
        : null

      if (decision.ok) {
        console.log(`      ${'endpoint policy'.padEnd(32)} accepted (${decision.protocol}://)`)
      } else {
        console.log(`      ${'ENDPOINT REJECTED'.padEnd(32)} ${decision.reason}`)
      }
      if (suffix !== null) console.log(`      ${''.padEnd(32)} ${suffix}`)
      if (!decision.ok) problems += 1
    }

    if (!normalized.toLowerCase().endsWith(`.${root.toLowerCase()}`)) {
      console.log(`      NOTE: this name is not a subname of ${root}. Registry records normally`)
      console.log('            list subnames of the root; the subgraph strategy enumerates subnames too.')
    }

    console.log('')
  }

  // --- Step 3: verify --------------------------------------------------------
  console.log('  STEP 3 — verify with read-only checks (no wallet needed)')
  console.log('    npm run probe:registry        # live discovery: strategies, agents, skipped records')
  console.log('    npm run dev                    # then press "Refresh from ENS" in the UI')
  console.log('')
  console.log('  Notes')
  console.log('    - Every name above must be registered (or at least resolvable) on Sepolia.')
  console.log('      Offchain/gasless Sepolia names resolve through the Universal Resolver, which')
  console.log('      is what viem and this app use.')
  console.log('    - The public ENS subgraph indexes mainnet names, so the `ens-subgraph` strategy')
  console.log('      may return nothing on Sepolia even when these names exist. `ens-registry` is')
  console.log('      the primary strategy for exactly that reason.')
  console.log('    - Publish the root record FIRST. Until it exists, discovery has no roster to read.')
  console.log('    - This repository holds no signing key and sends no ENS write transaction.')
  console.log('')

  if (problems > 0) {
    console.log(`  RESULT: ${problems} problem(s) above must be fixed before publishing.`)
    console.log('')
    return 1
  }

  console.log(`  RESULT: ${agentNames.length} name(s) ready to sign. No transaction was sent.`)
  console.log('')
  return 0
}

process.exit(main())