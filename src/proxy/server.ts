import express from "express";
import http from "http";
import path from "path";
import axios from "axios";
import { initDb, savePayment, updatePaymentStatus, saveHops, getPaymentWithHops, getAllPayments } from "./db";
import { initWebSocketServer, broadcastPaymentUpdate } from "./ws";
import { parseFnnError } from "./parser";

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "../dashboard")));

const PROXY_PORT = process.env.PROXY_PORT ? parseInt(process.env.PROXY_PORT) : 9227;
const FNN_RPC_URL = process.env.FNN_RPC_URL || "http://127.0.0.1:8227";

// Global cache for payer node ID
let payerNodeId = "Payer (Self)";

// Decode CKB invoice amount from Bech32 prefix
function extractAmountFromInvoice(invoice: string): number {
  const match = invoice.match(/^(fibt|fibd|fib)(\d+)1/i);
  if (match) {
    const shannons = parseFloat(match[2]);
    return shannons / 1e8;
  }
  return 0;
}

// Fetch local Node ID from FNN node_info RPC
async function fetchPayerNodeId() {
  try {
    const res = await axios.post(FNN_RPC_URL, {
      jsonrpc: "2.0",
      id: 1,
      method: "node_info",
      params: []
    });
    if (res.data?.result?.node_id) {
      payerNodeId = res.data.result.node_id;
      console.log(`[Proxy] Fetched local payer node ID dynamically: ${payerNodeId}`);
    }
  } catch (err: any) {
    console.warn(`[Proxy] node_info RPC query failed. Fallback: "Payer (Self)". Error: ${err.message}`);
  }
}

// Decode invoice using FNN decode_invoice RPC to fetch payee pubkey
async function fetchRecipientNodeId(invoice: string): Promise<string> {
  try {
    const res = await axios.post(FNN_RPC_URL, {
      jsonrpc: "2.0",
      id: 1,
      method: "decode_invoice",
      params: [{ invoice }]
    });
    if (res.data?.result?.payee_pubkey) {
      return res.data.result.payee_pubkey;
    }
  } catch (err: any) {
    console.warn(`[Proxy] decode_invoice RPC query failed. Fallback: "Recipient". Error: ${err.message}`);
  }
  return "Recipient";
}

// Dynamically construct path hops using the node's channel topology
async function getDynamicHops(recipientId: string, failingNodeId?: string): Promise<string[]> {
  const pathList: string[] = [payerNodeId];

  try {
    const res = await axios.post(FNN_RPC_URL, {
      jsonrpc: "2.0",
      id: 1,
      method: "list_channels",
      params: [{}]
    });

    const channels = res.data?.result?.channels || [];
    
    // 1. Direct channel path
    const directChannel = channels.find((c: any) => c.pubkey === recipientId);
    if (directChannel) {
      pathList.push(recipientId);
      return pathList;
    }

    // 2. Intermediate channel path
    if (channels.length > 0) {
      const peerId = channels[0].pubkey;
      pathList.push(peerId);

      // If we have a downstream failing node, place it in the path (e.g. Node C)
      if (failingNodeId && failingNodeId !== payerNodeId && failingNodeId !== recipientId && failingNodeId !== peerId) {
        pathList.push(failingNodeId);
      }

      pathList.push(recipientId);
      return pathList;
    }
  } catch (err: any) {
    console.warn(`[Proxy] list_channels RPC query failed: ${err.message}`);
  }

  // 3. Fallback: using the parsed failing node if channels query failed
  if (failingNodeId && failingNodeId !== payerNodeId && failingNodeId !== recipientId) {
    pathList.push(failingNodeId);
  }
  pathList.push(recipientId);
  return pathList;
}

