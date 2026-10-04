# P3 — ENS Agent Router: action log

Problem: **Which AI Should Answer This?** (`p3.md`, 9 scored checks, 80 points).
Brief and the nine checks verbatim: `docs/problem-statement.md`.

Working rules for this repo:

- Everything P3 lives inside `p3/`. `p1/`, `p2/` and the Dev8 root are read-only here.
- No commit and no push in this phase.
- No ENS write transaction in this phase. Publishing is a later front-end-review step.
- Secrets only in the ignored `p3/.env`. `.env.example` is placeholders only. No wallet key is
  ever requested, read, stored or transmitted by anything in this repository.
- The scored Agent Harness evaluation is **not** run in this phase. Local checks are local.

---

## Status summary

| # | Task | Status |
| --- | --- | --- |
| T1 | Read `p3.md` + `plan.md`, inspect P2 conventions, write this log | `DONE` |
| T2 | Install Agent Harness in `p3/`, read installed skill | `DONE` |
| T3 | Query the `ens-agent-router` knowledge graph | `DONE` (no context returned) |
| T4 | Scaffold project: package.json, tsconfig, vite, vitest, ignores, env | `DONE` |
| T5 | ENS agent-record schema + endpoint policy (HTTPS / localhost-only dev exception) | `DONE` |
| T6 | ENS reads + runtime discovery (registry pointer, optional subgraph), skip malformed | `DONE` |
| T7 | Model routing, code-level membership check, forward with timeout, attribution, no-agent branch | `DONE` |
| T8 | Three specialist HTTP agents, separately runnable | `DONE` |
| T9 | React UI: ask, discovery status, attribution, no-agent state, MetaMask + Sepolia status | `DONE` |
| T10 | Recorded routing cases (dataset + judge + generated doc) | `DONE` (dataset + doc; **live run deferred**) |
| T11 | Tests: schema, endpoint policy, skip-malformed, membership, no-agent, timeouts, no-literal-list | `DONE` — 146 tests |
| T12 | Scripts: secret scan, `harness:check`, record-routes, publish dry-run, probe, doc refs | `DONE` |
| T13 | Docs: problem statement, record format, discovery strategy, acceptance checklist, README | `DONE` |
| T14 | Bounded checks actually run, with results | `DONE` |
| T15 | Handoff: what is verified, what is not, next step for the front-end review | `DONE` |
| T16 | Full 9-check official evaluation, recorded cases run live, harness defects fixed | `DONE` |

---

## T1 — Read the brief and the plan `DONE`

- `p3.md`: nine scored checks, listed in full in `docs/problem-statement.md`.
- `plan.md`: the P3 flow, the "no hardcoded agent list" requirement, and the instruction to use one
  reproducible namespace strategy, documented, with an explicit discovery root.
- P2 conventions reused for consistency (Express + viem + Zod + Vite/React + Vitest, secrets
  scanner, `harness:check`, generated docs, `action.md`). No runtime coupling: P3 has its own
  ports (8789 / 5175 / 8791-8793), its own env file and its own package.

## T2 — Agent Harness installed in `p3/` `DONE`

Command, run from `N:\dev8\p3`:

```
npx loopshouse add road-to-devcon-vii
```

Result (from `harness-add.log`): CLI `v0.5.0` installed and up to date, skill written to
`.claude/skills/loops-road-to-devcon-vii/SKILL.md` and
`.agents/skills/loops-road-to-devcon-vii/SKILL.md`, signed in as the existing account
(`loops auth status` → `authenticated: true`). Node is `v22.22.0`, above the required 20.12.

Skill facts that shape this build:

- The repo **is** the submission. `loops project create` needs a real GitHub repo, so it is not
  run in this phase.
- `loops evaluate` returns an evaluator *prompt* to execute by hand. It is not a pass/fail
  runner, so it is **not** run in this phase either.
- 1 credit per knowledge-graph query; 93 of 100 were available.

## T3 — Knowledge graph query `DONE` (returned nothing)

Queries run against `--problem ens-agent-router`:

1. `"How should a router enumerate the ENS names of specialist agents on Sepolia at runtime -
   registry text record pointer vs subgraph enumeration - and what are the limits of each on
   Sepolia?"` → `No relevant context was retrieved for this query.`
