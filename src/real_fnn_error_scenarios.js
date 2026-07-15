/**
 * real_fnn_error_scenarios.js
 *
 * Integration test script that boots FNN nodes A, B, D and triggers four distinct
 * Fiber Network routing error scenarios through the Fiber Route Diagnostics Proxy.
 *
 * Scenarios demonstrated:
 *   Scenario A: NoRouteFound       — Send to a node with no known route
 *   Scenario B: ExpiryTooSoon      — Use an invoice that has already expired
 *   Scenario C: HoldTlcTimeout     — Kill recipient node immediately after payment dispatch
 *   Scenario D: AmountBelowMinimum — Send 1 Shannon (below any hop's min forwarding amount)
 *
 * Prerequisites:
 *   - Fiber Route Diagnostics Proxy must be running: npm start
 *   - FNN binary must exist at: ./bin/fnn
 *   - testnet_node_a, testnet_node_b, testnet_node_d dirs must exist with config.yml
 */

const http = require("http");
const { spawn } = require("child_process");
const path = require("path");

const PROJECT_DIR = path.resolve(__dirname, "..");
const BIN_DIR = path.join(PROJECT_DIR, "bin");
const FNN_BIN = path.join(BIN_DIR, "fnn");
const PROXY_PORT = 9227;

const nodes = {
  A: { rpc: 8227, p2p: 8228 },
  B: { rpc: 8327, p2p: 8328 },
  D: { rpc: 8527, p2p: 8528 },
};

// ─────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function callRpc(port, method, params = []) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ id: 1, jsonrpc: "2.0", method, params });
    const options = {
      hostname: "127.0.0.1",
      port,
      path: "/",
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": data.length },
    };
    const req = http.request(options, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try { resolve(JSON.parse(body)); }
        catch { reject(new Error(`Parse error: ${body.slice(0, 200)}`)); }
      });
    });
    req.on("error", reject);
    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error(`Timeout calling ${method} on port ${port}`));
    });
    req.write(data);
    req.end();
  });
}

function printResponse(label, response) {
  console.log(`\n${"=".repeat(70)}`);
  console.log(`📋 ${label}`);
  console.log("=".repeat(70));
  const payload = response.error || response.result;
  console.log(JSON.stringify(payload, null, 2));
  console.log("=".repeat(70));
}

function printScenario(num, title, description) {
  console.log(`\n${"─".repeat(70)}`);
  console.log(`🔥 SCENARIO ${num}: ${title}`);
  console.log(`   ${description}`);
  console.log("─".repeat(70));
}

function spawnNode(name) {
  const nodeConf = nodes[name];
  const nodeDir = path.join(BIN_DIR, `testnet_node_${name.toLowerCase()}`);
  const env = { ...process.env, FIBER_SECRET_KEY_PASSWORD: "test_rpc_password", RUST_LOG: "info" };
  return spawn(FNN_BIN, [
    "-c", path.join(nodeDir, "config.yml"),
    "-d", nodeDir,
    "-s", "ckb,fiber,rpc",
    "--ckb-node-rpc-url", "https://testnet.ckbapp.dev/",
    "--rpc-listening-addr", `127.0.0.1:${nodeConf.rpc}`
  ], { env, cwd: nodeDir });
}

async function waitForNode(name, timeoutSecs = 20) {
  console.log(`[boot] Waiting for Node ${name} on port ${nodes[name].rpc}...`);
  for (let i = 0; i < timeoutSecs; i++) {
    await delay(1000);
    try {
      const res = await callRpc(nodes[name].rpc, "node_info");
      if (res.result) {
        console.log(`[boot] ✅ Node ${name} ready. Pubkey: ${res.result.pubkey.slice(0, 20)}...`);
        return res.result;
      }
    } catch { /* still starting */ }
  }
  throw new Error(`Node ${name} did not start within ${timeoutSecs}s`);
}