// Background poller for pending payments
async function startPaymentPoller(paymentHash: string, invoiceAddress: string, amountCkb: number) {
  let attempts = 0;
  const maxAttempts = 45; // 90 seconds total (45 * 2s)
  console.log(`[Poller] Starting background polling for payment hash: ${paymentHash}`);

  // Fetch recipient pubkey dynamically on startup
  const recipientId = await fetchRecipientNodeId(invoiceAddress);

  const interval = setInterval(async () => {
    attempts++;
    try {
      const response = await axios.post(FNN_RPC_URL, {
        id: 1,
        jsonrpc: "2.0",
        method: "get_payment",
        params: [{ payment_hash: paymentHash }]
      });

      const payment = response.data?.result;
      if (!payment) {
        console.warn(`[Poller] get_payment returned no result for ${paymentHash}`);
        return;
      }

      const status = payment.status;
      console.log(`[Poller] Hash: ${paymentHash} (Attempt ${attempts}/${maxAttempts}) Status: ${status}`);

      if (status === "Success") {
        clearInterval(interval);
        const feeShannons = payment.fee ? parseInt(payment.fee, 16) : 0;
        const feeCkb = feeShannons / 1e8;

        updatePaymentStatus(paymentHash, "Success", { feeCkb });

        // Build dynamic success path
        const hopsPath = await getDynamicHops(recipientId);
        const successHops = hopsPath.map((nodeId, idx) => ({
          hop_index: idx,
          node_pubkey: nodeId,
          status: "Success" as const
        }));
        saveHops(paymentHash, successHops);

        const updated = getPaymentWithHops(paymentHash);
        broadcastPaymentUpdate(updated);
        console.log(`[Poller] Payment ${paymentHash} settled successfully.`);
      } else if (status === "Failed") {
        clearInterval(interval);
        const rawError = payment.failed_error || "Unknown background routing failure";
        
        // Fetch dynamic path hops
        const failingNodeMatch = rawError.match(/failing node:\s*([a-fA-F0-9]+)/i);
        const failingNodeId = failingNodeMatch ? failingNodeMatch[1] : undefined;
        const hopsPath = await getDynamicHops(recipientId, failingNodeId);
        const diagnostic = parseFnnError(rawError, hopsPath);

        updatePaymentStatus(paymentHash, "Failed", {
          errorRaw: rawError,
          errorCode: diagnostic.code,
          diagnosticMsg: diagnostic.suggestion
        });

        // Save failing hops based on dynamic path matching
        const failHops = hopsPath.map((nodeId, idx) => {
          let hopStatus: "Success" | "Failed" | "Untracked" = "Success";
          if (diagnostic.failing_node_pubkey && diagnostic.failing_node_pubkey.toLowerCase() === nodeId.toLowerCase()) {
            hopStatus = "Failed";
          } else if (diagnostic.failing_hop_index === idx) {
            hopStatus = "Failed";
          } else if (
            (diagnostic.failing_hop_index !== undefined && idx > diagnostic.failing_hop_index) ||
            (diagnostic.failing_node_pubkey && idx > hopsPath.findIndex(h => h.toLowerCase() === diagnostic.failing_node_pubkey!.toLowerCase()))
          ) {
            hopStatus = "Untracked";
          } else if (!diagnostic.failing_node_pubkey && diagnostic.failing_hop_index === undefined) {
            // General failure fallback
            hopStatus = idx === 0 ? "Failed" : "Untracked";
          }
          return {
            hop_index: idx,
            node_pubkey: nodeId,
            status: hopStatus
          };
        });
        saveHops(paymentHash, failHops);

        const updated = getPaymentWithHops(paymentHash);
        broadcastPaymentUpdate(updated);
        console.log(`[Poller] Payment ${paymentHash} marked as Failed: ${diagnostic.code}`);
      }
    } catch (err: any) {
      console.error(`[Poller] Connection error during polling:`, err.message);
    }

    if (attempts >= maxAttempts) {
      clearInterval(interval);
      console.warn(`[Poller] Payment ${paymentHash} timed out in background.`);
      updatePaymentStatus(paymentHash, "Failed", {
        errorRaw: "RouteSearchTimeout",
        errorCode: "RouteSearchTimeout",
        diagnosticMsg: "The routing engine took too long to find an active path. This indicates downstream channel congestion or that the destination node is currently offline."
      });

      // Save untracked timeout hops dynamically
      const hopsPath = await getDynamicHops(recipientId);
      const timeoutHops = hopsPath.map((nodeId, idx) => ({
        hop_index: idx,
        node_pubkey: nodeId,
        status: idx === 0 ? ("Success" as const) : ("Untracked" as const)
      }));
      saveHops(paymentHash, timeoutHops);

      const updated = getPaymentWithHops(paymentHash);
      broadcastPaymentUpdate(updated);
    }
  }, 2000);
}

