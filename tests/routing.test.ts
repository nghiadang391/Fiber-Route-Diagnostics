import {
  extractAmountFromInvoice,
  buildApproximateHops,
  findDisconnectedChannels,
  findDrainedChannels,
  suggestCircularRoutes,
  excludeChannelFromHops,
} from "../src/proxy/routing";
import type { ChannelInfo, PeerInfo, GraphChannelInfo } from "../src/proxy/fnnClient";
import type { ChannelSnapshot } from "../src/proxy/db";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeChannel(pubkey: string, outpoint: string, local = "0x64", remote = "0x384", capacity = "0x3e8"): ChannelInfo {
  return {
    channel_id: outpoint,
    pubkey,
    channel_outpoint: outpoint,
    local_balance: local,
    remote_balance: remote,
    capacity,
    state: { state_name: "ChannelReady" },
  };
}

function makePeer(peer_id: string, connected = true): PeerInfo {
  return { peer_id, connected };
}

function makeSnapshot(outpoint: string, local: number, remote: number, capacity: number, at = 1000): ChannelSnapshot {
  return { channel_outpoint: outpoint, peer_id: "0xpeer", local_balance_shannons: local, remote_balance_shannons: remote, capacity_shannons: capacity, sampled_at: at };
}

function makeGraphCh(outpoint: string, node1: string, node2: string): GraphChannelInfo {
  return { channel_outpoint: outpoint, node1, node2 };
}

// ─── extractAmountFromInvoice ─────────────────────────────────────────────────

describe("extractAmountFromInvoice", () => {
  test("parses fibt prefix", () => {
    // "fibt" + digits + "1": "fibt24000000001abc" → digits = "2400000000", then "1"
    expect(extractAmountFromInvoice("fibt24000000001abc")).toBe(2400000000);
  });
  test("parses fib prefix", () => {
    expect(extractAmountFromInvoice("fib1001xyz")).toBe(100);
  });
  test("returns 0 for unrecognized format", () => {
    expect(extractAmountFromInvoice("invalidinvoice")).toBe(0);
  });
});

// ─── buildApproximateHops ─────────────────────────────────────────────────────

describe("buildApproximateHops", () => {
  test("direct channel: payer → recipient", () => {
    const channels = [makeChannel("0xrecip", "out1")];
    const hops = buildApproximateHops("0xpayer", "0xrecip", channels);
    expect(hops).toEqual(["0xpayer", "0xrecip"]);
  });

  test("indirect: payer → peer → recipient", () => {
    const channels = [makeChannel("0xpeer", "out1")];
    const hops = buildApproximateHops("0xpayer", "0xrecip", channels);
    expect(hops).toEqual(["0xpayer", "0xpeer", "0xrecip"]);
  });

  test("indirect with failing node inserted between peer and recipient", () => {
    const channels = [makeChannel("0xpeer", "out1")];
    const hops = buildApproximateHops("0xpayer", "0xrecip", channels, "0xfailing");
    expect(hops).toEqual(["0xpayer", "0xpeer", "0xfailing", "0xrecip"]);
  });

  test("fallback when no channels: payer → recipient", () => {
    const hops = buildApproximateHops("0xpayer", "0xrecip", []);
    expect(hops).toEqual(["0xpayer", "0xrecip"]);
  });

  test("fallback with failing node: payer → failing → recipient", () => {
    const hops = buildApproximateHops("0xpayer", "0xrecip", [], "0xfailing");
    expect(hops).toEqual(["0xpayer", "0xfailing", "0xrecip"]);
  });
});

// ─── findDisconnectedChannels ─────────────────────────────────────────────────

describe("findDisconnectedChannels", () => {
  test("returns channel whose peer is not in peer list", () => {
    const channels = [makeChannel("0xpeer1", "out1"), makeChannel("0xpeer2", "out2")];
    const peers = [makePeer("0xpeer1")];
    const result = findDisconnectedChannels(channels, peers);
    expect(result).toHaveLength(1);
    expect(result[0].peer_id).toBe("0xpeer2");
  });

  test("returns empty when all peers connected", () => {
    const channels = [makeChannel("0xpeer1", "out1")];
    const peers = [makePeer("0xpeer1")];
    expect(findDisconnectedChannels(channels, peers)).toHaveLength(0);
  });

  test("returns all channels when no peers connected", () => {
    const channels = [makeChannel("0xp1", "out1"), makeChannel("0xp2", "out2")];
    expect(findDisconnectedChannels(channels, [])).toHaveLength(2);
  });
});

