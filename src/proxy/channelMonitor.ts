import type { FnnClient, ChannelInfo } from "./fnnClient";
import type { ChannelSnapshot } from "./db";
import { saveChannelSnapshot, getLatestSnapshots } from "./db";
import { findDrainedChannels, findDisconnectedChannels, type DrainedChannel, type DisconnectedChannel } from "./routing";

// ─── Config ─────────────────────────────────────────────────────────────────

export interface ChannelMonitorOptions {
  pollIntervalMs?: number;
  drainThresholdPct?: number;
}

export type BroadcastFn = (type: string, payload: any) => void;

export const DEFAULT_POLL_INTERVAL_MS = 60_000;
export const DEFAULT_DRAIN_THRESHOLD_PCT = 0.10;

// ─── Pure helpers ─────────────────────────────────────────────────────────────

/**
 * Parse a balance field into a number of shannons. Accepts hex strings
 * ("0x..."), decimal strings, or numbers. Returns 0 for unparseable input.
 * (Balance field format hex-vs-int is flagged in the Risk Register; this
 * tolerates both so a probe-script confirmation cannot break the monitor.)
 */
export function parseBalance(value: string | number | undefined): number {
  if (typeof value === "number") return value;
  if (!value) return 0;
  const str = String(value).trim();
  const parsed = str.toLowerCase().startsWith("0x")
    ? parseInt(str, 16)
    : parseInt(str, 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** Convert an FNN ChannelInfo into a persisted ChannelSnapshot. */
export function channelToSnapshot(channel: ChannelInfo, sampledAt: number): ChannelSnapshot {
  return {
    channel_outpoint: channel.channel_outpoint,
    peer_id: channel.pubkey,
    local_balance_shannons: parseBalance(channel.local_balance),
    remote_balance_shannons: parseBalance(channel.remote_balance),
    capacity_shannons: parseBalance(channel.capacity),
    sampled_at: sampledAt,
  };
}

// ─── Polling ────────────────────────────────────────────────────────────────

/**
 * Poll channels once: fetch list_channels, persist a snapshot per channel,
 * recompute drained channels from the latest snapshots, and broadcast a
 * CHANNEL_ALERT when any channel is drained.
 *
 * Gracefully degrades: on RPC failure it logs and returns [] so the interval
 * keeps running.
 */
export async function pollChannels(
  client: FnnClient,
  broadcast: BroadcastFn,
  drainThresholdPct: number = DEFAULT_DRAIN_THRESHOLD_PCT
): Promise<DrainedChannel[]> {
  try {
    const result = await client.listChannels({});
    const channels = result?.channels ?? [];
    const sampledAt = Date.now();
    for (const ch of channels) {
      saveChannelSnapshot(channelToSnapshot(ch, sampledAt));
    }
    const drained = findDrainedChannels(getLatestSnapshots(), drainThresholdPct);
    if (drained.length > 0) {
      broadcast("CHANNEL_ALERT", drained);
    }
    return drained;
  } catch (err: any) {
    console.warn(`[ChannelMonitor] list_channels query failed: ${err.message}`);
    return [];
  }
}

/**
 * Poll peer connectivity once: fetch list_peers + list_channels, derive which
 * channels' peers are not currently connected, and broadcast a
 * PEER_HEALTH_UPDATE with the result (even when empty, so the dashboard can
 * clear a stale disconnected badge).
 *
 * Gracefully degrades: on RPC failure it logs and returns [] so the interval
 * keeps running.
 */
export async function pollPeerHealth(
  client: FnnClient,
  broadcast: BroadcastFn
): Promise<DisconnectedChannel[]> {
  try {
    const [peersResult, channelsResult] = await Promise.all([
      client.listPeers(),
      client.listChannels({}),
    ]);
    const peers = peersResult?.peers ?? [];
    const channels = channelsResult?.channels ?? [];
    const disconnected = findDisconnectedChannels(channels, peers);
    broadcast("PEER_HEALTH_UPDATE", disconnected);
    return disconnected;
  } catch (err: any) {
    console.warn(`[ChannelMonitor] peer health query failed: ${err.message}`);
    return [];
  }
}

/**
 * Start periodic channel + peer monitoring. Runs one poll of each immediately,
 * then repeats on `pollIntervalMs`. Returns the interval handle so the caller
 * can clear it.
 */
export function startChannelMonitor(
  client: FnnClient,
  broadcast: BroadcastFn,
  options: ChannelMonitorOptions = {}
): NodeJS.Timeout {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const drainThresholdPct = options.drainThresholdPct ?? DEFAULT_DRAIN_THRESHOLD_PCT;
  console.log(
    `[ChannelMonitor] Started (interval ${pollIntervalMs}ms, drain threshold ${drainThresholdPct * 100}%).`
  );

  // Kick off an immediate poll so the dashboard is populated on startup.
  void pollChannels(client, broadcast, drainThresholdPct);
  void pollPeerHealth(client, broadcast);

  return setInterval(() => {
    void pollChannels(client, broadcast, drainThresholdPct);
    void pollPeerHealth(client, broadcast);
  }, pollIntervalMs);
}
