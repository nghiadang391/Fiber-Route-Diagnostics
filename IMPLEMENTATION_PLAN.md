# Fiber Route Diagnostics — Feature Build-Out Plan

## Context

The project (`/data1/NgocVo/Fiber`) already ships a working proxy + dashboard + SDK that
intercepts Fiber `send_payment` responses, parses flat error strings into structured
diagnostics, stores history in a JSON file, and renders a live dashboard. The README's
"Future Work" (8.1–8.13) plus two features it labels *not-yet-implemented* (Failure
Statistics panel, `graph_nodes` integration) describe where the project should go next.

**Goal of this plan:** implement the *self-contained, buildable-now* features — everything
that lives in the TypeScript proxy/dashboard/SDK and needs no external Rust work. Per user
decisions:

- **In scope (10 features):** Failure Statistics panel, `graph_nodes` name resolution,
  dry-run route check (8.2), payment probing (8.3), channel balance monitor (8.4), peer
  connectivity health (8.5), manual route construction (8.7), fee simulation (8.12),
  network health explorer (8.13), + circular rebalancing (8.11).
- **Dependency-only (build to degrade gracefully, no Rust):** per-hop failure heatmap (8.6),
  auto-retry with channel exclusion (8.8). Both work today with *approximate* node/channel
  attribution and improve automatically once the upstream TlcErr-in-RPC PR (8.1) lands.
- **Excluded:** 8.1 (Rust upstream PR), 8.9 (cross-chain), 8.10 (multipath/MPP).

**Testing constraint:** testnet RPC is currently blocked by the corporate VPN/Fortinet
firewall, so several FNN RPCs cannot be verified live yet. Strategy = **Jest unit tests with
mocked FNN RPC responses** for all new logic (extract pure functions into testable modules),
plus an **offckb local devnet** path for integration once available. Every new RPC shape is
flagged in the Risk Register and must be confirmed against FNN v0.8.1 before its phase ships.

---

## Guiding architecture decisions

1. **Extract logic out of `server.ts` into pure, testable modules.** `server.ts` becomes a
   thin orchestration layer; business logic moves to modules that take injected dependencies
   (an `FnnClient`, DB functions) so they can be unit-tested with mocks.
2. **DB in-memory cache.** `db.ts` currently does a full file read+write on every op. Add a
   module-level cache populated on `initDb()` and kept in sync on write — preserves the exact
   public API, removes repeated disk reads (critical once channel time-series is added).
3. **WS message registry.** Reuse the existing `{type, payload}` envelope. New types:
   `STATS_UPDATE`, `NODE_ALIASES_UPDATED`, `CHANNEL_ALERT`, `PEER_HEALTH_UPDATE`. Dashboard
   switches on `msg.type` in its existing `ws.onmessage`.

---

## Phase 0 — Shared infrastructure (prerequisite for everything)

No user-visible output; makes all later phases testable.

**0-A. `src/proxy/fnnClient.ts` (new).** Single place for all FNN JSON-RPC calls, replacing
scattered `axios.post(FNN_RPC_URL, ...)` in `server.ts`. `createFnnClient({rpcUrl, postFn?})`
returns an object with methods: `nodeInfo`, `decodeInvoice`, `listChannels`, `listPeers`,
`getPayment`, `sendPayment`, `sendPaymentWithRouter`, `graphNodes`, `graphChannels`,
`newInvoice`. Default `postFn = axios.post`; tests inject a Jest mock. Throws a new
`FnnRpcError{code,message}` when the RPC returns an error. Define result interfaces here
(`NodeInfoResult`, `ChannelInfo`, `PeerInfo`, `GraphNodeInfo`, `GraphChannelInfo`, `HopSpec`, …).
Refactor `server.ts`'s `fetchPayerNodeId`/`fetchRecipientNodeId`/`getDynamicHops`/
`startPaymentPoller` to use one client instance created at startup.
Tests: `tests/fnnClient.test.ts` (mocked `postFn` for success + error paths per method).

