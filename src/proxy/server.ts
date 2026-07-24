import express from "express";
import http from "http";
import path from "path";
import { initDb, savePayment, updatePaymentStatus, saveHops, getPaymentWithHops, getAllPayments } from "./db";
import { initWebSocketServer, broadcastPaymentUpdate, broadcastRaw } from "./ws";
import { computePaymentStats } from "./stats";
import { parseFnnError } from "./parser";
import { createFnnClient } from "./fnnClient";
import { extractAmountFromInvoice, buildApproximateHops } from "./routing";
import { refreshNodeAliases } from "./nodeRegistry";
import { getAllNodeAliases } from "./db";
import { generateProbeHash, runProbe } from "./prober";

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "../dashboard")));

const PROXY_PORT = process.env.PROXY_PORT ? parseInt(process.env.PROXY_PORT) : 9227;
const FNN_RPC_URL = process.env.FNN_RPC_URL || "http://127.0.0.1:8227";

const fnnClient = createFnnClient({ rpcUrl: FNN_RPC_URL });

// Global cache for payer node ID
let payerNodeId = "Payer (Self)";

// Fetch local Node ID from FNN node_info RPC
async function fetchPayerNodeId() {
  try {
    const result = await fnnClient.nodeInfo();
    if (result?.node_id) {
      payerNodeId = result.node_id;
      console.log(`[Proxy] Fetched local payer node ID dynamically: ${payerNodeId}`);
    }
  } catch (err: any) {
    console.warn(`[Proxy] node_info RPC query failed. Fallback: "Payer (Self)". Error: ${err.message}`);
  }
}

// Decode invoice using FNN decode_invoice RPC to fetch payee pubkey
async function fetchRecipientNodeId(invoice: string): Promise<string> {
  try {
    const result = await fnnClient.decodeInvoice(invoice);
    if (result?.payee_pubkey) return result.payee_pubkey;
  } catch (err: any) {
    console.warn(`[Proxy] decode_invoice RPC query failed. Fallback: "Recipient". Error: ${err.message}`);
  }
  return "Recipient";
}

// Dynamically construct path hops using the node's channel topology
async function getDynamicHops(recipientId: string, failingNodeId?: string): Promise<string[]> {
  try {
    const result = await fnnClient.listChannels({});
    const channels = result?.channels ?? [];
    return buildApproximateHops(payerNodeId, recipientId, channels, failingNodeId);
  } catch (err: any) {
    console.warn(`[Proxy] list_channels RPC query failed: ${err.message}`);
    return buildApproximateHops(payerNodeId, recipientId, [], failingNodeId);
  }
}

