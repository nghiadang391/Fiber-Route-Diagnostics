import type { PaymentRecord } from "./db";

export interface PaymentStats {
  total: number;
  succeeded: number;
  failed: number;
  pending: number;
  successRate: number;
  failureRate: number;
  topErrorCodes: Array<{ code: string; count: number }>;
  avgFeeCkb: number;
  totalVolumeCkb: number;
}

export function computePaymentStats(payments: PaymentRecord[]): PaymentStats {
  const total = payments.length;
  let succeeded = 0, failed = 0, pending = 0;
  let totalFeeCkb = 0, feeCount = 0, totalVolumeCkb = 0;
  const errorCodeCounts: Record<string, number> = {};

  for (const p of payments) {
    if (p.status === "Success") succeeded++;
    else if (p.status === "Failed") failed++;
    else pending++;

    totalVolumeCkb += p.amount_ckb ?? 0;

    if (p.status === "Success" && p.fee_ckb !== undefined) {
      totalFeeCkb += p.fee_ckb;
      feeCount++;
    }

    if (p.error_code) {
      errorCodeCounts[p.error_code] = (errorCodeCounts[p.error_code] ?? 0) + 1;
    }
  }

  const settled = succeeded + failed;
  const topErrorCodes = Object.entries(errorCodeCounts)
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => b.count - a.count);

  return {
    total,
    succeeded,
    failed,
    pending,
    successRate: settled > 0 ? succeeded / settled : 0,
    failureRate: settled > 0 ? failed / settled : 0,
    topErrorCodes,
    avgFeeCkb: feeCount > 0 ? totalFeeCkb / feeCount : 0,
    totalVolumeCkb,
  };
}
