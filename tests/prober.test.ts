import { generateProbeHash, classifyProbeResult, runProbe } from "../src/proxy/prober";
import { FnnRpcError } from "../src/proxy/fnnClient";

// ─── generateProbeHash ────────────────────────────────────────────────────────

describe("generateProbeHash", () => {
  test("returns a 64-character hex string", () => {
    const hash = generateProbeHash();
    expect(hash).toHaveLength(64);
    expect(/^[0-9a-f]{64}$/.test(hash)).toBe(true);
  });

  test("two calls return different hashes", () => {
    expect(generateProbeHash()).not.toBe(generateProbeHash());
  });
});

// ─── classifyProbeResult ──────────────────────────────────────────────────────

describe("classifyProbeResult", () => {
  test("IncorrectOrUnknownPaymentDetails → ROUTE_VIABLE", () => {
    expect(classifyProbeResult("IncorrectUnknownPaymentDetails: hash not found")).toBe("ROUTE_VIABLE");
  });

  test("unknown payment hash variant → ROUTE_VIABLE", () => {
    expect(classifyProbeResult("Error: unknown payment hash")).toBe("ROUTE_VIABLE");
  });

  test("incorrect payment details variant → ROUTE_VIABLE", () => {
    expect(classifyProbeResult("incorrect payment details for invoice")).toBe("ROUTE_VIABLE");
  });

  test("TemporaryChannelFailure → ROUTE_BLOCKED", () => {
    expect(classifyProbeResult("TemporaryChannelFailure at hop 1")).toBe("ROUTE_BLOCKED");
  });

  test("NoRouteFound → ROUTE_BLOCKED", () => {
    expect(classifyProbeResult("Send payment error: Failed to build route, no path found")).toBe("ROUTE_BLOCKED");
  });

  test("InsufficientLocalBalance → ROUTE_BLOCKED", () => {
    expect(classifyProbeResult("Insufficient balance: max outbound liquidity 100 is insufficient")).toBe("ROUTE_BLOCKED");
  });

  test("empty string → UNKNOWN", () => {
    expect(classifyProbeResult("")).toBe("UNKNOWN");
  });

  test("unrecognized message → UNKNOWN", () => {
    expect(classifyProbeResult("some completely unexpected error")).toBe("UNKNOWN");
  });
});

// ─── runProbe ─────────────────────────────────────────────────────────────────

function makeClient(sendPaymentImpl: () => Promise<any>) {
  return {
    nodeInfo: jest.fn(),
    decodeInvoice: jest.fn(),
    listChannels: jest.fn(),
    listPeers: jest.fn(),
    getPayment: jest.fn(),
    sendPayment: jest.fn(sendPaymentImpl),
    sendPaymentWithRouter: jest.fn(),
    graphNodes: jest.fn(),
    graphChannels: jest.fn(),
    newInvoice: jest.fn(),
  };
}

describe("runProbe", () => {
  test("ROUTE_VIABLE when FNN returns unknown payment hash error", async () => {
    const client = makeClient(() =>
      Promise.reject(new FnnRpcError(-1, "unknown payment hash"))
    );
    const result = await runProbe(client as any, "fibt1234", "aabbcc");
    expect(result.viable).toBe(true);
    expect(result.classification).toBe("ROUTE_VIABLE");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  test("ROUTE_BLOCKED when FNN returns NoRouteFound", async () => {
    const client = makeClient(() =>
      Promise.reject(new FnnRpcError(-1, "Failed to build route, no path found"))
    );
    const result = await runProbe(client as any, "fibt1234", "aabbcc");
    expect(result.viable).toBe(false);
    expect(result.classification).toBe("ROUTE_BLOCKED");
    expect(result.errorMessage).toContain("no path found");
  });

  test("UNKNOWN classification for unrecognized error", async () => {
    const client = makeClient(() =>
      Promise.reject(new Error("some unexpected internal error"))
    );
    const result = await runProbe(client as any, "fibt1234", "aabbcc");
    expect(result.classification).toBe("UNKNOWN");
    expect(result.viable).toBe(false);
  });

  test("returns viable if sendPayment unexpectedly succeeds", async () => {
    const client = makeClient(() =>
      Promise.resolve({ payment_hash: "0xabc", status: "Success" })
    );
    const result = await runProbe(client as any, "fibt1234", "aabbcc");
    expect(result.viable).toBe(true);
    expect(result.classification).toBe("ROUTE_VIABLE");
  });

  test("latencyMs is a non-negative number", async () => {
    const client = makeClient(() =>
      Promise.reject(new FnnRpcError(-1, "unknown payment hash"))
    );
    const result = await runProbe(client as any, "fibt1234", "aabbcc");
    expect(typeof result.latencyMs).toBe("number");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });
});
