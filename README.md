Fiber Route Diagnostics — Hackathon Project Description


1. Project Overview

Fiber Route Diagnostics is a developer-facing diagnostic middleware and web dashboard that sits between a developer's application and their Fiber Network Node (FNN). It intercepts send_payment RPC responses, parses the flat failed_error string into a structured diagnostic object, and presents enriched failure information through both a JSON API and a visual web dashboard.

In short: it turns Fiber's flat error string into a structured diagnostic with a human-readable explanation, an actionable suggestion, and a visual payment timeline in the dashboard.

Category: Node, Routing, and Diagnostics Infrastructure


2. What Problem Does It Solve?

The Gap:

Fiber's internal payment engine already tracks exactly which hop failed and why, using a rich type system. Inside the Fiber codebase (payment.rs), there is a struct called TlcErr that contains an error_code field (a TlcErrorCode enum with values like TemporaryChannelFailure, InsufficientAmount, etc.) and an extra_data field (an optional TlcErrData enum that carries the failing node ID, channel outpoint, and channel update suggestions).

However, when this information reaches the developer through the RPC API, it is flattened into a single string. The SendPaymentResponse struct defines the failed_error field as Option<String>. For locally-generated errors (insufficient balance, no route found, expired invoice), that string carries real detail. For remote hop failures, only the error code name survives — the node ID, channel outpoint, and channel update are consumed internally by FNN and never reach the string.

The Real-World Impact:

Without this tool, when a payment fails the developer sees a raw string like "Send payment error: Failed to build route, Insufficient balance: max outbound liquidity 90000000000 is insufficient, required amount: 1500000000000" with no structured breakdown. To understand it they must parse the string manually and correlate it with their channel state. If the same error pattern keeps appearing, there is no way to detect the trend.

With this tool, the developer sees a structured diagnostic: the error code, a plain-English explanation, an actionable suggestion, and a dashboard timeline of all payment attempts with failure statistics.

Who Benefits:
- dApp developers integrating Fiber payments who need to debug failed transactions
- Node operators who want to monitor payment health and identify recurring error patterns
- Wallet developers who want to show users meaningful error messages instead of raw strings


3. What the Proxy Can and Cannot Recover

The current proxy works by parsing the flat failed_error string. What it can recover depends on where the error originated:

Local errors (fully recoverable):
- InsufficientLocalBalance: the string contains the exact max outbound and required amounts
- NoRouteFound: the string identifies that no path could be built
- ExpiryTooSoon: the string identifies invoice expiry or TLC expiry constraint violations
- HoldTlcTimeout: the string identifies a settlement timeout
- InvalidParameter: the string carries the validation message from FNN

Remote hop errors (partially recoverable):
- The error code name (e.g. TemporaryChannelFailure) survives in the string
- The failing node ID and channel outpoint do not survive — they are used internally by FNN to update the routing graph and are not included in the string
- Per-hop attribution in the dashboard is therefore an approximation based on local channel topology, not the real route

This gap is the motivation for Future Work 7.1 described at the end of this document.


4. System Design

Architecture:

The system has three components arranged in a chain:

Developer App connects to Fiber Route Diagnostics (Proxy + Dashboard + SDK), which connects to the Fiber Node (FNN).

Component 1 — RPC Proxy Server (Node.js / TypeScript):
- Forwards all RPC calls transparently to the real FNN
- Intercepts send_payment responses
- Parses the failed_error string into a structured DiagnosticResult using pattern matching against known error formats
- Enriches the response with a diagnostics field containing the error code, human-readable suggestion, and approximate hop information
- Stores payment history in a local JSON database for trend analysis

Component 2 — Web Dashboard (HTML / JavaScript):
- Connects to the proxy server via WebSocket for real-time updates
- Payment Timeline: shows all payments with their status (Pending, Success, Failed) and timestamps
- Failure Detail View: when a payment fails, shows the parsed error code, human-readable suggestion, and an approximate hop path derived from local channel state
- Failure Statistics panel: always-visible summary of total/succeeded/failed payments, success/failure rate, average fee, and top error codes, updated live via `STATS_UPDATE`
- Channel Health tab: drained-channel and disconnected-peer warnings alongside the Diagnostics tab
- Test Route / Probe controls: dry-run route simulation and probe payments, with fee estimates rendered under the result