// REST endpoints for the visual dashboard UI
app.get("/api/payments", (req, res) => {
  try {
    const list = getAllPayments();
    res.json(list);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/payments/:hash", (req, res) => {
  try {
    const record = getPaymentWithHops(req.params.hash);
    if (!record) {
      return res.status(404).json({ error: "Payment not found" });
    }
    res.json(record);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// JSON-RPC Interceptor POST route
app.post("/", async (req, res) => {
  const { method, params, id } = req.body;

  console.log(`[RPC Proxy] Intercepted method: ${method}`);

  try {
    // Forward the request to FNN Node
    const fnnResponse = await axios.post(FNN_RPC_URL, req.body);
    const resultData = fnnResponse.data;

    // Intercept send_payment
    if (method === "send_payment" && params && params[0]) {
      const invoiceAddress = params[0].invoice;
      const amountCkb = extractAmountFromInvoice(invoiceAddress);

      if (resultData.error) {
        // Synchronous send_payment failure (Scenario 1)
        const rawError = resultData.error.message || JSON.stringify(resultData.error);
        
        // Dynamically build path hops
        const recipientId = await fetchRecipientNodeId(invoiceAddress);
        const failingNodeMatch = rawError.match(/failing node:\s*([a-fA-F0-9]+)/i);
        const failingNodeId = failingNodeMatch ? failingNodeMatch[1] : undefined;
        const hopsPath = await getDynamicHops(recipientId, failingNodeId);
        const diagnostic = parseFnnError(rawError, hopsPath);

        const paymentHash = `error_sync_${Date.now()}`;
        savePayment({
          payment_hash: paymentHash,
          invoice_address: invoiceAddress,
          amount_ckb: amountCkb
        });
        updatePaymentStatus(paymentHash, "Failed", {
          errorRaw: rawError,
          errorCode: diagnostic.code,
          diagnosticMsg: diagnostic.suggestion
        });

        // Save failure hops dynamically
        const failHops = hopsPath.map((nodeId, idx) => ({
          hop_index: idx,
          node_pubkey: nodeId,
          status: idx === 0 ? ("Failed" as const) : ("Untracked" as const)
        }));
        saveHops(paymentHash, failHops);

        // Enrich the RPC response error payload with diagnostics info
        resultData.error.data = {
          diagnostics: diagnostic
        };

        const updated = getPaymentWithHops(paymentHash);
        broadcastPaymentUpdate(updated);
      } else if (resultData.result) {
        // Asynchronous send_payment accepted (Scenario 2)
        const paymentHash = resultData.result.payment_hash;
        
        savePayment({
          payment_hash: paymentHash,
          invoice_address: invoiceAddress,
          amount_ckb: amountCkb
        });

        // Start background polling
        startPaymentPoller(paymentHash, invoiceAddress, amountCkb);

        const updated = getPaymentWithHops(paymentHash);
        broadcastPaymentUpdate(updated);
      }
    }

    res.json(resultData);
  } catch (err: any) {
    console.error(`[RPC Proxy] Forwarding error:`, err.message);
    res.status(500).json({
      jsonrpc: "2.0",
      id: id || 1,
      error: {
        code: -32603,
        message: `RPC Proxy failed to communicate with FNN node: ${err.message}`
      }
    });
  }
});

// Boot the server
const server = http.createServer(app);

// Initialize DB and WS Broadcast server
initDb();
initWebSocketServer(server);

server.listen(PROXY_PORT, async () => {
  console.log(`=======================================================`);
  console.log(`🚀 Fiber Route Diagnostics Proxy running on port ${PROXY_PORT}`);
  console.log(`📡 Forwarding to FNN Node at ${FNN_RPC_URL}`);
  console.log(`=======================================================`);
  
  // Dynamic payer node identification fetch on start
  await fetchPayerNodeId();
});
