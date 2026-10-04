# Submission report — P3 "Which AI Should Answer This?" (ENS Agent Router)

Prepared from observed command output only. Every row is backed by a command in
[Checks actually run](#checks-actually-run). No official numeric score is claimed: `loops evaluate`
returns an evaluator *prompt*, not a verdict, and this repository's `npm run harness:check` labels
itself *"P3 repo-local gates (no score, not the official harness)"*.

## Target repository

- Project folder: `p3/`
- Remote: `https://github.com/Niru-9/road-to-DEVCON-P21`
- Remote state when checked: **empty** (`git ls-remote` → 0 refs), so no remote history is at risk.

## The nine scored checks, and what was actually observed

| # | Check (`p3.md`) | Observed | Evidence |
| --- | --- | --- | --- |
| 1 | The routed agent is checked against the discovered agent list (20) | **PASS** | `verifyRoutingDecision()` — `src/shared/routing-decision.ts:133` — is the only path from a model string to an agent, enforced in `routeRequest()` — `src/server/route.ts:144`. A name outside the discovered set becomes `rejected-unknown-agent` with `agent: null` and `answer: null`, so there is no route to a fetch; `null` is a valid answer. Tests: `src/server/route.test.ts` (20 tests) — the membership gate, and *never falls through to some other agent*. **No default agent exists anywhere in the codebase.** |
| 2 | The forwarded URL comes from the agent's ENS record (14) | **PASS** | `forwardToAgent()` — `src/server/forward.ts:87` — fetches `agent.endpoint`, which `validateAgentRecords()` — `src/shared/agent-record.ts:235` — took from the `com.ensagent.endpoint` text record. No map, no env lookup, no model-supplied URL on that path. Test: *answers, and attributes the answer to the ENS name whose records supplied the URL* asserts the fetched URL equals the record value. Observed live: 6 real forwards in the recorded run. |
| 3 | The router source contains no literal list of agents (10) | **PASS in code / live discovery NOT VERIFIED** | `runRegistryStrategy()` — `src/server/discovery.ts:355` — reads the roster from the discovery root's own ENS text record; the subgraph strategy is `src/server/subgraph.ts`; names are unioned, capped by `AGENT_DISCOVERY_MAX` — `src/server/discovery.ts:255` — and resolved independently in `resolveNames()` — `src/server/discovery.ts:428`. Only one root is configured, in config. `src/server/no-literal-list.test.ts` (29 tests) scans `src/server/**` and `src/shared/**` for concrete ENS names and non-placeholder endpoints and fails if any appear. **Nothing is published on Sepolia, so live discovery finds nothing** — see below. |
| 4 | A malformed agent record is skipped without failing discovery (8) | **PASS** | `validateAgentRecords()` — `src/shared/agent-record.ts:235` — plus per-key failure isolation in `readAgentRecords()` — `src/server/ens.ts:137`. Test: *skips a malformed agent and continues with the rest* — 7 names in, 3 valid out, 4 rejected with distinct reasons. Observed in the previous session's probe: both live strategies failed in one run and 3 agents were still returned from the fallback. |
| 5 | The forward call to an agent has an explicit timeout (7) | **PASS** | `AbortController` inside `forwardToAgent()` — `src/server/forward.ts:106` — bounded by `AGENT_TIMEOUT_MS`, cleared in `finally`. Tests: *aborts a downstream agent that exceeds the explicit timeout*, *passes an AbortSignal to the underlying fetch*. |
| 6 | The endpoint from ENS is checked to use https before calling (4) | **PASS** | `checkEndpointPolicy()` — `src/shared/agent-record.ts:98` — is called at discovery **and again** immediately before the fetch — `src/server/forward.ts:94`. `https` required; plain `http` accepted only when `ALLOW_INSECURE_LOCAL_AGENTS=true` **and** the host is loopback; `javascript:`, `data:`, `file:`, `ws:`, `ftp:` and relative values always refused. Tests: the `checkEndpointPolicy` block plus `POST /api/check-endpoint`. |
| 7 | An unmatched request produces an explicit no-agent response (6) | **PASS, and observed live** | `routeRequest()` — `src/server/route.ts:144` — returns `no-suitable-agent` using `NO_AGENT_MESSAGES` — `src/shared/routing-decision.ts:177`. Observed in the recorded run: cases **R5 and R6 returned no agent**. |
| 8 | Recorded routing cases state their expected agent (6) | **PASS, and observed** | `src/shared/routing-cases.json` — 8 cases (`R1`…`R8`), each with `question`, `expectAgent` and a `why`; 3 distinct expected agents and 2 explicit `null` expectations. Judge: `judgeRouteResult()` — `src/shared/routing-cases.ts:104`. `npm run record` → **8 of 8 cases matched**. Suite `src/shared/routing-cases.test.ts` (15 tests). |
| 9 | No credential appears in any tracked file (5) | **PASS** | `npm run check:secrets` → `PASS: no credential-shaped content in tracked files, and no secret file is tracked`, 54 text files read, ignore rules verified, `tracked .env files: none`. `toPublicConfigView()` in `src/server/config.ts` keeps secrets server-side. |

**9 of 9 checks pass on local evidence, with check 3's on-chain half unverified.**

## Checks actually run

| Check | Command | Observed result |
| --- | --- | --- |
| Typecheck + tests + secret scan + doc refs | `npm run check` | **exit 0** — `tsc --noEmit` clean; **146 passed / 146** across 7 files (4.66 s); credential scan PASS (54 files, no tracked `.env`); `checked 85 code path(s) and 20 file:line reference(s) across 8 doc file(s)` → PASS |
| Production build | `npm run build` | **PASS** — built in 4.93 s, `dist/web` 162.88 kB JS / 10.93 kB CSS |

Not re-run this session, because nothing in the release path depended on them and they were already
observed in the previous session (recorded in `docs/harness-run-log.md` and `docs/routing-cases.md`):
`npm run harness:check` (green), `npm run record` (8/8, model `qwen2.5:3b` via local Ollama, with
the three agents running), `npm run probe:registry` (3 agents, **all from the labelled dev-registry
fallback**; `ens-registry=empty`, `ens-subgraph=failed`), the three agents' `/health` (200 on 8791 /
8792 / 8793), and the official evaluator prompt (exit 0, 19 740 chars, executed in-repo). The long
full stress process is not part of this project's documented gates and was deliberately not
repeated.

