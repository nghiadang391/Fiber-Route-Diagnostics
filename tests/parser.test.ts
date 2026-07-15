import { parseFnnError } from "../src/proxy/parser";

// Realistic pubkeys extracted from real testnet runs
const PUBKEY_A = "02a98322491152f69ae17bc1206f3ed04b72d0ca6c48a09a742df30d2884087617"; // Node A (Payer)
const PUBKEY_B = "021df85a50e15ae35aabb8cb92e369954db2adee86dbe834739f2619531ca4080b"; // Node B (Intermediate Hop)
const PUBKEY_D = "033e3752d3e38c2c4fcbb5e4d1bc8bc6bb9952082b25fd1f2d996a5166aa691af4"; // Node D (Recipient)

const routeHops = [PUBKEY_A, PUBKEY_B, PUBKEY_D];

// ─────────────────────────────────────────────────────────────────────────────
// 1. InsufficientLocalBalance (Scenario 1 — Payer's own channel too small)
// ─────────────────────────────────────────────────────────────────────────────
describe("1. InsufficientLocalBalance", () => {
  test("should parse standard synchronous FNN error message", () => {
    const rawError =
      "Send payment error: Failed to build route, Insufficient balance: max outbound liquidity 90000000000 is insufficient, required amount: 1500000000000";
    const result = parseFnnError(rawError, routeHops);

    expect(result.code).toBe("InsufficientLocalBalance");
    expect(result.failing_hop_index).toBe(0);
    expect(result.failing_node_pubkey).toBe(PUBKEY_A);
    // Human-readable amounts should be correct
    expect(result.suggestion).toContain("900.00 CKB");
    expect(result.suggestion).toContain("15000.00 CKB");
  });

  test("should correctly compute fractional CKB amounts", () => {
    const rawError =
      "Send payment error: Failed to build route, Insufficient balance: max outbound liquidity 89951032427 is insufficient, required amount: 94926232576";
    const result = parseFnnError(rawError, routeHops);

    expect(result.code).toBe("InsufficientLocalBalance");
    expect(result.suggestion).toContain("899.51 CKB");
    expect(result.suggestion).toContain("949.26 CKB");
  });

  test("should attribute the failure to Hop 0 even without routeHops provided", () => {
    const rawError =
      "Insufficient balance: max outbound liquidity 100000000 is insufficient, required amount: 200000000";
    const result = parseFnnError(rawError);

    expect(result.code).toBe("InsufficientLocalBalance");
    expect(result.failing_hop_index).toBe(0);
    // No hops provided: node pubkey should be undefined
    expect(result.failing_node_pubkey).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. TemporaryChannelFailure (Intermediate hop — onion error returned by B)
// ─────────────────────────────────────────────────────────────────────────────
describe("2. TemporaryChannelFailure (onion / intermediate hop)", () => {
  test("should identify the failing intermediate node pubkey and hop index", () => {
    const rawError = `failing node: ${PUBKEY_B}, channel outpoint: 0x5fa9b78738f9420d6f53b88777d355e154ae596354e8f64bd94d67af9dc4159f00000000, error code: TemporaryChannelFailure`;
    const result = parseFnnError(rawError, routeHops);

    expect(result.code).toBe("TemporaryChannelFailure");
    expect(result.failing_hop_index).toBe(1);  // B is at index 1
    expect(result.failing_node_pubkey).toBe(PUBKEY_B);
    expect(result.suggestion).toContain("insufficient outbound balance");
  });

  test("should resolve hop index = undefined when failing node is not in routeHops", () => {
    const unknownPubkey = "03abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890ab";
    const rawError = `failing node: ${unknownPubkey}, channel outpoint: 0xdeadbeef00000000, error code: TemporaryChannelFailure`;
    const result = parseFnnError(rawError, routeHops);

    expect(result.code).toBe("TemporaryChannelFailure");
    // Not in our path list — hop index should be undefined
    expect(result.failing_hop_index).toBeUndefined();
    expect(result.failing_node_pubkey).toBe(unknownPubkey);
  });

  test("should perform case-insensitive pubkey matching after audit fix", () => {
    // FNN may return pubkeys in uppercase; our graph stores them lowercase
    const rawError = `failing node: ${PUBKEY_B.toUpperCase()}, channel outpoint: 0x5fa9b78738f9420d6f53b88777d355e154ae596354e8f64bd94d67af9dc4159f00000000, error code: TemporaryChannelFailure`;
    const result = parseFnnError(rawError, routeHops);

    expect(result.code).toBe("TemporaryChannelFailure");
    expect(result.failing_hop_index).toBe(1);  // Must resolve despite uppercase
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. AmountBelowMinimum (Onion error — payment amount too small for hop's min)
// ─────────────────────────────────────────────────────────────────────────────
describe("3. AmountBelowMinimum (onion / intermediate hop)", () => {
  test("should produce AmountBelowMinimum code and useful suggestion", () => {
    const rawError = `failing node: ${PUBKEY_B}, channel outpoint: 0xabc1230000000000, error code: AmountBelowMinimum`;
    const result = parseFnnError(rawError, routeHops);

    expect(result.code).toBe("AmountBelowMinimum");
    expect(result.failing_hop_index).toBe(1);
    expect(result.failing_node_pubkey).toBe(PUBKEY_B);
    expect(result.suggestion).toContain("minimum forwarding limit");
  });

  test("should identify the hop even when it is the last intermediate (close to recipient)", () => {
    // Simulate a 4-hop route: A -> B -> C -> D where C is the failing hop
    const PUBKEY_C = "03aaaa1234abcdef5678901234abcdef5678901234abcdef5678901234abcdef1234";
    const fourHopRoute = [PUBKEY_A, PUBKEY_B, PUBKEY_C, PUBKEY_D];
    const rawError = `failing node: ${PUBKEY_C}, channel outpoint: 0x999900000000, error code: AmountBelowMinimum`;
    const result = parseFnnError(rawError, fourHopRoute);

    expect(result.code).toBe("AmountBelowMinimum");
    expect(result.failing_hop_index).toBe(2);  // C is at index 2
    expect(result.failing_node_pubkey).toBe(PUBKEY_C);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. ExpiryTooSoon (TLC lock time expiry is too small for the routing path)
// ─────────────────────────────────────────────────────────────────────────────
describe("4. ExpiryTooSoon", () => {
  test("should parse standard ExpiryTooSoon string", () => {
    const rawError = "Send payment error: ExpiryTooSoon";
    const result = parseFnnError(rawError);

    expect(result.code).toBe("ExpiryTooSoon");
    expect(result.suggestion).toContain("invoice");
    // Should not attribute to a specific hop
    expect(result.failing_hop_index).toBeUndefined();
    expect(result.failing_node_pubkey).toBeUndefined();
  });

  test("should parse TlcExpiry variant string", () => {
    // Alternative wording FNN may use
    const rawError = "Payment rejected: TlcExpiry constraint violation";
    const result = parseFnnError(rawError);

    expect(result.code).toBe("ExpiryTooSoon");
    expect(result.suggestion).toContain("invoice");
  });

  test("should parse mixed-case ExpiryTooSoon", () => {
    const rawError = "expirytoosoon detected during route evaluation";
    const result = parseFnnError(rawError);

    expect(result.code).toBe("ExpiryTooSoon");
  });

  test("should parse real FNN 'invoice is expired' message (discovered on testnet)", () => {
    // REAL error string returned by FNN v0.9.0-rc7 when submitting an expired invoice
    const rawError = 'InvalidParameter: Failed to validate payment request: "invoice is expired"';
    const result = parseFnnError(rawError);

    expect(result.code).toBe("ExpiryTooSoon");
    expect(result.suggestion).toContain("Generate a fresh invoice");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. HoldTlcTimeout (Recipient or intermediate node did not settle in time)
// ─────────────────────────────────────────────────────────────────────────────
describe("5. HoldTlcTimeout", () => {
  test("should parse standard FNN HoldTlcTimeout log line", () => {
    // Real FNN log format from fiber/payment.rs
    const rawError = "Remove TLCs for payment hash because of error HoldTlcTimeout";
    const result = parseFnnError(rawError);

    expect(result.code).toBe("HoldTlcTimeout");
    expect(result.suggestion).toContain("took too long to settle");
    expect(result.suggestion).toContain("recipient");
  });

  test("should parse generic TlcTimeout variant", () => {
    const rawError = "Payment failed: TlcTimeout after 90 blocks";
    const result = parseFnnError(rawError);

    expect(result.code).toBe("HoldTlcTimeout");
    expect(result.suggestion).toContain("online");
  });

  test("should not attribute HoldTlcTimeout to a specific hop", () => {
    const rawError = "HoldTlcTimeout during settlement";
    const result = parseFnnError(rawError, routeHops);

    expect(result.code).toBe("HoldTlcTimeout");
    // Timeout is a global payment failure — not hop-specific
    expect(result.failing_hop_index).toBeUndefined();
    expect(result.failing_node_pubkey).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. NoRouteFound (Routing engine cannot find any path to destination)
// ─────────────────────────────────────────────────────────────────────────────
describe("6. NoRouteFound", () => {
  test("should parse 'Failed to build route' message", () => {
    const rawError = "Failed to build route";
    const result = parseFnnError(rawError);

    expect(result.code).toBe("NoRouteFound");
    expect(result.suggestion).toContain("No path could be constructed");
  });

  test("should parse 'PathFind error: no path found' — real FNN format from testnet DB", () => {
    // Real error seen in diagnostics_db.json from testnet run
    const rawError = "Send payment error: Failed to build route, PathFind error: no path found";
    const result = parseFnnError(rawError);

    expect(result.code).toBe("NoRouteFound");
    expect(result.suggestion).toContain("active channels");
  });

  test("should parse 'Build payment route error' variant", () => {
    // Second real variant seen in diagnostics_db.json
    const rawError = "Build payment route error: Failed to build route, PathFind error: no path found";
    const result = parseFnnError(rawError);

    expect(result.code).toBe("NoRouteFound");
  });

  test("should not attribute NoRouteFound to a specific hop or node", () => {
    const rawError = "NoRouteFound to destination node";
    const result = parseFnnError(rawError, routeHops);

    expect(result.code).toBe("NoRouteFound");
    expect(result.failing_hop_index).toBeUndefined();
    expect(result.failing_node_pubkey).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. UnknownError Fallback
// ─────────────────────────────────────────────────────────────────────────────
describe("7. UnknownError fallback", () => {
  test("should include the raw message in the suggestion", () => {
    const rawError = "Some unexpected network failure occurred";
    const result = parseFnnError(rawError);

    expect(result.code).toBe("UnknownError");
    expect(result.suggestion).toContain("Some unexpected network failure occurred");
  });

  test("should handle empty string gracefully", () => {
    const result = parseFnnError("");

    expect(result.code).toBe("UnknownError");
    expect(result.suggestion).toBeDefined();
  });

  test("should not produce a hop index for unknown errors", () => {
    const result = parseFnnError("some random FNN internal error", routeHops);

    expect(result.code).toBe("UnknownError");
    expect(result.failing_hop_index).toBeUndefined();
    expect(result.failing_node_pubkey).toBeUndefined();
  });
});
