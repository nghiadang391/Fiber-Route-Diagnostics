import fs from "fs";

// Mock fs before importing db so the module uses the mock
jest.mock("fs");

const mockFs = fs as jest.Mocked<typeof fs>;

// Reset the db module cache between tests so dbCache is cleared
beforeEach(() => {
  jest.resetModules();
  mockFs.existsSync.mockReturnValue(false);
  mockFs.readFileSync.mockReturnValue(JSON.stringify({ payments: {}, hops: {} }));
  mockFs.writeFileSync.mockImplementation(() => {});
});

function loadDb() {
  return require("../src/proxy/db");
}

describe("initDb + cache", () => {
  test("data saved via savePayment is immediately readable via getAllPayments (cache consistent)", () => {
    const db = loadDb();
    db.initDb();
    db.savePayment({ payment_hash: "0xabc", invoice_address: "fibt1", amount_ckb: 5 });
    db.savePayment({ payment_hash: "0xdef", invoice_address: "fibt2", amount_ckb: 10 });
    const payments = db.getAllPayments();
    expect(payments).toHaveLength(2);
    // The second write didn't lose the first (cache is coherent across writes)
    const hashes = payments.map((p: any) => p.payment_hash);
    expect(hashes).toContain("0xabc");
    expect(hashes).toContain("0xdef");
  });

  test("initDb migrates old DB file lacking new keys", () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(JSON.stringify({ payments: {}, hops: {} }));
    const db = loadDb();
    db.initDb();
    // getLatestSnapshots should work (no crash on missing channel_snapshots key)
    expect(db.getLatestSnapshots()).toEqual([]);
    expect(db.getHopFailureCounts()).toEqual([]);
    expect(db.getAllNodeAliases()).toEqual({});
  });
});

describe("savePayment + getAllPayments", () => {
  test("round-trip: saved payment appears in getAllPayments", () => {
    const db = loadDb();
    db.initDb();
    db.savePayment({ payment_hash: "0xabc", invoice_address: "fibt123", amount_ckb: 10 });
    const payments = db.getAllPayments();
    expect(payments).toHaveLength(1);
    expect(payments[0].payment_hash).toBe("0xabc");
    expect(payments[0].status).toBe("Pending");
  });

  test("getAllPayments sorted newest first", () => {
    const db = loadDb();
    db.initDb();
    // Use jest fake timers to control Date.now()
    jest.spyOn(Date, "now").mockReturnValueOnce(1000).mockReturnValueOnce(2000);
    db.savePayment({ payment_hash: "0x001", invoice_address: "a", amount_ckb: 1 });
    db.savePayment({ payment_hash: "0x002", invoice_address: "b", amount_ckb: 2 });
    jest.restoreAllMocks();
    const payments = db.getAllPayments();
    expect(payments[0].payment_hash).toBe("0x002");
    expect(payments[1].payment_hash).toBe("0x001");
  });
});

