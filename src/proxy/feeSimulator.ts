import type { FnnClient, GraphChannelInfo } from "./fnnClient";
import { buildApproximateHops } from "./routing";

export interface RouteFeeEstimate {
  route: string[];               // ordered node pubkeys, payer → recipient
  channel_outpoints: string[];   // one per hop; empty string where unresolved
  total_fee_shannons: number;
  confidence: "graph_data" | "approximated";
}

// Fallback fee rate (parts-per-million) used when a hop's channel isn't found
// in graph_channels data — field names/units are unverified (see risk register).
const DEFAULT_FEE_RATE_PPM = 1000;

function parseFeeRate(rate: string | undefined): number {
  if (!rate) return DEFAULT_FEE_RATE_PPM;
  const n = parseInt(rate, 16);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_FEE_RATE_PPM;
}

/**
 * Estimate total routing fees for each candidate route.
 * Pure function: takes routes + graph channel data, no RPC calls.
 * `confidence` is "graph_data" only when every hop resolved to a real
 * graph channel with a fee rate; otherwise "approximated".
 */
export function estimateRouteFees(
  routes: string[][],
  graphChannels: GraphChannelInfo[],
  amountShannons: number
): RouteFeeEstimate[] {
  const channelByPair = new Map<string, GraphChannelInfo>();
  for (const ch of graphChannels) {
    channelByPair.set(`${ch.node1}|${ch.node2}`, ch);
    channelByPair.set(`${ch.node2}|${ch.node1}`, ch);
  }

  return routes.map(route => {
    let totalFee = 0;
    let allResolved = route.length > 1;
    const outpoints: string[] = [];

    for (let i = 0; i < route.length - 1; i++) {
      const from = route[i];
      const to = route[i + 1];
      const ch = channelByPair.get(`${from}|${to}`);

      if (ch) {
        outpoints.push(ch.channel_outpoint);
        const rate = ch.node1 === from ? parseFeeRate(ch.node1_fee_rate) : parseFeeRate(ch.node2_fee_rate);
        totalFee += Math.round((amountShannons * rate) / 1_000_000);
      } else {
        outpoints.push("");
        allResolved = false;
        totalFee += Math.round((amountShannons * DEFAULT_FEE_RATE_PPM) / 1_000_000);
      }
    }

    return {
      route,
      channel_outpoints: outpoints,
      total_fee_shannons: totalFee,
      confidence: allResolved ? "graph_data" : "approximated",
    };
  });
}

/**
 * Find up to `maxRoutes` candidate paths payer → recipient.
 * Prefers BFS over graph_channels topology; falls back to the single
 * approximate hop path (buildApproximateHops) when graph_channels is
 * unavailable/unsupported or yields no path.
 */
export async function getCandidateRoutes(
  client: FnnClient,
  payerNodeId: string,
  recipientId: string,
  maxRoutes: number = 3
): Promise<string[][]> {
  try {
    const graphResult = await client.graphChannels();
    const graphChannels = graphResult?.channels ?? [];
    if (graphChannels.length > 0) {
      const routes = bfsRoutes(payerNodeId, recipientId, graphChannels, maxRoutes);
      if (routes.length > 0) return routes;
    }
  } catch {
    // graph_channels not supported or FNN unreachable — fall back below
  }

  const listResult = await client.listChannels({});
  const approx = buildApproximateHops(payerNodeId, recipientId, listResult?.channels ?? []);
  return [approx];
}

function bfsRoutes(
  start: string,
  end: string,
  graphChannels: GraphChannelInfo[],
  maxRoutes: number,
  maxDepth: number = 4
): string[][] {
  const adj = new Map<string, string[]>();
  for (const ch of graphChannels) {
    if (!adj.has(ch.node1)) adj.set(ch.node1, []);
    if (!adj.has(ch.node2)) adj.set(ch.node2, []);
    adj.get(ch.node1)!.push(ch.node2);
    adj.get(ch.node2)!.push(ch.node1);
  }

  const routes: string[][] = [];
  const queue: string[][] = [[start]];

  while (queue.length > 0 && routes.length < maxRoutes) {
    const path = queue.shift()!;
    const node = path[path.length - 1];

    if (node === end && path.length > 1) {
      routes.push(path);
      continue;
    }
    if (path.length - 1 >= maxDepth) continue;

    for (const neighbor of adj.get(node) ?? []) {
      if (path.includes(neighbor)) continue; // no cycles
      queue.push([...path, neighbor]);
    }
  }

  return routes;
}
