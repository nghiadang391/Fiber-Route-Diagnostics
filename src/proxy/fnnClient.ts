import axios from "axios";

// ─── Error type ───────────────────────────────────────────────────────────────

export class FnnRpcError extends Error {
  constructor(public code: number, message: string) {
    super(message);
    this.name = "FnnRpcError";
  }
}

// ─── Result interfaces ────────────────────────────────────────────────────────

export interface NodeInfoResult {
  node_id: string;
  node_name?: string;
  addresses?: string[];
  [key: string]: any;
}

export interface DecodeInvoiceResult {
  payee_pubkey: string;
  amount?: string;
  description?: string;
  [key: string]: any;
}

export interface ChannelInfo {
  channel_id: string;
  pubkey: string;           // peer node pubkey (field name confirmed from existing server.ts usage)
  channel_outpoint: string;
  local_balance: string;    // hex shannons — confirm with probe script before Phase 3
  remote_balance: string;   // hex shannons
  capacity: string;         // hex shannons
  state: { state_name: string; [key: string]: any };
  [key: string]: any;
}

export interface PeerInfo {
  peer_id: string;
  connected?: boolean;      // field name unverified — confirm with probe script before Phase 4
  [key: string]: any;
}

export interface GraphNodeInfo {
  node_id: string;
  alias?: string;
  addresses?: string[];
  [key: string]: any;
}

export interface GraphChannelUpdateInfo {
  fee_rate?: string;
  enabled?: boolean;
  tlc_expiry_delta?: string;
  tlc_minimum_value?: string;
  [key: string]: any;
}

export interface GraphChannelInfo {
  channel_outpoint: string;
  node1: string;
  node2: string;
  capacity?: string;
  update_info_of_node1?: GraphChannelUpdateInfo;
  update_info_of_node2?: GraphChannelUpdateInfo;
  node1_fee_rate?: string;  // backward-compatible fallback
  node2_fee_rate?: string;
  [key: string]: any;
}

export interface HopSpec {
  pubkey: string;
  channel_id: string;       // field name unverified — confirm before Phase 7
  [key: string]: any;
}

export interface SendPaymentParams {
  invoice: string;
  dry_run?: boolean;        // existence unverified — confirm before Phase 5
  [key: string]: any;
}

export interface SendPaymentWithRouterParams {
  invoice?: string;
  payment_hash?: string;
  amount?: string;
  hops: HopSpec[];
  [key: string]: any;
}

export interface SendPaymentResult {
  payment_hash: string;
  status?: string;
  [key: string]: any;
}

export interface NewInvoiceParams {
  amount: string;
  currency?: string;
  description?: string;
  expiry?: string;
  [key: string]: any;
}

export interface NewInvoiceResult {
  invoice_address: string;
  [key: string]: any;
}

export interface ListChannelsParams {
  peer_id?: string;
  [key: string]: any;
}

export interface ListChannelsResult {
  channels: ChannelInfo[];
}

export interface ListPeersResult {
  peers: PeerInfo[];
}

export interface GraphNodesResult {
  nodes: GraphNodeInfo[];
}

export interface GraphChannelsResult {
  channels: GraphChannelInfo[];
}

// ─── Client factory ───────────────────────────────────────────────────────────

export type PostFn = (url: string, body: object) => Promise<{ data: any }>;

export interface FnnClientConfig {
  rpcUrl: string;
  postFn?: PostFn;
}

export interface FnnClient {
  nodeInfo(): Promise<NodeInfoResult>;
  decodeInvoice(invoice: string): Promise<DecodeInvoiceResult>;
  listChannels(params?: ListChannelsParams): Promise<ListChannelsResult>;
  listPeers(): Promise<ListPeersResult>;
  getPayment(paymentHash: string): Promise<any>;
  sendPayment(params: SendPaymentParams): Promise<SendPaymentResult>;
  sendPaymentWithRouter(params: SendPaymentWithRouterParams): Promise<SendPaymentResult>;
  graphNodes(params?: object): Promise<GraphNodesResult>;
  graphChannels(params?: object): Promise<GraphChannelsResult>;
  newInvoice(params: NewInvoiceParams): Promise<NewInvoiceResult>;
}

export function createFnnClient(config: FnnClientConfig): FnnClient {
  const { rpcUrl } = config;
  const post: PostFn = config.postFn ?? axios.post;

  async function call(method: string, params: any[] = []): Promise<any> {
    const body = { jsonrpc: "2.0", id: 1, method, params };
    const res = await post(rpcUrl, body);
    if (res.data?.error) {
      throw new FnnRpcError(
        res.data.error.code ?? -1,
        res.data.error.message ?? JSON.stringify(res.data.error)
      );
    }
    return res.data?.result;
  }

  return {
    nodeInfo: () => call("node_info"),
    decodeInvoice: (invoice) => call("decode_invoice", [{ invoice }]),
    listChannels: (params = {}) => call("list_channels", [params]),
    listPeers: () => call("list_peers"),
    getPayment: (paymentHash) => call("get_payment", [{ payment_hash: paymentHash }]),
    sendPayment: (params) => call("send_payment", [params]),
    sendPaymentWithRouter: (params) => call("send_payment_with_router", [params]),
    graphNodes: (params = {}) => call("graph_nodes", [params]),
    graphChannels: (params = {}) => call("graph_channels", [params]),
    newInvoice: (params) => call("new_invoice", [params]),
  };
}
