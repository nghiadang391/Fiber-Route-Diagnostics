import path from "path";
import fs from "fs";

const DB_PATH = path.resolve(__dirname, "../../diagnostics_db.json");

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
}

export interface HopRecord {
  payment_hash: string;
  hop_index: number;
  node_pubkey: string;
  channel_outpoint?: string;
  status: "Success" | "Failed" | "Untracked";
}

interface Schema {
  payments: Record<string, PaymentRecord>;
  hops: Record<string, HopRecord[]>;
}

// Read database file safely
function readDb(): Schema {
  try {
    if (!fs.existsSync(DB_PATH)) {
      return { payments: {}, hops: {} };
    }
    const content = fs.readFileSync(DB_PATH, "utf-8");
    return JSON.parse(content) as Schema;
  } catch (err) {
    console.error("[DB] Error reading JSON file, returning empty database:", err);
    return { payments: {}, hops: {} };
  }
}

// Write database file safely
function writeDb(data: Schema) {
  try {
    fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), "utf-8");
  } catch (err) {
    console.error("[DB] Error writing JSON file:", err);
  }
}

export function initDb() {
  console.log(`[DB] Using pure-JS JSON database at: ${DB_PATH}`);
  if (!fs.existsSync(DB_PATH)) {
    writeDb({ payments: {}, hops: {} });
  }
}

export function savePayment(payment: Omit<PaymentRecord, "status" | "created_at">) {
  const db = readDb();
  db.payments[payment.payment_hash] = {
    ...payment,
    status: "Pending",
    created_at: Date.now()
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
) {
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

export function saveHops(paymentHash: string, hops: Omit<HopRecord, "payment_hash">[]) {
  const db = readDb();
  db.hops[paymentHash] = hops.map(h => ({
    ...h,
    payment_hash: paymentHash
  }));
  writeDb(db);
}

export function getPayment(paymentHash: string): PaymentRecord | undefined {
  const db = readDb();
  return db.payments[paymentHash];
}

export function getHops(paymentHash: string): HopRecord[] {
  const db = readDb();
  return db.hops[paymentHash] || [];
}

export function getPaymentWithHops(paymentHash: string) {
  const payment = getPayment(paymentHash);
  if (!payment) return undefined;
  const hops = getHops(paymentHash);
  return { ...payment, hops };
}

export function getAllPayments() {
  const db = readDb();
  const paymentsList = Object.values(db.payments);
  // Sort by created_at DESC
  paymentsList.sort((a, b) => b.created_at - a.created_at);
  
  return paymentsList.map(p => ({
    ...p,
    hops: db.hops[p.payment_hash] || []
  }));
}
