const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

const PROJECT_DIR = path.resolve(__dirname, "..");
const BIN_DIR = path.join(PROJECT_DIR, "bin");
const FNN_BIN = path.join(BIN_DIR, "fnn");

const nodes = {
  A: { rpc: 8227, p2p: 8228, key: "8c3f8a6a6847a31af93000a31629f0c674e0cbb1b7cb71bdfbf4fb9dd828a518", addr: "ckt1qzda0cr08m85hc8jlnfp3zer7xulejywt49kt2rr0vthywaa50xwsq0kegwq3fq2k0gqug5ejvx0p7xznzs6jrg890q3w" },
  B: { rpc: 8327, p2p: 8328, key: "11e34fc1bad213b1ce3071501a18c39e5dbf1ea2e66ac05059c36a5d1e7a56cf", addr: "ckt1qzda0cr08m85hc8jlnfp3zer7xulejywt49kt2rr0vthywaa50xwsq2uhqycsfpjnsazuuckgxhyay96pglv89svgrrcn" },
  D: { rpc: 8527, p2p: 8528, key: "006250e940dbce94ad9329ac16c109acf7de98c7e4738013bdd3105d4f004d8a", addr: "ckt1qzda0cr08m85hc8jlnfp3zer7xulejywt49kt2rr0vthywaa50xwsqt6svzzmk47kfefflnztzxl0txxyl2ps8cyvd734" }
};

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function callRpc(port, method, params = []) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      id: 1,
      jsonrpc: "2.0",
      method: method,
      params: params
    });

    const options = {
      hostname: "127.0.0.1",
      port: port,
      path: "/",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": data.length
      }
    };

    const req = http.request(options, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(new Error(`Failed to parse: ${body}`));
        }
      });
    });

    req.on("error", (err) => reject(err));
    req.write(data);
    req.end();
  });
}

