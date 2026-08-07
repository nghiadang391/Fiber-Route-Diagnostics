import crypto from "crypto";
import type { FnnClient } from "./fnnClient";

export type ProbeClassification = "ROUTE_VIABLE" | "ROUTE_BLOCKED" | "UNKNOWN";

export interface ProbeResult {
  viable: boolean;
  classification: ProbeClassification;
  errorCode?: string;
  errorMessage?: string;
  latencyMs: number;
}

/**
 * Generates a random 32-byte hex string to use as an unsettleable payment hash.
 * The recipient cannot pre-image this hash, so the payment will always be
 * rejected at the destination — but only if the route actually reached it.
 */
export function generateProbeHash(): string {
  return crypto.randomBytes(32).toString("hex");
}

/**
 * Classifies the probe outcome from the raw error message or code string.
 *
 * ROUTE_VIABLE   — the route reached the destination; the recipient rejected
 *                  it with IncorrectOrUnknownPaymentDetails because the hash
 *                  is unknown. This is the expected success case for a probe.
 * ROUTE_BLOCKED  — a routing error occurred before reaching the destination.
 * UNKNOWN        — the error does not match any known pattern.
 */
export function classifyProbeResult(errorMessage: string): ProbeClassification {
  if (!errorMessage) return "UNKNOWN";
  const msg = errorMessage.toLowerCase();

  // Destination reached — hash simply unknown to recipient
  if (
    msg.includes("incorrectunknownpaymentdetails") ||
    msg.includes("incorrect_or_unknown_payment_details") ||
    msg.includes("unknown payment hash") ||
    msg.includes("incorrect payment details") ||
    msg.includes("payment_hash does not match") ||
    msg.includes("payment hash does not match")
  ) {
    return "ROUTE_VIABLE";
  }

  // Route-level failures — never reached destination
  if (
    msg.includes("noroutefound") ||
    msg.includes("no route") ||
    msg.includes("failed to build route") ||
    msg.includes("temporarychannelfailure") ||
    msg.includes("insufficient") ||
    msg.includes("amountbelowminimum") ||
    msg.includes("expirytooson") ||
    msg.includes("holdtlctimeout")
  ) {
    return "ROUTE_BLOCKED";
  }

  return "UNKNOWN";
}

/**
 * Sends a probe payment: a real send_payment call with a random hash that
 * the recipient cannot settle. Measures latency and classifies the result.
 *
 * Risk note: the exact FNN error message for "unknown payment hash" is
 * unverified against v0.8.1 — classifyProbeResult covers several plausible
 * variants and falls back to UNKNOWN when none match.
 */
export async function runProbe(
  client: FnnClient,
  invoice: string,
  probeHash: string
): Promise<ProbeResult> {
  const start = Date.now();

  try {
    // Attempt payment — we expect this to fail
    await client.sendPayment({ invoice, payment_hash: probeHash });

    // If it somehow succeeds (should not happen with a random hash),
    // treat as viable since the route clearly works
    return {
      viable: true,
      classification: "ROUTE_VIABLE",
      latencyMs: Date.now() - start,
    };
  } catch (err: any) {
    const msg: string = err.message ?? String(err);
    const classification = classifyProbeResult(msg);
    return {
      viable: classification === "ROUTE_VIABLE",
      classification,
      errorCode: err.code !== undefined ? String(err.code) : undefined,
      errorMessage: msg,
      latencyMs: Date.now() - start,
    };
  }
}
