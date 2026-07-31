# Fiber Route Diagnostics

Diagnostic middleware and dashboard for the Fiber Network Node (FNN) payment protocol.

## 1. Overview

Fiber Route Diagnostics sits between a developer's app and their FNN. It intercepts `send_payment`
responses, parses the flat `failed_error` string into a structured diagnostic object, and surfaces
it through a REST/WS API, a web dashboard, and a TypeScript SDK.

**Category:** Node, Routing, and Diagnostics Infrastructure

## 2. Problem

Fiber's payment engine tracks exactly which hop failed and why (`TlcErr`, with an `error_code` and
optional `extra_data` carrying the failing node ID and channel outpoint). But `SendPaymentResponse`
flattens all of that into `failed_error: Option<String>`:

- **Local errors** (insufficient balance, no route, expired invoice) keep real detail in the string.
- **Remote hop errors** keep only the error code name — the node ID and channel outpoint are
  consumed internally by FNN and never reach the string.

Without this tool, a developer sees a raw string and has to parse it manually against their channel
state, with no way to spot recurring patterns. This tool turns that string into a structured
diagnostic (code, plain-English explanation, suggestion) plus a dashboard timeline and failure
stats.

**Who benefits:** dApp developers debugging failed payments, node operators monitoring payment
health, wallet developers who want to show users meaningful errors instead of raw strings.

## 3. What Can and Can't Be Recovered

| Error class | Recoverable? | Detail |
|---|---|---|
| `InsufficientLocalBalance` | Full | exact max-outbound / required amounts in the string |
| `NoRouteFound` | Full | route-build/pathfind failure identified |
| `ExpiryTooSoon` | Full | invoice/TLC expiry violation identified |
| `HoldTlcTimeout` | Full | settlement timeout identified |
| `InvalidParameter` | Full | FNN's own validation message |
| Remote hop errors (e.g. `TemporaryChannelFailure`) | Partial | code name survives; failing node ID / channel outpoint do not |

Per-hop attribution in the dashboard is therefore an approximation from local channel topology, not
the real route. Closing this gap is Future Work item 8.1.

## 4. System Design

**Developer App → Fiber Route Diagnostics (Proxy + Dashboard + SDK) → Fiber Node (FNN)**

- **Proxy (`src/proxy/`, Node.js/TypeScript)** — forwards all RPCs transparently to FNN;
  intercepts `send_payment`; parses/classifies `failed_error`; enriches the response with a
  `diagnostics` object; stores history; runs background pollers (node aliases, channel health).
- **Dashboard (`src/dashboard/index.html`)** — WebSocket-driven single-page UI: live payment feed,
  failure detail panel, always-on stats panel, Diagnostics/Channel Health tabs, Test
  Route/Probe controls with fee estimates.
- **SDK (`src/sdk/index.ts`)** — `FiberDiagClient` wraps the proxy's RPC + REST API; `sendPayment`
  throws a structured `FiberDiagError`; also exposes `getAllPayments`, `getPaymentDetails`,
  `getStats`, `testRoute`.