// Background poller for pending payments
async function startPaymentPoller(paymentHash: string, invoiceAddress: string, amountCkb: number) {
  let attempts = 0;
  const maxAttempts = 45; // 90 seconds total (45 * 2s)
  console.log(`[Poller] Starting background polling for payment hash: ${paymentHash}`);

  const recipientId = await fetchRecipientNodeId(invoiceAddress);

  const interval = setInterval(async () => {
    attempts++;
    try {
      const payment = await fnnClient.getPayment(paymentHash);
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

        const hopsPath = await getDynamicHops(recipientId);
        const successHops = hopsPath.map((nodeId, idx) => ({
          hop_index: idx,
          node_pubkey: nodeId,
          status: "Success" as const
        }));
        saveHops(paymentHash, successHops);

        broadcastPaymentAndStats(paymentHash);
        console.log(`[Poller] Payment ${paymentHash} settled successfully.`);
      } else if (status === "Failed") {
        clearInterval(interval);
        const rawError = payment.failed_error || "Unknown background routing failure";

        const failingNodeMatch = rawError.match(/failing node:\s*([a-fA-F0-9]+)/i);
        const failingNodeId = failingNodeMatch ? failingNodeMatch[1] : undefined;
        const hopsPath = await getDynamicHops(recipientId, failingNodeId);
        const diagnostic = parseFnnError(rawError, hopsPath);

        updatePaymentStatus(paymentHash, "Failed", {
          errorRaw: rawError,
          errorCode: diagnostic.code,
          diagnosticMsg: diagnostic.suggestion
        });

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
            hopStatus = idx === 0 ? "Failed" : "Untracked";
          }
          return { hop_index: idx, node_pubkey: nodeId, status: hopStatus };
        });
        saveHops(paymentHash, failHops);

        broadcastPaymentAndStats(paymentHash);
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

function broadcastPaymentAndStats(paymentHash: string): void {
  const updated = getPaymentWithHops(paymentHash);
  broadcastPaymentUpdate(updated);
  broadcastRaw("STATS_UPDATE", computePaymentStats(getAllPayments()));
}

// REST endpoints for the visual dashboard UI
app.get("/api/stats", (req, res) => {
  try {
    res.json(computePaymentStats(getAllPayments()));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/payments/dry-run", async (req, res) => {
  const { invoice } = req.body;
  if (!invoice) return res.status(400).json({ error: "invoice is required" });
  try {
    const result = await fnnClient.sendPayment({ invoice, dry_run: true });
    res.json({ success: true, route: result });
  } catch (err: any) {
    const msg: string = err.message ?? String(err);
    // If FNN does not support dry_run, return a clear 501 rather than crashing
    if (/unknown field|invalid param|unrecognized/i.test(msg)) {
      return res.status(501).json({
        success: false,
        error: "dry_run is not supported by this FNN version"
      });
    }
    const diagnostic = parseFnnError(msg);
    res.json({ success: false, error: msg, diagnostic });
  }
});

app.post("/api/payments/probe", async (req, res) => {
  const { invoice } = req.body;
  if (!invoice) return res.status(400).json({ error: "invoice is required" });
  try {
    const probeHash = generateProbeHash();
    const result = await runProbe(fnnClient, invoice, probeHash);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/nodes", (req, res) => {
  try {
    res.json(getAllNodeAliases());
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/payments", (req, res) => {
  try {
    res.json(getAllPayments());
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/payments/:hash", (req, res) => {
  try {
    const record = getPaymentWithHops(req.params.hash);
    if (!record) return res.status(404).json({ error: "Payment not found" });
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
    // Forward the request directly to FNN (preserve original body)
    const { default: axios } = await import("axios");
    const fnnResponse = await axios.post(FNN_RPC_URL, req.body);
    const resultData = fnnResponse.data;

    if (method === "send_payment" && params && params[0]) {
      const invoiceAddress = params[0].invoice;
      const amountCkb = extractAmountFromInvoice(invoiceAddress) / 1e8;

      if (resultData.error) {
        const rawError = resultData.error.message || JSON.stringify(resultData.error);

        const recipientId = await fetchRecipientNodeId(invoiceAddress);
        const failingNodeMatch = rawError.match(/failing node:\s*([a-fA-F0-9]+)/i);
        const failingNodeId = failingNodeMatch ? failingNodeMatch[1] : undefined;
        const hopsPath = await getDynamicHops(recipientId, failingNodeId);
        const diagnostic = parseFnnError(rawError, hopsPath);

        const paymentHash = `error_sync_${Date.now()}`;
        savePayment({ payment_hash: paymentHash, invoice_address: invoiceAddress, amount_ckb: amountCkb });
        updatePaymentStatus(paymentHash, "Failed", {
          errorRaw: rawError,
          errorCode: diagnostic.code,
          diagnosticMsg: diagnostic.suggestion
        });

        const failHops = hopsPath.map((nodeId, idx) => ({
          hop_index: idx,
          node_pubkey: nodeId,
          status: idx === 0 ? ("Failed" as const) : ("Untracked" as const)
        }));
        saveHops(paymentHash, failHops);

        resultData.error.data = { diagnostics: diagnostic };

        broadcastPaymentAndStats(paymentHash);
      } else if (resultData.result) {
        const paymentHash = resultData.result.payment_hash;
        savePayment({ payment_hash: paymentHash, invoice_address: invoiceAddress, amount_ckb: amountCkb });
        startPaymentPoller(paymentHash, invoiceAddress, amountCkb);
        broadcastPaymentAndStats(paymentHash);
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

initDb();
initWebSocketServer(server);

server.listen(PROXY_PORT, async () => {
  console.log(`=======================================================`);
  console.log(`🚀 Fiber Route Diagnostics Proxy running on port ${PROXY_PORT}`);
  console.log(`📡 Forwarding to FNN Node at ${FNN_RPC_URL}`);
  console.log(`=======================================================`);
  await fetchPayerNodeId();
  await refreshNodeAliases(fnnClient);
  broadcastRaw("NODE_ALIASES_UPDATED", getAllNodeAliases());
  // Refresh node aliases every 5 minutes
  setInterval(async () => {
    await refreshNodeAliases(fnnClient);
    broadcastRaw("NODE_ALIASES_UPDATED", getAllNodeAliases());
  }, 5 * 60 * 1000);
});