// ─── findDrainedChannels ──────────────────────────────────────────────────────

describe("findDrainedChannels", () => {
  test("returns channel below threshold", () => {
    const snaps = [makeSnapshot("out1", 50, 950, 1000)]; // 5% — below 10%
    const result = findDrainedChannels(snaps, 0.10);
    expect(result).toHaveLength(1);
    expect(result[0].ratio).toBeCloseTo(0.05);
  });

  test("exactly at threshold is NOT drained", () => {
    const snaps = [makeSnapshot("out1", 100, 900, 1000)]; // 10%
    expect(findDrainedChannels(snaps, 0.10)).toHaveLength(0);
  });

  test("healthy channels not returned", () => {
    const snaps = [makeSnapshot("out1", 500, 500, 1000)]; // 50%
    expect(findDrainedChannels(snaps, 0.10)).toHaveLength(0);
  });

  test("zero capacity channel not returned", () => {
    const snaps = [makeSnapshot("out1", 0, 0, 0)];
    expect(findDrainedChannels(snaps, 0.10)).toHaveLength(0);
  });
});

// ─── suggestCircularRoutes ────────────────────────────────────────────────────

describe("suggestCircularRoutes", () => {
  test("finds A→B→C→A circular route", () => {
    const nodeId = "0xA";
    const graphChs: GraphChannelInfo[] = [
      makeGraphCh("outAB", "0xA", "0xB"),
      makeGraphCh("outBC", "0xB", "0xC"),
      makeGraphCh("outCA", "0xC", "0xA"),
    ];
    const routes = suggestCircularRoutes(nodeId, [], graphChs, 3);
    expect(routes.length).toBeGreaterThan(0);
    expect(routes[0].hops[0]).toBe("0xA");
    expect(routes[0].hops[routes[0].hops.length - 1]).toBe("0xA");
  });

  test("returns empty when no graph channels", () => {
    expect(suggestCircularRoutes("0xA", [], [], 3)).toHaveLength(0);
  });

  test("returns empty for graph with only 2 nodes (no intermediate)", () => {
    const graphChs: GraphChannelInfo[] = [makeGraphCh("outAB", "0xA", "0xB")];
    expect(suggestCircularRoutes("0xA", [], graphChs, 3)).toHaveLength(0);
  });

  test("respects maxRoutes limit", () => {
    const graphChs: GraphChannelInfo[] = [
      makeGraphCh("outAB", "0xA", "0xB"),
      makeGraphCh("outBC", "0xB", "0xC"),
      makeGraphCh("outCA", "0xC", "0xA"),
      makeGraphCh("outAD", "0xA", "0xD"),
      makeGraphCh("outDE", "0xD", "0xE"),
      makeGraphCh("outEA", "0xE", "0xA"),
    ];
    const routes = suggestCircularRoutes("0xA", [], graphChs, 1);
    expect(routes).toHaveLength(1);
  });
});

// ─── excludeChannelFromHops ───────────────────────────────────────────────────

describe("excludeChannelFromHops", () => {
  test("builds HopSpec list skipping excluded outpoints", () => {
    const channels = [
      makeChannel("0xB", "outAB_1"),
      makeChannel("0xB", "outAB_2"),
    ];
    const specs = excludeChannelFromHops(["0xA", "0xB"], channels, ["outAB_1"]);
    expect(specs).toHaveLength(1);
    expect(specs[0].channel_id).toBe("outAB_2");
  });

  test("falls back to excluded channel when no alternatives", () => {
    const channels = [makeChannel("0xB", "outAB_1")];
    const specs = excludeChannelFromHops(["0xA", "0xB"], channels, ["outAB_1"]);
    expect(specs).toHaveLength(1);
    expect(specs[0].channel_id).toBe("outAB_1"); // fallback
  });

  test("returns empty specs when no channels available for a hop", () => {
    const specs = excludeChannelFromHops(["0xA", "0xB"], [], []);
    expect(specs).toHaveLength(0);
  });
});
