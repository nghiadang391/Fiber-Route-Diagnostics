import {
  parseBalance,
  channelToSnapshot,
  pollChannels,
} from "../src/proxy/channelMonitor";

// Mock the db module so we don't touch the filesystem.
jest.mock("../src/proxy/db", () => ({
  saveChannelSnapshot: jest.fn(),
  getLatestSnapshots: jest.fn(() => []),
}));

import { saveChannelSnapshot, getLatestSnapshots } from "../src/proxy/db";
const mockSaveSnapshot = saveChannelSnapshot as jest.Mock;
const mockGetLatest = getLatestSnapshots as jest.Mock;

function makeClient(listChannelsImpl: () => Promise<any>) {
  return {
    nodeInfo: jest.fn(),
    decodeInvoice: jest.fn(),
    listChannels: jest.fn(listChannelsImpl),
    listPeers: jest.fn(),
    getPayment: jest.fn(),
    sendPayment: jest.fn(),
    sendPaymentWithRouter: jest.fn(),
    graphNodes: jest.fn(),
    graphChannels: jest.fn(),
    newInvoice: jest.fn(),
  };
}

const channel = (over: Partial<any> = {}) => ({
  channel_id: "cid",
  pubkey: "0xpeer",
  channel_outpoint: "out1",
  local_balance: "0x64", // 100
  remote_balance: "0x384", // 900
  capacity: "0x3e8", // 1000
  state: { state_name: "CHANNEL_READY" },
  ...over,
});

beforeEach(() => {
  mockSaveSnapshot.mockClear();
  mockGetLatest.mockReset();
  mockGetLatest.mockReturnValue([]);
});

describe("parseBalance", () => {
  test("parses hex strings", () => {
    expect(parseBalance("0x64")).toBe(100);
    expect(parseBalance("0xFF")).toBe(255);
  });

  test("parses decimal strings", () => {
    expect(parseBalance("100")).toBe(100);
  });

  test("passes numbers through", () => {
    expect(parseBalance(42)).toBe(42);
  });

  test("returns 0 for undefined / empty / garbage", () => {
    expect(parseBalance(undefined)).toBe(0);
    expect(parseBalance("")).toBe(0);
    expect(parseBalance("xyz")).toBe(0);
  });
});

describe("channelToSnapshot", () => {
  test("maps FNN channel fields into a snapshot", () => {
    const snap = channelToSnapshot(channel(), 1234);
    expect(snap).toEqual({
      channel_outpoint: "out1",
      peer_id: "0xpeer",
      local_balance_shannons: 100,
      remote_balance_shannons: 900,
      capacity_shannons: 1000,
      sampled_at: 1234,
    });
  });
});

describe("pollChannels", () => {
  test("persists a snapshot for each channel returned", async () => {
    const client = makeClient(() =>
      Promise.resolve({ channels: [channel({ channel_outpoint: "a" }), channel({ channel_outpoint: "b" })] })
    );
    await pollChannels(client as any, jest.fn(), 0.1);
    expect(mockSaveSnapshot).toHaveBeenCalledTimes(2);
  });

  test("broadcasts CHANNEL_ALERT when a channel is drained", async () => {
    // local 50 / capacity 1000 = 0.05 < 0.10 threshold → drained
    mockGetLatest.mockReturnValue([
      {
        channel_outpoint: "a",
        peer_id: "0xpeer",
        local_balance_shannons: 50,
        remote_balance_shannons: 950,
        capacity_shannons: 1000,
        sampled_at: 1,
      },
    ]);
    const broadcast = jest.fn();
    const client = makeClient(() => Promise.resolve({ channels: [channel({ channel_outpoint: "a" })] }));
    const drained = await pollChannels(client as any, broadcast, 0.1);

    expect(drained).toHaveLength(1);
    expect(broadcast).toHaveBeenCalledWith("CHANNEL_ALERT", drained);
  });

  test("does NOT broadcast when no channel is drained", async () => {
    // local 500 / capacity 1000 = 0.5 > 0.10 threshold → healthy
    mockGetLatest.mockReturnValue([
      {
        channel_outpoint: "a",
        peer_id: "0xpeer",
        local_balance_shannons: 500,
        remote_balance_shannons: 500,
        capacity_shannons: 1000,
        sampled_at: 1,
      },
    ]);
    const broadcast = jest.fn();
    const client = makeClient(() => Promise.resolve({ channels: [channel({ channel_outpoint: "a" })] }));
    const drained = await pollChannels(client as any, broadcast, 0.1);

    expect(drained).toHaveLength(0);
    expect(broadcast).not.toHaveBeenCalled();
  });

  test("gracefully degrades on RPC error (returns [], no throw, no broadcast)", async () => {
    const broadcast = jest.fn();
    const client = makeClient(() => Promise.reject(new Error("ECONNREFUSED")));
    await expect(pollChannels(client as any, broadcast, 0.1)).resolves.toEqual([]);
    expect(mockSaveSnapshot).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });

  test("handles empty channel list without error", async () => {
    const broadcast = jest.fn();
    const client = makeClient(() => Promise.resolve({ channels: [] }));
    await expect(pollChannels(client as any, broadcast, 0.1)).resolves.toEqual([]);
    expect(mockSaveSnapshot).not.toHaveBeenCalled();
  });
});