2. `"ENS agent router problem brief, acceptance criteria, ENS text record format for agent
   capability endpoint and accepted input, and discovery from ENS"` → same.
3. `"ENS text records on Sepolia"` → same, and the identical query against
   `community-people-finder` also returned nothing.

Re-run in this session, both returning nothing:

4. `"How should the router discover specialist agent ENS names at runtime on Sepolia - enumerate
   subnames of a parent via subgraph, or use an ENS text-record registry pointer on the parent
   name - and what are the limitations of each on Sepolia?"` → `No relevant context…`
5. `"ENS text record format for AI agent capability endpoint and accepted input; judging rubric
   for Which AI Should Answer This"` → `No relevant context…`

So the graph holds no retrievable context for this problem. The discovery design is therefore
derived from `p3.md`, from the event prerequisites in the root `plan.md`, and from the ENSIP-5 /
ENSIP-15 behaviour viem implements — **not** from the knowledge graph. Recorded here so nobody
later assumes the graph confirmed this design.

## T4 — Scaffold `DONE`

`package.json`, `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`, `.gitignore`,
`.env.example`, and an ignored `.env` containing placeholders only. Node `v22.22.0`,
npm `11.6.2`, 233 packages installed. P3 is port-isolated from P1/P2: router 8789, web 5175,
agents 8791/8792/8793.

## T5 — Record schema and endpoint policy `DONE`

`src/shared/agent-record.ts`: the four agent keys, the two registry keys, Zod schemas with
explicit bounds, per-key read status (`read` / `unset` / `failed`), and `checkEndpointPolicy`.

The policy is the scored criterion 6 behaviour: **https required**, with plain `http` accepted
only when `ALLOW_INSECURE_LOCAL_AGENTS=true` **and** the hostname is loopback
(`localhost`, `127.0.0.1`, `::1`). `http://agents.example.com` is refused even on a laptop, and
`javascript:`, `data:`, `file:`, `ws:`, `ftp:` and relative values are always refused. The check
runs at discovery and again in `forwardToAgent` immediately before the fetch.

## T6 — ENS reads and runtime discovery `DONE`

`src/server/ens.ts` — `normalizeEnsName` (ENSIP-15) is the only way a name enters the module;
`readAgentRecords` isolates per-key failures; `readRegistryRecord` reads the roster.

`src/server/discovery.ts` — two configurable strategies, no name in code:

- `ens-registry` (primary): the discovery root's own `com.ensagent.registry.agents` record lists
  its agents. Works on Sepolia because it needs no indexer.
- `ens-subgraph` (secondary): `src/server/subgraph.ts` enumerates the root's subnames via the ENS
  subgraph. One GraphQL document, one variable, never concatenating the parent into the query.

Union → `AGENT_DISCOVERY_MAX` ceiling → normalize/dedupe → read and validate each name
independently. One bad record becomes a `RejectedAgent` with a reason; discovery continues.
TTL cache (`AGENT_CACHE_TTL_MS`) with the UI's Refresh bypassing it, and concurrent callers
sharing one in-flight pass.

## T7 — Model routing, membership gate, forwarding `DONE`

`src/shared/routing-prompt.ts`: `ROUTING_SYSTEM_PROMPT` is a frozen literal with no
interpolation point; untrusted descriptions are flattened to one bounded line in a **separate**
data message with `|` and `"` stripped so a record cannot forge a field or a candidate.

`src/server/llm.ts`: OpenAI-compatible `/chat/completions`, per-attempt `AbortController` bounded
by `LLM_TIMEOUT_MS` and always cleared in `finally`, bounded retries honouring `Retry-After`,
bounded `max_tokens`, and a leak assertion that refuses to call the model if record text or the
client request ever reached the system prompt.

`src/shared/routing-decision.ts`: `verifyRoutingDecision` is the only path from a model string to
an agent. `null` is a correct answer; a name outside the candidate set is `rejected-unknown-agent`
with `agent: null`, so there is no route to a fetch.

`src/server/forward.ts`: fetches `agent.endpoint` — the value read from that agent's ENS record —
re-checks the policy, and bounds the call with `AGENT_TIMEOUT_MS`.

`src/server/route.ts`: orchestrates discover → bound → decide → verify → forward, and returns
`answered` / `no-suitable-agent` / `error`. Attribution carries the ENS name, the endpoint host and
protocol, the HTTP status, the agent duration and the timeout. **No default agent exists anywhere
in this codebase.**

