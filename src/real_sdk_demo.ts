import { FiberDiagClient, FiberDiagError } from "./sdk";

async function runDemo() {
  console.log("===============================================================================");
  console.log("                      FIBER ROUTE DIAGNOSTICS SDK DEMO                         ");
  console.log("===============================================================================");

  const client = new FiberDiagClient("http://127.0.0.1:9227");

  // 1. Fetching historical diagnostics logs
  console.log("[1/3] Fetching past diagnostics logs from proxy database...");
  try {
    const list = await client.getAllPayments();
    console.log(`Successfully fetched ${list.length} payment records.`);
    if (list.length > 0) {
      console.log("\nLast logged payment details:");
      const last = list[0];
      console.log(`- Hash: ${last.payment_hash}`);
      console.log(`- Amount: ${last.amount_ckb} CKB`);
      console.log(`- Status: ${last.status}`);
      if (last.status === "Failed") {
        console.log(`- Error Code: ${last.error_code}`);
        console.log(`- Suggestion: ${last.diagnostic_msg}`);
      }
    }
  } catch (err: any) {
    console.error("❌ Failed to query database logs via SDK:", err.message);
  }

  // 2. Triggering a payment that fails immediately (Scenario 1)
  console.log("\n[2/3] Attempting to pay an invoice exceeding local capacity (15,000 CKB)...");
  // This is a testnet invoice address from our Scenario 1 run
  const testnetInvoiceExceeding = "fibt15000000000001pcg7uy03dewgfw0pmm6vkcugjy65k9qn68yu7099t7cwddeyvyngygp6np083gsraxntcg45tkpp6u50vtvq4azagv0ay067japcklkygt0ktfdc2zqgk6ymhv70pmxmyx2l5lvkru2rzq746hjvlcm4t2jmw0xs2xt2drq8xmsjy4y7egaluqhmre6x8nvuvpna5w03ht2xxprl0vy75xdegufn9mchtndzdcz4t639qazxc8vnhw5c008erldcl5agqnly50zu368t08t9pu4hehjl74arhn7dntufnpk7s383fl32262fhtlfegqg0xlx66q4y30s4pnlurp76gatd9dquzcgaeywa0t0px2sq0zrl2h";
  
  try {
    const res = await client.sendPayment(testnetInvoiceExceeding);
    console.log("✅ Success response:", JSON.stringify(res, null, 2));
  } catch (err: any) {
    if (err instanceof FiberDiagError) {
      console.log("\n❌ [INTERCEPTED FAILURE] FiberDiagError caught successfully!");
      console.log(`- Structured Code:   ${err.code}`);
      console.log(`- Failing Hop Index: ${err.failingHopIndex ?? "0 (Local Node A)"}`);
      console.log(`- Developer Advice:  ${err.suggestion}`);
      console.log(`- Raw RPC Response:  ${err.rawError.slice(0, 100)}...`);
    } else {
      console.error("❌ Unexpected Error:", err.message);
    }
  }

  // 3. Triggering a payment that fails asynchronously (Scenario 2)
  console.log("\n[3/3] Attempting to pay an invoice exceeding path capacity (950 CKB)...");
  const testnetInvoiceRouteExceeding = "fibt594099768321pccuuvw33c7gfw0pmm6vkegxsz5zu7pgvpnuw0ppw3l9pxz2dg58zpfn5e6jmsq8gngjwn9cw6ydjnza0l7j4ed632lwfxyqnnz58qgl4svruweq0dpt46d8cfzpt7xr4du2tu7rre42wp6wxt5dmucnzsaqcrn9qg9e3qg0mzqtmn7gmtsgfckhk0wqeqv58jm73yxrtp34t3sr6xhucgwyc7tut3pdpe2hrzp63puc9rpa4mevfq54xdp7cffj4vg74cmj55qtzce7q64mzs8su8wavv93lgdepqhk07gavh66fffd0t0zxjpz8f9m0ecwq2zjkkdn23vpvn36ft5ztt80fdtqpzpf0qtad5035md3pgqzucxhj";

  try {
    const res = await client.sendPayment(testnetInvoiceRouteExceeding);
    console.log("✅ Success response:", JSON.stringify(res, null, 2));
  } catch (err: any) {
    if (err instanceof FiberDiagError) {
      console.log("\n❌ [INTERCEPTED FAILURE] FiberDiagError caught successfully!");
      console.log(`- Structured Code:   ${err.code}`);
      console.log(`- Failing Node PK:   ${err.failingNodePubkey || "Unknown Hop"}`);
      console.log(`- Developer Advice:  ${err.suggestion}`);
    } else {
      console.error("❌ Unexpected Error:", err.message);
    }
  }
}

runDemo();
