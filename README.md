Fiber Route Diagnostics — Hackathon Project Description


1. Project Overview

Fiber Route Diagnostics is a developer-facing diagnostic middleware and web dashboard that sits between a developer's application and their Fiber Network Node (FNN). It intercepts payment RPC responses, parses the flat "failed_error" (which is just an Option String) into its original structured form (TlcErr with TlcErrorCode and TlcErrData), and presents rich, per-hop failure information through both a structured JSON API and a visual web dashboard.

In short: it turns Fiber's "your payment failed" into "your payment failed at Hop 3 (Node 0xabc...) because the channel 0xdef... had insufficient outbound capacity — here is the channel update the failing node suggested."

Category: Node, Routing, and Diagnostics Infrastructure


2. What Problem Does It Solve?

The Gap:

Fiber's internal payment engine already tracks exactly which hop failed and why, using a rich type system. Inside the Fiber codebase (payment.rs), there is a struct called TlcErr that contains an error_code field (a TlcErrorCode enum with values like TemporaryChannelFailure, InsufficientAmount, etc.) and an extra_data field (an optional TlcErrData enum that tells you which node failed, which channel failed, and includes channel update suggestions).

The TlcErrData enum has three variants:
- ChannelFailed: includes the channel_outpoint, an optional channel_update, and the node_id
- NodeFailed: includes the node_id
- TrampolineFailed: includes the node_id and an inner_error_packet

But when this information reaches the developer through the RPC API, it is flattened into a single string. The SendPaymentResponse struct in network.rs (line 607) defines the failed_error field as Option String. All the rich structured data is gone by the time the developer sees it.

The Real-World Impact:

Without this tool, when a payment fails, the developer sees something like "TemporaryChannelFailure" — a flat string with no context about which hop, which node, or which channel caused the problem. To debug, they must enable RUST_LOG=debug, read raw Rust log output, and manually correlate timestamps. If the same node keeps failing, there is no way to detect the pattern.

With this tool, the developer sees: "Hop 2 (Node 0xabc...) on Channel 0xdef... temporarily unavailable. Suggested channel update attached." They can open the dashboard and see a visual timeline of all payment attempts with per-hop status. Repeated failures are surfaced automatically through a failure heatmap.

Who Benefits:
- dApp developers integrating Fiber payments who need to debug failed transactions
- Node operators who want to monitor routing health and identify problematic peers
- Wallet developers who want to show users meaningful error messages instead of raw codes


3. System Design

Architecture:

The system has three components arranged in a chain:

Developer App (dApp or Wallet) connects to the Fiber Route Diagnostics (Proxy + UI + SDK), which connects to the Fiber Node (FNN). The RPC Proxy, the Web Dashboard, and the TypeScript SDK are the three sub-components of Fiber Route Diagnostics.

Component 1 — RPC Proxy Server (Node.js / TypeScript):
- Forwards all RPC calls transparently to the real FNN
- Intercepts send_payment and get_payment responses
- Parses failed_error strings into structured TlcErr objects using pattern matching against known TlcErrorCode values
- Enriches the response with a new "diagnostics" field containing structured error data
- Stores payment history in a local SQLite database for trend analysis

Component 2 — Web Dashboard (HTML + JavaScript):
- Connects to the proxy server via WebSocket for real-time updates
- Payment Timeline: shows all payments with their status (Created, Inflight, Success, Failed)
- Failure Detail View: when a payment fails, shows the error code, affected node/channel, and human-readable explanation
- Failure Heatmap: aggregates failures over time to identify unreliable nodes or channels

Component 3 — TypeScript SDK (npm package):
- A thin wrapper class (FiberDiag) that developers import into their Node.js applications
- Provides sendPayment with automatic diagnostics enrichment built in
- Provides getFailures to query payment history by time range
- Handles retry logic with smart channel exclusion when a failure is retryable

User Flow — Developer Debugging a Failed Payment:

Step 1: Developer starts the Proxy and Dashboard by running:
  npx fiber-diag --fnn-url http://127.0.0.1:8227

Step 2: Developer points their dApp to the proxy instead of FNN directly. The proxy listens on port 9227 instead of the FNN's default 8227.

Step 3: Developer sends a payment through their dApp or via curl to http://127.0.0.1:9227.

Step 4: Payment fails. The proxy intercepts the response.

What FNN originally returns:
  status: "Failed"
  failed_error: "TemporaryChannelFailure"

What the proxy returns to the developer:
  status: "Failed"
  failed_error: "TemporaryChannelFailure"
  diagnostics:
    error_code: "TemporaryChannelFailure"
    error_category: "channel"
    is_retryable: true
    failing_node: "0xabc..."
    failing_channel: "0xdef..."
    human_message: "Hop 2 channel is temporarily unable to forward. This is usually caused by concurrent state updates. Retrying may succeed."
    suggestion: "Wait 5 seconds and retry, or exclude this channel."

Step 5: Developer opens http://localhost:9228 (the dashboard), sees the payment in the timeline, clicks it, and sees a visual hop diagram showing exactly where it broke.

Developer Flow — Integrating the SDK:

Instead of calling FNN directly, a developer imports the FiberDiag class from the fiber-route-diagnostics package. They create an instance with their FNN URL, then call sendPayment with an invoice. If the result status is Failed, they can read result.diagnostics.human_message for a plain-English explanation. If result.diagnostics.is_retryable is true, they can retry with the failing channel excluded by passing exclude_channels in the next sendPayment call.


4. Setup Environment

Local Environment:
- OS: macOS
- Runtime: Node.js v26+
- Package Manager: npm v11+
- Language: TypeScript (proxy and SDK), HTML/CSS/JS (dashboard)
- Database: SQLite via better-sqlite3 for local payment history
- Fiber Node: FNN running locally on default port 8227
- CKB Node: Local devnet via offckb node or CKB testnet