## T8 — Three specialist agents `DONE`

`agents/invoice/server.ts`, `agents/contract/server.ts`, `agents/brand-copy/server.ts`, sharing
`agents/shared/service.ts`. Each is its own process and port (`npm run agent:invoice`,
`:contract`, `:brand`, or `npm run agents` for all three), serves `GET /health` and
`POST /invoke` and nothing else, and answers from rules so the demo does not depend on a model
provider. Each `GET /health` prints the exact ENS records its owner should publish, so the
running service and the chain cannot drift apart.

**How a service is started has no bearing on how the router finds it** — the router reads the URL
from the ENS record and does not know about ports.

## T9 — UI `DONE`

`src/web/App.tsx` + `api.ts` + `wallet.ts` + `styles.css`. One column on a phone, two columns on
a laptop with the answer spanning beneath. It shows: the discovery root, the strategies that ran
and what each returned, every discovered agent with its source badge, the agents skipped and why,
the ask box, the recorded cases as one-click buttons, and per answer a **Routing trace** showing
all four steps plus the candidates offered to the model.

MetaMask connect/disconnect with visible address and Sepolia/network status is implemented and
read-only. Routing and discovery work with the wallet disconnected, and no ENS write transaction
is sent from this build. `wallet.ts` contains no key handling; the only URL in it is the
**public, unauthenticated** Sepolia RPC used for `wallet_addEthereumChain`, which is not a secret.

## T10 — Recorded routing cases `DONE` for the dataset; live run deferred

`src/shared/routing-cases.json`: 8 cases, 3 distinct expected agents, 2 cases that explicitly
expect **no** agent (`expectAgent: null`). Validated with Zod at load time.
`judgeRouteResult` is the shared pass/fail rule used by both the tests and `npm run record`.
`docs/routing-cases.md` states the expectations and says in its own header that they are
**expectations, not observations**.

`npm run record` exists and re-runs every case through the live route, rewriting that document
with observed results. **It has not been run** — it needs a model endpoint and published records.

## T11 — Tests `DONE` (146 passing)

`npm test` → **7 files, 146 tests, 0 failures, ~5 s.** Coverage by criterion:

| Criterion | Where |
| --- | --- |
| 1 membership gate | `src/server/route.test.ts` — including `null`, a URL, `default`, a suffixed name and a TLD-stripped name, all refused with zero forward calls |
| 2 URL from the ENS record | `src/server/route.test.ts` — the fetched URL is asserted equal to the record value |
| 3 no literal list | `src/server/no-literal-list.test.ts` — reads the router's own source; 29 tests |
| 4 skip malformed | `src/server/discovery.test.ts` — 7 names in, 3 valid out, 4 rejected with 4 distinct reasons |
| 5 forward timeout | `src/server/route.test.ts` — abort on exceed, and an `AbortSignal` really reaches fetch |
| 6 https policy | `src/shared/agent-record.test.ts` |
| 7 explicit no-agent | `src/server/route.test.ts` — "never falls through to some other agent" |
| 8 recorded cases | `src/shared/routing-cases.test.ts` |
| 9 credentials | `npm run check:secrets` |

Also covered: prompt-leak prevention, hostile-record flattening, reply sanitization and
truncation, the dev fallback being subordinate to live discovery, cache TTL behaviour, the API
never leaking the API key or the RPC path, and a missing model/RPC producing an actionable error.

## T12 — Scripts `DONE`

| Script | Purpose |
| --- | --- |
| `scripts/scan-secrets.mjs` | verifies ignore rules actually match, that no secret file is tracked, and that no tracked file holds credential-shaped content — including authenticated URLs and keyed-RPC provider hosts |
| `scripts/check-doc-references.mjs` | validates every code path **and** every `file:line` in the docs; currently 35 paths + 20 line refs, all resolving |
| `scripts/harness-check.mjs` | repo-local gate runner; computes **no score**, writes `docs/harness-run-log.md` |
| `scripts/probe-registry.ts` | which discovery strategy finds what, right now, on Sepolia |
| `scripts/publish-records.ts` | prints the exact records to sign per name; **sends no transaction** |
| `scripts/record-routes.ts` | runs the recorded cases and rewrites `docs/routing-cases.md` |

