const axios = require("axios");

const PROXY_URL = process.env.PROXY_URL || "http://127.0.0.1:9227";
const FNN_URL = process.env.FNN_RPC_URL || "http://127.0.0.1:8227";

async function callRpc(url, method, params = []) {
  try {
    const res = await axios.post(url, {
      jsonrpc: "2.0",
      id: 1,
      method,
      params,
    });
    return res.data;
  } catch (err) {
    return { error: err.message };
  }
}

async function probe() {
  console.log("=======================================================");
  console.log("🔍 FIBER RPC SHAPE PROBE SCRIPT (FNN v0.8.1)");
  console.log("=======================================================\n");

  console.log("--- 1. Testing node_info ---");
  const nodeInfo = await callRpc(FNN_URL, "node_info");
  console.log(JSON.stringify(nodeInfo, null, 2));

  console.log("\n--- 2. Testing list_channels ---");
  const listChannels = await callRpc(FNN_URL, "list_channels", [{}]);
  console.log(JSON.stringify(listChannels, null, 2));

  console.log("\n--- 3. Testing list_peers ---");
  const listPeers = await callRpc(FNN_URL, "list_peers");
  console.log(JSON.stringify(listPeers, null, 2));

  console.log("\n--- 4. Testing graph_nodes ---");
  const graphNodes = await callRpc(FNN_URL, "graph_nodes", [{}]);
  console.log(JSON.stringify(graphNodes, null, 2));

  console.log("\n--- 5. Testing graph_channels ---");
  const graphChannels = await callRpc(FNN_URL, "graph_channels", [{}]);
  console.log(JSON.stringify(graphChannels, null, 2));
}

probe();
