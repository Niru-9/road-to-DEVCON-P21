/**
 * The shared shape of a specialist agent.
 *
 * Each agent in `agents/` is its own small HTTP service with its own process and its own port,
 * so any one of them can be started, stopped or restarted independently of the router and of
 * each other. This module is the part they share: request validation, the reply shape, a
 * health endpoint that echoes the agent's own metadata, and a startup log.
 *
 * Nothing here reads the router's configuration, and the router never imports this module.
 * That separation is the point: how an agent is started has no bearing on how the router
 * discovers it. The router learns an agent's URL from that agent's ENS text record; it does not
 * know about ports, and these services do not register themselves anywhere.
 */

import express from 'express'
import type { Request, Response } from 'express'
import { z } from 'zod'

import {
  AGENT_RECORD_KEYS,
  AGENT_RECORD_FORMAT_VERSION,
  checkEndpointPolicy,
} from '../../src/shared/agent-record'

/** What the router POSTs. Bounded here too, so a huge request cannot occupy the agent. */
export const agentRequestSchema = z.object({
  question: z
    .string()
    .trim()
    .min(3, 'question is too short to answer')
    .max(2_000, 'question is longer than this agent accepts'),
  /** The ENS name the router discovered. Informational; never used for attribution. */
  requestedBy: z.string().trim().max(200).optional(),
})

export type AgentRequest = z.infer<typeof agentRequestSchema>

/** The reply shape the router validates. Documented in docs/agent-record-format.md. */
export interface AgentReplyBody {
  readonly ok: true
  readonly answer: string
  /** Advisory only. The router always attributes from the ENS name it discovered. */
  readonly agent: string
  readonly notes: readonly string[]
}

export interface AgentDefinition {
  /** Stable slug, used in logs. Matches the agent's ENS label by convention only. */
  readonly slug: string
  readonly displayName: string
  /** One line: what this agent is for. Mirrors the capability record. */
  readonly capability: string
  /** One line: what this agent expects to receive. Mirrors the accepted-input record. */
  readonly accepts: string
  /** The agent's own version, mirrored in the optional version record. */
  readonly version: string
  /**
   * The port this process listens on, from its own environment variable.
   *
   * This is how the service is started. It is NOT how the router finds it — the router reads
   * the endpoint from this agent's ENS text record. Keeping the two apart is what makes "add a
   * fourth agent by publishing records" true.
   */
  readonly portEnvVar: string
  readonly defaultPort: number
  /** The agent's answer. Deterministic, so the demo never depends on a model provider. */
  readonly handle: (question: string) => { readonly answer: string; readonly notes: readonly string[] }
}

/** Read this agent's port from its own environment, with a documented default. */
function resolvePort(definition: AgentDefinition): number {
  const raw = process.env[definition.portEnvVar]
  if (raw === undefined || raw.trim().length === 0) return definition.defaultPort

  const parsed = Number.parseInt(raw.trim(), 10)
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(
      `${definition.portEnvVar} must be a port number between 1 and 65535, but was "${raw}".`,
    )
  }
  return parsed
}

/**
 * The exact ENS text records this agent's owner must publish for it.
 *
 * Returned by `GET /health` and printed at startup, so publishing the metadata and running the
 * service cannot drift apart: the values the operator needs to put on chain are the values the
 * running process reports about itself.
 */
export function recordsFor(definition: AgentDefinition, port: number): Readonly<Record<string, string>> {
  const path = '/invoke'
  return {
    [AGENT_RECORD_KEYS.capability]: definition.capability,
    // The router requires https for a discovered endpoint. On a laptop the localhost
    // exception applies, so this is http://127.0.0.1:<port>/invoke for local development.
    [AGENT_RECORD_KEYS.endpoint]: `http://127.0.0.1:${port}${path}`,
    [AGENT_RECORD_KEYS.accepts]: definition.accepts,
    [AGENT_RECORD_KEYS.version]: definition.version,
  }
}

/**
 * Start one agent service.
 *
 * Routes: `GET /health` and `POST /invoke`. Nothing else, so there is no accidental surface.
 */
export function startAgent(definition: AgentDefinition): void {
  const port = resolvePort(definition)
  const records = recordsFor(definition, port)
  const app = createAgentApp(definition, port)

  app.listen(port, () => {
    const lines = [
      '',
      `  ${definition.displayName}  (${definition.slug})`,
      `  capability: ${definition.capability}`,
      `  accepts:    ${definition.accepts}`,
      `  listening:  http://127.0.0.1:${port}`,
      '',
      `  ENS text records to publish on the agent's Sepolia name`,
      `  (the router reads these; it does not know this port):`,
    ]

    for (const [key, value] of Object.entries(records)) {
      lines.push(`    ${key.padEnd(28)} ${value}`)
    }

    const localCheck = checkEndpointPolicy(records[AGENT_RECORD_KEYS.endpoint], {
      allowInsecureLocal: true,
    })
    lines.push(
      '',
      `  endpoint policy (dev): ${localCheck.ok ? 'accepted as a loopback endpoint' : localCheck.reason}`,
      `  For a public demo, replace the endpoint value with an https:// URL before publishing.`,
      '',
    )

    console.log(lines.join('\n'))
  })
}

/** Exported so the agent's logic can be exercised without binding a port. */
export function createAgentApp(definition: AgentDefinition, port: number): express.Express {
  const app = express()
  const records = recordsFor(definition, port)
  app.use(express.json({ limit: '32kb' }))

  app.get('/health', (_req: Request, res: Response) => {
    res.json({
      ok: true,
      agent: definition.slug,
      displayName: definition.displayName,
      version: definition.version,
      recordFormatVersion: AGENT_RECORD_FORMAT_VERSION,
      port,
      records,
    })
  })

  app.post('/invoke', (req: Request, res: Response) => {
    const parsed = agentRequestSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({
        error: {
          code: 'BAD_REQUEST',
          message: 'Send {"question": "…"} with a question of 3 to 2000 characters.',
          detail: parsed.error.issues,
        },
      })
      return
    }

    try {
      const result = definition.handle(parsed.data.question)
      const body: AgentReplyBody = {
        ok: true,
        answer: result.answer,
        agent: definition.slug,
        notes: result.notes,
      }
      res.json(body)
    } catch (error) {
      res.status(500).json({
        error: {
          code: 'AGENT_ERROR',
          message: `${definition.displayName} could not answer that request.`,
          detail: error instanceof Error ? error.message : String(error),
        },
      })
    }
  })

  app.use((_req: Request, res: Response) => {
    res.status(404).json({
      error: { code: 'NOT_FOUND', message: 'This agent serves only GET /health and POST /invoke.' },
    })
  })

  return app
}

/**
 * Shared text helpers.
 *
 * These agents answer from rules rather than from a model, on purpose: the point being
 * demonstrated is ENS discovery and constrained routing, and a rule-based answer keeps the demo
 * deterministic and free. Nothing here invents facts — each answer says what it is based on.
 */
export const text = {
  /** Lowercase, punctuation-collapsed words, for keyword matching. */
  tokens(input: string): string[] {
    return input
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((token) => token.length > 2)
  },

  hasAny(input: string, needles: readonly string[]): boolean {
    const haystack = ` ${input.toLowerCase()} `
    return needles.some((needle) => haystack.includes(needle.toLowerCase()))
  },

  bullets(lines: readonly string[]): string {
    return lines.map((line) => `- ${line}`).join('\n')
  },
} as const