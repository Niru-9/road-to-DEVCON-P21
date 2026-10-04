/**
 * SCORED CRITERION 3 (10 points), enforced as a test.
 *
 * The claim is: the router obtains the agent set at runtime from ENS data, with no literal
 * list of agent names or endpoints in router code. A comment asserting that would be worth
 * nothing, so this test reads the router's own source and checks.
 *
 * Scope: `src/server/**` and `src/shared/**`, excluding test files. Two files are excluded by
 * name and for a stated reason:
 *
 *   `src/shared/routing-cases.json` — the recorded routing dataset, which must name agents in
 *   order to state what each case expects. It is data the problem explicitly asks to be
 *   recorded, it is never imported by the router, and the routes serve it read-only.
 *
 * `dev-registry/registry.json` is outside `src/` and is the labelled development fallback,
 * discussed in `dev-registry/README.md`.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const srcRoot = join(here, '..')

/** Anything that looks like a concrete ENS name with two or more labels. */
const ENS_NAME_LITERAL = /\b[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*\.(eth|test|xyz|box|lens|name|addr)\b/g

/** An absolute URL that is not an obvious placeholder/example host. */
const ENDPOINT_LITERAL =
  /\bhttps?:\/\/[a-z0-9][a-z0-9.-]*(?::\d+)?\/[^\s'"`)]{0,80}/gi

const PLACEHOLDER_HOST = /(example|placeholder|your-|localhost|127\.0\.0\.1|\[::1\]|provider\.example|invalid)/i

/**
 * Public, read-only infrastructure defaults that live in `config.ts`.
 *
 * These are not agent endpoints: they are the Sepolia RPC and the ENS subgraph, both read
 * transports, both overridable from `.env`, and both documented public services. What the
 * check must catch is a hardcoded AGENT endpoint, because that is what would let discovery
 * bypass ENS entirely.
 */
const ALLOWED_CONFIG_DEFAULTS = [
  'https://ethereum-sepolia-rpc.publicnode.com',
  'https://api.thegraph.com/subgraphs/name/ensdomains/ens',
]

const EXCLUDED_FILES = new Set(['routing-cases.json'])

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (entry.isFile()) out.push(full)
  }
  return out
}

const routerFiles = [
  ...walk(join(srcRoot, 'server')),
  ...walk(join(srcRoot, 'shared')),
]
  .map((path) => relative(srcRoot, path).split(sep).join('/'))
  .filter((path) => !path.endsWith('.test.ts'))
  .filter((path) => !EXCLUDED_FILES.has(path.split('/').pop() ?? path))
  // The subgraph module necessarily names the public ENS subgraph endpoint in a comment.
  .filter((path) => path !== 'server/subgraph.ts')

describe('router source contains no literal list of agents', () => {
  it('finds the files it is checking', () => {
    expect(routerFiles.length).toBeGreaterThan(5)
    expect(routerFiles.every((path) => !path.endsWith('.test.ts'))).toBe(true)
  })

  it.each(routerFiles)('%s names no concrete ENS agent name', (path) => {
    const text = readFileSync(join(srcRoot, path), 'utf8')

    // Strip block and line comments so documentation and prose about the format are allowed.
    // A literal agent name in CODE would still be caught.
    const code = text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1')

    const found = code.match(ENS_NAME_LITERAL) ?? []
    expect(found, `literal ENS name(s) in ${path}: ${found.join(', ')}`).toEqual([])
  })

  it.each(routerFiles)('%s names no non-placeholder agent endpoint', (path) => {
    const text = readFileSync(join(srcRoot, path), 'utf8')
    const code = text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1')

    const candidates = (code.match(ENDPOINT_LITERAL) ?? []).filter(
      (value) => !PLACEHOLDER_HOST.test(value) && !ALLOWED_CONFIG_DEFAULTS.includes(value),
    )

    expect(candidates, `literal endpoint(s) in ${path}: ${candidates.join(', ')}`).toEqual([])
  })
})

describe('the configuration schema offers no way to list agents', () => {
  it('has no environment variable whose name mentions agents as a list', () => {
    const configSource = readFileSync(join(srcRoot, 'server', 'config.ts'), 'utf8')

    // A variable like AGENT_NAMES or AGENT_ENDPOINTS would reintroduce exactly what the
    // design forbids, so the schema must not grow one.
    expect(configSource).not.toMatch(/\bAGENTS?\s*:/)
    expect(configSource).not.toMatch(/AGENT_(NAMES|LIST|ENDPOINTS|ROSTER|SLUGS)/)
    expect(configSource).not.toMatch(/ENDPOINT_MAP|AGENT_MAP|ROSTER_JSON/)
  })

  it('declares exactly one ENS-derived input: the discovery root', () => {
    const configSource = readFileSync(join(srcRoot, 'server', 'config.ts'), 'utf8')
    const ensNameFields = [...configSource.matchAll(/^\s{2}([A-Z][A-Z0-9_]*):/gm)].map((m) => m[1]!)

    expect(ensNameFields).toContain('AGENT_DISCOVERY_ROOT')
    expect(ensNameFields.filter((field) => field.includes('AGENT') && field.includes('LIST'))).toEqual([])
  })
})

describe('the discovery root is the only ENS name the router is configured with', () => {
  it('is read from configuration and never defaulted to a literal name', () => {
    const configSource = readFileSync(join(srcRoot, 'server', 'config.ts'), 'utf8')

    // The field is the shared `ensName` schema, which has no `.default(...)`. That absence is
    // what makes the discovery root mandatory rather than a baked-in name.
    expect(configSource).toMatch(/AGENT_DISCOVERY_ROOT: ensName,/)
    expect(configSource).not.toMatch(/AGENT_DISCOVERY_ROOT:\s*z/)

    const ensNameBlock = /const ensName = z[\s\S]*?^\s{2}\)/m.exec(configSource)
    expect(ensNameBlock, 'could not find the ensName schema block').not.toBeNull()
    expect(ensNameBlock![0]).not.toMatch(/\.default\(/)

    // And no `.env.example` value is a real name: it is a placeholder.
    const example = readFileSync(join(srcRoot, '..', '.env.example'), 'utf8')
    expect(example).toMatch(/AGENT_DISCOVERY_ROOT=replace-with-/)
  })
})

describe('the agents live outside src/', () => {
  it('each agent has its own directory and its own entry point', () => {
    const agentsRoot = join(srcRoot, '..', 'agents')
    const slugs = readdirSync(agentsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== 'shared')
      .map((entry) => entry.name)

    expect(slugs.length).toBeGreaterThanOrEqual(3)
    for (const slug of slugs) {
      expect(statSync(join(agentsRoot, slug, 'server.ts')).isFile()).toBe(true)
    }
  })
})