**0-B. DB cache + schema extension in `src/proxy/db.ts`.** Add `dbCache` (read returns cache,
write updates cache then disk, `initDb` populates it). Extend `Schema` with new top-level keys
(with backward-compatible migration in `initDb` for existing files):
- `channel_snapshots: ChannelSnapshot[]` — `{channel_outpoint, peer_id, local_balance_shannons,
  remote_balance_shannons, capacity_shannons, sampled_at}` (8.4)
- `hop_failure_counts: Record<string, HopFailureCount>` — `{node_pubkey, fail_count,
  last_failed_at, error_codes: Record<code,count>}` (8.6)
- `node_aliases: Record<string,string>` (graph_nodes)

New DB fns: `saveChannelSnapshot`, `getChannelSnapshots`, `getLatestSnapshots`,
`pruneChannelSnapshots(maxAgeMs)`, `incrementHopFailure`, `getHopFailureCounts`,
`saveNodeAlias`, `getNodeAlias`, `getAllNodeAliases`.
Tests: `tests/db.test.ts` (`jest.mock('fs')`; round-trips + assert `readFileSync` called ≤1×
after `initDb`).

**0-C. `src/proxy/routing.ts` (new).** Move `extractAmountFromInvoice` and `getDynamicHops`
(rename `buildApproximateHops`, now pure: takes channel list, not a client). Add pure fns used
by later phases: `findDisconnectedChannels(channels, peers)` (8.5),
`findDrainedChannels(latestSnapshots, thresholdPct)` (8.4),
`suggestCircularRoutes(nodeId, drained, graphChannels)` (8.11),
`excludeChannelFromHops(hops, channels, excludedOutpoints)` (8.8).
Tests: `tests/routing.test.ts` (pure, static fixtures, no mocks).

**0-D. `src/proxy/stats.ts` (new).** `computePaymentStats(payments): PaymentStats`
(`total/succeeded/failed/pending/successRate/failureRate/topErrorCodes/avgFeeCkb/totalVolumeCkb`).
Tests: `tests/stats.test.ts` (pure).

---

## Feature phases

Each phase: backend module → `server.ts` REST endpoint + WS broadcast → dashboard → unit tests.
Recommended session order (quick wins + infra first): **0 → 2 → 1 → 5 → 6 → 3 → 4 → 8 → 7 → 10 → 9 → 11 → 12.**

**Phase 2 — Failure Statistics panel** (simplest; pure aggregation). `GET /api/stats`;
broadcast `STATS_UPDATE` after each payment update. Dashboard: always-visible stats panel at
top of the right column (6 metric tiles + top-error badges) using existing `.summary-card`
styling; handle `STATS_UPDATE`, bootstrap via `/api/stats`. SDK: add `getStats()`.

**Phase 1 — graph_nodes name resolution.** New `src/proxy/nodeRegistry.ts`:
`refreshNodeAliases(client, db)` (calls `graphNodes`, stores aliases; swallows `FnnRpcError` →
graceful degrade to raw pubkeys), `resolveAlias(pubkey, aliases)`. `server.ts`: refresh on
startup + 5-min interval; `GET /api/nodes`; broadcast `NODE_ALIASES_UPDATED`. Dashboard: keep
`nodeAliases` map, resolve aliases in `renderDetails` hop labels. Tests:
`tests/nodeRegistry.test.ts`.

**Phase 5 — Dry-run pre-flight route check (8.2).** `POST /api/payments/dry-run {invoice}` →
`fnnClient.sendPayment({invoice, dry_run:true})`; on error parse with `parseFnnError`; return
`501`-style message if FNN rejects the param. Read-only, no DB writes. Dashboard: "Test Route"
button rendering result in the existing route-visualizer. SDK: `testRoute(invoice)`. Tests:
`tests/dryRun.test.ts`.

**Phase 6 — Payment probing (8.3).** New `src/proxy/prober.ts`: `generateProbeHash()`
(`crypto.randomBytes(32)`), `classifyProbeResult(code)` (`IncorrectOrUnknownPaymentDetails` →
`ROUTE_VIABLE`, else `ROUTE_BLOCKED`), `runProbe(client, invoice, hash)`.
`POST /api/payments/probe`. Dashboard: "Probe Route" button beside "Test Route". Tests:
`tests/prober.test.ts`.

