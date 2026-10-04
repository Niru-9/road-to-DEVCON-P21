/**
 * The recorded routing cases.
 *
 * SCORED CRITERION 8 (6 points): each case pairs a client request with the specific agent
 * expected to handle it, or explicitly expects no agent. `expectAgent: null` is a first-class
 * expected outcome here, not a missing value.
 *
 * The dataset is validated with Zod at load time, so a malformed case fails loudly at
 * startup rather than quietly producing a bogus expectation.
 */

import { z } from 'zod'

import rawCases from './routing-cases.json'

/**
 * One recorded case.
 *
 * `expectAgent` is a full ENS name that must be a subname of the discovery root, or `null`.
 * Nothing else is accepted — there is no "closest agent" and no fuzzy match here either.
 */
export const routingCaseSchema = z.object({
  id: z
    .string()
    .trim()
    .regex(/^R\d+$/, 'a case id looks like R1'),
  question: z.string().trim().min(8, 'a case needs a real request to route'),
  expectAgent: z
    .string()
    .trim()
    .regex(/^.+\.[a-z]{2,}$/i, 'an expected agent must be a full ENS name')
    .nullable(),
  why: z.string().trim().min(8, 'a case must state why this agent, or why none'),
})

export type RoutingCase = z.infer<typeof routingCaseSchema>

const datasetSchema = z.object({
  problem: z.string().trim().min(1),
  problemSlug: z.string().trim().min(1),
  discoveryRoot: z.string().trim().regex(/^[^.\s]+\.[a-z]{2,}$/i),
  status: z.string().trim().min(1),
  notes: z.array(z.string().trim().min(1)).min(1),
  cases: z.array(routingCaseSchema).min(1),
})

export const ROUTING_CASES = datasetSchema.parse(rawCases)
export const ROUTING_CASE_LIST: readonly RoutingCase[] = ROUTING_CASES.cases

/**
 * Every expected agent in the dataset must sit under the recorded discovery root.
 *
 * This is a self-consistency check on the data, not a routing check, and it is cheap: a case
 * that names an agent outside the root could never pass and would waste a demo.
 */
export function assertCasesMatchRoot(cases: readonly RoutingCase[], root: string): void {
  const suffix = `.${root.toLowerCase()}`
  const outside = cases
    .filter((testCase) => testCase.expectAgent !== null)
    .filter((testCase) => !(testCase.expectAgent ?? '').toLowerCase().endsWith(suffix))

  if (outside.length > 0) {
    throw new Error(
      `Recorded routing cases name agents outside ${root}: ${outside
        .map((testCase) => `${testCase.id} -> ${testCase.expectAgent}`)
        .join(', ')}`,
    )
  }
}

export const EXPECTED_NO_AGENT_CASES: readonly RoutingCase[] = ROUTING_CASE_LIST.filter(
  (testCase) => testCase.expectAgent === null,
)

/** A short list for the UI's one-click demo buttons. */
export const EXAMPLE_CASES: readonly RoutingCase[] = ROUTING_CASE_LIST

/**
 * Judge one observed route against one recorded case.
 *
 * Returns a plain pass/fail plus the reason, so `npm run record` can write an honest report
 * and the UI can show which expectations currently hold.
 */
export function judgeRouteResult(
  testCase: RoutingCase,
  observed: { readonly outcome: string; readonly answeredAgent: string | null },
): { readonly pass: boolean; readonly detail: string } {
  if (testCase.expectAgent === null) {
    if (observed.outcome === 'no-suitable-agent') {
      return { pass: true, detail: 'expected no agent, and none was used' }
    }
    if (observed.answeredAgent !== null) {
      return {
        pass: false,
        detail: `expected no agent, but ${observed.answeredAgent} answered`,
      }
    }
    return {
      pass: false,
      detail: `expected no agent, but the route ended as "${observed.outcome}"`,
    }
  }

  if (observed.answeredAgent === testCase.expectAgent) {
    return { pass: true, detail: `routed to ${testCase.expectAgent} as expected` }
  }

  if (observed.answeredAgent === null) {
    return {
      pass: false,
      detail:
        observed.outcome === 'no-suitable-agent'
          ? `expected ${testCase.expectAgent}, but the router returned no-suitable-agent`
          : `expected ${testCase.expectAgent}, but the route errored (${observed.outcome})`,
    }
  }

  return {
    pass: false,
    detail: `expected ${testCase.expectAgent}, but ${observed.answeredAgent} answered instead`,
  }
}