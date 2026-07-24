import path from "path";
import fs from "fs";

const DB_PATH = path.resolve(__dirname, "../../diagnostics_db.json");

// ─── Record interfaces ────────────────────────────────────────────────────────

export interface PaymentRecord {
  payment_hash: string;
  invoice_address: string;
  amount_ckb: number;
  status: "Pending" | "Success" | "Failed";
  fee_ckb?: number;
  error_raw?: string;
  error_code?: string;
  diagnostic_msg?: string;
  created_at: number;
  retry_policy?: {
    max_attempts: number;
    attempt_count: number;
    excluded_outpoints: string[];
  };
}

export interface HopRecord {
  payment_hash: string;
  hop_index: number;
  node_pubkey: string;
  channel_outpoint?: string;
  status: "Success" | "Failed" | "Untracked";
}

export interface ChannelSnapshot {
  channel_outpoint: string;
  peer_id: string;
  local_balance_shannons: number;
  remote_balance_shannons: number;
  capacity_shannons: number;
  sampled_at: number;
}

export interface HopFailureCount {
  node_pubkey: string;
  fail_count: number;
  last_failed_at: number;
  error_codes: Record<string, number>;
}

// ─── Schema ───────────────────────────────────────────────────────────────────

interface Schema {
  payments: Record<string, PaymentRecord>;
  hops: Record<string, HopRecord[]>;
  channel_snapshots: ChannelSnapshot[];
  hop_failure_counts: Record<string, HopFailureCount>;
  node_aliases: Record<string, string>;
}

const EMPTY_SCHEMA: Schema = {
  payments: {},
  hops: {},
  channel_snapshots: [],
  hop_failure_counts: {},
  node_aliases: {},
};

// ─── In-memory cache ──────────────────────────────────────────────────────────

let dbCache: Schema | null = null;

function readDb(): Schema {
  if (dbCache) return dbCache;
  try {
    if (!fs.existsSync(DB_PATH)) {
      dbCache = { ...EMPTY_SCHEMA };
      return dbCache;
    }
    const content = fs.readFileSync(DB_PATH, "utf-8");
    const parsed = JSON.parse(content) as Partial<Schema>;
    // Backward-compatible migration: add missing keys for existing DB files
    dbCache = {
      payments: parsed.payments ?? {},
      hops: parsed.hops ?? {},
      channel_snapshots: parsed.channel_snapshots ?? [],
      hop_failure_counts: parsed.hop_failure_counts ?? {},
      node_aliases: parsed.node_aliases ?? {},
    };
    return dbCache;
  } catch (err) {
    console.error("[DB] Error reading JSON file, returning empty database:", err);
    dbCache = { ...EMPTY_SCHEMA };
    return dbCache;
  }
}

function writeDb(data: Schema): void {
  dbCache = data;
  try {
    fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), "utf-8");
  } catch (err) {
    console.error("[DB] Error writing JSON file:", err);
  }
}

// ─── Init ─────────────────────────────────────────────────────────────────────

export function initDb(): void {
  console.log(`[DB] Using pure-JS JSON database at: ${DB_PATH}`);
  const db = readDb(); // populates cache (runs migration if file exists)
  if (!fs.existsSync(DB_PATH)) {
    writeDb(db);
  }
}

// ─── Payments ─────────────────────────────────────────────────────────────────

export function savePayment(payment: Omit<PaymentRecord, "status" | "created_at">): void {
  const db = readDb();
  db.payments[payment.payment_hash] = {
    ...payment,
    status: "Pending",
    created_at: Date.now(),
  };
  writeDb(db);
}

