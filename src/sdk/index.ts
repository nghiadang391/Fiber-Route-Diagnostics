import axios from "axios";

export interface DiagnosticInfo {
  code: string;
  suggestion: string;
  failing_hop_index?: number;
  failing_node_pubkey?: string;
}

export interface HopInfo {
  hop_index: number;
  node_pubkey: string;
  channel_outpoint?: string;
  status: "Success" | "Failed" | "Untracked";
}

export interface PaymentResult {
  payment_hash: string;
  invoice_address: string;
  amount_ckb: number;
  status: "Pending" | "Success" | "Failed";
  fee_ckb?: number;
  error_raw?: string;
  error_code?: string;
  diagnostic_msg?: string;
  created_at: number;
  hops?: HopInfo[];
}

export class FiberDiagError extends Error {
  public code: string;
  public suggestion: string;
  public failingHopIndex?: number;
  public failingNodePubkey?: string;
  public rawError: string;

  constructor(diag: DiagnosticInfo, rawError: string) {
    super(`Payment failed with code ${diag.code}: ${diag.suggestion}`);
    this.name = "FiberDiagError";
    this.code = diag.code;
    this.suggestion = diag.suggestion;
    this.failingHopIndex = diag.failing_hop_index;
    this.failingNodePubkey = diag.failing_node_pubkey;
    this.rawError = rawError;
  }
}

export class FiberDiagClient {
  private proxyUrl: string;

  constructor(proxyUrl: string = "http://127.0.0.1:9227") {
    this.proxyUrl = proxyUrl;
  }

  /**
   * Helper to perform GET requests to the proxy REST API
   */
  private async get(path: string): Promise<any> {
    const url = `${this.proxyUrl}${path}`;
    const response = await axios.get(url);
    return response.data;
  }

  /**
   * Helper to perform JSON-RPC POST requests to the proxy
   */
  private async postRpc(method: string, params: any[] = []): Promise<any> {
    const response = await axios.post(this.proxyUrl, {
      jsonrpc: "2.0",
      id: 1,
      method,
      params
    });
    return response.data;
  }

  /**
   * Fetches the complete list of payments from the proxy database
   */
  public async getAllPayments(): Promise<PaymentResult[]> {
    return this.get("/api/payments");
  }

  /**
   * Fetches detailed information for a specific payment, including its hops
   */
  public async getPaymentDetails(paymentHash: string): Promise<PaymentResult> {
    return this.get(`/api/payments/${paymentHash}`);
  }

  /**
   * Sends an off-chain payment and resolves when the payment is completed.
   * If the payment fails (either synchronously or asynchronously), throws a structured FiberDiagError.
   */
  public async sendPayment(invoiceAddress: string): Promise<PaymentResult> {
    console.log(`[SDK] Dispatching payment for invoice to proxy...`);
    const rpcResult = await this.postRpc("send_payment", [{ invoice: invoiceAddress }]);

    // Case 1: Synchronous failure intercepted by proxy
    if (rpcResult.error) {
      const diag = rpcResult.error.data?.diagnostics as DiagnosticInfo;
      const rawError = rpcResult.error.message || JSON.stringify(rpcResult.error);
      
      const fallbackDiag: DiagnosticInfo = {
        code: "UnknownSyncError",
        suggestion: "The payment request failed during submission. Check if parameters are valid."
      };
      
      throw new FiberDiagError(diag || fallbackDiag, rawError);
    }

    const paymentHash = rpcResult.result?.payment_hash;
    if (!paymentHash) {
      throw new Error("[SDK] FNN node did not return a valid payment_hash.");
    }

    console.log(`[SDK] Payment accepted (Hash: ${paymentHash}). Polling status...`);

    // Case 2: Asynchronous background payment. Poll the proxy REST API.
    return new Promise<PaymentResult>((resolve, reject) => {
      let pollCount = 0;
      const maxPolls = 95; // 95 seconds max timeout

      const interval = setInterval(async () => {
        pollCount++;
        try {
          const payment = await this.getPaymentDetails(paymentHash);
          
          if (payment.status === "Success") {
            clearInterval(interval);
            console.log(`[SDK] Payment settled successfully.`);
            resolve(payment);
          } else if (payment.status === "Failed") {
            clearInterval(interval);
            const diag: DiagnosticInfo = {
              code: payment.error_code || "UnknownAsyncError",
              suggestion: payment.diagnostic_msg || "The payment failed in the background.",
              failing_hop_index: payment.hops?.find(h => h.status === "Failed")?.hop_index,
              failing_node_pubkey: payment.hops?.find(h => h.status === "Failed")?.node_pubkey
            };
            reject(new FiberDiagError(diag, payment.error_raw || "Unknown Error"));
          }
        } catch (err: any) {
          console.warn(`[SDK] Polling warning (Attempt ${pollCount}):`, err.message);
        }

        if (pollCount >= maxPolls) {
          clearInterval(interval);
          reject(
            new FiberDiagError(
              {
                code: "RouteSearchTimeout",
                suggestion: "The SDK timed out waiting for the payment to settle. Please verify recipient connectivity."
              },
              "SDK_TIMEOUT"
            )
          );
        }
      }, 1000);
    });
  }
}