**Phase 3 — Channel balance monitor (8.4).** New `src/proxy/channelMonitor.ts`:
`startChannelMonitor(client, db, broadcast, {pollIntervalMs:60000, drainThresholdPct:0.10})`
returning the interval handle; `pollChannels()` → `listChannels` → `saveChannelSnapshot` each →
`findDrainedChannels`. Add `broadcastRaw({type,payload})` to `ws.ts` (existing
`broadcastPaymentUpdate` delegates to it). Broadcast `CHANNEL_ALERT` when drained. Endpoints:
`GET /api/channels/snapshots`, `GET /api/channels/alerts`. Hourly `pruneChannelSnapshots`.
**Dashboard: introduce a tab switcher in the details panel — "Diagnostics" (existing) |
"Channel Health" (new)**; Channel Health shows a channel table with balance-ratio bars +
status badges + drained-channel alert banner. Tests: `tests/channelMonitor.test.ts`.

**Phase 4 — Peer connectivity health (8.5).** Extend `channelMonitor.ts` with
`pollPeerHealth(client)` → `listPeers` + `findDisconnectedChannels`; broadcast
`PEER_HEALTH_UPDATE`. `GET /api/peers/health`. Dashboard: "Peer Status" sub-section in the
Channel Health tab with DISCONNECTED badges. Tests: `tests/peerHealth.test.ts`.

**Phase 8 — Per-hop failure heatmap (8.6, graceful-degrade).** 2-line addition in each failure
path of `server.ts`: `if (diagnostic.failing_node_pubkey) incrementHopFailure(pubkey, code)`.
`GET /api/heatmap` (sorted desc). Dashboard: "Failure Heatmap" section in Channel Health tab
(ranked heat-gradient bars, alias labels) with a muted disclaimer "attribution approximate
until upstream PR 8.1" (removable one-liner later). Tests: extend `tests/db.test.ts`.

**Phase 7 — Manual route construction (8.7).** `POST /api/payments/manual-route {invoice, hops}`
→ `fnnClient.sendPaymentWithRouter(...)` then reuse `startPaymentPoller`; save hops as
`Untracked`. Dashboard: "Build Route" drawer — paste invoice, pick nodes from `GET /api/nodes`,
order into a hop list, send. Tests: extend `tests/routing.test.ts` (HopSpec construction).

**Phase 10 — Auto-retry with channel exclusion (8.8, graceful-degrade).** Add optional
`retry_policy {max_attempts, attempt_count, excluded_outpoints}` to `PaymentRecord`. In
`startPaymentPoller`, on retryable codes (`TemporaryChannelFailure`, `AmountBelowMinimum`)
add the (approximate) failing outpoint to exclusions, rebuild hops via `excludeChannelFromHops`,
resend via `sendPaymentWithRouter`, increment attempts, broadcast update. `POST
/api/payments/:hash/retry`. Dashboard: "Retry with Channel Exclusion" button on failed
payments. Tests: `tests/retry.test.ts`.

**Phase 9 — Fee simulation (8.12).** New `src/proxy/feeSimulator.ts`:
`estimateRouteFees(routes, graphChannels, amount)` (pure; `confidence:"graph_data"|"approximated"`),
`getCandidateRoutes(client, payer, recipient, maxRoutes)` (BFS over `graphChannels`, falls back
to `buildApproximateHops`). `POST /api/payments/estimate-fees`; also augment dry-run response.
Dashboard: "Fee Estimate" card under the route visualizer + per-route fees in Build Route
drawer. Tests: `tests/feeSimulator.test.ts`.

**Phase 11 — Circular rebalancing (8.11).** Implement `suggestCircularRoutes` (BFS
node→…→node preferring drained outgoing / healthy return legs). `GET /api/rebalance/suggestions`,
`POST /api/rebalance/execute {route, amountShannons}` (generate self-invoice via `newInvoice`,
send via `sendPaymentWithRouter`). Dashboard: "Rebalance" section in Channel Health tab with
suggested routes + Execute buttons. If self-payment unsupported by FNN, show suggestions but
disable Execute. Tests: extend `tests/routing.test.ts`.

