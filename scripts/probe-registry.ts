#!/usr/bin/env tsx
/**
 * `npm run probe:registry` — which discovery strategy actually finds agents, right now.
 *
 * Read-only. It runs the real discovery pipeline against the real Sepolia RPC with the real
 * configuration and prints:
 *
 *   - the configured discovery root
 *   - each enabled strategy, its status and the names it contributed
 *   - every agent that survived validation, and every one that was skipped and why
 *   - whether the development fallback was used
 *
 * This is the honest way to answer "did you publish the records yet". It sends no ENS write
 * transaction and reads nothing from your wallet.
 *
 * Exit code 0 when at least one agent was found from ENS, 1 when the live set is empty (so a
 * CI-style check can distinguish published from unpublished), 2 on a configuration error.
 */

import { AgentDiscovery, describeDiscovery } from '../src/server/discovery'
import { ConfigError, getConfig, toPublicConfigView, type AppConfig } from '../src/server/config'
import { createEnsClient } from '../src/server/ens'
import { REGISTRY_RECORD_KEY } from '../src/shared/agent-record'

function rule(char = '-'): string {
  return char.repeat(78)
}

async function probe(config: AppConfig): Promise<number> {
  const view = toPublicConfigView(config)
  const client = createEnsClient(config.sepoliaRpcUrl, config.rpcTimeoutMs)
  const discovery = new AgentDiscovery(client, config)

  const state = await discovery.discover({ forceRefresh: true })

  console.log('')
  console.log(rule('='))
  console.log('  ENS discovery probe (read-only)')
  console.log(rule('='))
  console.log('')
  console.log(`  chain:           Sepolia (chain id 11155111)`)
  console.log(`  rpc:             ${view.rpcHost}`)
  console.log(`  discovery root:  ${state.root}`)
  console.log(`  registry record: ${REGISTRY_RECORD_KEY}`)
  console.log(`  strategies:      ${view.discoverySources.join(', ')}`)
  console.log(`  endpoint policy: https required${view.allowInsecureLocalAgents ? ' (localhost exception ON)' : ' (no exception)'}`)
  console.log('')

  console.log('  strategies')
  if (state.reports.length === 0) console.log('    (none ran)')
  for (const report of state.reports) {
    console.log(`    ${report.source.padEnd(16)} ${report.status.padEnd(8)} ${report.namesFound.length} name(s)`)
    if (report.namesFound.length > 0) {
      for (const name of report.namesFound) console.log(`        - ${name}`)
    }
    if (report.detail !== null) console.log(`        ${report.detail}`)
  }
  console.log('')

  console.log(`  agents (${state.agents.length})`)
  if (state.agents.length === 0) console.log('    (none)')
  for (const agent of state.agents) {
    console.log(`    ${agent.ensName}  [${agent.source}]`)
    console.log(`        capability: ${agent.capability}`)
    console.log(`        endpoint:   ${agent.endpoint}`)
    console.log(`        accepts:    ${agent.accepts}`)
    for (const warning of agent.warnings) console.log(`        warning:    ${warning}`)
  }
  console.log('')

  if (state.rejected.length > 0) {
    console.log(`  skipped (${state.rejected.length})`)
    for (const rejected of state.rejected) {
      console.log(`    ${rejected.ensName}  ${rejected.reason} — ${rejected.detail}`)
    }
    console.log('')
  }

  if (state.notices.length > 0) {
    console.log('  notices')
    for (const notice of state.notices) console.log(`    - ${notice}`)
    console.log('')
  }

  console.log(`  summary: ${describeDiscovery(state)}`)
  console.log(`  elapsed: ${state.durationMs ?? 0} ms`)
  console.log('')

  if (state.usedDevRegistry) {
    console.log('  RESULT: no live ENS agents. This run used the labelled development fallback.')
    console.log('          Publish the records in dev-registry/registry.json on Sepolia, then re-run.')
    console.log('')
    return 1
  }

  if (state.agents.length === 0) {
    console.log('  RESULT: no agents discoverable from ENS.')
    console.log('          Publish the registry record on the root, then each agent\'s own records.')
    console.log('')
    return 1
  }

  console.log(`  RESULT: ${state.agents.length} agent(s) discovered from ENS.`)
  console.log('')
  return 0
}

const startedAt = Date.now()

try {
  const config = getConfig()
  const code = await probe(config)
  console.log(`  done in ${Date.now() - startedAt} ms`)
  console.log('')
  process.exit(code)
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(`\n${error.message}\n`)
    process.exit(2)
  }
  console.error(`\n  probe failed: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(2)
}