Component 3 — TypeScript SDK:
- A thin wrapper class (FiberDiagClient) that developers import into their Node.js applications
- Provides sendPayment with automatic diagnostics enrichment built in
- Throws a structured FiberDiagError on failure, with code, suggestion, and raw error fields
- Provides getAllPayments and getPaymentDetails to query payment history, and getStats / testRoute for the newer endpoints

User Flow — Developer Debugging a Failed Payment:

Step 1: Developer starts the Proxy and Dashboard by running:
  npm start

Step 2: Developer points their dApp to the proxy instead of FNN directly. The proxy listens on port 9227 by default instead of FNN's default port 8227.

Step 3: Developer sends a payment through their dApp or via curl to http://127.0.0.1:9227.

Step 4: Payment fails due to insufficient local balance. The proxy intercepts the response.

What FNN originally returns:
  failed_error: "Send payment error: Failed to build route, Insufficient balance: max outbound liquidity 90000000000 is insufficient, required amount: 1500000000000"

What the proxy returns to the developer:
  failed_error: "Send payment error: Failed to build route, Insufficient balance: ..."
  error.data.diagnostics:
    code: "InsufficientLocalBalance"
    suggestion: "Your local channel balance is insufficient. The maximum outbound liquidity on this channel is currently 900.00 CKB, but this payment requires 15000.00 CKB. Try funding your channel or wait for incoming balance shifts."
    failing_hop_index: 0

Step 5: Developer opens http://localhost:9227 (the dashboard), sees the payment in the timeline, clicks it, and sees the parsed error with a plain-English explanation.

Developer Flow — Integrating the SDK:

Instead of calling FNN directly, a developer imports FiberDiagClient from the package. They create an instance pointing at the proxy URL and call sendPayment with an invoice. If the payment fails, the SDK throws a FiberDiagError with structured fields: code, suggestion, failingHopIndex, failingNodePubkey, and rawError.


5. Setup Environment

Local Environment:
- OS: macOS or Linux
- Runtime: Node.js v18+
- Package Manager: npm
- Language: TypeScript (proxy and SDK), HTML/CSS/JS (dashboard, inline in index.html)
- Database: JSON file (diagnostics_db.json) written to disk alongside the proxy
- Fiber Node: FNN running locally on default port 8227
- CKB Node: Local devnet via offckb node or CKB testnet

Project Structure:

fiber-route-diagnostics/
  package.json
  tsconfig.json
  src/
    proxy/
      server.ts         — HTTP proxy that forwards to FNN and intercepts send_payment
      parser.ts         — Parses flat error strings into structured DiagnosticResult objects
      db.ts             — JSON file-based payment history storage
      ws.ts             — WebSocket server for real-time dashboard updates
    sdk/
      index.ts          — FiberDiagClient and FiberDiagError classes
    dashboard/
      index.html        — Single-file dashboard (styles and JS included inline)
      history.json      — Static snapshot of testnet payment history for offline demo
    real_fnn_testnet_multihop.js      — Testnet scenario scripts
    real_fnn_testnet_multihop_fail.js
    real_fnn_error_scenarios.js
    real_fnn_testnet_shutdown.js
    real_sdk_demo.ts
  tests/
    parser.test.ts      — Unit tests for error string parsing


6. Tooling

CKB / Fiber Scripts, Tooling, and SDKs Used:

- Fiber Network Node (FNN): The core Fiber node that this tool wraps. Source: github.com/nervosnetwork/fiber
- @ckb-ccc/fiber: Official Fiber JS/TS SDK, used as a reference for RPC method signatures and response types
- FNN JSON-RPC API: The proxy forwards all JSON-RPC calls (send_payment, get_payment, list_channels, graph_nodes, etc.) to FNN and intercepts send_payment responses
- OffCKB: Used to run a local CKB devnet for testing the full payment lifecycle
- Fiber Scripts: On-chain scripts from github.com/nervosnetwork/fiber-scripts, not modified but referenced to understand channel outpoint structures

Key Fiber RPC Methods Used:

