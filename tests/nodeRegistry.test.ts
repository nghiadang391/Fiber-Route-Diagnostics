import { refreshNodeAliases, resolveAlias } from "../src/proxy/nodeRegistry";
import { FnnRpcError } from "../src/proxy/fnnClient";

// Mock the db module so we don't touch the filesystem
jest.mock("../src/proxy/db", () => ({
  saveNodeAlias: jest.fn(),
  getAllNodeAliases: jest.fn(() => ({})),
}));

import { saveNodeAlias } from "../src/proxy/db";
const mockSaveNodeAlias = saveNodeAlias as jest.Mock;

function makeClient(graphNodesImpl: () => Promise<any>) {
  return {
    nodeInfo: jest.fn(),
    decodeInvoice: jest.fn(),
    listChannels: jest.fn(),
    listPeers: jest.fn(),
    getPayment: jest.fn(),
    sendPayment: jest.fn(),
    sendPaymentWithRouter: jest.fn(),
    graphNodes: jest.fn(graphNodesImpl),
    graphChannels: jest.fn(),
    newInvoice: jest.fn(),
  };
}

beforeEach(() => {
  mockSaveNodeAlias.mockClear();
});

describe("refreshNodeAliases", () => {
  test("stores alias for each node returned by graphNodes", async () => {
    const client = makeClient(() => Promise.resolve({
      nodes: [
        { node_id: "0xaaa", alias: "Alice" },
        { node_id: "0xbbb", alias: "Bob" },
      ]
    }));
    await refreshNodeAliases(client as any);
    expect(mockSaveNodeAlias).toHaveBeenCalledTimes(2);
    expect(mockSaveNodeAlias).toHaveBeenCalledWith("0xaaa", "Alice");
    expect(mockSaveNodeAlias).toHaveBeenCalledWith("0xbbb", "Bob");
  });

  test("uses short pubkey fallback when alias is missing", async () => {
    const client = makeClient(() => Promise.resolve({
      nodes: [{ node_id: "0xabcdef1234567890" }]
    }));
    await refreshNodeAliases(client as any);
    expect(mockSaveNodeAlias).toHaveBeenCalledWith("0xabcdef1234567890", "0xabcdef…");
  });

  test("uses short pubkey fallback when alias is empty string", async () => {
    const client = makeClient(() => Promise.resolve({
      nodes: [{ node_id: "0xabcdef1234567890", alias: "   " }]
    }));
    await refreshNodeAliases(client as any);
    expect(mockSaveNodeAlias).toHaveBeenCalledWith("0xabcdef1234567890", "0xabcdef…");
  });

  test("silently swallows FnnRpcError (graph_nodes not supported)", async () => {
    const client = makeClient(() => Promise.reject(new FnnRpcError(-32601, "Method not found")));
    await expect(refreshNodeAliases(client as any)).resolves.toBeUndefined();
    expect(mockSaveNodeAlias).not.toHaveBeenCalled();
  });

  test("silently swallows network errors", async () => {
    const client = makeClient(() => Promise.reject(new Error("ECONNREFUSED")));
    await expect(refreshNodeAliases(client as any)).resolves.toBeUndefined();
    expect(mockSaveNodeAlias).not.toHaveBeenCalled();
  });

  test("handles empty nodes array without error", async () => {
    const client = makeClient(() => Promise.resolve({ nodes: [] }));
    await refreshNodeAliases(client as any);
    expect(mockSaveNodeAlias).not.toHaveBeenCalled();
  });
});

describe("resolveAlias", () => {
  test("returns alias when pubkey is in the map", () => {
    expect(resolveAlias("0xaaa", { "0xaaa": "Alice" })).toBe("Alice");
  });

  test("returns truncated pubkey when not in map", () => {
    expect(resolveAlias("0xabcdef1234567890", {})).toBe("0xabcdef…");
  });

  test("returns pubkey as-is when it is short enough", () => {
    expect(resolveAlias("0xshort", {})).toBe("0xshort");
  });
});
