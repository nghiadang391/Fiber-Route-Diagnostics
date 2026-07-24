import { createFnnClient, FnnRpcError } from "../src/proxy/fnnClient";

const makeClient = (mockFn: jest.Mock) =>
  createFnnClient({ rpcUrl: "http://mock", postFn: mockFn });

const ok = (result: any) =>
  Promise.resolve({ data: { jsonrpc: "2.0", id: 1, result } });

const err = (code: number, message: string) =>
  Promise.resolve({ data: { jsonrpc: "2.0", id: 1, error: { code, message } } });

describe("FnnClient", () => {
  let mock: jest.Mock;
  beforeEach(() => { mock = jest.fn(); });

  test("nodeInfo returns result", async () => {
    mock.mockResolvedValueOnce(await ok({ node_id: "0xabc", node_name: "Alice" }));
    const client = makeClient(mock);
    const res = await client.nodeInfo();
    expect(res.node_id).toBe("0xabc");
    expect(mock).toHaveBeenCalledWith("http://mock", expect.objectContaining({ method: "node_info" }));
  });

  test("nodeInfo throws FnnRpcError on error response", async () => {
    mock.mockResolvedValue(await err(-1, "internal error"));
    const client = makeClient(mock);
    await expect(client.nodeInfo()).rejects.toThrow(FnnRpcError);
    await expect(client.nodeInfo()).rejects.toThrow("internal error");
  });

  test("decodeInvoice passes invoice and returns payee_pubkey", async () => {
    mock.mockResolvedValueOnce(await ok({ payee_pubkey: "0xpub", amount: "0x100" }));
    const client = makeClient(mock);
    const res = await client.decodeInvoice("fibt1234");
    expect(res.payee_pubkey).toBe("0xpub");
    expect(mock).toHaveBeenCalledWith("http://mock", expect.objectContaining({
      method: "decode_invoice",
      params: [{ invoice: "fibt1234" }]
    }));
  });

  test("listChannels passes params to FNN", async () => {
    mock.mockResolvedValueOnce(await ok({ channels: [] }));
    const client = makeClient(mock);
    await client.listChannels({ peer_id: "0xpeer" });
    expect(mock).toHaveBeenCalledWith("http://mock", expect.objectContaining({
      method: "list_channels",
      params: [{ peer_id: "0xpeer" }]
    }));
  });

  test("listChannels with no params passes empty object", async () => {
    mock.mockResolvedValueOnce(await ok({ channels: [] }));
    const client = makeClient(mock);
    await client.listChannels();
    expect(mock).toHaveBeenCalledWith("http://mock", expect.objectContaining({
      params: [{}]
    }));
  });

  test("listPeers calls correct RPC method", async () => {
    mock.mockResolvedValueOnce(await ok({ peers: [] }));
    const client = makeClient(mock);
    await client.listPeers();
    expect(mock).toHaveBeenCalledWith("http://mock", expect.objectContaining({ method: "list_peers" }));
  });

  test("graphNodes maps result array", async () => {
    const nodes = [{ node_id: "0xn1", alias: "Bob" }];
    mock.mockResolvedValueOnce(await ok({ nodes }));
    const client = makeClient(mock);
    const res = await client.graphNodes();
    expect(res.nodes).toHaveLength(1);
    expect(res.nodes[0].alias).toBe("Bob");
  });

  test("graphChannels calls correct method", async () => {
    mock.mockResolvedValueOnce(await ok({ channels: [] }));
    const client = makeClient(mock);
    await client.graphChannels();
    expect(mock).toHaveBeenCalledWith("http://mock", expect.objectContaining({ method: "graph_channels" }));
  });

  test("sendPayment passes dry_run param", async () => {
    mock.mockResolvedValueOnce(await ok({ payment_hash: "0xhash" }));
    const client = makeClient(mock);
    await client.sendPayment({ invoice: "fibt1234", dry_run: true });
    expect(mock).toHaveBeenCalledWith("http://mock", expect.objectContaining({
      params: [{ invoice: "fibt1234", dry_run: true }]
    }));
  });

  test("network error propagates as thrown error", async () => {
    mock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const client = makeClient(mock);
    await expect(client.nodeInfo()).rejects.toThrow("ECONNREFUSED");
  });

  test("FnnRpcError has correct code", async () => {
    mock.mockResolvedValueOnce(await err(-32601, "Method not found"));
    const client = makeClient(mock);
    try {
      await client.nodeInfo();
    } catch (e: any) {
      expect(e).toBeInstanceOf(FnnRpcError);
      expect(e.code).toBe(-32601);
    }
  });
});
