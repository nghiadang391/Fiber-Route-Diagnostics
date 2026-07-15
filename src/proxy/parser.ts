export interface DiagnosticResult {
  code: string;
  suggestion: string;
  failing_hop_index?: number;
  failing_node_pubkey?: string;
}

export function parseFnnError(rawError: string, routeHops: string[] = []): DiagnosticResult {
  const errStr = rawError.trim();

  // 1. Check for local channel capacity limits (Scenario 1)
  const balanceMatch = errStr.match(
    /Insufficient balance: max outbound liquidity (\d+) is insufficient, required amount: (\d+)/i
  );
  if (balanceMatch) {
    const maxOutbound = parseFloat(balanceMatch[1]) / 1e8;
    const required = parseFloat(balanceMatch[2]) / 1e8;
    return {
      code: "InsufficientLocalBalance",
      suggestion: `Your local channel balance is insufficient. The maximum outbound liquidity on this channel is currently ${maxOutbound.toFixed(2)} CKB, but this payment requires ${required.toFixed(2)} CKB. Try funding your channel or wait for incoming balance shifts.`,
      failing_hop_index: 0,
      failing_node_pubkey: routeHops[0] || undefined
    };
  }

  // 2. Check for intermediate onion routing failures (contains failing node, outpoint, code)
  // Example format: "failing node: <pubkey>, channel outpoint: <outpoint>, error code: <code_string>"
  const onionMatch = errStr.match(
    /failing node:\s*([a-fA-F0-9]+),\s*channel outpoint:\s*([a-fA-F0-9x]+),\s*error code:\s*(\w+)/i
  );
  if (onionMatch) {
    const failingNode = onionMatch[1];
    const errorCode = onionMatch[3];
    const hopIndex = routeHops.findIndex(hop => hop.toLowerCase() === failingNode.toLowerCase());

    let suggestion = `The payment failed at routing hop ${failingNode.slice(0, 10)}... with error: "${errorCode}".`;
    if (errorCode === "TemporaryChannelFailure") {
      suggestion += " This node has insufficient outbound balance to forward your payment. Try routing through an alternative path.";
    } else if (errorCode === "AmountBelowMinimum") {
      suggestion += " The payment amount is below the minimum forwarding limit configured by this hop.";
    } else {
      suggestion += " Please check peer channel health and parameters.";
    }

    return {
      code: errorCode,
      suggestion,
      failing_hop_index: hopIndex !== -1 ? hopIndex : undefined,
      failing_node_pubkey: failingNode
    };
  }

  // 3. Expiry too soon (CLTV/TLC expiry constraints)
  // Covers both the internal code path (ExpiryTooSoon) and the RPC-level validation
  // message returned when an already-expired invoice is submitted to FNN.
  if (
    /ExpiryTooSoon/i.test(errStr) ||
    /TlcExpiry/i.test(errStr) ||
    /invoice is expired/i.test(errStr) ||
    /Failed to validate payment request.*expired/i.test(errStr)
  ) {
    return {
      code: "ExpiryTooSoon",
      suggestion: "The payment invoice has expired or the TLC lock time expiry is too small. Either the invoice was generated too long ago, or your FNN node's block height is out of sync with the testnet tip. Generate a fresh invoice and retry."
    };
  }

  // 4. Timeouts (e.g. HoldTlcTimeout)
  if (/HoldTlcTimeout/i.test(errStr) || /TlcTimeout/i.test(errStr)) {
    return {
      code: "HoldTlcTimeout",
      suggestion: "The recipient or an intermediate node took too long to settle the lock. Verify the recipient node is online, connected, and fully synced."
    };
  }

  // 5. General Route build failure
  if (/Failed to build route/i.test(errStr) || /NoRouteFound/i.test(errStr)) {
    return {
      code: "NoRouteFound",
      suggestion: "No path could be constructed to the destination node. Ensure the recipient node is registered in the graph, has active channels, and is connected to the P2P network."
    };
  }

  // 6. Generic FNN parameter validation errors (catch before UnknownError)
  if (/InvalidParameter/i.test(errStr)) {
    return {
      code: "InvalidParameter",
      suggestion: `The payment request was rejected by the FNN node due to a parameter validation error: "${errStr}". Check the invoice format, currency, and expiry.`
    };
  }

  // 6. Generic Fallback
  return {
    code: "UnknownError",
    suggestion: `An unmapped error occurred during routing: "${errStr}". Check node debug logs for details.`
  };
}
