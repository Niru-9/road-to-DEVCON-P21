# ENS Agent Router

**One front door. The right helper answers, and you can see which one.**

A client asks a question. The router discovers the specialist agents from their **own ENS text
records on Sepolia**, asks a model to choose one of them — or decides that none of them fits —
forwards the request to the URL in that agent's record, and returns the answer with ENS
attribution. Adding a fourth agent is a matter of publishing records; no router file changes.

Road To Devcon - VII · problem `ens-agent-router` · the brief is at [`p3.md`](p3.md), the nine
scored checks are at [`docs/problem-statement.md`](docs/problem-statement.md).

---

## The three things this is actually about

**1. A retrieval index built from live, user-controlled ENS data.**
There is no agent list in this codebase. One configured ENS name — the *discovery root* — points
at its agents through its own `com.ensagent.registry.agents` text record, and each agent
describes itself on its own name. [`docs/discovery-strategy.md`](docs/discovery-strategy.md)
documents the strategy, its bounds and its limits, including why the ENS subgraph cannot be
relied on for Sepolia.

**2. Model-driven routing constrained in code to choices that really exist.**
The model may only return a name it was given. Whatever it returns is membership-checked against
the set discovered on that pass before anything is forwarded; a name that was not discovered is
refused, not repaired.

**3. Every record and every downstream answer treated as untrusted input.**
ENS text is public and anyone can write it. Records are validated, flattened, bounded and
deliberately kept out of the system prompt; endpoints must be `https`; agent replies are
sanitized before display. None of this makes a hostile record harmless — it bounds the damage.

## Quick start

```
# Node 20.12+ (22 LTS recommended). Check with:  node -v
npm install

Copy-Item .env.example .env        # bash/mac: cp .env.example .env
# then edit .env: LLM_BASE_URL, LLM_MODEL, LLM_API_KEY, AGENT_DISCOVERY_ROOT
# `.env` is git-ignored. `.env.example` is placeholders only.

npm run dev
```

`npm run dev` starts three things at once:

| | | |
| --- | --- | --- |
| router API | http://localhost:8789 | discovery, routing, forwarding |
| browser UI | http://localhost:5175 | the demo |
| three agents | 8791 / 8792 / 8793 | invoice, contract, brand copy |

Open http://localhost:5175. Read-only routing and discovery work with MetaMask disconnected, and
this build sends no ENS write transaction.

## Repository layout

```
src/shared/         the record format, the routing prompt, the decision gate — no I/O
src/server/         ENS reads, discovery, the model call, forwarding, the HTTP API
agents/             the three specialist services, each its own process and port
dev-registry/       the labelled development fallback (NOT discovery)
scripts/            secret scan, doc-reference check, probe, record, publish dry-run
docs/               the format, the strategy, the recorded cases, the checklist
```

Each agent is separately runnable and has its own port:

```
npm run agents                # all three
npm run agent:invoice         # one
npm run agent:contract
npm run agent:brand
```

Each also serves `GET /health`, which echoes the exact ENS text records its owner should publish
for it — so the running service and the records on chain cannot drift apart.

**How a service is started has no bearing on how the router finds it.** The router reads an
agent's URL from that agent's ENS record; it does not know about ports, and the services do not
register themselves anywhere.

## Configuration

Everything externally reachable is read from `.env`. There is no configuration value that lists
agent names or endpoints — that is the design, and a test enforces it.

| Variable | Meaning |
| --- | --- |
| `LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY` | any OpenAI-compatible endpoint. Swap all three to change provider. |
| `LLM_TIMEOUT_MS` | explicit bound on the routing model request |
| `LLM_MAX_TOKENS` | explicit bound on the routing decision |
| `SEPOLIA_RPC_URL` | public endpoint is fine; a keyed URL is a secret and stays in `.env` |
| `RPC_TIMEOUT_MS` | explicit bound on every RPC call |
| `AGENT_DISCOVERY_ROOT` | **the** configured ENS name. A root, not a roster. |
| `AGENT_DISCOVERY_SOURCES` | `ens-registry`, `ens-subgraph`, in any order |
| `AGENT_DISCOVERY_MAX` | ceiling on names resolved per pass |
| `AGENT_CACHE_TTL_MS` | discovery cache TTL; the UI's Refresh bypasses it |
| `ENS_SUBGRAPH_URL` | optional; only used by the `ens-subgraph` strategy |
| `AGENT_TIMEOUT_MS` | explicit bound on every forwarded agent request |
| `AGENT_REPLY_MAX_CHARS` | ceiling on the answer text from an agent |
| `ALLOW_INSECURE_LOCAL_AGENTS` | allow plain `http` **only** for loopback hosts |
| `ALLOW_DEV_REGISTRY_FALLBACK` | allow the labelled development fallback when live discovery is empty |
| `AGENT_ROUTE_MAX_CANDIDATES` | ceiling on agents offered for one decision |
| `PORT` | router port (8789) |

Secrets live only in `.env`, which is git-ignored. `toPublicConfigView` is the only shape that
leaves the server, and it reduces the RPC URL to a host and the API key to a boolean. The browser
bundle contains no key, no provider endpoint and no RPC URL.

## The ENS record format

