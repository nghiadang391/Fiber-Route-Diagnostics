import { pollPeerHealth } from "../src/proxy/channelMonitor";

// Mock the db module so we don't touch the filesystem (channelMonitor imports it).
jest.mock("../src/proxy/db", () => ({
  saveChannelSnapshot: jest.fn(),
  getLatestSnapshots: jest.fn(() => []),
}));

function makeClient(overrides: Partial<any> = {}) {
  return {
    nodeInfo: jest.fn(),
    decodeInvoice: jest.fn(),
    listChannels: jest.fn(() => Promise.resolve({ channels: [] })),
    listPeers: jest.fn(() => Promise.resolve({ peers: [] })),
    getPayment: jest.fn(),
    sendPayment: jest.fn(),
    sendPaymentWithRouter: jest.fn(),
    graphNodes: jest.fn(),
    graphChannels: jest.fn(),
    newInvoice: jest.fn(),
    ...overrides,
  };
}

const channel = (over: Partial<any> = {}) => ({
  channel_id: "cid",
  pubkey: "0xpeer",
  channel_outpoint: "out1",
  local_balance: "0x64",
  remote_balance: "0x384",
  capacity: "0x3e8",
  state: { state_name: "CHANNEL_READY" },
  ...over,
});

describe("pollPeerHealth", () => {
  test("returns disconnected channels and broadcasts PEER_HEALTH_UPDATE", async () => {
    const client = makeClient({
      listChannels: jest.fn(() => Promise.resolve({ channels: [channel({ pubkey: "0xdisconnected" })] })),
      listPeers: jest.fn(() => Promise.resolve({ peers: [{ peer_id: "0xother" }] })),
    });
    const broadcast = jest.fn();
    const result = await pollPeerHealth(client as any, broadcast);

    expect(result).toHaveLength(1);
    expect(result[0].peer_id).toBe("0xdisconnected");
    expect(broadcast).toHaveBeenCalledWith("PEER_HEALTH_UPDATE", result);
  });

  test("broadcasts an empty array when all peers are connected", async () => {
    const client = makeClient({
      listChannels: jest.fn(() => Promise.resolve({ channels: [channel({ pubkey: "0xpeer" })] })),
      listPeers: jest.fn(() => Promise.resolve({ peers: [{ peer_id: "0xpeer" }] })),
    });
    const broadcast = jest.fn();
    const result = await pollPeerHealth(client as any, broadcast);

    expect(result).toEqual([]);
    expect(broadcast).toHaveBeenCalledWith("PEER_HEALTH_UPDATE", []);
  });

  test("gracefully degrades on RPC error (returns [], no throw, no broadcast)", async () => {
    const client = makeClient({
      listPeers: jest.fn(() => Promise.reject(new Error("ECONNREFUSED"))),
    });
    const broadcast = jest.fn();
    await expect(pollPeerHealth(client as any, broadcast)).resolves.toEqual([]);
    expect(broadcast).not.toHaveBeenCalled();
  });

  test("handles empty peers and channels without error", async () => {
    const client = makeClient();
    const broadcast = jest.fn();
    const result = await pollPeerHealth(client as any, broadcast);
    expect(result).toEqual([]);
    expect(broadcast).toHaveBeenCalledWith("PEER_HEALTH_UPDATE", []);
  });
});