- send_payment: Primary interception target, parse failed_error from the response
- get_payment: Polled in the background to capture final status after an async payment
- node_info: Fetch the local node ID on startup for path approximation
- decode_invoice: Resolve the payee pubkey from an invoice string
- list_channels: Approximate the hop path for the route visualizer
- graph_nodes: (NOT YET IMPLEMENTED — planned) intended to resolve node pubkeys for display in the dashboard. Currently pubkeys are resolved via node_info, decode_invoice, and list_channels.


7. Current Functionality

7.1 RPC Proxy with Error Enrichment

The proxy server listens on a configurable port (default 9227) and transparently forwards all JSON-RPC requests to the real FNN. For send_payment responses, it:

- Detects failures: checks if the response contains an error or if status is Failed
- Parses the error string: matches the flat string against a catalogue of known error formats extracted from the Fiber source code
- Classifies the error: determines whether it is a local balance failure, a route-build failure, an expiry issue, a timeout, or a remote hop error
- Enriches the response: appends a diagnostics object containing the parsed code, a human-readable suggestion, and where recoverable, the failing hop index

The following error types are reliably parsed from the current FNN string format:
- InsufficientLocalBalance (exact amounts extracted from the string)
- NoRouteFound (route-build failures and pathfind errors)
- ExpiryTooSoon (invoice expiry and TLC expiry constraint violations)
- HoldTlcTimeout (settlement timeout)
- InvalidParameter (FNN parameter validation messages)
- Remote hop error codes (code name only, e.g. TemporaryChannelFailure — node and channel not recoverable from the string)

7.2 Payment History Database

Every payment that passes through the proxy is stored in a local JSON file with the payment hash, invoice address, amount in CKB, status, timestamps, the raw failed_error string, and the parsed diagnostics. This enables historical queries through the REST API and the dashboard.

7.3 Web Dashboard

A single-page web dashboard served on port 9227 alongside the proxy:

- Live Payment Feed: real-time list of all payments flowing through the proxy, color-coded by status
- Failure Detail Panel: click any failed payment to see the parsed error code, human-readable suggestion, and an approximate hop path derived from the local channel list
- Failure Statistics (NOT YET IMPLEMENTED — planned): a summary panel showing total payments, success rate, failure rate, and most common error codes. The current dashboard has two panels (the live payment feed and the payment detail view); the statistics panel is future work.

Note on the hop visualizer: the route shown is reconstructed from the local channel list, not from the actual payment route (which FNN does not expose in the current RPC). It is an approximation useful for orientation, not a precise trace.

7.4 TypeScript SDK

FiberDiagClient wraps the proxy's JSON-RPC and REST API. It provides sendPayment (which throws a FiberDiagError on failure with structured fields) and getAllPayments / getPaymentDetails for querying history.


8. Future Work

8.1 Upstream PR — Expose TlcErr in the RPC (the primary unlock)

The most impactful next step is a pull request to the nervosnetwork/fiber repository. Inside payment.rs, when a remote hop fails, the full TlcErr struct is available at the call site — it contains the error code, the failing node ID, the channel outpoint, and optionally a channel_update from the failing node. Currently, only the error code name is written into the failed_error string before the rest is discarded.

The change is small: thread the TlcErr into the SendPaymentResponse struct (either replacing the string field or adding a parallel structured field), update the JSON type in fiber-json-types, and serialize it in the RPC mapping. This would make per-hop attribution available to all Fiber developers natively, eliminate the need for string parsing, and unblock the features in 8.2 through 8.4 below.

8.2 Pre-Flight Route Check via dry_run

The send_payment RPC accepts a dry_run parameter. When set to true, FNN simulates the route selection without dispatching any TLC. Adding a "Test Route" button to the dashboard that calls send_payment with dry_run: true would give developers immediate feedback on whether a route is viable before committing real funds.

8.3 Payment Probing

Before sending a payment, the proxy could send a probe: a small payment to the destination using a randomly-generated payment hash that the recipient cannot settle. If the route reaches the destination, the recipient rejects it with IncorrectOrUnknownPaymentDetails, which confirms the route is viable. Any other error code pinpoints where the bottleneck is. This technique is used widely in Lightning Network tooling and has no equivalent in the current Fiber ecosystem.

