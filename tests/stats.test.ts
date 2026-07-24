import { computePaymentStats } from "../src/proxy/stats";
import type { PaymentRecord } from "../src/proxy/db";

function makePayment(overrides: Partial<PaymentRecord>): PaymentRecord {
  return {
    payment_hash: "0xabc",
    invoice_address: "fibt123",
    amount_ckb: 10,
    status: "Pending",
    created_at: 1000,
    ...overrides,
  };
}

describe("computePaymentStats", () => {
  test("empty array returns all zeroes", () => {
    const stats = computePaymentStats([]);
    expect(stats.total).toBe(0);
    expect(stats.succeeded).toBe(0);
    expect(stats.failed).toBe(0);
    expect(stats.pending).toBe(0);
    expect(stats.successRate).toBe(0);
    expect(stats.failureRate).toBe(0);
    expect(stats.avgFeeCkb).toBe(0);
    expect(stats.totalVolumeCkb).toBe(0);
    expect(stats.topErrorCodes).toEqual([]);
  });

  test("all-success array has successRate 1 and failureRate 0", () => {
    const payments = [
      makePayment({ payment_hash: "0x1", status: "Success", fee_ckb: 0.01 }),
      makePayment({ payment_hash: "0x2", status: "Success", fee_ckb: 0.02 }),
    ];
    const stats = computePaymentStats(payments);
    expect(stats.succeeded).toBe(2);
    expect(stats.failed).toBe(0);
    expect(stats.successRate).toBe(1);
    expect(stats.failureRate).toBe(0);
  });

  test("mixed payments count correctly", () => {
    const payments = [
      makePayment({ payment_hash: "0x1", status: "Success" }),
      makePayment({ payment_hash: "0x2", status: "Failed", error_code: "NoRouteFound" }),
      makePayment({ payment_hash: "0x3", status: "Pending" }),
    ];
    const stats = computePaymentStats(payments);
    expect(stats.total).toBe(3);
    expect(stats.succeeded).toBe(1);
    expect(stats.failed).toBe(1);
    expect(stats.pending).toBe(1);
    expect(stats.successRate).toBe(0.5);
    expect(stats.failureRate).toBe(0.5);
  });

  test("topErrorCodes sorted descending by count", () => {
    const payments = [
      makePayment({ payment_hash: "0x1", status: "Failed", error_code: "NoRouteFound" }),
      makePayment({ payment_hash: "0x2", status: "Failed", error_code: "NoRouteFound" }),
      makePayment({ payment_hash: "0x3", status: "Failed", error_code: "InsufficientLocalBalance" }),
    ];
    const stats = computePaymentStats(payments);
    expect(stats.topErrorCodes[0].code).toBe("NoRouteFound");
    expect(stats.topErrorCodes[0].count).toBe(2);
    expect(stats.topErrorCodes[1].code).toBe("InsufficientLocalBalance");
    expect(stats.topErrorCodes[1].count).toBe(1);
  });

  test("avgFeeCkb computed from successful payments with fee only", () => {
    const payments = [
      makePayment({ payment_hash: "0x1", status: "Success", fee_ckb: 0.01 }),
      makePayment({ payment_hash: "0x2", status: "Success", fee_ckb: 0.03 }),
      makePayment({ payment_hash: "0x3", status: "Failed" }), // no fee
    ];
    const stats = computePaymentStats(payments);
    expect(stats.avgFeeCkb).toBeCloseTo(0.02);
  });

  test("totalVolumeCkb sums all payment amounts", () => {
    const payments = [
      makePayment({ payment_hash: "0x1", amount_ckb: 10, status: "Success" }),
      makePayment({ payment_hash: "0x2", amount_ckb: 25, status: "Failed" }),
    ];
    const stats = computePaymentStats(payments);
    expect(stats.totalVolumeCkb).toBe(35);
  });

  test("pending-only payments: successRate and failureRate are 0", () => {
    const payments = [
      makePayment({ payment_hash: "0x1", status: "Pending" }),
    ];
    const stats = computePaymentStats(payments);
    expect(stats.successRate).toBe(0);
    expect(stats.failureRate).toBe(0);
  });
});