Project Structure:

fiber-route-diagnostics/
  package.json
  tsconfig.json
  src/
    proxy/
      server.ts         — HTTP proxy that forwards to FNN
      interceptor.ts    — Intercepts and enriches payment responses
      parser.ts         — Parses flat error strings into TlcErr structs
    sdk/
      index.ts          — FiberDiag class wrapping the proxy
    dashboard/
      index.html
      style.css
      app.js
    db/
      store.ts          — SQLite payment history storage
  tests/
    parser.test.ts      — Unit tests for error string parsing
    proxy.test.ts       — Integration tests with mock FNN responses


5. Tooling

CKB / Fiber Scripts, Tooling, and SDKs Used:

- Fiber Network Node (FNN): The core Fiber node that this tool wraps. Source: github.com/nervosnetwork/fiber
- @ckb-ccc/fiber: Official Fiber JS/TS SDK, used as a reference for RPC method signatures and response types
- FNN JSON-RPC API: The proxy forwards all JSON-RPC calls (send_payment, get_payment, list_channels, graph_nodes, etc.) to FNN and intercepts responses
- OffCKB: Used to run a local CKB devnet for testing the full payment lifecycle
- Fiber Scripts: On-chain scripts from github.com/nervosnetwork/fiber-scripts, not modified but referenced to understand channel outpoint structures

Key Fiber RPC Methods Used:

- send_payment: Primary interception target, parse failed_error from the response
- get_payment: Poll payment status and capture final error state
- graph_nodes: Resolve node pubkeys to human-readable aliases for the dashboard
- graph_channels: Look up channel capacity and state to enrich error diagnostics
- list_channels: Show the operator's own channels and their balance ratios


6. Current Functionality

6.1 RPC Proxy with Error Enrichment

The proxy server listens on a configurable port (default 9227) and transparently forwards all JSON-RPC requests to the real FNN. For send_payment and get_payment responses, it:

- Detects failures: checks if status is Failed and failed_error is not null
- Parses the error string: matches the flat string against a catalogue of known TlcErrorCode values extracted from the Fiber source code (TemporaryChannelFailure, AmountBelowMinimum, IncorrectPaymentDetails, ExpiryTooSoon, etc.)
- Classifies the error: determines if it is a channel-level, node-level, or payment-level failure, and whether it is retryable
- Enriches the response: appends a diagnostics object to the JSON-RPC response containing the parsed error_code, error_category (channel, node, or payment), is_retryable flag, human_message (plain-English explanation), and suggestion (actionable next step)

6.2 Payment History Database

Every payment that passes through the proxy is stored in a local SQLite database with payment hash, status, timestamps, the raw failed_error string, the parsed diagnostics object, and the route hops (if available from graph_channels). This enables historical queries like "show me all failures in the last hour" or "which nodes have the highest failure rate."

6.3 Web Dashboard

A lightweight, single-page web dashboard served on port 9228:

- Live Payment Feed: real-time list of all payments flowing through the proxy, color-coded by status (green for success, red for failed, yellow for inflight)
- Failure Detail Panel: click any failed payment to see the parsed error code, human-readable message, suggestion for resolution, and whether the error is retryable
- Failure Statistics: a summary panel showing total payments, success rate, failure rate, most common error codes as a bar chart, and nodes with the highest failure count as a table

6.4 TypeScript SDK

A thin wrapper class (FiberDiag) that developers can import into their Node.js applications. It provides sendPayment (with automatic diagnostics enrichment) and getFailures (to query payment history by time range).


7. Future Functionality

7.1 Upstream PR — Expose TlcErr in the RPC

The most impactful follow-up would be contributing a pull request to the nervosnetwork/fiber repository to change the SendPaymentResponse struct's failed_error field from Option String to Option TlcErr (the structured error with code and extra_data). This would eliminate the need for string parsing entirely and make the diagnostics available to all Fiber developers natively. The proxy would then become a thin UI layer rather than a parser.

7.2 Visual Route Tracing

With access to the network graph (graph_nodes + graph_channels), the dashboard could render an interactive network topology map showing the attempted payment route as a highlighted path, the failing hop marked in red, channel capacities and balance ratios along the path, and alternative routes that could have succeeded.

7.3 Pre-Flight Route Simulation

Before sending a real payment, the SDK could simulate the route using locally cached graph data. A developer would call simulatePayment with a destination and amount, and receive back a success probability, the bottleneck hop, and the reason for the bottleneck.

7.4 Automated Retry with Smart Exclusion

When a payment fails with a retryable error, the SDK could automatically exclude the failing channel or node, recalculate the route, retry the payment, and return the final result to the developer.

7.5 Cross-Chain Diagnostics (Fiber to Lightning)

When a payment crosses from Fiber to the Bitcoin Lightning Network via a Cross-Chain Hub, failures become even harder to debug because the error could originate on either chain. Future versions could correlate errors across both networks.

7.6 Alerting and Webhooks

Node operators could configure alerts (Slack, Discord, email) when a specific node exceeds a failure threshold, a channel's success rate drops below a configured percentage, or a new error code appears that has not been seen before.


Summary:

What: Diagnostic middleware + dashboard for Fiber payment routing errors
Why: Rich error data exists inside Fiber but is flattened to a string at the RPC boundary
How: RPC proxy parses flat errors into structured diagnostics, stores history, renders a dashboard
Stack: TypeScript, Node.js, SQLite, HTML/CSS/JS
Fiber integration: Wraps FNN JSON-RPC, uses @ckb-ccc/fiber SDK, references fiber-scripts
Hackathon scope: Proxy + parser + dashboard + SDK
Future: Upstream PR to expose TlcErr natively, route visualization, pre-flight simulation
