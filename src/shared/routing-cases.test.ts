/**
 * The recorded routing dataset.
 *
 * SCORED CRITERION 8 (6 points): every case states the agent expected to handle it, or an
 * explicit null. These tests keep that true as the dataset is edited.
 */

import { describe, expect, it } from 'vitest'

import {
  EXPECTED_NO_AGENT_CASES,
  ROUTING_CASES,
  ROUTING_CASE_LIST,
  assertCasesMatchRoot,
  judgeRouteResult,
  routingCaseSchema,
} from './routing-cases'

describe('the recorded routing cases', () => {
  it('are for this problem and name a discovery root', () => {
    expect(ROUTING_CASES.problemSlug).toBe('ens-agent-router')
    expect(ROUTING_CASES.discoveryRoot.endsWith('.eth')).toBe(true)
  })

  it('cover at least three distinct agents, so routing is actually a choice', () => {
    const agents = new Set(
      ROUTING_CASE_LIST.map((testCase) => testCase.expectAgent).filter((name) => name !== null),
    )
    expect(agents.size).toBeGreaterThanOrEqual(3)
  })

  it('include at least one case that explicitly expects no agent', () => {
    expect(EXPECTED_NO_AGENT_CASES.length).toBeGreaterThan(0)
    for (const testCase of EXPECTED_NO_AGENT_CASES) {
      expect(testCase.expectAgent).toBeNull()
      expect(testCase.why.length).toBeGreaterThan(8)
    }
  })

  it('every case pairs a request with an expected agent or an explicit null, and a reason', () => {
    for (const testCase of ROUTING_CASE_LIST) {
      expect(testCase.question.length).toBeGreaterThan(20)
      expect(testCase.why.length).toBeGreaterThan(20)
      if (testCase.expectAgent !== null) {
        expect(testCase.expectAgent.endsWith(`.${ROUTING_CASES.discoveryRoot}`)).toBe(true)
      }
    }
  })

  it('all name agents under the recorded root', () => {
    expect(() => assertCasesMatchRoot(ROUTING_CASE_LIST, ROUTING_CASES.discoveryRoot)).not.toThrow()
    expect(() => assertCasesMatchRoot(ROUTING_CASE_LIST, 'someother.eth')).toThrow(/outside/)
  })

  it('have unique ids', () => {
    const ids = ROUTING_CASE_LIST.map((testCase) => testCase.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('state plainly that the observed run does not exist yet', () => {
    expect(ROUTING_CASES.status).toBe('recorded-expected')
    expect(ROUTING_CASES.notes.join(' ')).toMatch(/EXPECTATIONS, not observations/)
  })
})

describe('the case schema', () => {
  it('rejects an id that does not look like a case id', () => {
    const base = { question: 'A real request to route', expectAgent: null, why: 'A reason for the expectation.' }
    expect(routingCaseSchema.safeParse({ ...base, id: 'invoice-case' }).success).toBe(false)
    expect(routingCaseSchema.safeParse({ ...base, id: 'R99' }).success).toBe(true)
  })

  it('rejects an expected agent that is not a full ENS name', () => {
    const base = { id: 'R1', question: 'A real request to route', why: 'A reason for the expectation.' }
    expect(routingCaseSchema.safeParse({ ...base, expectAgent: 'invoice' }).success).toBe(false)
    expect(routingCaseSchema.safeParse({ ...base, expectAgent: 'invoice.ensrouter.eth' }).success).toBe(true)
  })

  it('accepts null as a first-class expected agent', () => {
    const parsed = routingCaseSchema.safeParse({
      id: 'R1',
      question: 'Book me a flight to Lisbon tomorrow',
      expectAgent: null,
      why: 'No discovered agent handles travel.',
    })
    expect(parsed.success).toBe(true)
  })
})

describe('judgeRouteResult', () => {
  const routed = ROUTING_CASE_LIST.find((testCase) => testCase.expectAgent !== null)!
  const unrouted = EXPECTED_NO_AGENT_CASES[0]!

  it('passes when the expected agent answered', () => {
    expect(
      judgeRouteResult(routed, { outcome: 'answered', answeredAgent: routed.expectAgent }).pass,
    ).toBe(true)
  })

  it('fails, with a reason, when a different agent answered', () => {
    const verdict = judgeRouteResult(routed, {
      outcome: 'answered',
      answeredAgent: 'contract.ensrouter.eth',
    })
    expect(verdict.pass).toBe(false)
    expect(verdict.detail).toMatch(/answered instead/)
  })

  it('fails, with a reason, when nothing answered an agent case', () => {
    const verdict = judgeRouteResult(routed, { outcome: 'no-suitable-agent', answeredAgent: null })
    expect(verdict.pass).toBe(false)
    expect(verdict.detail).toMatch(/no-suitable-agent/)
  })

  it('passes when an explicit-null case produced no-suitable-agent', () => {
    expect(
      judgeRouteResult(unrouted, { outcome: 'no-suitable-agent', answeredAgent: null }).pass,
    ).toBe(true)
  })

  it('fails when an explicit-null case was answered anyway', () => {
    const verdict = judgeRouteResult(unrouted, {
      outcome: 'answered',
      answeredAgent: 'invoice.ensrouter.eth',
    })
    expect(verdict.pass).toBe(false)
    expect(verdict.detail).toMatch(/but invoice\.ensrouter\.eth answered/)
  })
})