**Phase 12 — Network health explorer (8.13).** `GET /api/graph` (composite: `graphNodes` +
`graphChannels` + `getLatestSnapshots` + local node id). Dashboard: third tab "Network Map" —
vanilla-JS force-directed graph on `<canvas>` (no D3, keep single-file), node sizing/coloring by
role, edge color by health (green/orange drained/red disconnected), thickness by capacity,
hover tooltips (alias), refresh/zoom/local-only controls. No new backend pure-logic tests.

---

## Files created / modified

- **New modules:** `src/proxy/fnnClient.ts`, `routing.ts`, `stats.ts`, `nodeRegistry.ts`,
  `channelMonitor.ts`, `prober.ts`, `feeSimulator.ts`.
- **Modified:** `src/proxy/server.ts` (refactor to fnnClient + all new endpoints/broadcasts),
  `src/proxy/db.ts` (cache + schema + new fns), `src/proxy/ws.ts` (`broadcastRaw`),
  `src/dashboard/index.html` (stats panel, tabbed details panel, all feature views),
  `src/sdk/index.ts` (`getStats`, `testRoute`).
- **New tests:** `tests/{fnnClient,db,routing,stats,nodeRegistry,channelMonitor,peerHealth,dryRun,prober,feeSimulator,retry}.test.ts`.
  `tests/parser.test.ts` unchanged.

---

## Verification

**Unit (works offline, now):** `npm test` (jest + ts-jest). All new logic is pure or takes an
injected `FnnClient`/DB, mocked per `parser.test.ts` style. FNN responses mocked via
`mockPostFn.mockResolvedValueOnce({data:{result:{...}}})`; DB via `jest.mock('fs')`.

**Integration (once offckb devnet or unblocked network available):**
1. First, a throwaway probe script calling `graph_nodes`, `graph_channels`, `list_peers`,
   `list_channels` (log a raw channel object), `send_payment {dry_run:true}`, and
   `send_payment_with_router` — to confirm the RPC shapes flagged below *before* trusting them.
2. `FNN_RPC_URL=<devnet>` + `npm start`; run existing `src/real_fnn_error_scenarios.js`.
3. New `src/integration_channel_monitor.js`: drain a channel, assert a `CHANNEL_ALERT` WS
   message arrives within 2 poll cycles.

**Build:** `npm run build` (tsc) must stay clean after each phase.

---

## Risk register (RPC shapes unverifiable while firewall is up)

| Risk | Sev | Mitigation |
|---|---|---|
| `graph_nodes` name/shape differs or absent in v0.8.1 | High | Verify via probe script; Phases 1 & 12 degrade to raw pubkeys. |
| `graph_channels` absent | High | Phases 9 & 12 fall back to `list_channels`-only; fees `confidence:"approximated"`. |
| `send_payment_with_router` name/hop format unverified | High | 1-line client change if name differs; adjust `HopSpec` if hop fields differ. Gate Phases 7/10/11. |
| `send_payment` `dry_run` param existence/name | Med | Phase 5 returns clear "not supported" if FNN rejects the param. |
| `list_channels` balance field names/format (hex vs int) | Med | Probe-log a raw channel before Phase 3; existing code only reads `.pubkey`. |
| `list_peers` `connected` field name/type | Med | If absent, treat presence in peer list as connected. |
| `new_invoice` self-payment support (8.11) | Med | Phase 11 last; disable Execute if unsupported. |
| DB growth from 60s channel snapshots | Med | Phase 0-B cache + hourly `pruneChannelSnapshots` (keep 24h). |

---

## Dependencies

```
Phase 0
 ├─ Phase 2 (stats)                 ├─ Phase 5 (dry-run) ─ Phase 6 (probe)
 ├─ Phase 1 (aliases)               ├─ Phase 7 (manual) ─ Phase 10 (retry)
 ├─ Phase 3 (balance) ─ Phase 4 (peers)   ├─ Phase 9 (fees, needs 5)
 │                    └ Phase 8 (heatmap)  └─ Phase 11 (rebalance, needs 3+7+9)
 └─────────────────────────────────────────── Phase 12 (map, needs 1+3)
```
