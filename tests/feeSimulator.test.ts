import { estimateRouteFees, getCandidateRoutes } from "../src/proxy/feeSimulator";
import { createFnnClient } from "../src/proxy/fnnClient";
import type { GraphChannelInfo, ChannelInfo } from "../src/proxy/fnnClient";

const ok = (result: any) =>
  Promise.resolve({ data: { jsonrpc: "2.0", id: 1, result } });
const rpcErr = (message: string, code = -1) =>
  Promise.resolve({ data: { jsonrpc: "2.0", id: 1, error: { code, message } } });

const graphChannel = (overrides: Partial<GraphChannelInfo> = {}): GraphChannelInfo => ({
  channel_outpoint: "0xoutpoint",
  node1: "A",
  node2: "B",
  node1_fee_rate: "3e8", // 1000 in hex
  node2_fee_rate: "3e8",
  ...overrides,
});

describe("estimateRouteFees", () => {
  test("resolves fee for a route fully covered by graph_channels", () => {
    const channels = [graphChannel({ node1: "A", node2: "B", node1_fee_rate: "3e8" })];
    const result = estimateRouteFees([["A", "B"]], channels, 1_000_000);
    expect(result).toHaveLength(1);
    expect(result[0].confidence).toBe("graph_data");
    expect(result[0].channel_outpoints).toEqual(["0xoutpoint"]);
    expect(result[0].total_fee_shannons).toBe(1000); // 1_000_000 * 1000ppm / 1e6
  });

  test("uses node2's fee rate when traversing node2 -> node1", () => {
    const channels = [graphChannel({ node1: "A", node2: "B", node1_fee_rate: "3e8", node2_fee_rate: "64" })];
    const result = estimateRouteFees([["B", "A"]], channels, 1_000_000);
    expect(result[0].confidence).toBe("graph_data");
    expect(result[0].total_fee_shannons).toBe(100); // rate=0x64=100ppm
  });

  test("falls back to approximated confidence when a hop has no matching graph channel", () => {
    const result = estimateRouteFees([["A", "B", "C"]], [graphChannel({ node1: "A", node2: "B" })], 1_000_000);
    expect(result[0].confidence).toBe("approximated");
    expect(result[0].channel_outpoints).toEqual(["0xoutpoint", ""]);
  });

  test("empty graph_channels list yields approximated confidence for every route", () => {
    const result = estimateRouteFees([["A", "B"]], [], 1_000_000);
    expect(result[0].confidence).toBe("approximated");
    expect(result[0].total_fee_shannons).toBeGreaterThan(0);
  });

  test("handles multiple routes independently", () => {
    const channels = [graphChannel({ node1: "A", node2: "B" })];
    const result = estimateRouteFees([["A", "B"], ["A", "C"]], channels, 1_000_000);
    expect(result).toHaveLength(2);
    expect(result[0].confidence).toBe("graph_data");
    expect(result[1].confidence).toBe("approximated");
  });

  test("single-node route produces zero fee and no outpoints", () => {
    const result = estimateRouteFees([["A"]], [], 1_000_000);
    expect(result[0].total_fee_shannons).toBe(0);
    expect(result[0].channel_outpoints).toEqual([]);
  });
});

describe("getCandidateRoutes", () => {
  let mock: jest.Mock;
  beforeEach(() => { mock = jest.fn(); });

  test("finds a path via graph_channels BFS when available", async () => {
    mock.mockResolvedValueOnce(await ok({
      channels: [
        graphChannel({ node1: "A", node2: "B" }),
        graphChannel({ node1: "B", node2: "C", channel_outpoint: "0xoutpoint2" }),
      ],
    }));
    const client = createFnnClient({ rpcUrl: "http://mock", postFn: mock });
    const routes = await getCandidateRoutes(client, "A", "C", 3);
    expect(routes.length).toBeGreaterThan(0);
    expect(routes[0][0]).toBe("A");
    expect(routes[0][routes[0].length - 1]).toBe("C");
  });

  test("falls back to buildApproximateHops when graph_channels errors", async () => {
    mock.mockResolvedValueOnce(await rpcErr("Method not found"));
    mock.mockResolvedValueOnce(await ok({
      channels: [{ pubkey: "B", channel_outpoint: "0xch1" } as ChannelInfo],
    }));
    const client = createFnnClient({ rpcUrl: "http://mock", postFn: mock });
    const routes = await getCandidateRoutes(client, "A", "C", 3);
    expect(routes).toHaveLength(1);
    expect(routes[0][0]).toBe("A");
    expect(routes[0][routes[0].length - 1]).toBe("C");
  });

  test("falls back to buildApproximateHops when graph_channels returns no channels", async () => {
    mock.mockResolvedValueOnce(await ok({ channels: [] }));
    mock.mockResolvedValueOnce(await ok({ channels: [] }));
    const client = createFnnClient({ rpcUrl: "http://mock", postFn: mock });
    const routes = await getCandidateRoutes(client, "A", "C", 3);
    expect(routes).toHaveLength(1);
    expect(routes[0]).toEqual(["A", "C"]);
  });

  test("falls back when graph_channels has no path to recipient", async () => {
    mock.mockResolvedValueOnce(await ok({
      channels: [graphChannel({ node1: "A", node2: "B" })], // no path to "Z"
    }));
    mock.mockResolvedValueOnce(await ok({ channels: [] }));
    const client = createFnnClient({ rpcUrl: "http://mock", postFn: mock });
    const routes = await getCandidateRoutes(client, "A", "Z", 3);
    expect(routes).toHaveLength(1);
    expect(routes[0]).toEqual(["A", "Z"]);
  });

  test("respects maxRoutes cap", async () => {
    mock.mockResolvedValueOnce(await ok({
      channels: [
        graphChannel({ node1: "A", node2: "B" }),
        graphChannel({ node1: "A", node2: "C", channel_outpoint: "0x2" }),
        graphChannel({ node1: "A", node2: "D", channel_outpoint: "0x3" }),
        graphChannel({ node1: "B", node2: "Z", channel_outpoint: "0x4" }),
        graphChannel({ node1: "C", node2: "Z", channel_outpoint: "0x5" }),
        graphChannel({ node1: "D", node2: "Z", channel_outpoint: "0x6" }),
      ],
    }));
    const client = createFnnClient({ rpcUrl: "http://mock", postFn: mock });
    const routes = await getCandidateRoutes(client, "A", "Z", 2);
    expect(routes).toHaveLength(2);
  });
});
