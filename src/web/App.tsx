/**
 * The demo UI.
 *
 * Four things it has to make obvious, because the problem is about trust and attribution:
 *
 *   1. **Where the agents came from.** Live ENS or the labelled development fallback. The
 *      discovery panel shows the root, which strategies ran, what each returned, which agents
 *      were skipped and why. Discovery status is never implied by the presence of a result.
 *   2. **Who answered.** Every answer carries an attribution block naming the ENS name whose
 *      records produced it, the endpoint host the URL came from, and the timing.
 *   3. **That "no agent" is a real answer.** A dedicated, non-error state, never a blank panel
 *      and never a default agent.
 *   4. **That a wallet is optional.** Connecting shows an address and the network; routing and
 *      discovery work without it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  ApiError,
  api,
  type CasesResponse,
  type DiscoveryResponse,
  type HealthResponse,
  type RouteResponse,
} from './api'
import {
  WalletError,
  connectWallet,
  getInjectedProvider,
  hasInjectedProvider,
  shortenAddress,
  subscribeToWallet,
  switchToSepolia,
  type WalletConnection,
} from './wallet'

type Busy = 'idle' | 'routing' | 'refreshing'

function shortenRoot(root: string): string {
  return root.length <= 34 ? root : `${root.slice(0, 33)}…`
}

function formatTime(value: string | null): string {
  if (value === null) return 'never'
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleTimeString()
}

function sourceBadge(source: string) {
  if (source === 'ens') return <span className="badge badge-ens">from ENS</span>
  return <span className="badge badge-dev">dev fallback</span>
}

export function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null)
  const [discovery, setDiscovery] = useState<DiscoveryResponse | null>(null)
  const [cases, setCases] = useState<CasesResponse | null>(null)
  const [question, setQuestion] = useState('')
  const [busy, setBusy] = useState<Busy>('idle')
  const [result, setResult] = useState<RouteResponse | null>(null)
  const [error, setError] = useState<{ code: string; message: string } | null>(null)
  const [wallet, setWallet] = useState<WalletConnection | null>(null)
  const [walletError, setWalletError] = useState<string | null>(null)
  const [walletBusy, setWalletBusy] = useState(false)

  const answerRef = useRef<HTMLElement | null>(null)

  // --- Boot: read health, current discovery state, and the recorded cases ---------
  useEffect(() => {
    let cancelled = false

    void (async () => {
      try {
        const [healthResult, discoveryResult, casesResult] = await Promise.all([
          api.health(),
          api.agents(),
          api.cases(),
        ])
        if (cancelled) return
        setHealth(healthResult)
        setDiscovery(discoveryResult)
        setCases(casesResult)
      } catch (bootError) {
        if (cancelled) return
        setError({
          code: bootError instanceof ApiError ? bootError.code : 'BOOT_FAILED',
          message:
            bootError instanceof Error
              ? bootError.message
              : 'Could not load the router. Is it running on port 8789?',
        })
      }
    })()

    return () => {
      cancelled = true
    }
  }, [])

  // --- Wallet events, so the address is never stale ------------------------------
  useEffect(() => {
    const provider = getInjectedProvider()
    if (provider === null) return
    return subscribeToWallet(provider, {
      onAccountsChanged: (accounts) => {
        if (accounts.length === 0) setWallet(null)
      },
      onChainChanged: () => {
        // Re-read the account and chain rather than trying to translate the hex here.
        void connectWallet(provider)
          .then(setWallet)
          .catch(() => setWallet(null))
      },
      onDisconnected: () => setWallet(null),
    })
  }, [])

  const refreshDiscovery = useCallback(async (): Promise<void> => {
    setBusy('refreshing')
    try {
      setDiscovery(await api.refreshAgents())
      setError(null)
    } catch (refreshError) {
      setError({
        code: refreshError instanceof ApiError ? refreshError.code : 'REFRESH_FAILED',
        message: refreshError instanceof Error ? refreshError.message : 'Refresh failed.',
      })
    } finally {
      setBusy('idle')
    }
  }, [])

  const ask = useCallback(async (text: string, refreshFirst: boolean): Promise<void> => {
    const trimmed = text.trim()
    if (trimmed.length < 3) {
      setError({ code: 'BAD_REQUEST', message: 'Ask a question of at least 3 characters.' })
      return
    }

    setBusy('routing')
    setError(null)
    setResult(null)

    try {
      const routed = await api.route(trimmed, refreshFirst)
      setResult(routed)
      if (routed.discovery.usedDevRegistry) setDiscovery(await api.agents())
      window.setTimeout(() => answerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 40)
    } catch (routeError) {
      setError({
        code: routeError instanceof ApiError ? routeError.code : 'ROUTE_FAILED',
        message: routeError instanceof Error ? routeError.message : 'The route could not be completed.',
      })
    } finally {
      setBusy('idle')
    }
  }, [])

  const onSubmit = useCallback(
    (event: React.FormEvent) => {
      event.preventDefault()
      void ask(question, true)
    },
    [ask, question],
  )

  const onConnect = useCallback(async () => {
    const provider = getInjectedProvider()
    if (provider === null) {
      setWalletError('No injected wallet found. Install MetaMask, or use an in-browser wallet.')
      return
    }

    setWalletBusy(true)
    setWalletError(null)
    try {
      setWallet(await connectWallet(provider))
    } catch (connectError) {
      setWalletError(connectError instanceof Error ? connectError.message : 'Could not connect the wallet.')
    } finally {
      setWalletBusy(false)
    }
  }, [])

  const onDisconnect = useCallback(() => {
    // EIP-1193 has no "disconnect this page" call; the app simply drops the session.
    setWallet(null)
    setWalletError(null)
  }, [])

  const onSwitchNetwork = useCallback(async () => {
    const provider = getInjectedProvider()
    if (provider === null) return
    setWalletBusy(true)
    setWalletError(null)
    try {
      await switchToSepolia(provider)
      setWallet(await connectWallet(provider))
    } catch (switchError) {
      setWalletError(switchError instanceof Error ? switchError.message : 'Could not switch network.')
    } finally {
      setWalletBusy(false)
    }
  }, [])

  const agents = discovery?.agents ?? []
  const usingDevRegistry = discovery?.usedDevRegistry === true
  const agentSummary = useMemo(() => {
    if (discovery === null) return 'loading…'
    if (discovery.status === 'loading') return 'discovering…'
    return `${discovery.agentCount} agent${discovery.agentCount === 1 ? '' : 's'} discoverable`
  }, [discovery])

  return (
    <div className="page">
      <header className="masthead">
        <div className="masthead-main">
          <p className="eyebrow">Road To Devcon VII · Which AI Should Answer This?</p>
          <h1>ENS Agent Router</h1>
          <p className="lede">
            One front door. The router discovers specialist agents from their own ENS text records on
            Sepolia, asks the model to pick one of them, forwards to the URL in that agent&apos;s
            record, and shows you which name answered.
          </p>
        </div>

        <WalletPanel
          wallet={wallet}
          walletError={walletError}
          busy={walletBusy}
          hasProvider={hasInjectedProvider()}
          onConnect={() => void onConnect()}
          onDisconnect={onDisconnect}
          onSwitchNetwork={() => void onSwitchNetwork()}
        />
      </header>

      {error !== null && (
        <div className="banner banner-error" role="alert">
          <strong>{error.code}</strong>
          <span>{error.message}</span>
        </div>
      )}

      {usingDevRegistry && (
        <div className="banner banner-warn" role="status">
          <strong>Development fallback</strong>
          <span>
            No agent records are published on Sepolia yet, so live ENS discovery found nothing and the
            router read <code>dev-registry/registry.json</code> instead. These agents are <b>not</b>{' '}
            discovered from ENS. Publish the registry record on{' '}
            <code>{health?.config.discoveryRoot ?? 'the discovery root'}</code> to switch to live
            discovery.
          </span>
        </div>
      )}

      <main className="grid">
        <section className="panel panel-ask">
          <h2>Ask the front door</h2>
          <p className="panel-note">
            The model may only choose an agent that discovery found this pass. If it names anything
            else, the router refuses to forward.
          </p>

          <form onSubmit={onSubmit}>
            <label className="field-label" htmlFor="question">
              Your question
            </label>
            <textarea
              id="question"
              className="field"
              rows={4}
              maxLength={2000}
              placeholder="e.g. Client invoice 2291 is 40 days overdue — what do we say in the reminder, and can we add a late fee?"
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
            />
            <div className="actions">
              <button type="submit" className="button button-primary" disabled={busy === 'routing'}>
                {busy === 'routing' ? 'Routing…' : 'Route this request'}
              </button>
              <span className="hint">Refreshes discovery first, so a newly published agent is picked up without a restart.</span>
            </div>
          </form>

          {cases !== null && (
            <div className="cases">
              <h3>Recorded routing cases</h3>
              <p className="panel-note">
                {cases.cases.length} cases, each with the agent expected to handle it — or{' '}
                <code>null</code>, which is a correct outcome. Click one to run it.
              </p>
              <ul className="case-list">
                {cases.cases.map((testCase) => (
                  <li key={testCase.id}>
                    <button
                      type="button"
                      className="case-button"
                      onClick={() => {
                        setQuestion(testCase.question)
                        void ask(testCase.question, false)
                      }}
                      disabled={busy === 'routing'}
                    >
                      <span className="case-id">{testCase.id}</span>
                      <span className="case-question">{testCase.question}</span>
                      <span className={testCase.expectAgent === null ? 'case-expect case-expect-none' : 'case-expect'}>
                        {testCase.expectAgent ?? 'no agent expected'}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>

        <section className="panel panel-discovery">
          <div className="panel-header">
            <h2>Discovered agents</h2>
            <button
              type="button"
              className="button button-ghost"
              onClick={() => void refreshDiscovery()}
              disabled={busy === 'refreshing'}
            >
              {busy === 'refreshing' ? 'Refreshing…' : 'Refresh from ENS'}
            </button>
          </div>

          <dl className="facts">
            <div>
              <dt>Discovery root</dt>
              <dd title={discovery?.root ?? ''}>{shortenRoot(discovery?.root ?? '—')}</dd>
            </div>
            <div>
              <dt>Strategies</dt>
              <dd>{(discovery?.strategies ?? health?.config.discoverySources ?? []).join(' → ')}</dd>
            </div>
            <div>
              <dt>Active set</dt>
              <dd>{agentSummary}</dd>
            </div>
            <div>
              <dt>Last read</dt>
              <dd>
                {formatTime(discovery?.refreshedAt ?? null)}
                {discovery?.fromCache === true ? ' (cached)' : ''}
              </dd>
            </div>
            <div>
              <dt>Chain</dt>
              <dd>Sepolia · 11155111</dd>
            </div>
            <div>
              <dt>Routing model</dt>
              <dd>
                {health?.config.model ?? '—'} @ {health?.config.providerHost ?? '—'}
              </dd>
            </div>
            <div>
              <dt>Timeouts</dt>
              <dd>
                model {health?.config.timeoutMs ?? '—'} ms · agent {health?.config.agentTimeoutMs ?? '—'} ms
              </dd>
            </div>
          </dl>

          {discovery !== null && discovery.reports.length > 0 && (
            <div className="strategies">
              <h3>Discovery strategies</h3>
              <ul>
                {discovery.reports.map((report) => (
                  <li key={report.source} className={`strategy strategy-${report.status}`}>
                    <span className="strategy-name">{report.source}</span>
                    <span className="strategy-status">{report.status}</span>
                    <span className="strategy-detail">{report.detail ?? `${report.namesFound.length} name(s)`}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {agents.length === 0 ? (
            <p className="empty">
              No agent is discoverable under <code>{discovery?.root ?? 'the discovery root'}</code>{' '}
              right now. Publish <code>com.ensagent.registry.agents</code> on it, then press Refresh.
            </p>
          ) : (
            <ul className="agent-list">
              {agents.map((agent) => (
                <li key={agent.ensName} className="agent-card">
                  <div className="agent-card-head">
                    <span className="agent-name">{agent.ensName}</span>
                    {sourceBadge(agent.source)}
                  </div>
                  <p className="agent-capability">{agent.capability}</p>
                  <dl className="agent-meta">
                    <div>
                      <dt>accepts</dt>
                      <dd>{agent.accepts}</dd>
                    </div>
                    <div>
                      <dt>endpoint</dt>
                      <dd>
                        {agent.endpointProtocol}://{agent.endpointHost}
                      </dd>
                    </div>
                    {agent.version !== null && (
                      <div>
                        <dt>version</dt>
                        <dd>{agent.version}</dd>
                      </div>
                    )}
                  </dl>
                  {agent.warnings.length > 0 && <p className="agent-warning">Note: {agent.warnings.join(' ')}</p>}
                </li>
              ))}
            </ul>
          )}

          {discovery !== null && discovery.rejected.length > 0 && (
            <div className="rejected">
              <h3>Skipped during discovery</h3>
              <p className="panel-note">A malformed record excludes only that agent. Discovery continued for the rest.</p>
              <ul>
                {discovery.rejected.map((rejected) => (
                  <li key={`${rejected.ensName}-${rejected.reason}`}>
                    <code>{rejected.ensName}</code>
                    <span>
                      {rejected.reason} — {rejected.detail}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {discovery !== null && discovery.notices.length > 0 && !usingDevRegistry && (
            <ul className="notices">
              {discovery.notices.map((notice) => (
                <li key={notice}>{notice}</li>
              ))}
            </ul>
          )}
        </section>

        <section className="panel panel-answer" ref={answerRef} aria-live="polite">
          <h2>Answer</h2>

          {result === null && error === null && (
            <p className="empty">
              No request yet. Ask something, or pick a recorded case. Routing is model-driven and
              constrained to the {agents.length} agent{agents.length === 1 ? '' : 's'} discovered above.
            </p>
          )}

          {result !== null && <ResultView result={result} />}

          {result === null && error !== null && (
            <p className="empty">The request could not be completed. The error above has the code and what to check.</p>
          )}
        </section>
      </main>

      <footer className="footer">
        <p>
          ENS records are public text that anyone can write. This app treats every record and every
          agent answer as untrusted input: records are validated before an agent becomes routable,
          endpoints must be <code>https</code> unless they are loopback in development, the
          model&apos;s choice is membership-checked against the discovered set, and agent replies are
          sanitized before display.
        </p>
        <p className="footer-meta">
          {health?.notice ?? ''} Wallet connection is optional and no ENS write transaction is sent
          from this build.
        </p>
      </footer>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

function ResultView({ result }: { readonly result: RouteResponse }) {
  if (result.outcome === 'no-suitable-agent') {
    return (
      <>
        <div className="banner banner-neutral" role="status">
          <strong>No suitable agent</strong>
          <span>{result.noAgentMessage ?? 'No discovered agent could handle this request.'}</span>
        </div>
        <RoutingTrace result={result} />
      </>
    )
  }

  if (result.outcome === 'error') {
    return (
      <>
        <div className="banner banner-error" role="alert">
          <strong>{result.error?.code ?? 'ERROR'}</strong>
          <span>{result.error?.message ?? 'The route could not be completed.'}</span>
        </div>
        <RoutingTrace result={result} />
      </>
    )
  }

  return (
    <>
      <article className="answer-body">
        {result.answer?.split(/\n{2,}/).map((paragraph, index) =>
          paragraph.trim().startsWith('- ') ? (
            <ul key={index} className="answer-list">
              {paragraph
                .split('\n')
                .filter((line) => line.trim().length > 0)
                .map((line, lineIndex) => (
                  <li key={lineIndex}>{renderInline(line.replace(/^-\s*/, ''))}</li>
                ))}
            </ul>
          ) : (
            <p key={index}>{renderInline(paragraph)}</p>
          ),
        )}
      </article>

      {result.notes.length > 0 && (
        <ul className="answer-notes">
          {result.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}

      {result.attribution !== null && (
        <div className="attribution">
          <p className="attribution-label">Answered by</p>
          <p className="attribution-name">
            {result.attribution.ensName} {sourceBadge(result.attribution.source)}
          </p>
          <p className="attribution-capability">{result.attribution.capability}</p>
          <dl className="facts facts-tight">
            <div>
              <dt>endpoint from ENS record</dt>
              <dd>
                {result.attribution.endpointProtocol}://{result.attribution.endpointHost}
              </dd>
            </div>
            <div>
              <dt>agent HTTP status</dt>
              <dd>{result.attribution.status}</dd>
            </div>
            <div>
              <dt>agent time</dt>
              <dd>
                {result.attribution.durationMs} ms (timeout {result.attribution.timeoutMs} ms)
              </dd>
            </div>
            <div>
              <dt>total route time</dt>
              <dd>{result.totalDurationMs} ms</dd>
            </div>
          </dl>
        </div>
      )}

      <RoutingTrace result={result} />
    </>
  )
}