8.4 Channel Balance Ratio Monitor

list_channels returns the local and remote balance for each of the operator's channels. Tracking these over time and alerting when a channel is heavily drained in one direction (for example, local balance below 10 percent of capacity) gives node operators advance warning before payments start failing. This is actionable information that FNN does not surface on its own.

8.5 Peer Connectivity Health

list_peers returns which peers are currently connected. Cross-referencing this with list_channels identifies channels whose peer is disconnected — a dead path that FNN will attempt and fail before marking unavailable. Surfacing these in the dashboard as a warning saves failed payment attempts.

8.6 True Per-Hop Failure Heatmap

Once 8.1 lands, the error response will carry the failing node ID. The dashboard can then aggregate failures by node rather than by error code alone, answering questions like which peer is causing the most failures this week, and which channel has the lowest success rate. The database schema already supports this; it just needs real node IDs instead of approximations.

8.7 Manual Route Construction via send_payment_with_router

FNN exposes a send_payment_with_router RPC that accepts an explicit list of hops. The dashboard could let a developer select nodes from the network graph and manually construct a route for testing, which is useful for isolating whether a specific path is the problem.

8.8 Automated Retry with Channel Exclusion

When a payment fails with a retryable error, the SDK could automatically exclude the failing channel or node on the next attempt. The send_payment RPC does not currently expose an exclude_channels parameter, but this could be implemented via send_payment_with_router once a viable alternative path is identified from the graph.

8.9 Cross-Chain Diagnostics (Fiber to Lightning)

When a payment crosses from Fiber to the Bitcoin Lightning Network via a Cross-Chain Hub, failures become harder to debug because the error could originate on either chain. Future versions could correlate errors across both networks and present a unified failure trace.

8.10 Multipath Payment Diagnostics

Fiber's design documents describe support for multipath payments (MPP), where a single large payment is split into smaller parts routed through different channels simultaneously. There is currently no developer tooling to visualize or debug how a payment was split. The dashboard could show which sub-payments were created, which path each part took, which parts succeeded and which failed, and the aggregate result. This is essential for debugging partial-success scenarios where some splits complete but others do not.

8.11 Circular Rebalancing Assistant

In Lightning, node operators use circular payments (pay yourself through a loop: A to B to C to A) to rebalance drained channels without opening new ones or going on-chain. Tools like Ride The Lightning and ThunderHub provide one-click rebalancing. No such tool exists for Fiber. The dashboard could detect heavily drained channels using list_channels balance ratios, suggest circular rebalancing routes through the network graph, and execute them via send_payment_with_router with the operator's own node as both sender and receiver.

8.12 Fee Simulation and Cost Estimation

Before sending a payment, Lightning tools like Lightning Terminal let developers estimate the total routing fee across multiple candidate paths. Fiber has no fee estimation tool. Using dry_run combined with local graph data, the proxy could return a list of candidate routes with their estimated total fees, letting the developer pick the cheapest or most reliable path before committing.

8.13 Network Health Explorer

Lightning has public explorers like 1ML and Amboss that show the health of the entire network — node uptime, channel capacity distribution, fee market trends, and connectivity scores. No equivalent exists for the Fiber network. The dashboard already queries graph_nodes and list_channels. Extending it to render a network-wide topology map with node health scores, fee policies, and capacity rankings would give Fiber its first network health explorer.


Summary:

What: Diagnostic middleware and dashboard for Fiber payment routing errors
Why: Locally-generated errors carry real detail in the RPC string; this tool structures and explains them. Remote hop attribution is currently limited by what FNN exposes.
How: RPC proxy parses the flat error string, stores history, renders a real-time dashboard
Stack: TypeScript, Node.js, JSON file storage, HTML/CSS/JS
Fiber integration: Wraps FNN JSON-RPC, uses @ckb-ccc/fiber SDK as reference
Hackathon scope: Proxy + parser + dashboard + SDK + testnet scenario scripts
Primary future contribution: Upstream PR to expose TlcErr natively (8.1), which unlocks per-hop attribution, the full heatmap, and the retry-with-exclusion feature

