# dev-registry — the development fallback, not discovery

This directory holds **one file**, `registry.json`, and it exists for exactly one situation:
the three local agents have no published ENS records yet, so live ENS discovery correctly finds
zero agents.

## What it is not

It is **not** live discovery and it must never be presented as such.

- Live ENS discovery runs first on **every** refresh. `ens-registry` reads the roster record
  from the configured root; `ens-subgraph` enumerates the root's subnames.
- This file is read **only** when every enabled live strategy returned zero names.
- It is gated on `ALLOW_DEV_REGISTRY_FALLBACK` in `.env`. Set it to `false` and the honest
  "no agents published yet" state is what you get.
- Every agent it produces is tagged `source: "dev-registry"` in the API response and carries a
  banner in the UI. Agents from ENS are tagged `source: "ens"`.

## Why it is a separate file and not a list in router code

The router's source contains no agent names and no agent URLs anywhere. This file is not router
source: it is a fixture for the demo, and the router's discovery pipeline treats it as a
*record source* that goes through the exact same validation as ENS data — same Zod schema, same
`checkEndpointPolicy` HTTPS rule, same per-agent rejection handling. It cannot introduce an
agent the live path would reject.

## Its shape

```json
{
  "notice": "…",
  "agents": [
    {
      "ensName": "invoice.ensrouter.eth",
      "records": { "com.ensagent.capability": "…", "com.ensagent.endpoint": "…", "com.ensagent.accepts": "…", "com.ensagent.version": "…" }
    }
  ]
}
```

`records` uses the **same keys** as the ENS text records documented in
`docs/agent-record-format.md`, so the values here are literally the values to publish.

## Editing it

The `com.ensagent.endpoint` values must match the ports the agent processes actually bind,
which are the defaults in `agents/*/server.ts` (`AGENT_INVOICE_PORT` 8791,
`AGENT_CONTRACT_PORT` 8792, `AGENT_BRAND_PORT` 8793). Each agent's own `GET /health` prints its
current records, so a mismatch is visible without reading either file.

The endpoints use `http://` on `127.0.0.1`, which the router accepts **only** because
`ALLOW_INSECURE_LOCAL_AGENTS` is true and the hostname is loopback. Any other host over plain
HTTP is rejected. For a public demo, publish `https://` URLs instead — see
`docs/agent-record-format.md`.

Once `com.ensagent.registry.agents` is published on the discovery root, this file stops being
read. It can stay in the repository as documentation of what was published.