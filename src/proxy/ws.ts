import { WebSocketServer, WebSocket } from "ws";
import { Server } from "http";
import { getAllPayments } from "./db";

let wss: WebSocketServer;
const clients = new Set<WebSocket>();

export function initWebSocketServer(server: Server) {
  wss = new WebSocketServer({ server });

  wss.on("connection", (ws: WebSocket) => {
    clients.add(ws);
    console.log(`[WS] Client connected. Total clients: ${clients.size}`);

    // Send historical payments to the newly connected client
    try {
      const history = getAllPayments();
      ws.send(
        JSON.stringify({
          type: "PAYMENT_HISTORY",
          payload: history
        })
      );
    } catch (err) {
      console.error("[WS] Failed to send history to client:", err);
    }

    ws.on("close", () => {
      clients.delete(ws);
      console.log(`[WS] Client disconnected. Total clients: ${clients.size}`);
    });

    ws.on("error", (err) => {
      console.error("[WS] Socket error:", err);
      clients.delete(ws);
    });
  });

  console.log("[WS] WebSocket Server initialized.");
}

export function broadcastRaw(type: string, payload: any): void {
  if (!wss) return;
  const message = JSON.stringify({ type, payload });
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
}

export function broadcastPaymentUpdate(payload: any): void {
  console.log(`[WS] Broadcasting update for payment: ${payload?.payment_hash}`);
  broadcastRaw("PAYMENT_UPDATE", payload);
}
