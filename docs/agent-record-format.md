# The ENS agent-record format

One document, two jobs: tell an operator exactly what to publish, and tell a reviewer exactly
what the router will accept.

Record format version: **1**. Declared on the discovery root as
`com.ensagent.registry.version`.

All keys use the ENSIP-5 *global key* shape `<namespace>.<key>`. They are read by viem's
`getEnsText` through the Universal Resolver, so they work on a Sepolia name regardless of
whether it is an onchain ENSv1 name or an offchain ENSv2 name.

## The discovery root carries the roster

One configured name, `AGENT_DISCOVERY_ROOT`. It is a root, not an agent. It carries one record
that matters:

| Key | Required | Meaning |
| --- | --- | --- |
| `com.ensagent.registry.version` | no | The record format this registry speaks. Publish `1`. |
| `com.ensagent.registry.agents` | **yes** | Comma- or whitespace-separated list of the root's agent names. |

```
com.ensagent.registry.version = 1
com.ensagent.registry.agents  = invoice.<root>, contract.<root>, brand-copy.<root>
```

**This is the whole "add a fourth agent" mechanism.** Publish one more name in this record and
press Refresh. No code, no config change, no deploy. See `discovery-strategy.md` for how the
names are enumerated and what its limits are.

## Each agent describes itself

Three required text records and one optional, on the agent's own name:

| Key | Required | Bound | Meaning |
| --- | --- | --- | --- |
| `com.ensagent.capability` | **yes** | 3–400 chars, one line | What this agent is for. |
| `com.ensagent.endpoint` | **yes** | ≤ 300 chars, absolute URL | Where to forward a request. |
| `com.ensagent.accepts` | **yes** | 3–400 chars, one line | What kind of request it wants. |
| `com.ensagent.version` | no | 1–40 chars | The agent's own version. |

`com.ensagent.endpoint` and `com.ensagent.accepts` are both required because routing needs a
destination *and* the model needs a description of the input shape. A capability alone is not
enough for the model to decide; an endpoint alone is not enough for a human to trust the answer.

Example — on `<agent>.<root>`:

```
com.ensagent.capability = Handles invoices and receivables: overdue balances, dunning and reminder wording, late-fee questions, payment plans, credits and payment reconciliation.
com.ensagent.endpoint   = https://agents.example.com/invoice/invoke
com.ensagent.accepts    = A question about an invoice, an overdue amount, a late fee, a disputed amount, a duplicate payment, or a request for reminder wording.
com.ensagent.version    = 1.0.0
```

## What "valid" means, exactly

`validateAgentRecords` in `src/shared/agent-record.ts` is the only gate between a name and a
routable agent. It never throws; every failure becomes a rejection with a reason, and discovery
continues with the remaining names.

| Rejection reason | Cause |
| --- | --- |
| `missing-capability` | the capability record is unset |
| `missing-endpoint` | the endpoint record is unset |
| `missing-accepts` | the accepted-input record is unset |
| `unreadable` | the resolver threw or reverted for that key |
| `invalid-capability` | too short, too long, or contains control characters |
| `invalid-accepts` | too short, too long, or contains control characters |
| `invalid-endpoint` | not an absolute URL, wrong protocol, too long, or rejected by policy |
| `invalid-version` | never emitted; a bad optional version is a warning, not a rejection |

Control characters (`U+0000`–`U+001F`, `U+007F`) are rejected because a record that can emit a
terminal escape can forge log lines, and one that can emit a newline can forge a line in a UI.

## The endpoint policy

`checkEndpointPolicy` parses the value with `new URL()` and then:

1. **Requires `https`.** Anything else is rejected — `http`, `ftp`, `file`, `javascript`, `data`,
   `ws`.
2. **Allows plain `http` only when BOTH are true:** `ALLOW_INSECURE_LOCAL_AGENTS=true` **and** the
   hostname is loopback (`localhost`, `127.0.0.1`, `::1`).

So `http://127.0.0.1:8791/invoke` is accepted on a laptop and rejected in production, and
`http://agents.example.com/invoke` is rejected **even on a laptop**. The exception is narrow on
purpose: it exists so the three local demo services can be discovered without a TLS terminator,
and it cannot be used to reach anything off the machine.

The check runs twice: once during discovery, and again in `forwardToAgent` immediately before
the fetch, so a validation gap upstream still cannot produce an arbitrary outbound call.

Try a value before publishing it:

```
POST /api/check-endpoint   {"endpoint":"https://agents.example.com/invoice/invoke"}
```

## The agent's HTTP contract

Every discovered agent must accept:

```
POST <the endpoint URL>
content-type: application/json

{"question":"…","requestedBy":"<agent ENS name>"}
```

`question` is 3–2000 characters. `requestedBy` is informational — the agent may use it to
attribute its own answer, but the router **always** attributes from the ENS name it discovered.

And must reply:

```
200 OK
content-type: application/json

{"ok":true,"answer":"…","agent":"<slug>","notes":["…"]}
```

`answer` is required and must be non-empty. `agent` and `notes` are optional and advisory. Any
other body — a non-2xx status, HTML, or JSON without `answer` — is an error, not an answer. The
router reports the failure and shows no text.

The agent's `answer` is untrusted. It is stripped of markup, stripped of control characters and
truncated to `AGENT_REPLY_MAX_CHARS` before it is displayed. The three agents in `agents/` return
plain text with `-` bullets; the UI renders bullets as a list and never as HTML.

## Names are normalized before anything is read

Every name passes through `normalizeEnsName`, which is viem's ENSIP-15 (UTS-46)
normalization plus a check for at least two labels and an alphabetic root. Nothing reaches the
resolver un-normalized, and a name that will not normalize is dropped rather than fatal.

Registry entries are therefore case- and Unicode-tolerant: `Invoice.<Root>.eth` and
`invoice.<root>.eth` are the same name.

## Publishing, step by step

`npm run publish:dry-run` prints exactly what to set, per name, using the values in
`dev-registry/registry.json` and the record keys above. It sends no transaction and holds no
signing key. The actual signing happens in MetaMask at a Sepolia ENS client, in the
front-end-review phase, in this order:

1. Register (or confirm) the discovery root and each agent name on Sepolia.
2. Set `com.ensagent.registry.version` and `com.ensagent.registry.agents` on the root.
3. Set the three required records (and optionally the version) on each agent name.
4. Verify with `npm run probe:registry`, then press **Refresh from ENS** in the UI.

## Adding a fourth agent

1. Create the service under `agents/<slug>/server.ts`, or anywhere that answers
   `POST /invoke` with the documented shape.
2. Publish the three records on its ENS name.
3. Add its name to the root's `com.ensagent.registry.agents`.
4. Refresh.

No router file changes. `src/server/no-literal-list.test.ts` enforces that: it reads the router's
own source and fails if a concrete ENS name or a non-placeholder endpoint URL appears in it.

## Security note

Every field of every record is public text that anyone can write. The router therefore treats
records as untrusted input:

- descriptions are flattened to a single bounded line, with `|` and `"` stripped, so a record
  cannot forge a field or a candidate in the routing prompt;
- descriptions are placed in a separate data message, never in the system prompt — the system
  prompt is a frozen literal with no interpolation point, and a test asserts no record text
  reaches it;
- an endpoint is only ever fetched after the https/loopback policy accepts it;
- the model's chosen name must be a member of the discovered set before anything is forwarded;
- the agent's reply is validated and sanitized before display.

None of this makes a hostile record harmless, and none of it should be presented as if it did.
It bounds the damage.