**Example flow:** developer runs `npm start`, points their dApp at the proxy (port `9227` instead
of FNN's `8227`), sends a payment. If it fails with insufficient balance, FNN's raw string —
`"...Insufficient balance: max outbound liquidity 90000000000 is insufficient, required amount:
1500000000000"` — comes back enriched with `error.data.diagnostics: { code:
"InsufficientLocalBalance", suggestion: "...fund your channel or wait for incoming balance
shifts.", failing_hop_index: 0 }`. The dashboard at `http://localhost:9227` shows the same payment
in the timeline with the plain-English explanation.

## 5. Setup

- **OS:** macOS or Linux · **Runtime:** Node.js v18+ · **Package manager:** npm
- **Language:** TypeScript (proxy, SDK), inline HTML/CSS/JS (dashboard)
- **Storage:** JSON file (`diagnostics_db.json`), in-memory cache on top
- **Fiber Node:** FNN on default port `8227` · **CKB:** local devnet via `offckb`, or testnet

**Project structure:**

```
src/
  proxy/
    server.ts         orchestration layer — REST endpoints, WS broadcasts, background pollers
    fnnClient.ts       single place for all FNN JSON-RPC calls (injectable postFn for tests)
    parser.ts          flat error strings -> structured DiagnosticResult
    routing.ts         pure helpers: extractAmountFromInvoice, buildApproximateHops,
                        findDrainedChannels, findDisconnectedChannels
    stats.ts           payment history -> PaymentStats (success rate, top errors)
    nodeRegistry.ts     graph_nodes pubkeys -> aliases, refreshed on an interval
    channelMonitor.ts  polls list_channels/list_peers -> drained channels, disconnected peers
    prober.ts          probe payment hashes + result classification
    feeSimulator.ts    route fee estimation (BFS over graph_channels, approximate-hop fallback)
    db.ts              JSON file storage + in-memory cache
    ws.ts              WebSocket server; broadcastRaw powers all typed WS messages
  sdk/index.ts         FiberDiagClient, FiberDiagError
  dashboard/           index.html (single-file UI), history.json (offline demo snapshot)
  real_fnn_*.js/.ts    testnet scenario scripts
tests/                 parser, fnnClient, db, routing, stats, nodeRegistry, channelMonitor,
                       peerHealth, dryRun, prober, feeSimulator — mocked FNN RPC responses
```

## 6. Tooling & Key RPCs

- **FNN** (`github.com/nervosnetwork/fiber`) — the node this tool wraps.
- **`@ckb-ccc/fiber`** — reference for RPC method/response shapes.
- **OffCKB** — local CKB devnet for full payment-lifecycle testing.
- **Fiber Scripts** (`fiber-scripts`) — referenced (not modified) for channel outpoint structure.

| RPC | Used for |
|---|---|
| `send_payment` | main interception target; also `dry_run:true` (pre-flight) and probe hash (route probing) |
| `get_payment` | background polling for final async status |
| `node_info` | local node ID on startup |
| `decode_invoice` | resolve payee pubkey from invoice |
| `list_channels` | hop approximation, drained-channel detection, fee-estimate fallback |
| `list_peers` | cross-referenced with `list_channels` for disconnected peers |
| `graph_nodes` | pubkey → alias resolution (startup + every 5 min; falls back to raw pubkeys) |
| `graph_channels` | BFS candidate routes + fee rates for fee estimation; falls back to approximate hop |

## 7. Current Functionality

**7.1 Error enrichment.** Detects `send_payment` failures, parses the flat string against known
formats, classifies (`InsufficientLocalBalance`, `NoRouteFound`, `ExpiryTooSoon`,
`HoldTlcTimeout`, `InvalidParameter`, or remote hop code), and appends a `diagnostics` object with
code, suggestion, and (where recoverable) failing hop index.

**7.2 Payment history.** Every payment is stored locally (hash, invoice, amount, status,
timestamps, raw error, parsed diagnostics), queryable via REST and the dashboard.

**7.3 Web dashboard.** Live payment feed; failure detail panel; a stats panel
(`GET /api/stats`, live via `STATS_UPDATE`) showing totals, success/failure rate, avg fee, top
error codes; node-alias resolution in hop labels (`GET /api/nodes`, `NODE_ALIASES_UPDATED`); a
Channel Health tab alongside Diagnostics. The hop visualizer is reconstructed from local channel
state, not the real payment route — FNN doesn't expose that.

**7.4 Channel & peer health.** `channelMonitor.ts` polls every 60s: snapshots channel balance
ratios, flags channels under a threshold (default 10%) as drained (`CHANNEL_ALERT`), and flags
channels whose peer is disconnected (`PEER_HEALTH_UPDATE`). Query via `GET /api/channels/snapshots`
and `GET /api/channels/alerts`.

**7.5 Pre-flight check & probing.** `POST /api/payments/dry-run` simulates routing via
`send_payment {dry_run:true}` (501 if unsupported). `POST /api/payments/probe` sends an
unsettleable probe payment — `IncorrectOrUnknownPaymentDetails` back means `ROUTE_VIABLE`, anything
else means `ROUTE_BLOCKED`.

**7.6 Fee simulation.** `POST /api/payments/estimate-fees` (and the dry-run response) resolve
recipient + amount, find up to 3 candidate routes (BFS over `graph_channels`, falling back to an
approximate hop), and score each with `confidence: "graph_data" | "approximated"`.

**7.7 SDK.** `FiberDiagClient`: `sendPayment` (throws `FiberDiagError`), `getAllPayments`,
`getPaymentDetails`, `getStats`, `testRoute`.

## 8. Future Work

**8.1 Upstream PR — expose `TlcErr` in the RPC (primary unlock).** Thread the existing `TlcErr`
(error code, failing node ID, channel outpoint, optional `channel_update`) into
`SendPaymentResponse` instead of discarding it after flattening to a string. Small change in
`payment.rs` + `fiber-json-types` + RPC mapping; unblocks native per-hop attribution and 8.2 below.

**8.2 True per-hop failure heatmap.** Once 8.1 lands, aggregate failures by real node ID instead of
error code alone — the DB schema already supports it.

**8.3 Manual route construction** via `send_payment_with_router` — let a developer pick nodes from
the graph and build a route by hand, to isolate whether a specific path is the problem.

**8.4 Automated retry with channel exclusion.** On a retryable failure, exclude the failing
channel/node next attempt via `send_payment_with_router` (no native `exclude_channels` param yet).

**8.5 Cross-chain diagnostics** (Fiber ↔ Lightning via a Cross-Chain Hub) — correlate errors across
both chains into one failure trace.

**8.6 Multipath payment diagnostics.** Visualize how an MPP split into sub-payments, which paths
they took, and which succeeded/failed — needed for debugging partial-success cases.

**8.7 Circular rebalancing assistant.** Use the drained-channel data from 7.4 to suggest and execute
(via `send_payment_with_router`) self-looped rebalancing payments, à la Lightning's RTL/ThunderHub.

**8.8 Network health explorer — descoped.** A 1ML/Amboss-style network-wide topology/health view
was considered but cut to keep scope tight; the existing `graph_nodes`/`graph_channels` plumbing
(7.6) would be the starting point if revisited.

---

**What:** diagnostic middleware + dashboard for Fiber payment routing errors.
**Why:** local errors carry real detail in the RPC string; this structures and explains them —
remote hop attribution is limited by what FNN exposes today.
**How:** RPC proxy parses the error string, stores history, renders a real-time dashboard.
**Stack:** TypeScript, Node.js, JSON storage, HTML/CSS/JS.
**Fiber integration:** wraps FNN JSON-RPC; uses `@ckb-ccc/fiber` as a reference.
**Hackathon scope:** proxy + parser + dashboard + SDK + testnet scenario scripts.
**Primary future contribution:** upstream PR to expose `TlcErr` natively (8.1), unlocking per-hop
attribution, the full heatmap, and retry-with-exclusion.