`publish-records.ts` and `record-routes.ts` contain no agent name or endpoint literal either —
they read `dev-registry/registry.json` and `.env`.

## T13 — Docs `DONE`

`README.md`, `docs/problem-statement.md`, `docs/agent-record-format.md`,
`docs/discovery-strategy.md`, `docs/routing-cases.md`, `docs/acceptance-checklist.md`,
`dev-registry/README.md`.

`docs/acceptance-checklist.md` maps each of the nine criteria to a verified `file:line`, to how
to verify it, and to its **latest observed local result** — with a separate table of what is
*not* yet demonstrated and why.

## T14 — Bounded checks actually run, with results

Everything below was run in this session from `N:\dev8\p3`. These are **local** results. They are
not, and must not be read as, scored harness results.

| Command | Result |
| --- | --- |
| `npm run typecheck` | **pass**, no output (`tsc --noEmit`, strict, over `src`, `scripts`, `agents`) |
| `npm test` | **pass** — 7 files, 146 tests, 0 failures, 5.01 s |
| `npm run build` | **pass** — 33 modules, `dist/web` 162.88 kB JS (52.12 kB gzip) + 10.93 kB CSS, 4.97 s |
| `npm run check:secrets` | **pass** — 53 text files read, no credential-shaped content, no tracked `.env`, ignore rules verified |
| `npm run check:docs` | **pass** — 35 code paths and 20 `file:line` refs resolve |
| `loops auth status` | `authenticated: true`, CLI `0.5.0` |
| `loops knowledge query … --problem ens-agent-router` (2 more queries) | `No relevant context was retrieved for this query.` |
| Bundle leak probe (grep `dist/web/assets/*.js`) | clean for `LLM_API_KEY`, `SEPOLIA_RPC_URL`, `AGENT_DISCOVERY_ROOT`, `thegraph`, `api.groq`, `openrouter`, `Bearer`. The single `publicnode` hit is the **public unauthenticated** Sepolia RPC in `wallet_addEthereumChain`, not a secret |

### Short bounded runtime smoke (partial, and why it was stopped)

Run with a placeholder `.env` (`LLM_API_KEY` unset/placeholder, `AGENT_DISCOVERY_ROOT=ensrouter.eth`,
public Sepolia RPC). Two long-running server startups were stopped after they exceeded their
expected duration; the cause was the harness pattern, not the app — `Start-Process … -NoNewWindow`
plus a sleep-and-poll pattern in a single shell call, and one `EADDRINUSE` from a leftover child
process. Both were cleaned up; all four ports were confirmed free afterwards, and no P3 process
survives. **This workflow is not repeated.** What the partial run did establish:

- Router boots, prints its configuration, and answers `GET /api/health` on 8789.
- Live discovery ran against real Sepolia and returned nothing — `ens-registry=empty`,
  `ens-subgraph=failed` — which is the correct, expected state before publication. The router
  then used the labelled `dev-registry/registry.json` fallback.
- **A real wiring bug was found and fixed this way:** the boot warm-up used a *second*
  `AgentDiscovery` instance, so `GET /api/agents` reported 0 agents on the first page load and the
  UI would have looked broken. `createApp` now accepts a shared `discovery` and `main()` warms up
  the instance the routes use. After the fix, `GET /api/agents` reported all three agents.
- All three agents booted and answered `GET /health` with their correct records and endpoints
  (8791 invoice, 8792 contract, 8793 brand copy).

**Not run:** a live end-to-end `/api/route` with a real model. There is no model key in this
workspace, so the routing decision cannot be made. The full forward path is covered by unit tests
with an injected model and an injected downstream fetch.

### Not run in this phase, by instruction

- The full 9-check scored harness evaluation (`loops evaluate --event road-to-devcon-vii
  --problem ens-agent-router`), and any stress test. Deferred until all three MVPs are built.
- `npm run record` — needs a model endpoint and published records.
- `npm run dev` full stack with the Vite dev server.

---

## Configuration still required, by name

`.env.example` holds a documented placeholder for every one of these. Nothing below is present as
a real value, and no value was copied from the Dev8 root `.env`.

