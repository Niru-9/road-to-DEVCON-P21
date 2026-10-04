/**
 * Discovery strategy: `ens-subgraph`.
 *
 * Enumerates the subnames of the configured discovery root from the ENS subgraph. This is the
 * strategy that needs no roster record at all — a studio could publish `invoice.acme.eth`
 * and `copy.acme.eth` and never touch the parent's records, and they would still be found.
 *
 * DOCUMENTED LIMITATION, not worked around: the public ENS subgraph indexes mainnet names.
 * Sepolia names are frequently offchain/gasless, so this strategy may legitimately return
 * nothing even when the subnames exist and resolve. That is exactly why `ens-registry` is the
 * primary strategy, why both are configured rather than assumed, and why the API reports
 * which strategies ran and what each returned. `npm run probe:registry` shows this live.
 *
 * A failure here is never fatal: the strategy reports its error and discovery continues.
 */

import { normalizeNameList } from './ens'

export interface SubgraphEnumeration {
  readonly names: readonly string[]
  readonly status: 'ok' | 'empty' | 'failed'
  readonly detail: string | null
}

/**
 * One GraphQL query. Kept as a template string with a single `$parent` variable, so the
 * parent name is never concatenated into the query text.
 */
const SUBNAMES_QUERY = /* GraphQL */ `
  query AgentSubnames($parent: String!) {
    domains(where: { parentName: $parent }, first: 50, orderBy: createdAt, orderDirection: desc) {
      name
    }
  }
`

export type SubgraphFetcher = (
  url: string,
  body: string,
  signal: AbortSignal,
) => Promise<{ readonly status: number; readonly text: string }>

/** The real fetcher. `fetch` with a caller-supplied abort signal; no timeout of its own. */
export const fetchViaHttp: SubgraphFetcher = async (url, body, signal) => {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body,
    signal,
  })
  return { status: response.status, text: await response.text() }
}

interface SubgraphResponse {
  readonly data?: { readonly domains?: ReadonlyArray<{ readonly name?: unknown }> }
  readonly errors?: ReadonlyArray<{ readonly message?: unknown }>
}

/**
 * Ask the subgraph which subnames exist under `parentName`.
 *
 * Never throws. Every outcome — non-2xx, GraphQL `errors`, malformed body, zero results — is
 * returned as a status so the caller can report it and carry on.
 */
export async function enumerateSubnamesViaSubgraph(params: {
  readonly subgraphUrl: string
  readonly parentName: string
  readonly timeoutMs: number
  readonly fetchImpl?: SubgraphFetcher
}): Promise<SubgraphEnumeration> {
  const { subgraphUrl, parentName, timeoutMs } = params
  const doFetch = params.fetchImpl ?? fetchViaHttp

  // Explicit timeout, same discipline as every other network call in this app.
  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort()
  }, timeoutMs)

  try {
    const { status, text } = await doFetch(
      subgraphUrl,
      JSON.stringify({ query: SUBNAMES_QUERY, variables: { parent: parentName } }),
      controller.signal,
    )

    if (status < 200 || status >= 300) {
      return { names: [], status: 'failed', detail: `subgraph returned HTTP ${status}` }
    }

    let payload: SubgraphResponse
    try {
      payload = JSON.parse(text) as SubgraphResponse
    } catch {
      return { names: [], status: 'failed', detail: 'subgraph returned a body that is not JSON' }
    }

    if (Array.isArray(payload.errors) && payload.errors.length > 0) {
      const first = payload.errors[0]
      const message = typeof first?.message === 'string' ? first.message : 'unknown GraphQL error'
      return { names: [], status: 'failed', detail: `subgraph GraphQL error: ${truncate(message)}` }
    }

    const domains = payload.data?.domains
    if (!Array.isArray(domains)) {
      return { names: [], status: 'failed', detail: 'subgraph response had no domains array' }
    }

    const raw = domains
      .map((domain) => (typeof domain.name === 'string' ? domain.name : ''))
      .filter((name) => name.length > 0)

    // Drop the root itself: the root is the registry, not one of its agents.
    const withoutRoot = raw.filter((name) => name.toLowerCase() !== parentName.toLowerCase())

    const names = normalizeNameList(withoutRoot)

    return names.length === 0
      ? {
          names: [],
          status: 'empty',
          detail:
            'the public ENS subgraph indexes mainnet names, and Sepolia subnames are often ' +
            'offchain/gasless, so an empty result here is expected rather than an error',
        }
      : { names, status: 'ok', detail: null }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const timedOut = error instanceof Error && error.name === 'AbortError'
    return {
      names: [],
      status: 'failed',
      detail: timedOut ? `subgraph did not respond within ${timeoutMs} ms` : truncate(message),
    }
  } finally {
    clearTimeout(timer)
  }
}

function truncate(value: string, max = 160): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}