async function generateInvoice(nodeRpc, amountShannons, description, expirySecs = 3600) {
  const res = await callRpc(nodeRpc, "new_invoice", [{
    amount: "0x" + parseInt(amountShannons).toString(16),
    currency: "Fibt",
    description,
    expiry: "0x" + parseInt(expirySecs).toString(16),  // FNN requires hex for all uint fields
  }]);
  if (res.error) throw new Error(`new_invoice failed: ${JSON.stringify(res.error)}`);
  return res.result.invoice_address;
}

// ─────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────
async function run() {
  console.log("=".repeat(70));
  console.log("  FIBER ROUTE DIAGNOSTICS — ERROR SCENARIO INTEGRATION TESTS");
  console.log("=".repeat(70));

  // ── Step 1: Verify proxy is running ───────────────────
  let proxyRunning = false;
  try {
    await callRpc(PROXY_PORT, "node_info");
    proxyRunning = true;
  } catch { proxyRunning = false; }

  if (!proxyRunning) {
    // The proxy returns -32603 when FNN is down, but it is still UP.
    // Try a direct HTTP GET to /api/payments to confirm proxy is alive.
    proxyRunning = await new Promise((resolve) => {
      const req = http.request({ hostname: "127.0.0.1", port: PROXY_PORT, path: "/api/payments", method: "GET" },
        (res) => resolve(res.statusCode < 500));
      req.on("error", () => resolve(false));
      req.end();
    });
  }

  if (!proxyRunning) {
    console.error("❌ Fiber Route Diagnostics Proxy is NOT running on port 9227.");
    console.error("   Start it first: npm start");
    process.exit(1);
  }
  console.log("✅ Proxy is running on port 9227.");

  // ── Step 2: Boot FNN nodes A, B, D ───────────────────
  console.log("\n[boot] Starting FNN Node A, B, D...");
  const spawnedProcesses = [];

  function shutdown() {
    console.log("\n[shutdown] Killing all FNN node processes...");
    for (const proc of spawnedProcesses) {
      try { proc.kill("SIGINT"); } catch { }
    }
    console.log("[shutdown] Done.");
    process.exit(0);
  }
  process.on("SIGINT", shutdown);

  for (const name of ["A", "B", "D"]) {
    const proc = spawnNode(name);
    spawnedProcesses.push(proc);
  }

  let statusA, statusB, statusD;
  try {
    [statusA, statusB, statusD] = await Promise.all([
      waitForNode("A", 20),
      waitForNode("B", 20),
      waitForNode("D", 20),
    ]);
  } catch (err) {
    console.error("❌ Failed to start FNN nodes:", err.message);
    shutdown();
  }

  // ── Step 3: Connect peers A→B, B→D ──────────────────
  console.log("\n[peers] Connecting A→B and B→D...");
  try {
    await callRpc(nodes.A.rpc, "connect_peer", [{ address: `/ip4/127.0.0.1/tcp/${nodes.B.p2p}`, pubkey: statusB.pubkey }]);
    await callRpc(nodes.B.rpc, "connect_peer", [{ address: `/ip4/127.0.0.1/tcp/${nodes.D.p2p}`, pubkey: statusD.pubkey }]);
    console.log("[peers] ✅ Peer connections established.");
  } catch (err) {
    console.warn("[peers] ⚠️  Peer connect warning (may already be connected):", err.message);
  }
  await delay(3000);

  // ── Preflight: Check Node A's outbound channel balance ─────────
  let nodeAOutboundCkb = 0;
  try {
    const chsA = await callRpc(nodes.A.rpc, "list_channels", [{}]);
    const channels = chsA.result?.channels || [];
    const totalOutbound = channels.reduce((sum, c) => sum + parseInt(c.local_balance || "0", 10), 0);
    nodeAOutboundCkb = totalOutbound / 1e8;
    console.log(`\n[preflight] Node A total outbound capacity: ${nodeAOutboundCkb.toFixed(4)} CKB across ${channels.length} channel(s).`);
    if (nodeAOutboundCkb === 0) {
      console.warn("[preflight] ⚠️  Node A has 0 outbound balance. Scenarios A and D require funded channels.");
      console.warn("           These scenarios will produce InsufficientLocalBalance instead of the target error.");
      console.warn("           To rebalance: have Node D send a payment to Node A, or open a new channel.");
    }
  } catch (err) {
    console.warn("[preflight] Could not check Node A balance:", err.message);
  }

  // ══════════════════════════════════════════════════════════════
  // SCENARIO A: NoRouteFound
  // Approach: send a payment to a fresh invoice from Node D, but
  // with Node D forcefully disconnected from the gossip graph by
  // killing Node B (the only bridge). Fiber's route builder cannot
  // find a path from A to D without B.
  // ══════════════════════════════════════════════════════════════
  printScenario("A", "NoRouteFound", "Kill Node B (the bridge), then try to route from A to D.");

  if (nodeAOutboundCkb === 0) {
    console.warn("[A] ⚠️  SKIPPING: Node A has 0 outbound balance — cannot trigger NoRouteFound.");
    console.warn("[A]    Channels are drained. Rebalance Node A first, then re-run.");
  } else {

  console.log("[A.1] Generating invoice on Node D (0.01 CKB)...");
  let invoiceA;
  try {
    invoiceA = await generateInvoice(nodes.D.rpc, 1_000_000, "Scenario A: NoRouteFound");
    console.log(`[A.2] Invoice: ${invoiceA.slice(0, 55)}...`);
  } catch (err) {
    console.error("[A] ❌ Could not generate invoice:", err.message);
    invoiceA = null;
  }

  if (invoiceA) {
    // Kill Node B to break the A→B→D path
    console.log("[A.3] Killing Node B to break the routing path...");
    try { spawnedProcesses[1].kill("SIGINT"); } catch { }
    await delay(4000); // Wait for B to go offline and graph to propagate

    console.log("[A.4] Sending via Proxy (expecting NoRouteFound or TemporaryChannelFailure)...");
    const result = await callRpc(PROXY_PORT, "send_payment", [{ invoice: invoiceA }]);
    printResponse("Scenario A — NoRouteFound", result);

    // Restart Node B for subsequent scenarios
    console.log("[A.5] Restarting Node B for next scenarios...");
    const newProcB = spawnNode("B");
    spawnedProcesses[1] = newProcB;
    await waitForNode("B", 20).catch(() => console.warn("[A.5] Node B restart timed out."));
    await delay(3000);
  } // end invoiceA block
  } // end balance check block

  // ══════════════════════════════════════════════════════════════
  // SCENARIO B: ExpiryTooSoon
  // Generate a 1-second expiry invoice, wait 5s, then pay it.
  // FNN will reject the payment because the invoice timestamp has passed.
  // ══════════════════════════════════════════════════════════════
  printScenario("B", "ExpiryTooSoon", "Generate a 1-second expiry invoice, wait 5s, then send it.");

  console.log("[B.1] Generating invoice on Node D with 1-second expiry...");
  try {
    const invoiceB = await generateInvoice(
      nodes.D.rpc,
      24_414_062,  // ~0.24 CKB in Shannons
      "Scenario B: ExpiryTooSoon",
      "1"          // expires in 1 second
    );
    console.log(`[B.2] Invoice: ${invoiceB.slice(0, 55)}...`);
    console.log("[B.3] Waiting 5 seconds for invoice to expire...");
    await delay(5000);
    console.log("[B.4] Sending expired invoice via Proxy (expecting ExpiryTooSoon)...");
    const result = await callRpc(PROXY_PORT, "send_payment", [{ invoice: invoiceB }]);
    printResponse("Scenario B — ExpiryTooSoon", result);
  } catch (err) {
    console.error("[B] ❌ Scenario B failed:", err.message);
  }

  await delay(3000);

  // ══════════════════════════════════════════════════════════════
  // SCENARIO C: HoldTlcTimeout
  // Dispatch a payment to Node D, then immediately kill Node D.
  // The in-flight TLC has nobody to settle it — the proxy's
  // background poller marks it as HoldTlcTimeout after 90s.
  // NOTE: This is a long-running scenario. The dashboard will update
  // automatically when the proxy poller detects the timeout.
  // ══════════════════════════════════════════════════════════════
  printScenario("C", "HoldTlcTimeout", "Dispatch payment to Node D, then kill Node D before settlement.");

  console.log("[C.1] Generating invoice on Node D (0.24 CKB)...");
  try {
    const invoiceC = await generateInvoice(
      nodes.D.rpc,
      24_414_062,
      "Scenario C: HoldTlcTimeout"
    );
    console.log(`[C.2] Invoice: ${invoiceC.slice(0, 55)}...`);
    console.log("[C.3] Dispatching payment via Proxy (async — will NOT await result)...");

    // Fire-and-forget — intentionally NOT awaiting the payment result
    callRpc(PROXY_PORT, "send_payment", [{ invoice: invoiceC }]).catch(() => { });

    // Kill Node D 1 second after dispatch so the TLC is in-flight
    await delay(1000);
    console.log("[C.4] Killing Node D mid-payment to prevent TLC settlement...");
    try { spawnedProcesses[2].kill("SIGINT"); } catch { }

    console.log("[C.5] ✅ Node D killed. The proxy background poller will detect HoldTlcTimeout.");
    console.log("       → Dashboard at http://localhost:9228 will update automatically (~90s).");
  } catch (err) {
    console.error("[C] ❌ Scenario C failed:", err.message);
  }

  await delay(3000);

  // ══════════════════════════════════════════════════════════════
  // SCENARIO D: AmountBelowMinimum
  // Generate an invoice for 1 Shannon (smallest possible unit).
  // Restart Node D first since we killed it in Scenario C.
  // Fiber hop nodes reject forwarding amounts below their
  // configured htlc_minimum_value (typically 1000 shannons).
  // ══════════════════════════════════════════════════════════════
  printScenario("D", "AmountBelowMinimum", "Send 1 Shannon — below any hop's minimum HTLC forwarding amount.");

  console.log("[D.1] Restarting Node D (killed in Scenario C)...");
  const newProcD = spawnNode("D");
  spawnedProcesses[2] = newProcD;
  try {
    statusD = await waitForNode("D", 20);
    await callRpc(nodes.B.rpc, "connect_peer", [{ address: `/ip4/127.0.0.1/tcp/${nodes.D.p2p}`, pubkey: statusD.pubkey }]);
    await delay(3000);

    if (nodeAOutboundCkb === 0) {
      console.warn("[D] ⚠️  SKIPPING: Node A has 0 outbound balance — cannot trigger AmountBelowMinimum.");
      console.warn("[D]    The route builder fails before reaching the hop minimum check.");
      console.warn("[D]    Rebalance Node A first (or open a new funded channel), then re-run.");
    } else {
      console.log("[D.2] Generating invoice for 1 Shannon on Node D...");
      const invoiceD = await generateInvoice(
        nodes.D.rpc,
        1,      // 1 Shannon = 0.00000001 CKB
        "Scenario D: AmountBelowMinimum"
      );
      console.log(`[D.3] Invoice (1 Shannon): ${invoiceD.slice(0, 55)}...`);
      console.log("[D.4] Sending via Proxy (expecting AmountBelowMinimum or NoRouteFound)...");
      const result = await callRpc(PROXY_PORT, "send_payment", [{ invoice: invoiceD }]);
      printResponse("Scenario D — AmountBelowMinimum / Tiny Amount", result);
    }
  } catch (err) {
    console.error("[D] ❌ Scenario D failed:", err.message);
  }

  console.log("\n");
  console.log("=".repeat(70));
  console.log("✅ All synchronous error scenarios complete!");
  console.log(`📊 Dashboard: http://localhost:9228`);
  console.log("   Note: Scenario C (HoldTlcTimeout) resolves in ~90s on the dashboard.");
  console.log("=".repeat(70));
  console.log("\nPress Ctrl+C to shut down nodes.\n");
  // Keep alive so the Scenario C background poller can complete
}

run().catch((err) => {
  console.error("Unhandled error:", err.message);
  process.exit(1);
});
