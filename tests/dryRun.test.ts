import { createFnnClient, FnnRpcError } from "../src/proxy/fnnClient";
import { parseFnnError } from "../src/proxy/parser";

// Reuse the same mock pattern as fnnClient.test.ts
const makeClient = (mockFn: jest.Mock) =>
  createFnnClient({ rpcUrl: "http://mock", postFn: mockFn });

const ok = (result: any) =>
  Promise.resolve({ data: { jsonrpc: "2.0", id: 1, result } });

const rpcErr = (message: string, code = -1) =>
  Promise.resolve({ data: { jsonrpc: "2.0", id: 1, error: { code, message } } });

describe("dry-run via fnnClient.sendPayment", () => {
  let mock: jest.Mock;
  beforeEach(() => { mock = jest.fn(); });

  test("passes dry_run:true to FNN", async () => {
    mock.mockResolvedValueOnce(await ok({ payment_hash: "0xhash", status: "Success" }));
    const client = makeClient(mock);
    const result = await client.sendPayment({ invoice: "fibt1234", dry_run: true });
    expect(result.payment_hash).toBe("0xhash");
    expect(mock).toHaveBeenCalledWith("http://mock", expect.objectContaining({
      params: [{ invoice: "fibt1234", dry_run: true }]
    }));
  });

  test("throws FnnRpcError on routing failure", async () => {
    const errMsg = "Send payment error: Failed to build route, Insufficient balance: max outbound liquidity 90000000000 is insufficient, required amount: 1500000000000";
    mock.mockResolvedValueOnce(await rpcErr(errMsg));
    const client = makeClient(mock);
    await expect(client.sendPayment({ invoice: "fibt1234", dry_run: true }))
      .rejects.toThrow(FnnRpcError);
  });

  test("error message from dry-run parses correctly via parseFnnError", () => {
    const errMsg = "Send payment error: Failed to build route, Insufficient balance: max outbound liquidity 90000000000 is insufficient, required amount: 1500000000000";
    const diag = parseFnnError(errMsg);
    expect(diag.code).toBe("InsufficientLocalBalance");
    expect(diag.suggestion).toContain("900.00 CKB");
  });

  test("NoRouteFound error parses correctly", () => {
    const errMsg = "Send payment error: Failed to build route, no path found";
    const diag = parseFnnError(errMsg);
    expect(diag.code).toBe("NoRouteFound");
  });

  test("unsupported dry_run message detected by regex", () => {
    const msgs = [
      "unknown field `dry_run`",
      "invalid param: dry_run",
      "unrecognized field dry_run",
    ];
    const pattern = /unknown field|invalid param|unrecognized/i;
    for (const msg of msgs) {
      expect(pattern.test(msg)).toBe(true);
    }
  });

  test("normal routing error does NOT match unsupported pattern", () => {
    const msg = "Send payment error: Failed to build route, no path found";
    expect(/unknown field|invalid param|unrecognized/i.test(msg)).toBe(false);
  });
});