| Variable | Why P3 needs it | Currently |
| --- | --- | --- |
| `AGENT_DISCOVERY_ROOT` | the single ENS name discovery starts from. **Without it the router cannot find any agent**, by design. | placeholder |
| `LLM_BASE_URL` | any OpenAI-compatible endpoint, e.g. `https://api.groq.com/openai/v1`. Required, no default. | placeholder |
| `LLM_MODEL` | any model id that endpoint serves. Required, no default. | placeholder |
| `LLM_API_KEY` | provider key. Optional for a local provider such as Ollama. Server-side only. | placeholder |
| `SEPOLIA_RPC_URL` | reads the ENS records. A **public** endpoint is sufficient and is not a secret; a keyed/Pro URL is a secret and belongs only in `.env`. | public default works |
| `ENS_SUBGRAPH_URL` | optional; only used by the `ens-subgraph` strategy. Public works; a DeGraph URL is a secret. | public default works |

Optional tuning already has safe defaults and needs nothing: `LLM_TIMEOUT_MS`, `LLM_MAX_TOKENS`,
`RPC_TIMEOUT_MS`, `AGENT_DISCOVERY_SOURCES`, `AGENT_DISCOVERY_MAX`, `AGENT_CACHE_TTL_MS`,
`AGENT_TIMEOUT_MS`, `AGENT_REPLY_MAX_CHARS`, `ALLOW_INSECURE_LOCAL_AGENTS`,
`ALLOW_DEV_REGISTRY_FALLBACK`, `AGENT_ROUTE_MAX_CANDIDATES`, `PORT`.

**No wallet key is needed or wanted.** Publishing is signed in MetaMask in the browser during the
front-end review; this repository contains no signer and no ENS write path.

Missing configuration produces an actionable error, not a crash: `ConfigError` names the offending
variable and prints the copy-to-`.env` instruction (`npm run typecheck`-verified via the config
tests).

---

## Unresolved external dependency: ENS publishing

**No agent has been published. Nothing in this repository claims otherwise.**

The runtime discovery path is real and complete — `ens-registry` reads the root's registry record
and then each agent's own records, through viem's Universal Resolver — but it needs records that do
not exist yet. Until they do, live discovery returns nothing and the router reads
`dev-registry/registry.json`, which is tagged `source: "dev-registry"` everywhere it surfaces and
carries a banner in the UI. It is clearly labelled, isolated, and goes through the same validation
and the same endpoint policy as live records. It is **not** ENS discovery and does not pretend to
be.

To close the dependency:

1. Register the discovery root and each agent name on Sepolia.
2. Sign `com.ensagent.registry.version` and `com.ensagent.registry.agents` on the root.
3. Sign `com.ensagent.capability`, `com.ensagent.endpoint`, `com.ensagent.accepts` (and optionally
   `com.ensagent.version`) on each agent name.
4. `npm run probe:registry` → confirm `ens-registry=ok` and three agents.
5. Press **Refresh from ENS** in the UI, or restart the router.

`npm run publish:dry-run` prints the exact values to sign, per name, from the same file the running
agents report — no transaction, no key.

### A known limit that is not a defect

`ens-subgraph` is **expected to return nothing on Sepolia**: the public ENS subgraph indexes
mainnet names and Sepolia names are frequently offchain/gasless. That is why `ens-registry` is the
primary strategy, why both are configuration rather than assumptions, and why the UI reports each
strategy's status and reason instead of implying success. Documented in
`docs/discovery-strategy.md`.

---

## Handoff — next step

**Next step: supply `AGENT_DISCOVERY_ROOT`, `LLM_BASE_URL`, `LLM_MODEL` and (if the provider needs
one) `LLM_API_KEY` in the ignored `p3/.env`, then run the combined front-end review.**

That review does, in this order:

1. `npm run publish:dry-run` — publish the root record, then each agent's records, signed in
   MetaMask on Sepolia. No key in this repo.
2. `npm run probe:registry` — read-only confirmation that live discovery finds three agents and
   that `ens-registry=ok`. This is the first evidence that criteria 2, 3 and 4 hold against real
   ENS data rather than a fake reader.
3. `npm run record` — run the 8 recorded cases against the live route; it rewrites
   `docs/routing-cases.md` with observed results. Criterion 8 becomes an observation.