describe("updatePaymentStatus", () => {
  test("updates status and details", () => {
    const db = loadDb();
    db.initDb();
    db.savePayment({ payment_hash: "0xabc", invoice_address: "fibt123", amount_ckb: 10 });
    db.updatePaymentStatus("0xabc", "Failed", { errorCode: "NoRouteFound", diagnosticMsg: "No path" });
    const p = db.getPayment("0xabc");
    expect(p.status).toBe("Failed");
    expect(p.error_code).toBe("NoRouteFound");
    expect(p.diagnostic_msg).toBe("No path");
  });

  test("warns but does not throw for unknown hash", () => {
    const db = loadDb();
    db.initDb();
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => db.updatePaymentStatus("0xunknown", "Failed", {})).not.toThrow();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe("channel snapshots", () => {
  const snap = (outpoint: string, at: number) => ({
    channel_outpoint: outpoint,
    peer_id: "0xpeer",
    local_balance_shannons: 100,
    remote_balance_shannons: 900,
    capacity_shannons: 1000,
    sampled_at: at,
  });

  test("saveChannelSnapshot + getChannelSnapshots round-trip", () => {
    const db = loadDb();
    db.initDb();
    db.saveChannelSnapshot(snap("out1", 1000));
    const snaps = db.getChannelSnapshots("out1");
    expect(snaps).toHaveLength(1);
    expect(snaps[0].sampled_at).toBe(1000);
  });

  test("getChannelSnapshots without filter returns all", () => {
    const db = loadDb();
    db.initDb();
    db.saveChannelSnapshot(snap("out1", 1000));
    db.saveChannelSnapshot(snap("out2", 2000));
    expect(db.getChannelSnapshots()).toHaveLength(2);
  });

  test("getLatestSnapshots returns only most-recent per outpoint", () => {
    const db = loadDb();
    db.initDb();
    db.saveChannelSnapshot(snap("out1", 1000));
    db.saveChannelSnapshot(snap("out1", 3000));
    db.saveChannelSnapshot(snap("out2", 2000));
    const latest = db.getLatestSnapshots();
    expect(latest).toHaveLength(2);
    const out1 = latest.find((s: any) => s.channel_outpoint === "out1");
    expect(out1.sampled_at).toBe(3000);
  });

  test("pruneChannelSnapshots removes old entries", () => {
    const db = loadDb();
    db.initDb();
    jest.spyOn(Date, "now").mockReturnValue(10000);
    db.saveChannelSnapshot(snap("out1", 1000));   // old
    db.saveChannelSnapshot(snap("out2", 9000));   // recent
    db.pruneChannelSnapshots(5000); // keep last 5s → cutoff = 5000
    jest.restoreAllMocks();
    const snaps = db.getChannelSnapshots();
    expect(snaps).toHaveLength(1);
    expect(snaps[0].channel_outpoint).toBe("out2");
  });
});

describe("hop failure counts", () => {
  test("first call creates record with fail_count 1", () => {
    const db = loadDb();
    db.initDb();
    db.incrementHopFailure("0xpub1", "TemporaryChannelFailure");
    const counts = db.getHopFailureCounts();
    expect(counts).toHaveLength(1);
    expect(counts[0].fail_count).toBe(1);
    expect(counts[0].error_codes["TemporaryChannelFailure"]).toBe(1);
  });

  test("second call for same pubkey+code increments both", () => {
    const db = loadDb();
    db.initDb();
    db.incrementHopFailure("0xpub1", "TemporaryChannelFailure");
    db.incrementHopFailure("0xpub1", "TemporaryChannelFailure");
    const counts = db.getHopFailureCounts();
    expect(counts[0].fail_count).toBe(2);
    expect(counts[0].error_codes["TemporaryChannelFailure"]).toBe(2);
  });

  test("different error code for same pubkey adds to error_codes map", () => {
    const db = loadDb();
    db.initDb();
    db.incrementHopFailure("0xpub1", "TemporaryChannelFailure");
    db.incrementHopFailure("0xpub1", "AmountBelowMinimum");
    const counts = db.getHopFailureCounts();
    expect(counts[0].fail_count).toBe(2);
    expect(counts[0].error_codes["AmountBelowMinimum"]).toBe(1);
  });

  test("getHopFailureCounts sorted descending by fail_count", () => {
    const db = loadDb();
    db.initDb();
    db.incrementHopFailure("0xpub1", "X");
    db.incrementHopFailure("0xpub2", "X");
    db.incrementHopFailure("0xpub2", "X");
    const counts = db.getHopFailureCounts();
    expect(counts[0].node_pubkey).toBe("0xpub2");
    expect(counts[1].node_pubkey).toBe("0xpub1");
  });
});

describe("node aliases", () => {
  test("saveNodeAlias + getNodeAlias round-trip", () => {
    const db = loadDb();
    db.initDb();
    db.saveNodeAlias("0xpub1", "Alice");
    expect(db.getNodeAlias("0xpub1")).toBe("Alice");
  });

  test("getNodeAlias returns undefined for unknown pubkey", () => {
    const db = loadDb();
    db.initDb();
    expect(db.getNodeAlias("0xunknown")).toBeUndefined();
  });

  test("getAllNodeAliases returns all saved aliases", () => {
    const db = loadDb();
    db.initDb();
    db.saveNodeAlias("0xpub1", "Alice");
    db.saveNodeAlias("0xpub2", "Bob");
    const aliases = db.getAllNodeAliases();
    expect(aliases["0xpub1"]).toBe("Alice");
    expect(aliases["0xpub2"]).toBe("Bob");
  });
});
