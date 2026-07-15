const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

const PROJECT_DIR = path.resolve(__dirname, "..");
const BIN_DIR = path.join(PROJECT_DIR, "bin");
const FNN_BIN = path.join(BIN_DIR, "fnn");

// 3-Node Configurations: A -> B -> D (Success Scenario)
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
    const data = JSON.stringify({ id: 1, jsonrpc: "2.0", method, params });
    const options = {
      hostname: "127.0.0.1", port, path: "/", method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": data.length }
    };
    const req = http.request(options, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try { resolve(JSON.parse(body)); }
        catch (err) { reject(new Error(`Failed to parse: ${body}`)); }
      });
    });
    req.on("error", (err) => reject(err));
    req.write(data);
    req.end();
  });
}

async function run() {
  console.log("===============================================================================");
  console.log("             REAL FNN MULTI-HOP TESTNET PAYMENT ROUTING (A -> B -> D)          ");
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

  // 1. Setup configurations for all 3 nodes
  const templateConfigPath = path.join(BIN_DIR, "config", "testnet", "config.yml");
  const templateContent = fs.readFileSync(templateConfigPath, "utf-8");

  for (const name of ["A", "B", "D"]) {
    const nodeConf = nodes[name];
    const nodeDir = path.join(BIN_DIR, `testnet_node_${name.toLowerCase()}`);
    fs.mkdirSync(path.join(nodeDir, "ckb"), { recursive: true });

    let configYml = templateContent
      .replace('listening_addr: "/ip4/0.0.0.0/tcp/8228"', `listening_addr: "/ip4/127.0.0.1/tcp/${nodeConf.p2p}"`)
      .replace('listening_addr: "127.0.0.1:8227"', `listening_addr: "127.0.0.1:${nodeConf.rpc}"`);

    fs.writeFileSync(path.join(nodeDir, "config.yml"), configYml, "utf-8");
    fs.writeFileSync(path.join(nodeDir, "ckb/key"), nodeConf.key, "utf-8");
    console.log(`[*] Setup directories and configurations for Node ${name}.`);
  }

  // 2. Start all 3 nodes
  console.log("\n[1/6] Starting FNN Node A, B, and D processes...");
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

    const prefixLogs = (data, prefix) => {
      const lines = data.toString().trim().split("\n");
      for (const line of lines) { if (line) console.log(`[Node ${prefix}] ${line}`); }
    };
    proc.stdout.on("data", (data) => prefixLogs(data, name));
    proc.stderr.on("data", (data) => prefixLogs(data, name));
    spawnedProcesses.push(proc);
  }

  // 3. Wait for RPC servers to initialize
  console.log("[2/6] Waiting for JSON-RPC servers to initialize...");
  const status = { A: false, B: false, D: false };
  for (let i = 0; i < 15; i++) {
    await delay(1000);
    for (const name of ["A", "B", "D"]) {
      if (!status[name]) {
        try {
          const res = await callRpc(nodes[name].rpc, "node_info");
          if (res.result) { status[name] = res.result; }
        } catch (e) { }
      }
    }
    if (Object.values(status).every(s => s !== false)) break;
  }

  if (!Object.values(status).every(s => s !== false)) {
    console.error("❌ Could not connect to all FNN JSON-RPC ports. Exiting.");
    shutdown();
  }

  console.log("\nAll nodes successfully running on CKB Testnet!");
  for (const name of ["A", "B", "D"]) {
    console.log(`- Node ${name} Pubkey: ${status[name].pubkey}`);
    console.log(`  Address: ${nodes[name].addr}`);
  }

  // 4. Establish P2P Connections: A -> B, B -> D
  console.log("\n[3/6] Establishing peer connections: A -> B, B -> D...");
  await callRpc(nodes.A.rpc, "connect_peer", [{ address: `/ip4/127.0.0.1/tcp/${nodes.B.p2p}`, pubkey: status.B.pubkey }]);
  await callRpc(nodes.B.rpc, "connect_peer", [{ address: `/ip4/127.0.0.1/tcp/${nodes.D.p2p}`, pubkey: status.D.pubkey }]);

  console.log("Waiting 3 seconds for P2P initialization handshakes...");
  await delay(3000);

  const fundingAmount = "0x2e90edd000"; // 2,000 CKB

  // 5. Open Channel A-B
  console.log("\n[4/6] Checking/Requesting channel A-B...");
  let chsA = await callRpc(nodes.A.rpc, "list_channels", [{}]);
  let activeChanAB = chsA.result?.channels?.find(c => c.pubkey === status.B.pubkey && c.state.state_name === "ChannelReady");

  if (activeChanAB) {
    console.log("✅ Channel A-B is already active and ChannelReady. Skipping channel open.");
  } else {
    console.log("- Opening channel A -> B...");
    const openAB = await callRpc(nodes.A.rpc, "open_channel", [{ pubkey: status.B.pubkey, funding_amount: fundingAmount, public: true }]);
    if (openAB.error) { console.error("❌ A-B Open Failed:", JSON.stringify(openAB.error)); shutdown(); }
    console.log(`- A-B Temp Channel ID: ${openAB.result.temporary_channel_id}`);

    console.log("\n[5/6] Waiting for channel A-B to confirm on CKB Testnet (Awaiting blocks)...");
    let abReady = false;
    for (let loop = 0; loop < 100; loop++) {
      await delay(5000);
      try {
        const chsACheck = await callRpc(nodes.A.rpc, "list_channels", [{}]);
        const stateA = chsACheck.result?.channels?.find(c => c.pubkey === status.B.pubkey)?.state.state_name || "Unknown";
        console.log(`- A-B state: ${stateA}`);
        if (stateA === "ChannelReady") { abReady = true; break; }
      } catch (e) { }
    }
    if (!abReady) { console.error("❌ Channel A-B timed out waiting for confirmation."); shutdown(); }
  }

  // 6. Open Channel B-D
  console.log("\n[5/6] Checking/Requesting channel B-D...");
  let chsB = await callRpc(nodes.B.rpc, "list_channels", [{}]);
  let activeChanBD = chsB.result?.channels?.find(c => c.pubkey === status.D.pubkey && c.state.state_name === "ChannelReady");

  if (activeChanBD) {
    console.log("✅ Channel B-D is already active and ChannelReady. Skipping channel open.");
  } else {
    console.log("- Opening channel B -> D...");
    const openBD = await callRpc(nodes.B.rpc, "open_channel", [{ pubkey: status.D.pubkey, funding_amount: fundingAmount, public: true }]);
    if (openBD.error) { console.error("❌ B-D Open Failed:", JSON.stringify(openBD.error)); shutdown(); }
    console.log(`- B-D Temp Channel ID: ${openBD.result.temporary_channel_id}`);

    console.log("Waiting for channel B-D to confirm on CKB Testnet (Awaiting blocks)...");
    let bdReady = false;
    for (let loop = 0; loop < 100; loop++) {
      await delay(5000);
      try {
        const chsBCheck = await callRpc(nodes.B.rpc, "list_channels", [{}]);
        const stateB = chsBCheck.result?.channels?.find(c => c.pubkey === status.D.pubkey)?.state.state_name || "Unknown";
        console.log(`- B-D state: ${stateB}`);
        if (stateB === "ChannelReady") { bdReady = true; break; }
      } catch (e) { }
    }
    if (!bdReady) { console.error("❌ Channel B-D timed out waiting for confirmation."); shutdown(); }
  }

  // 7. Node D generates an invoice and Node A pays it
  // Wait for gossip propagation so Node A learns the new B-D channel
  console.log("\n[Gossip Sync] Waiting 60 seconds for channel announcements to propagate across nodes...");
  await delay(60000);

  console.log("\n[6/6] Node D generating a 0.24 CKB invoice...");
  const invoice = await callRpc(nodes.D.rpc, "new_invoice", [{
    amount: "0x174876e", // 0.24 CKB in Shannons
    currency: "Fibt",
    description: "Successful Testnet Multi-Hop payment A-B-D"
  }]);

  const invoiceAddress = invoice.result.invoice_address;
  console.log(`Invoice address generated: ${invoiceAddress}`);

  console.log("\n[7/7] Executing payment from Node A to Node D off-chain (via Proxy on port 9227)...");
  const paymentResult = await callRpc(9227, "send_payment", [{ invoice: invoiceAddress }]);

  console.log(`\n=================== PAYMENT ROUTING RESPONSE ===================`);
  console.log(JSON.stringify(paymentResult.result || paymentResult.error, null, 2));
  console.log(`================================================================\n`);

  console.log("Leaving nodes running. Press Ctrl+C to terminate.");
}

run();