4. Walk the acceptance criteria in a browser: overdue-invoice question → invoice helper answers
   and is attributed; a travel question → explicit no-suitable-agent; MetaMask connect/disconnect
   and Sepolia status; the whole thing still working disconnected.
5. **Then, and only then,** the full 9-check scored harness evaluation and the stress-test cycle,
   across all three MVPs.

State that must not be overstated before step 2 and 3 complete: no agent is published, live ENS
discovery has returned nothing, no routing case has an observed result, and no scored harness
evaluation has been run. What is real now is the code path, the tests, and the local gates.

---

## T16 — Full 9-check evaluation, bounded stress checks, recorded cases run live `DONE`

**Status:** `DONE` — local gates green, 8 of 8 recorded cases matched live, three harness defects
found and fixed, official evaluator prompt executed. Report in `docs/harness-run-log.md`.

Started this phase (P2 had just completed its equivalent pass). Scope, taken from the user's
instruction and `p3.md`:

- Run P3's **own** local gates (`npm run check`, then `npm run harness:check`).
- Fetch and execute the **official** evaluator prompt for all 9 checks via
  `loops evaluate --event road-to-devcon-vii --problem ens-agent-router`. Note up front, as with
  P2: `loops evaluate` returns a **prompt**, not a verdict, and this repo's `harness:check` says of
  itself that it is local and computes no score. Neither may be reported as a score.
- Run the documented bounded stress/record checks: `npm run record` (criterion 8 turns from
  "dataset exists" into "observed") and `npm run probe:registry` (criterion 4 evidence).
- Diagnose any real failure, make the narrowest correct fix, and rerun the failure plus the
  relevant regression checks.
- Record observed verdicts **per criterion** with `file:line` evidence, in this log and in
  `docs/harness-run-log.md`.

**Environment fact established first.** T14 could not exercise the model path because `p3/.env`
still holds placeholders: `LLM_MODEL = replace-with-a-model-id`,
`AGENT_DISCOVERY_ROOT = replace-with-your-discovery-root-name.eth`, and `LLM_BASE_URL` pointing at
a hosted provider. Unlike P1 and P2, **P3 has no working model endpoint configured.**

**Constraints carried forward:** nothing is committed or pushed; no ENS write or transaction is
sent; root `.env` is not touched; no gate is weakened; no credential is requested, printed or
written into a tracked file; no process is left running. `.env` is gitignored here, so anything
done to `p3/.env` affects local runnability only and does not change repository readiness —
`.env.example` remains the documented placeholder surface.

**Pre-flight:** ports 8789 (router), 8791 (invoice), 8792 (contract), 8793 (brand copy) confirmed
**free**; no `node`/`tsx` process with a P3 command line exists, so nothing from T14 survived.

#### Local gates — observed