## Defects

**None found in this session.** No gate failed, so nothing was patched and no test was changed.

Three real defects were found and fixed in the previous session's full evaluation pass, all in
`scripts/record-routes.ts`, and all three are why `npm run record` is trustworthy evidence:
it exited 0 on a total failure; it wrote "agents were discovered from live ENS records" into a
tracked doc when the run had discovered nothing; and it printed the expectations dataset's
discovery root instead of the root actually queried.

## Still NOT VERIFIED — blocked by ENS setup

| Requirement | Status | Why |
| --- | --- | --- |
| "Publish each agent under an ENS name on Sepolia, with text records that say what it does, how to reach it, and what input it accepts." | **NOT VERIFIED / BLOCKED BY ENS SETUP** | No agent record is published. `npm run probe:registry` observed `ens-registry=empty` and `ens-subgraph=failed`. The three agents currently resolve from `dev-registry/registry.json`, and every such agent is tagged `source: "dev-registry"` in the API response and badged in the UI. |
| "Make adding a fourth agent a matter of ENS records only, with no change to router code" (check 3's live half) | **NOT VERIFIED** | Proven in code — no literal list anywhere, guarded by a 29-test source grep — but not demonstrated against a real on-chain record, because nothing is published. |
| Acceptance criterion: a new helper published tomorrow is picked up without a deploy | **NOT VERIFIED** | The refresh path exists and works against a fake reader; there is no published record to discover. |
| Official scored evaluation / numeric points | **not claimed** | `loops evaluate --event road-to-devcon-vii --problem ens-agent-router` returns an evaluator prompt, not a verdict. |

No ENS write and no transaction was sent. The root `.env` was not touched. No credential was
printed, requested or written to a tracked file.

## Status

**Ready for repository preparation**, with the honest limitation that no agent is published on
Sepolia: the router, the discovery strategies, the membership gate, the endpoint policy, the
forwarding bounds, the three specialist agents and all local gates are green, and the repo labels
the dev fallback as a fallback everywhere it appears.

Next step for whoever has a funded Sepolia wallet: `npm run publish:dry-run` stages every record
value verbatim, then re-run `npm run probe:registry` and `npm run record` so checks 3 and 8 are
verified against live records instead of the fallback.

Known, deliberately unfixed (ergonomics, not correctness): `npm run record` does not check its own
preconditions and does not start the three agents, so a first-time user can get eight identical
forward timeouts without a hint of the cause.