export function updatePaymentStatus(
  paymentHash: string,
  status: "Success" | "Failed",
  details: {
    feeCkb?: number;
    errorRaw?: string;
    errorCode?: string;
    diagnosticMsg?: string;
  }
): void {
  const db = readDb();
  const payment = db.payments[paymentHash];
  if (payment) {
    payment.status = status;
    if (details.feeCkb !== undefined) payment.fee_ckb = details.feeCkb;
    if (details.errorRaw !== undefined) payment.error_raw = details.errorRaw;
    if (details.errorCode !== undefined) payment.error_code = details.errorCode;
    if (details.diagnosticMsg !== undefined) payment.diagnostic_msg = details.diagnosticMsg;
    writeDb(db);
  } else {
    console.warn(`[DB] Attempted to update non-existent payment: ${paymentHash}`);
  }
}

export function saveHops(paymentHash: string, hops: Omit<HopRecord, "payment_hash">[]): void {
  const db = readDb();
  db.hops[paymentHash] = hops.map(h => ({ ...h, payment_hash: paymentHash }));
  writeDb(db);
}

export function getPayment(paymentHash: string): PaymentRecord | undefined {
  return readDb().payments[paymentHash];
}

export function getHops(paymentHash: string): HopRecord[] {
  return readDb().hops[paymentHash] || [];
}

export function getPaymentWithHops(paymentHash: string) {
  const payment = getPayment(paymentHash);
  if (!payment) return undefined;
  return { ...payment, hops: getHops(paymentHash) };
}

export function getAllPayments() {
  const db = readDb();
  const list = Object.values(db.payments);
  list.sort((a, b) => b.created_at - a.created_at);
  return list.map(p => ({ ...p, hops: db.hops[p.payment_hash] || [] }));
}

// ─── Channel snapshots ────────────────────────────────────────────────────────

export function saveChannelSnapshot(snapshot: ChannelSnapshot): void {
  const db = readDb();
  db.channel_snapshots.push(snapshot);
  writeDb(db);
}

export function getChannelSnapshots(channelOutpoint?: string): ChannelSnapshot[] {
  const snaps = readDb().channel_snapshots;
  return channelOutpoint
    ? snaps.filter(s => s.channel_outpoint === channelOutpoint)
    : snaps;
}

export function getLatestSnapshots(): ChannelSnapshot[] {
  const snaps = readDb().channel_snapshots;
  const latest = new Map<string, ChannelSnapshot>();
  for (const s of snaps) {
    const existing = latest.get(s.channel_outpoint);
    if (!existing || s.sampled_at > existing.sampled_at) {
      latest.set(s.channel_outpoint, s);
    }
  }
  return Array.from(latest.values());
}

export function pruneChannelSnapshots(maxAgeMs: number): void {
  const db = readDb();
  const cutoff = Date.now() - maxAgeMs;
  db.channel_snapshots = db.channel_snapshots.filter(s => s.sampled_at >= cutoff);
  writeDb(db);
}

// ─── Hop failure counts ───────────────────────────────────────────────────────

export function incrementHopFailure(nodePubkey: string, errorCode: string): void {
  const db = readDb();
  const existing = db.hop_failure_counts[nodePubkey];
  if (existing) {
    existing.fail_count += 1;
    existing.last_failed_at = Date.now();
    existing.error_codes[errorCode] = (existing.error_codes[errorCode] ?? 0) + 1;
  } else {
    db.hop_failure_counts[nodePubkey] = {
      node_pubkey: nodePubkey,
      fail_count: 1,
      last_failed_at: Date.now(),
      error_codes: { [errorCode]: 1 },
    };
  }
  writeDb(db);
}

export function getHopFailureCounts(): HopFailureCount[] {
  const counts = Object.values(readDb().hop_failure_counts);
  return counts.sort((a, b) => b.fail_count - a.fail_count);
}

// ─── Node aliases ─────────────────────────────────────────────────────────────

export function saveNodeAlias(pubkey: string, alias: string): void {
  const db = readDb();
  db.node_aliases[pubkey] = alias;
  writeDb(db);
}

export function getNodeAlias(pubkey: string): string | undefined {
  return readDb().node_aliases[pubkey];
}

export function getAllNodeAliases(): Record<string, string> {
  return { ...readDb().node_aliases };
}
