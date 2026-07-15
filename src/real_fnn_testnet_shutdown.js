const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn, execSync } = require("child_process");

const PROJECT_DIR = path.resolve(__dirname, "..");
const BIN_DIR = path.join(PROJECT_DIR, "bin");
const FNN_BIN = path.join(BIN_DIR, "fnn");

const nodes = {
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

function getL1Balance(address) {
  try {
    const output = execSync(`offckb balance ${address} --network testnet`, { encoding: "utf-8" });
    const match = output.match(/Balance:\s*([0-9.]+)\s*CKB/);
    return match ? parseFloat(match[1]) : 0;
  } catch (e) {
    console.error("Error reading L1 balance:", e.message);
    return 0;
  }
}

async function run() {
  console.log("===============================================================================");
  console.log("             CLOSING FNN CHANNEL & SETTLING FUNDS TO LAYER 1                   ");
  console.log("===============================================================================");

  const spawnedProcesses = [];
  function shutdown() {
    console.log("\nShutting down FNN nodes...");
    for (const proc of spawnedProcesses) {
      try { proc.kill("SIGINT"); } catch (e) {}
    }
    console.log("Done.");
    process.exit(0);
  }
  process.on("SIGINT", shutdown);

  // 1. Start Node B and Node D
  console.log("[1/6] Booting Node B and Node D processes...");
  const env = { ...process.env, FIBER_SECRET_KEY_PASSWORD: "test_rpc_password", RUST_LOG: "info" };

  for (const name of ["B", "D"]) {
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
  console.log("[2/6] Connecting to JSON-RPC servers...");
  const status = { B: false, D: false };
  for (let i = 0; i < 15; i++) {
    await delay(1000);
    for (const name of ["B", "D"]) {
      if (!status[name]) {
        try {
          const res = await callRpc(nodes[name].rpc, "node_info");
          if (res.result) status[name] = res.result;
        } catch (e) {}
      }
    }
    if (status.B && status.D) break;
  }

  if (!status.B || !status.D) {
    console.error("❌ Could not connect to both FNN RPC nodes.");
    shutdown();
  }

  // Connect Node B and Node D first
  console.log("Connecting Node B to Node D...");
  await callRpc(nodes.B.rpc, "connect_peer", [{ address: `/ip4/127.0.0.1/tcp/${nodes.D.p2p}`, pubkey: status.D.pubkey }]);
  await delay(3000);

  // 3. Find B-D Channel ID
  console.log("[3/6] Fetching channel ID from Node D...");
  const channels = await callRpc(nodes.D.rpc, "list_channels", [{}]);
  const channel = channels.result?.channels?.find(c => c.pubkey === status.B.pubkey && parseInt(c.local_balance) > 0);

  if (!channel) {
    console.error("❌ No active channel with balance > 0 found between Node B and Node D.");
    shutdown();
  }

  const channelId = channel.channel_id;
  console.log(`Found active Channel ID: ${channelId}`);
  console.log(`Current L2 balances inside channel:`);
  console.log(`- Node B balance: ${parseFloat(parseInt(channel.remote_balance) / 1e8)} CKB`);
  console.log(`- Node D balance: ${parseFloat(parseInt(channel.local_balance) / 1e8)} CKB`);

  // 4. Print initial L1 balance of Node D
  const startL1Balance = getL1Balance(nodes.D.addr);
  console.log(`\n[4/6] Initial Node D L1 balance: ${startL1Balance} CKB`);

  // 5. Cooperative Close the channel
  console.log("\n[5/6] Requesting cooperative channel closing (shutdown_channel)...");
  const closeResult = await callRpc(nodes.D.rpc, "shutdown_channel", [{
    channel_id: channelId
  }]);

  if (closeResult.error) {
    console.error("❌ Cooperative Close request failed:", JSON.stringify(closeResult.error));
    shutdown();
  }

  console.log("Cooperative close transaction broadcast successfully!");

  // 6. Poll for mining confirmation and L1 balance change
  console.log("\n[6/6] Waiting for settlement transaction to mine on CKB Testnet (Awaiting blocks)...");
  let balanceSettled = false;
  for (let loop = 0; loop < 100; loop++) {
    await delay(10000); // Check every 10 seconds
    const currentBalance = getL1Balance(nodes.D.addr);
    console.log(`- Current Node D L1 Balance: ${currentBalance} CKB`);

    // Balance should increase by ~1,000 CKB
    if (currentBalance >= startL1Balance + 990) {
      balanceSettled = true;
      console.log(`\n✅ Settlement Successful!`);
      console.log(`- Starting Balance: ${startL1Balance} CKB`);
      console.log(`- Ending Balance:   ${currentBalance} CKB`);
      console.log(`- Net Increase:     +${currentBalance - startL1Balance} CKB`);
      break;
    }
  }

  if (!balanceSettled) {
    console.error("❌ Settlement timed out. Please check the L1 explorer status manually.");
  }

  shutdown();
}

run();
