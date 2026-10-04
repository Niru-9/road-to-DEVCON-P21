# Problem statement — Which AI Should Answer This?

The verbatim brief is kept at [`../p3.md`](../p3.md). This file restates what is being built
and lists the nine scored checks verbatim, because `docs/acceptance-checklist.md` maps code to
each one.

Problem slug: `ens-agent-router` · Event: Road To Devcon - VII (Loops House)

## The situation

Priya's design studio has quietly built a handful of small AI helpers: one answers contract
questions, one writes brand copy, one sorts out invoices. Each lives at its own address, and
only the person who built it remembers what it's for. Clients keep emailing the wrong one, and
every time the studio adds a new helper, someone has to update a list by hand.

Priya wants a single front door. A client asks a question, the right helper answers, and the
client can see who answered. Each helper describes itself publicly on its own ENS name, so
adding a new one should never require touching the front door's code.

## What to build

- At least three small specialist agents, each behind its own HTTP endpoint. Any framework, any
  model.
- Publish each agent under an ENS name on Sepolia, with text records that say what it does, how
  to reach it, and what input it accepts. The record format is ours to design.
- A router that discovers the agents from ENS, chooses the right one (or decides none fits),
  forwards the request, and returns the answer with attribution.
- Adding a fourth agent must be a matter of ENS records only, with no change to router code.
- Any model from any provider. Free tiers are enough.
- A recorded set of routing cases with the agent expected to reach each one.

## Acceptance criteria

A client asks about an overdue invoice, the invoice helper answers, the client can see which
helper it was, and a new helper Priya publishes tomorrow is picked up without a deploy.

## The nine scored checks

### 1. The routed agent is checked against the discovered agent list — 20 points

> Passes if Code confirms the model's chosen agent is one of the agents discovered from ENS
> before forwarding, and refuses to forward otherwise.
>
> Fails if The model's routing output is used to forward without that membership check, OR no
> model-driven routing step exists.

### 2. The forwarded URL comes from the agent's ENS record — 14 points

> Passes if The URL used to call the chosen agent is the value read from that agent's ENS text
> record.
>
> Fails if The URL comes from a hardcoded map, an environment variable, or the model's output,
> OR no forward call exists.

### 3. The router source contains no literal list of agents — 10 points

> Passes if The set of agents is obtained at runtime from ENS data, with no literal list of
> agent names or endpoints in router code.
>
> Fails if Router code contains a literal list of agent names or endpoints, OR no discovery step
> exists.

### 4. A malformed agent record is skipped without failing discovery — 8 points

> Passes if An agent whose records fail parsing or validation is excluded while discovery
> continues for the others.
>
> Fails if One invalid agent record aborts discovery or crashes the router, OR agent records are
> used without validation.

### 5. The forward call to an agent has an explicit timeout — 7 points

> Passes if The request to the downstream agent is bounded by an explicit timeout.
>
> Fails if The request to the downstream agent has no timeout, OR no forward call exists.

### 6. The endpoint from ENS is checked to use https before calling — 4 points

> Passes if The endpoint value is parsed and rejected unless its protocol is https (an explicit
> localhost exception for development is allowed).
>
> Fails if The endpoint value is called without a protocol check, OR no endpoint is read from
> ENS.

### 7. An unmatched request produces an explicit no-agent response — 6 points

> Passes if A code branch returns an explicit 'no suitable agent' response to the client in that
> case.
>
> Fails if No such branch exists (the router falls through to a default agent, an error, or a
> blank response).

### 8. Recorded routing cases state their expected agent — 6 points

> Passes if At least one recorded case pairs a client request with the specific agent expected
> to handle it, or explicitly expects no agent.
>
> Fails if No recorded routing cases exist, OR recorded cases state no expected agent.

### 9. No credential appears in any tracked file — 5 points

> Passes if No real credential, API key, private key, or authenticated URL appears in any
> tracked file.
>
> Fails if Any real credential, API key, private key, or authenticated URL appears in any
> tracked file.

## Harness status in this phase

The Loops Agent Harness is installed in this repository (`.claude/skills/loops-road-to-devcon-vii/`)
and authenticated. The **scored** evaluation (`loops evaluate --event road-to-devcon-vii
--problem ens-agent-router`) has deliberately **not** been run: it is deferred until all three
MVPs exist. `loops evaluate` returns an evaluator *prompt* to execute by hand rather than a
pass/fail result, so a knowledge-graph answer or a local green test run is not, and must not be
described as, a scored pass. See `../action.md`.

Knowledge-graph queries against `ens-agent-router` returned
`No relevant context was retrieved for this query` on every attempt (four queries, two distinct
phrasings, one of them against a different problem slug). The design here is therefore derived
from this brief, from the event prerequisites in the root `plan.md`, and from the ENSIP-5 /
ENSIP-15 behaviour viem implements — not from the knowledge graph.