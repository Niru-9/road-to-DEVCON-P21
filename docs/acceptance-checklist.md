# Acceptance checklist — the nine scored checks

Criterion → implementation → how to verify → **latest observed result**.

Two things this document will not do:

1. **It will not call anything a scored pass.** The Agent Harness scored evaluation for
   `ens-agent-router` has not been run; it is deferred until all three MVPs exist
   (`../action.md`). `loops evaluate` returns an evaluator *prompt* to execute by hand, not a
   pass/fail result.
2. **It will not claim anything was published.** No agent record exists on Sepolia yet. Every
   ENS-dependent claim below is marked accordingly, and the observable behaviour in this build
   runs through the clearly-labelled development fallback.

"Local check" means a deterministic test or script in this repository that ran and passed. The
observed local results are from the run recorded in [`harness-run-log.md`](harness-run-log.md).

| # | Criterion | Implementation (`file:line`) | Verify | Local status |
| --- | --- | --- | --- | --- |
| 1 | The routed agent is checked against the discovered agent list (20) | `verifyRoutingDecision` `src/shared/routing-decision.ts:133`; `findDiscoveredAgent` `src/shared/agent-record.ts:354`; enforced in `routeRequest` `src/server/route.ts:144` | `npm test` — "routeRequest — the membership gate" | **local check passes.** A name outside the discovered set yields `rejected-unknown-agent`, `answer: null`, `attribution: null`, and zero forward calls. A `null` choice yields the explicit no-agent response. |
| 2 | The forwarded URL comes from the agent's ENS record (14) | `forwardToAgent` `src/server/forward.ts:87` fetches `agent.endpoint`, which `validateAgentRecords` `src/shared/agent-record.ts:235` took from `com.ensagent.endpoint` | `npm test` — "answers, and attributes the answer to the ENS name whose records supplied the URL" asserts the fetched URL equals the record value | **local check passes.** No map, no env lookup, no model-supplied URL exists on this path. |
| 3 | The router source contains no literal list of agents (10) | `runRegistryStrategy` `src/server/discovery.ts:355`, `enumerateSubnamesViaSubgraph` `src/server/subgraph.ts:65`, configured by one root in `src/server/config.ts` | `npm test` — `src/server/no-literal-list.test.ts:71` reads the router's own source | **local check passes.** It scans `src/server/**` and `src/shared/**` for concrete ENS names and non-placeholder endpoint URLs, and fails if any appear in code. |
| 4 | A malformed agent record is skipped without failing discovery (8) | `validateAgentRecords` `src/shared/agent-record.ts:235` + `resolveNames` `src/server/discovery.ts:428`, reading via `readAgentRecords` `src/server/ens.ts:137` | `npm test` — "skips a malformed agent and continues with the rest" (7 names in, 3 valid out, 4 rejected with distinct reasons) | **local check passes.** Validated against a fake ENS reader, not against a live chain. |
| 5 | The forward call to an agent has an explicit timeout (7) | `forwardToAgent` `src/server/forward.ts:87`, `AGENT_TIMEOUT_MS` | `npm test` — "aborts a downstream agent that exceeds the explicit timeout" and "passes an AbortSignal to the underlying fetch" | **local check passes.** The `AbortController` is cleared in `finally` so a pending timer cannot hold the event loop open. |
| 6 | The endpoint from ENS is checked to use https before calling (4) | `checkEndpointPolicy` `src/shared/agent-record.ts:98`, called at discovery and again in `forwardToAgent` `src/server/forward.ts:87` | `npm test` — the `checkEndpointPolicy` block; also `POST /api/check-endpoint` | **local check passes.** `http` is rejected for any non-loopback host, even with the dev flag on. |
| 7 | An unmatched request produces an explicit no-agent response (6) | `routeRequest` `src/server/route.ts:144`; `NO_AGENT_MESSAGES` `src/shared/routing-decision.ts:177` | `npm test` — "routeRequest — no suitable agent (criterion 7)", including "never falls through to some other agent" | **local check passes.** There is no default agent anywhere in the codebase. |
| 8 | Recorded routing cases state their expected agent (6) | `src/shared/routing-cases.json` + `judgeRouteResult` `src/shared/routing-cases.ts:104` + `docs/routing-cases.md` | `npm test` — the `recorded routing cases` block | **local check passes.** 8 cases, 3 distinct expected agents, 2 explicit `null` expectations. **No observed live run yet** — see the note at the top of `routing-cases.md`. |
| 9 | No credential appears in any tracked file (5) | `.gitignore` + `scripts/scan-secrets.mjs`; server boundary in `toPublicConfigView` `src/server/config.ts` | `npm run check:secrets` | **local check passes.** Verified that ignore rules actually match and that no secret file is tracked. |

Two supporting properties are also enforced by tests, because they are what makes the checks
above meaningful rather than incidental:

- The system prompt is a frozen literal with no interpolation point
  (`ROUTING_SYSTEM_PROMPT` `src/shared/routing-prompt.ts:27`), and untrusted record text goes in a
  separate data message (`buildRoutingMessages` `src/shared/routing-prompt.ts:108`). A test asserts
  no record text and no client request reach the instruction slot.
- A downstream reply is schema-validated, de-marked-up, de-controlled and truncated before
  display (`parseAgentReply` `src/shared/agent-reply.ts:74`). A non-2xx status, HTML, or JSON
  without `answer` is an error, not an answer.

## Not yet demonstrated, and why

| Item | Status | Needed for |
| --- | --- | --- |
| Agent records published on Sepolia | **not done** | A live run of criterion 2, 3 and 4 against real ENS data. `npm run publish:dry-run` prints exactly what to sign; signing is a later, MetaMask-confirmed step. |
| Live ENS discovery through `ens-registry` | **not demonstrated** | Same. The code path is exercised against a fake reader; `npm run probe:registry` runs it against real Sepolia and will show `ens-registry: empty` until the root record exists. |
| Live ENS discovery through `ens-subgraph` | **expected to return nothing** | Documented in `discovery-strategy.md`: the public ENS subgraph indexes mainnet names, and Sepolia names are frequently offchain/gasless. Not worked around; the router reports the reason. |
| Model-driven routing against a live provider | **not demonstrated** | Needs `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` in the ignored `.env`. The whole route path is tested with an injected model, including a deliberately hostile one. |
| Recorded routing cases observed | **not done** | `npm run record` after the two items above. |
| Scored harness evaluation | **deferred by instruction** | All three MVPs implemented. |

## The dev fallback, stated plainly

Right now `dev-registry/registry.json` supplies the three agents, because live ENS discovery
correctly finds nothing. Every such agent is tagged `source: "dev-registry"` in the API response
and shown with a banner in the UI. It goes through the same validation and the same endpoint
policy as live records, so it cannot smuggle in an agent the live path would reject — but it is
**not** ENS discovery, and no part of this repository claims it is.