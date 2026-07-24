import type { ChannelInfo, PeerInfo, GraphChannelInfo, HopSpec } from "./fnnClient";
import type { ChannelSnapshot } from "./db";

// ─── Result types ─────────────────────────────────────────────────────────────

export interface DisconnectedChannel {
  channel_outpoint: string;
  peer_id: string;
  local_balance_shannons: number;
}

export interface DrainedChannel {
  channel_outpoint: string;
  peer_id: string;
  ratio: number;                  // local / capacity (0–1)
  local_balance_shannons: number;
  capacity_shannons: number;
}

export interface CircularRoute {
  hops: string[];                 // ordered node pubkeys (starts and ends at local node)
  channel_ids: string[];
  estimated_rebalance_shannons: number;
}

// ─── Moved from server.ts ─────────────────────────────────────────────────────

/** Parse the CKB amount in shannons from a Fiber invoice bech32 prefix. */
export function extractAmountFromInvoice(invoice: string): number {
  const match = invoice.match(/^(fibt|fibd|fib)(\d+)1/i);
  if (match) return parseFloat(match[2]);
  return 0;
}

/**
 * Build an approximate payment hop path from local channel topology.
 * Pure function: takes channel data, not an FNN client.
 */
export function buildApproximateHops(
  payerNodeId: string,
  recipientId: string,
  channels: ChannelInfo[],
  failingNodeId?: string
): string[] {
  const path: string[] = [payerNodeId];

  const directChannel = channels.find(c => c.pubkey === recipientId);
  if (directChannel) {
    path.push(recipientId);
    return path;
  }

  if (channels.length > 0) {
    const peerId = channels[0].pubkey;
    path.push(peerId);
    if (
      failingNodeId &&
      failingNodeId !== payerNodeId &&
      failingNodeId !== recipientId &&
      failingNodeId !== peerId
    ) {
      path.push(failingNodeId);
    }
    path.push(recipientId);
    return path;
  }

  if (failingNodeId && failingNodeId !== payerNodeId && failingNodeId !== recipientId) {
    path.push(failingNodeId);
  }
  path.push(recipientId);
  return path;
}

// ─── Feature 8.5: Peer connectivity ──────────────────────────────────────────

/**
 * Returns channels whose peer is not present in the connected peers list.
 * `peers` contains only currently connected peers.
 */
export function findDisconnectedChannels(
  channels: ChannelInfo[],
  peers: PeerInfo[]
): DisconnectedChannel[] {
  const connectedIds = new Set(peers.map(p => p.peer_id));
  return channels
    .filter(c => !connectedIds.has(c.pubkey))
    .map(c => ({
      channel_outpoint: c.channel_outpoint,
      peer_id: c.pubkey,
      local_balance_shannons: parseInt(c.local_balance, 16) || 0,
    }));
}

// ─── Feature 8.4: Channel balance ratio ──────────────────────────────────────

/**
 * Returns channels whose local balance is below `thresholdPct` of capacity.
 * `latestSnapshots` should be one snapshot per channel (use getLatestSnapshots()).
 */
export function findDrainedChannels(
  latestSnapshots: ChannelSnapshot[],
  thresholdPct: number
): DrainedChannel[] {
  return latestSnapshots
    .filter(s => {
      if (s.capacity_shannons === 0) return false;
      return s.local_balance_shannons / s.capacity_shannons < thresholdPct;
    })
    .map(s => ({
      channel_outpoint: s.channel_outpoint,
      peer_id: s.peer_id,
      ratio: s.local_balance_shannons / s.capacity_shannons,
      local_balance_shannons: s.local_balance_shannons,
      capacity_shannons: s.capacity_shannons,
    }));
}

// ─── Feature 8.11: Circular rebalancing ──────────────────────────────────────

/**
 * Suggest circular routes (nodeId → ... → nodeId) through graph channels.
 * Prefers paths where the outgoing leg is a drained channel.
 * Returns up to `maxRoutes` suggestions.
 */
export function suggestCircularRoutes(
  nodeId: string,
  drainedChannels: DrainedChannel[],
  graphChannels: GraphChannelInfo[],
  maxRoutes: number = 3
): CircularRoute[] {
  const drainedPeers = new Set(drainedChannels.map(d => d.peer_id));

  // Build adjacency map from graph channels
  const adj = new Map<string, Array<{ peer: string; channel_id: string }>>();
  for (const ch of graphChannels) {
    if (!adj.has(ch.node1)) adj.set(ch.node1, []);
    if (!adj.has(ch.node2)) adj.set(ch.node2, []);
    adj.get(ch.node1)!.push({ peer: ch.node2, channel_id: ch.channel_outpoint });
    adj.get(ch.node2)!.push({ peer: ch.node1, channel_id: ch.channel_outpoint });
  }

  const results: CircularRoute[] = [];

  // BFS: find paths from nodeId back to nodeId via exactly 2 intermediate hops
  const firstHops = adj.get(nodeId) ?? [];
  for (const firstHop of firstHops) {
    if (results.length >= maxRoutes) break;
    const secondHops = adj.get(firstHop.peer) ?? [];
    for (const secondHop of secondHops) {
      if (results.length >= maxRoutes) break;
      if (secondHop.peer === nodeId) continue; // skip direct return
      const returnHops = adj.get(secondHop.peer) ?? [];
      for (const returnHop of returnHops) {
        if (results.length >= maxRoutes) break;
        if (returnHop.peer !== nodeId) continue;

        // Prefer routes where the first hop is a drained channel
        const isDrainedFirst = drainedPeers.has(firstHop.peer);
        if (!isDrainedFirst && results.length > 0) continue;

        results.push({
          hops: [nodeId, firstHop.peer, secondHop.peer, nodeId],
          channel_ids: [firstHop.channel_id, secondHop.channel_id, returnHop.channel_id],
          estimated_rebalance_shannons: 0, // filled in by fee simulator in Phase 9
        });
      }
    }
  }

  return results;
}

// ─── Feature 8.8: Channel exclusion ──────────────────────────────────────────

/**
 * Build a HopSpec[] for send_payment_with_router, excluding specified channel outpoints.
 * Falls back to all available channels when exclusion removes all options.
 */
export function excludeChannelFromHops(
  hopPubkeys: string[],
  channels: ChannelInfo[],
  excludedOutpoints: string[]
): HopSpec[] {
  const excluded = new Set(excludedOutpoints);
  const specs: HopSpec[] = [];

  for (let i = 0; i < hopPubkeys.length - 1; i++) {
    const from = hopPubkeys[i];
    const to = hopPubkeys[i + 1];

    const available = channels.filter(
      c => c.pubkey === to && !excluded.has(c.channel_outpoint)
    );
    const fallback = channels.filter(c => c.pubkey === to);
    const chosen = available.length > 0 ? available[0] : fallback[0];

    if (chosen) {
      specs.push({ pubkey: to, channel_id: chosen.channel_outpoint });
    }
  }

  return specs;
}
