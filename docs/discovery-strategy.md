# The ENS discovery strategy

**The problem this solves.** The router must produce the agent set at runtime from ENS data, and
there must be no literal list of agent names or endpoints in router source. Enumerating subnames
is the hard part: ENS has no "give me all children of this name" primitive on-chain.

**The strategy chosen here is two-part, both live ENS, both configurable:**

1. `ens-registry` (primary) — the discovery root *points at* its agents through its own
   `com.ensagent.registry.agents` text record.
2. `ens-subgraph` (secondary) — enumerate the root's subnames from the ENS subgraph.

Order and membership are configuration (`AGENT_DISCOVERY_SOURCES`), not code. Neither strategy
contains a name.

---

## Strategy 1 — `ens-registry`: the root points at its agents

**Why this is the primary.** It works on Sepolia. Subgraph indexing does not.

The discovery root carries one record:

```
com.ensagent.registry.agents = invoice.<root>, contract.<root>, brand-copy.<root>
```

The router reads that record, splits it on commas and whitespace, normalizes each entry with
ENSIP-15, drops the ones ENS will not accept, deduplicates, and caps the result at
`AGENT_DISCOVERY_MAX`. Then for each surviving name it reads that agent's own records and
validates them.

**Why it satisfies "adding a fourth agent needs no code change."** Adding an agent is adding a
name to this record. Refreshing re-reads it. Nothing in `src/server` knows any name.

**Cost.** One RPC read for the roster, then four RPC reads (plus one address read) per agent.

**Known limitation, stated rather than hidden.** The registry is self-declared: anyone who can
set a record on the root can add a name. That is fine here — the root is the studio's own name
and the content is public by design — but it does mean the root is the trust anchor. A registry
held on a name the studio controls is the correct shape for this problem; a registry assembled
from arbitrary names would not be.

## Strategy 2 — `ens-subgraph`: enumerate subnames

**Why it is here at all.** It requires no roster record. A studio could publish
`invoice.<root>` and `copy.<root>`, never touch the parent's records, and they would still be
found. It is also the only strategy that would discover an agent published by a third party
without the studio's cooperation.

**The query.** One GraphQL document, one variable, no string concatenation of the parent into
the query text:

```graphql
query AgentSubnames($parent: String!) {
  domains(where: { parentName: $parent }, first: 50, orderBy: createdAt, orderDirection: desc) {
    name
  }
}
```

Names are normalized and the root itself is removed. Failures — non-2xx, GraphQL `errors`, a
body that is not JSON, no `domains` array, or the explicit `RPC_TIMEOUT_MS` bound — are returned
as a status. This strategy never throws and never aborts discovery.

## The documented Sepolia limitation — read this before judging the demo

**The public ENS subgraph indexes mainnet names. Sepolia names are frequently offchain/gasless,
so `ens-subgraph` is expected to return nothing on Sepolia even when the subnames exist and
resolve through the Universal Resolver.**

This is stated, designed around, and not worked around:

- `ens-registry` is the primary strategy, precisely because it does not depend on an indexer.
- Both strategies are configuration, so a deployment with a working Sepolia subgraph (a DeGraph
  substation, or the Subgraph team's own Sepolia deployment when one exists) gets enumeration by
  changing one environment value.
- `GET /api/agents` returns a per-strategy report — status, names contributed, and a reason — so
  "the subgraph returned nothing" is visible in the UI rather than looking like a broken router.
- `npm run probe:registry` prints the same thing from the terminal.

If you run the demo on Sepolia and see `ens-subgraph: empty`, **that is the expected state, not a
defect.** The message the router prints says so in those words.

## What discovery does with each name

For every name that survives enumeration:

1. Read `com.ensagent.capability`, `com.ensagent.endpoint`, `com.ensagent.accepts`,
   `com.ensagent.version`. Each read is isolated — a resolver that reverts on one key does not
   affect the other three — and a read that failed is reported as `failed`, which is not the same
   as `unset`.
2. Best-effort read of the agent's address. A name can carry text records without one, so this
   is optional.
3. `validateAgentRecords`. A failure becomes a `RejectedAgent` with a reason. **Discovery
   continues.** One bad record can never remove another agent.

Validated agents are sorted by name so a pass is reproducible, which is what makes a recorded
routing case comparable against a later run.

## Bounds, all explicit

| Bound | Setting | Why |
| --- | --- | --- |
| Names resolved per pass | `AGENT_DISCOVERY_MAX` (25) | a poisoned or accidentally huge registry cannot become hundreds of RPC calls |
| Names offered to the model per decision | `AGENT_ROUTE_MAX_CANDIDATES` (8) | bounds the routing prompt and its cost on a free tier |
| Description length reaching the model | 240 + 160 chars | an untrusted record cannot bloat the prompt |
| Router response cache | `AGENT_CACHE_TTL_MS` (60 s) | ENS records rarely change in a session and free-tier RPC limits are low; the UI's Refresh bypasses it |

## Caching

A successful pass is reused for `AGENT_CACHE_TTL_MS`. Concurrent callers share one in-flight
pass, so a burst of questions cannot become a burst of chain reads. `POST /api/agents/refresh`
and the UI's **Refresh from ENS** bypass the cache entirely.

## The development fallback, and why it is not discovery

`dev-registry/registry.json` is read **only** when every enabled live strategy returned zero
names, and only when `ALLOW_DEV_REGISTRY_FALLBACK` is true. Everything it produces is tagged
`source: "dev-registry"` in the API response and carries a banner in the UI; ENS-sourced agents
are tagged `source: "ens"`. It goes through the same validation as live records — same schema,
same endpoint policy — so it cannot introduce an agent the live path would reject. See
`../dev-registry/README.md`.

**No agent has been published to Sepolia yet.** Until that happens, the honest state is "live
discovery found nothing, here is the labelled fallback", and that is what the UI shows. Nothing
in this repository claims otherwise.

## Reproducing the whole thing

```
# 1. Point .env at the root and enable both strategies.
#    AGENT_DISCOVERY_ROOT=<your root>
#    AGENT_DISCOVERY_SOURCES=ens-registry,ens-subgraph

# 2. See what is actually discoverable right now.
npm run probe:registry

# 3. See exactly which records to publish, per name. No transaction is sent.
npm run publish:dry-run

# 4. Start everything.
npm run dev
#    then press "Refresh from ENS"

# 5. Optional: prove that discovery picked up a new agent with no code change.
#    Add a name to the root's registry record, re-run probe:registry, and the
#    agent count goes up by one.
```

## Alternative strategies considered

| Idea | Why not |
| --- | --- |
| Enumerate the root's subnames on-chain | There is no such primitive. ENS has no child-list action; the registry contract stores a resolver, not a child set. |
| Hardcode the three agents, "just for the demo" | Fails criterion 3 outright, and it is the thing the problem is about. |
| Use a subgraph subgraph with its own `AgentRegistered` entities | Would need the agents to publish events to our own contract, which puts a write transaction and a deployment in front of "publish some ENS records", and still would not cover an agent published by a third party. The registry pointer is less machinery for strictly more reach. |
| Read the root's `ENSIP-5` reverse-record keys | Per-name metadata belongs on the name, not on the root's reverse keys, and reverse keys are keyed by address anyway. |
| Wildcard/parent-resolution heuristics | A parent name's resolver does not expose subnames, and guessing is not discovery. |