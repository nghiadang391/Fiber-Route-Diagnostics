import type { FnnClient, FnnRpcError } from "./fnnClient";
import { saveNodeAlias, getAllNodeAliases } from "./db";

/**
 * Fetch graph nodes from FNN and store aliases in the DB.
 * Silently swallows FnnRpcError — if graph_nodes is not supported by this
 * FNN version, the feature degrades gracefully to raw pubkey display.
 */
export async function refreshNodeAliases(client: FnnClient): Promise<void> {
  try {
    const result = await client.graphNodes();
    const nodes = result?.nodes ?? [];
    for (const node of nodes) {
      if (node.node_id) {
        // Use alias if present, otherwise fall back to a short pubkey label
        const alias = node.alias?.trim() || shortPubkey(node.node_id);
        saveNodeAlias(node.node_id, alias);
      }
    }
    console.log(`[NodeRegistry] Refreshed ${nodes.length} node alias(es).`);
  } catch (err: any) {
    // Graceful degrade: graph_nodes not supported or FNN unreachable
    console.warn(`[NodeRegistry] graph_nodes query failed — aliases unavailable: ${err.message}`);
  }
}

/** Returns alias from the map, or a truncated pubkey as fallback. */
export function resolveAlias(pubkey: string, aliases: Record<string, string>): string {
  return aliases[pubkey] ?? shortPubkey(pubkey);
}

function shortPubkey(pubkey: string): string {
  return pubkey.length > 12 ? pubkey.slice(0, 8) + "…" : pubkey;
}