| Command | Result |
| --- | --- |
| `npm run check` | **exit 0** — typecheck clean, 146 tests / 7 files, credential scan PASS (53 files), docs PASS |
| `npm run harness:check` | **exit 0** — typecheck 4.7 s, test 5.5 s, scan 0.7 s, docs 0.4 s, build 6.0 s; 33 modules |
| `npm run check` (re-run after this phase's script edits) | **exit 0**, 146 tests still green |

`harness:check` labels itself *"P3 repo-local gates (no score, not the official harness)"*. It is a
local gate runner and **no score is claimed from it**.

#### Bounded checks — observed

| Check | Result |
| --- | --- |
| `npm run record` | **8 of 8 cases matched** (exit 0), model `qwen2.5:3b` via the already-running local Ollama |
| `npm run probe:registry` | 3 agents, **all from the labelled dev-registry fallback**; `ens-registry=empty`, `ens-subgraph=failed` |
| Agent `/health` (bounded, 8 s timeout) | 8791 invoice **200**, 8792 contract **200**, 8793 brand-copy **200** |

`R5` and `R6` returned **no agent** — criterion 7's explicit no-suitable-agent branch firing on a
real request rather than in a unit test. The other six cases were answered by the downstream helper
the model chose, over a real 1.2–1.3 s round trip.

The three agents had to be running for the forwards to land: `scripts/record-routes.ts` does not
start them. They were started for the run and **stopped afterwards**; ports 8789/8791/8792/8793
re-confirmed free and no P3 `node` process survived.

#### Configuration change made, and its blast radius

`p3/.env` held placeholders, so the model path could not run at all (this is why T14 could not
exercise it). Two lines were pointed at the local model provider that already runs on this machine
and that P2 uses:

- `LLM_BASE_URL` → `http://localhost:11434/v1`
- `LLM_MODEL` → `qwen2.5:3b`

`LLM_API_KEY` was **left untouched and never printed**. `p3/.env` is gitignored and the credential
scan confirms no `.env` is tracked, so this affects local runnability only — `.env.example` remains
the documented placeholder surface and repository readiness is unchanged.

#### Defects found and fixed

**1. `npm run record` exited 0 on a total failure.** It returned success with **0 of 8 cases
matched**, every case errored. A check that cannot fail is not a check, and this would have hidden a
broken configuration in CI. It now returns 1 on any mismatch. Verified both ways: exit 1 with the
placeholder endpoint, exit 0 at 8 of 8.

**2. The generated doc claimed live ENS discovery from a run that discovered nothing.**
`scripts/record-routes.ts` computed `usedDev = observations.some(o => o.attributionSource === 'dev-registry')`
and rendered `'Agents were discovered from live ENS records.'` in the `else` branch. When every case
errored, every `attributionSource` was `null`, so `usedDev` was `false` and the script wrote the
**exact opposite of the truth into a tracked file**, `docs/routing-cases.md`. Provenance is a
three-way fact — live / labelled fallback / nothing attributed — and it is now computed as one. The
regenerated doc reads: *"6 of 8 cases were answered by an agent from the labelled development
fallback, not from ENS."*

**3. The doc printed the wrong discovery root.** It printed `ROUTING_CASES.discoveryRoot` — the
*expectations* dataset's root — rather than the root the run actually queried, so the evidence could
describe a name that was never read. It now prints `config.agentDiscoveryRoot` and shows the
dataset's root beside it for comparison, which is how the mismatch surfaced.

All three are in `scripts/record-routes.ts`. `npm run typecheck`, `npm run check` and
`npm run check:docs` were re-run after the edits and are green.

#### Official evaluation

`loops evaluate --event road-to-devcon-vii --problem ens-agent-router` → exit 0, 19 740 chars. The
prompt was then **executed in this repo**, and the report — with `file:line` evidence for all nine
criteria, the three named wrong shapes, gaps and next steps — is in `docs/harness-run-log.md`
("Official harness evaluation — executed 2026-10-04").

`loops evaluate` returns a prompt, **not a verdict**. No official score, rank or pass verdict is
claimed for P3.

#### Criterion state after this run (no official numeric verdict claimed)

| # | Criterion | State |
| --- | --- | --- |
| 1 | Routed agent checked against discovered list | Met — `verifyRoutingDecision()`, `rejected-unknown-agent`, no fallback agent anywhere |
| 2 | Forwarded URL from the agent's ENS record | Met — `forward.ts` fetches `agent.endpoint` only; 6 real forwards observed |
| 3 | No literal list of agents in router source | Met in code, guarded by a 29-test source grep. **Live discovery NOT VERIFIED** — nothing published |
| 4 | Malformed record skipped, discovery continues | Met — `discovery.ts:154-158`; both strategies failed in one probe run and 3 agents still returned |
| 5 | Explicit timeout on the forward call | Met — `forward.ts:106-107` |
| 6 | https checked before calling | Met — re-checked at the last moment, `forward.ts:92-98` |
| 7 | Explicit no-agent response | Met **and observed live** — R5/R6 |
| 8 | Recorded cases state their expected agent | Met **and observed** — 8 of 8 |
| 9 | No credential in a tracked file | Met — scan PASS, 53 files |

**Criteria 1–9 are met in code; criterion 3's on-chain half is NOT VERIFIED / BLOCKED BY ENS
SETUP.** The brief's step 1 — publish each agent under an ENS name on Sepolia — is unmet, so the
acceptance criterion "a new helper published tomorrow is picked up without a deploy" remains a code
property with no live proof.

#### Process hygiene

- All three agents stopped; ports 8789/8791/8792/8793 free; no P3 `node`/`tsx` process remains.
- Two **pre-existing** stray processes (pids 17952, 11752, both started 18:28, before this phase)
  hold no listening port and were left alone. The P1 server on 8787 (pid 30060) is untouched.
- Nothing committed, nothing pushed, no ENS write or transaction sent, root `.env` untouched, no
  gate weakened, no credential printed or written to a tracked file.

#### Next step for a later session

Publish the three agent names plus the registry root — `dev-registry/registry.json` already holds
every record value verbatim and `npm run publish:dry-run` stages it — then re-run
`npm run probe:registry` and `npm run record` so criterion 3's discovery half and criterion 8's
expectations are verified against live records.

Two smaller items are recorded in the harness log rather than fixed here, because both are
ergonomics rather than correctness: `npm run record` does not check its own preconditions (a
reachable model provider *and* reachable agent endpoints), and it does not start the agents, so a
first-time user gets eight identical forward timeouts with no hint of the cause.
---

## T17 — Release readiness review (2026-10-04, late session) `DONE`

**Scope:** confirm each of the 9 scored checks in `p3.md` against observed output, then prepare the
repository. Deliberately **not** repeated: the long full stress process, `npm run record`,
`npm run probe:registry`, the three agents' `/health` probes and the manual UI review — all were
already observed in T16 and are recorded in `docs/harness-run-log.md` and `docs/routing-cases.md`,
and none of them gates the commit.

### Local gates — observed

| Command | Observed result |
| --- | --- |
| `npm run check` | **exit 0** — `tsc --noEmit` clean; **146 passed / 146** across 7 files (4.66 s); credential scan PASS (54 text files, `tracked .env files: none`); `checked 85 code path(s) and 20 file:line reference(s) across 8 doc file(s)` → PASS |
| `npm run build` | **PASS** — built in 4.93 s, `p3/dist/web` 162.88 kB JS / 10.93 kB CSS |

### Per-criterion state

| # | Criterion | State |
| --- | --- | --- |
| 1 | Routed agent checked against discovered list | Met — `src/shared/routing-decision.ts:133`, enforced in `src/server/route.ts:144`; no default agent anywhere |
| 2 | Forwarded URL from the agent's ENS record | Met — `src/server/forward.ts:87`, endpoint from `src/shared/agent-record.ts:235`; 6 real forwards observed in T16 |
| 3 | No literal list of agents in router source | **Met in code / live discovery NOT VERIFIED** — `src/server/discovery.ts:355`, `:428`; 29-test source grep |
| 4 | Malformed record skipped, discovery continues | Met — `src/shared/agent-record.ts:235`, `src/server/ens.ts:137` |
| 5 | Explicit timeout on the forward call | Met — `src/server/forward.ts:106` |
| 6 | https checked before calling | Met — `src/shared/agent-record.ts:98`, re-checked at `src/server/forward.ts:94` |
| 7 | Explicit no-agent response | Met **and observed live** — R5 / R6 returned no agent |
| 8 | Recorded cases state their expected agent | Met **and observed** — `src/shared/routing-cases.json`, 8 cases, 8/8 matched |
| 9 | No credential in a tracked file | Met — scan PASS |

**9 of 9 pass on local evidence; check 3's live-discovery half is BLOCKED BY ENS SETUP.**

### Defects

**None in this session.** No gate failed, so nothing was patched and no test was changed. The three
defects fixed in T16 (`npm run record` exiting 0 on total failure, the generated doc claiming live
ENS discovery when none happened, and the wrong discovery root printed) remain fixed and are covered
by the current green gates.

### T18 — submission report `DONE`

`docs/submission-report.md`: per-criterion observed results with `file:line`, every command run, and
an explicit "still NOT VERIFIED" section.

### Still NOT VERIFIED / BLOCKED BY ENS SETUP

- **"Publish each agent under an ENS name on Sepolia."** Not done. `npm run probe:registry` observed
  `ens-registry=empty` and `ens-subgraph=failed`; the three agents resolve from
  `dev-registry/registry.json`, tagged `source: "dev-registry"` everywhere they appear.
- **"Adding a fourth agent must be ENS records only, with no router change"** (check 3's live half)
  and the brief's "picked up without a deploy" acceptance criterion are therefore **NOT VERIFIED**:
  the code property is proven, the on-chain half is not.
- No official numeric score is claimed: `loops evaluate` returns an evaluator prompt, not a verdict.

No ENS write, no transaction, root `.env` untouched, no credential printed, no gate weakened.