async function run() {
  console.log("===============================================================================");
  console.log("             TRIGGERING MULTI-HOP PAYMENT ROUTING FAILURES ON TESTNET          ");
  console.log("===============================================================================");

  const spawnedProcesses = [];
  function shutdown() {
    console.log("\nShutting down all FNN node processes...");
    for (const proc of spawnedProcesses) {
      try { proc.kill("SIGINT"); } catch (e) { }
    }
    console.log("Done. Terminating.");
    process.exit(0);
  }
  process.on("SIGINT", shutdown);

  // 1. Boot the FNN nodes A, B, D
  console.log("[1/5] Booting FNN Node A, B, and D processes...");
  const env = { ...process.env, FIBER_SECRET_KEY_PASSWORD: "test_rpc_password", RUST_LOG: "info" };

  for (const name of ["A", "B", "D"]) {
    const nodeConf = nodes[name];
    const nodeDir = path.join(BIN_DIR, `testnet_node_${name.toLowerCase()}`);
    const proc = spawn(FNN_BIN, [
      "-c", path.join(nodeDir, "config.yml"),
      "-d", nodeDir,
      "-s", "ckb,fiber,rpc",
      "--ckb-node-rpc-url", "https://testnet.ckbapp.dev/",
      "--rpc-listening-addr", `127.0.0.1:${nodeConf.rpc}`
    ], { env, cwd: nodeDir });

    spawnedProcesses.push(proc);
  }

  // 2. Wait for RPC connections
  console.log("[2/5] Connecting to JSON-RPC servers...");
  const status = { A: false, B: false, D: false };
  for (let i = 0; i < 15; i++) {
    await delay(1000);
    for (const name of ["A", "B", "D"]) {
      if (!status[name]) {
        try {
          const res = await callRpc(nodes[name].rpc, "node_info");
          if (res.result) status[name] = res.result;
        } catch (e) { }
      }
    }
    if (status.A && status.B && status.D) break;
  }

  if (!status.A || !status.B || !status.D) {
    console.error("❌ Could not connect to FNN RPC nodes.");
    shutdown();
  }

  // Connect peers: A -> B, B -> D
  console.log("Establishing peer connections: A -> B, B -> D...");
  await callRpc(nodes.A.rpc, "connect_peer", [{ address: `/ip4/127.0.0.1/tcp/${nodes.B.p2p}`, pubkey: status.B.pubkey }]);
  await callRpc(nodes.B.rpc, "connect_peer", [{ address: `/ip4/127.0.0.1/tcp/${nodes.D.p2p}`, pubkey: status.D.pubkey }]);
  await delay(3000);

  // 3. Print Channel capacities and auto-open B-D if closed
  console.log("\n[3/5] Inspecting active channel capacities...");
  let chsA = await callRpc(nodes.A.rpc, "list_channels", [{}]);
  let chsB = await callRpc(nodes.B.rpc, "list_channels", [{}]);

  let chanAB = chsA.result?.channels?.find(c => c.pubkey === status.B.pubkey && c.state.state_name === "ChannelReady");
  let chanBD = chsB.result?.channels?.find(c => c.pubkey === status.D.pubkey && c.state.state_name === "ChannelReady");

  const fundingAmount = "0x2e90edd000"; // 2,000 CKB

  // Auto-open A-B if missing
  if (!chanAB) {
    console.log("- Channel A-B is closed/inactive. Initiating new channel request from Node A to Node B...");
    const openAB = await callRpc(nodes.A.rpc, "open_channel", [{ pubkey: status.B.pubkey, funding_amount: fundingAmount, public: true }]);
    if (openAB.error) {
      console.error("❌ Failed to open channel A-B:", JSON.stringify(openAB.error));
      shutdown();
    }
    console.log(`- Broadcasted Channel A-B Open (Temp ID: ${openAB.result.temporary_channel_id}). Awaiting blocks...`);

    let abReady = false;
    for (let loop = 0; loop < 100; loop++) {
      await delay(10000);
      try {
        const chsACheck = await callRpc(nodes.A.rpc, "list_channels", [{}]);
        const chanCheck = chsACheck.result?.channels?.find(c => c.pubkey === status.B.pubkey);
        const stateA = chanCheck?.state?.state_name || "Unknown";
        console.log(`- A-B state: ${stateA}`);
        if (stateA === "ChannelReady") {
          abReady = true;
          chanAB = chanCheck;
          break;
        }
      } catch (e) {
        console.log("Error querying channel A-B state:", e.message);
      }
    }

    if (!abReady) {
      console.error("❌ Channel A-B timed out waiting for L1 confirmation.");
      shutdown();
    }
  }

  // Auto-open B-D if missing
  if (!chanBD) {
    console.log("- Channel B-D is closed/inactive. Initiating new channel request from Node B to Node D...");
    const openBD = await callRpc(nodes.B.rpc, "open_channel", [{ pubkey: status.D.pubkey, funding_amount: fundingAmount, public: true }]);
    if (openBD.error) {
      console.error("❌ Failed to open channel B-D:", JSON.stringify(openBD.error));
      shutdown();
    }
    console.log(`- Broadcasted Channel B-D Open (Temp ID: ${openBD.result.temporary_channel_id}). Awaiting blocks...`);

    let bdReady = false;
    for (let loop = 0; loop < 100; loop++) {
      await delay(10000);
      try {
        const chsBCheck = await callRpc(nodes.B.rpc, "list_channels", [{}]);
        const chanCheck = chsBCheck.result?.channels?.find(c => c.pubkey === status.D.pubkey);
        const stateB = chanCheck?.state?.state_name || "Unknown";
        console.log(`- B-D state: ${stateB}`);
        if (stateB === "ChannelReady") {
          bdReady = true;
          chanBD = chanCheck;
          break;
        }
      } catch (e) {
        console.log("Error querying channel B-D state:", e.message);
      }
    }

    if (!bdReady) {
      console.error("❌ Channel B-D timed out waiting for L1 confirmation.");
      shutdown();
    }
  }

  const capAB = parseInt(chanAB.local_balance) / 1e8;
  const capBD = parseInt(chanBD.local_balance) / 1e8;

  console.log(`- Channel A-B local capacity: ${capAB} CKB`);
  console.log(`- Channel B-D local capacity: ${capBD} CKB`);

  // 4. Scenario 1: Exceeding Payer's Balance (1,500 CKB payment when capacity is ~899 CKB)
  console.log("\n[4/5] Scenario 1: Sending payment exceeding Node A's local capacity (1,500 CKB)...");

  console.log("- Generating invoice for 1,500 CKB on Node D...");
  const inv1 = await callRpc(nodes.D.rpc, "new_invoice", [{
    amount: "0x22ecb25c00", // 1,500 CKB in Shannons
    currency: "Fibt",
    description: "Failure Scenario 1: Exceeding capacity"
  }]);

  const invoiceAddr1 = inv1.result.invoice_address;
  console.log(`- Invoice generated: ${invoiceAddr1}`);

  console.log("- Node A calling send_payment (via Proxy on port 9227)...");
  const payResult1 = await callRpc(9227, "send_payment", [{ invoice: invoiceAddr1 }]);

  console.log(`\n=================== RAW RPC RESPONSE (SCENARIO 1) ===================`);
  console.log(JSON.stringify(payResult1.error || payResult1.result, null, 2));
  console.log(`======================================================================\n`);

  // 5. Scenario 2: Exceeding Route Capacity (950 CKB payment when capacity A-B is 899 CKB)
  console.log("[5/5] Scenario 2: Sending payment exceeding path capacity (950 CKB)...");

  console.log("- Generating invoice for 950 CKB on Node D...");
  const inv2 = await callRpc(nodes.D.rpc, "new_invoice", [{
    amount: "0x161a0b5c00", // 950 CKB in Shannons
    currency: "Fibt",
    description: "Failure Scenario 2: Exceeding hop capacity"
  }]);

  const invoiceAddr2 = inv2.result.invoice_address;
  console.log(`- Invoice generated: ${invoiceAddr2}`);

  console.log("- Node A calling send_payment (via Proxy on port 9227)...");
  const payResult2 = await callRpc(9227, "send_payment", [{ invoice: invoiceAddr2 }]);

  console.log(`\n=================== RAW RPC RESPONSE (SCENARIO 2) ===================`);
  console.log(JSON.stringify(payResult2.error || payResult2.result, null, 2));
  console.log(`======================================================================\n`);

  console.log("\n[*] Waiting 15 seconds for the Proxy Server to poll background payment status...");
  await delay(15000);

  shutdown();
}

run();