/** Minimal inline emphasis. No HTML injection: the agent's text is rendered as text. */
function renderInline(value: string) {
  const parts = value.split(/(\*\*[^*]+\*\*)/g)
  return parts.map((part, index) =>
    part.startsWith('**') && part.endsWith('**') ? <strong key={index}>{part.slice(2, -2)}</strong> : <span key={index}>{part}</span>,
  )
}

function RoutingTrace({ result }: { readonly result: RouteResponse }) {
  return (
    <details className="trace">
      <summary>Routing trace</summary>
      <ol className="trace-steps">
        <li>
          <span>1 · Discovery</span>
          <span>
            {result.discovery.discoveredCount} agent(s) under {result.discovery.root}; {result.discovery.candidateCount} offered
            to the model (limit {result.discovery.candidateLimit}).
            {result.discovery.fromCache ? ' Read from cache.' : ''}
            {result.discovery.usedDevRegistry ? ' Dev fallback, not ENS.' : ''}
          </span>
        </li>
        <li>
          <span>2 · Model decision</span>
          <span>
            {result.routing.model} @ {result.routing.providerHost} → <code>{result.routing.decisionStatus}</code>
            {result.routing.chosenName === null ? '' : ` — chose ${result.routing.chosenName}`}
            {result.routing.durationMs === null ? '' : ` in ${result.routing.durationMs} ms (${result.routing.attempts} attempt(s))`}
          </span>
        </li>
        <li>
          <span>3 · Membership check</span>
          <span>
            {result.routing.decisionStatus === 'selected'
              ? `Matched ${result.attribution?.ensName ?? ''} against the discovered set.`
              : 'Not a discovered agent, so nothing was forwarded.'}
          </span>
        </li>
        <li>
          <span>4 · Forward</span>
          <span>
            {result.outcome === 'answered'
              ? `POST to ${result.attribution?.endpointProtocol}://${result.attribution?.endpointHost}, read from the agent's ENS endpoint record.`
              : 'No request was sent to any agent.'}
          </span>
        </li>
      </ol>

      {result.candidates.length > 0 && (
        <div className="trace-candidates">
          <p className="trace-label">Candidates offered to the model (untrusted ENS data)</p>
          <ul>
            {result.candidates.map((candidate) => (
              <li key={candidate.ensName}>
                <code>{candidate.ensName}</code>
                <span>{candidate.capability}</span>
                <em>{candidate.source}</em>
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="trace-verdict">{result.routing.verdict}</p>
    </details>
  )
}

// ---------------------------------------------------------------------------
// Wallet
// ---------------------------------------------------------------------------

interface WalletPanelProps {
  readonly wallet: WalletConnection | null
  readonly walletError: string | null
  readonly busy: boolean
  readonly hasProvider: boolean
  readonly onConnect: () => void
  readonly onDisconnect: () => void
  readonly onSwitchNetwork: () => void
}

function WalletPanel({ wallet, walletError, busy, hasProvider, onConnect, onDisconnect, onSwitchNetwork }: WalletPanelProps) {
  return (
    <aside className="wallet">
      <p className="wallet-label">MetaMask · optional</p>

      {wallet === null ? (
        <>
          <p className="wallet-state">{hasProvider ? 'Not connected' : 'No injected wallet detected'}</p>
          <button type="button" className="button button-ghost" onClick={onConnect} disabled={busy}>
            {busy ? 'Connecting…' : 'Connect'}
          </button>
        </>
      ) : (
        <>
          <p className="wallet-state">
            <code>{shortenAddress(wallet.address)}</code>
          </p>
          <p className={`wallet-network ${wallet.onSepolia ? 'ok' : 'warn'}`}>
            {wallet.onSepolia ? 'Sepolia · 11155111' : wallet.networkLabel}
          </p>
          {wallet.networkError !== null && (
            <p className="wallet-hint">
              {wallet.networkError}{' '}
              <button type="button" className="link" onClick={onSwitchNetwork} disabled={busy}>
                Switch to Sepolia
              </button>
            </p>
          )}
          <button type="button" className="button button-ghost" onClick={onDisconnect} disabled={busy}>
            Disconnect
          </button>
        </>
      )}

      {walletError !== null && (
        <p className="wallet-hint" role="alert">
          {walletError}
        </p>
      )}

      <p className="wallet-note">
        Discovery and routing are read-only. They work with the wallet disconnected, and this build
        never sends an ENS write transaction.
      </p>
    </aside>
  )
}