Full spec: [`docs/agent-record-format.md`](docs/agent-record-format.md). In short.

On the **discovery root**:

```
com.ensagent.registry.version = 1
com.ensagent.registry.agents  = invoice.<root>, contract.<root>, brand-copy.<root>
```

On **each agent**:

```
com.ensagent.capability = one line: what this agent is for
com.ensagent.endpoint   = https://… (absolute URL; plain http only for loopback in development)
com.ensagent.accepts    = one line: what kind of request it wants
com.ensagent.version    = optional: the agent's own version
```

To see exactly what to publish, with values taken from the running configuration and the
registry file:

```
npm run publish:dry-run
```

It prints the records per name and sends **no transaction**. This repository holds no signing key
and contains no ENS write path.

## How a request flows

```
1  discover      registry record on the root  +  subnames from the subgraph
2  read+validate each name's own records; skip malformed ones, keep going
3  bound         at most AGENT_ROUTE_MAX_CANDIDATES validated agents
4  decide        the model names one candidate, or null          (LLM_TIMEOUT_MS)
5  verify        membership check against the candidates        ← nothing is forwarded without this
6  forward       POST to that agent's ENS endpoint record        (AGENT_TIMEOUT_MS)
7  attribute     answer + the ENS name it came from + the endpoint host + timings
```

If step 5 does not return an agent, the response is an explicit **no suitable agent** outcome. It
never falls through to a default agent, because there is no default agent.

The UI shows all four steps in a **Routing trace** under every answer, including which candidates
the model was shown and what it chose.

## Recorded routing cases

Expectations are in [`docs/routing-cases.md`](docs/routing-cases.md) and
[`src/shared/routing-cases.json`](src/shared/routing-cases.json): 8 cases, 3 distinct expected
agents, and 2 cases that explicitly expect **no** agent. `npm run record` runs them through the
live route and rewrites the document with observed results.

## Checks

```
npm run check            # typecheck + tests + credential scan + doc references
npm run harness:check    # the same gates, with a written log, plus the production build
```

`npm run harness:check` computes **no score**. The Agent Harness scored evaluation is deferred
until all three MVPs exist; see [`action.md`](action.md). A green local run means the local checks
pass, not that a scored criterion passed.

| Command | What it does |
| --- | --- |
| `npm run typecheck` | `tsc --noEmit`, strict, over `src`, `scripts` and `agents` |
| `npm test` | 146 tests: endpoint policy, malformed-record skipping, membership enforcement, forward timeout, explicit no-agent, the recorded dataset, and the no-literal-list source scan |
| `npm run check:secrets` | verifies ignore rules actually match, that no secret file is tracked, and that no tracked file contains credential-shaped content — including authenticated URLs |
| `npm run check:docs` | every `file:line` reference in the docs resolves to a real, non-blank line |
| `npm run probe:registry` | which discovery strategies find what, right now, on Sepolia |
| `npm run publish:dry-run` | the exact records to sign, per name. No transaction |
| `npm run record` | run the recorded cases and rewrite `docs/routing-cases.md` |

## Safety notes

- **ENS records are public text anyone can write.** They are treated as untrusted input
  everywhere: validated before an agent becomes routable, flattened and bounded before reaching a
  prompt, and kept out of the system prompt (which is a frozen literal — a test asserts it).
- **Endpoints must be `https`.** The only exception requires both `ALLOW_INSECURE_LOCAL_AGENTS`
  and a loopback hostname, so `http://agents.example.com` is refused even on a laptop. The policy
  is re-checked immediately before the fetch.
- **The model has no authority.** It names a candidate or it does not; anything else is refused.
- **Agent replies are untrusted** and are schema-validated, de-marked-up, de-controlled and
  truncated before display. A non-2xx status, HTML, or JSON without `answer` is an error, not an
  answer.
- **Nothing in this repository holds a signing key**, accepts one, or sends an ENS write
  transaction. Wallet connection is optional and read-only.

## Known limitations

1. **No agent records are published on Sepolia yet.** Until they are, live ENS discovery correctly
   finds nothing and the router reads the clearly-labelled `dev-registry/registry.json` fallback
   so the demo is reviewable. Those agents are tagged `source: "dev-registry"` and shown with a
   banner — they are **not** ENS-discovered, and this README does not claim they are. See
   [`dev-registry/README.md`](dev-registry/README.md).
2. **The `ens-subgraph` strategy is expected to return nothing on Sepolia.** The public ENS
   subgraph indexes mainnet names and Sepolia names are frequently offchain/gasless. Documented,
   reported in the UI, and not worked around.
3. **No recorded live run of the routing cases yet.** `npm run record` needs a model endpoint and
   published records.
4. **The agents answer from rules, not from a model.** They are deliberately deterministic so the
   demo does not depend on a provider, and they say so in their answers. Routing is the thing
   being demonstrated.
5. **This is a polished demo MVP, not production infrastructure.** The registry on the discovery
   root is the trust anchor: anyone who can write to that root can add a name. That is appropriate
   for a studio's own name, and it is not a general-purpose agent directory.

## License

MIT. Demo data only — the ENS names, prompts and questions in
[`src/shared/routing-cases.json`](src/shared/routing-cases.json) are invented for this demo.