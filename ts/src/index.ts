import WebSocket from "ws";
import { CONFIG } from "./config";
import { initializeClient } from "./client";
import { updateMarkets } from "./market";
import { processPriceUpdate } from "./strategy";
import type { Market } from "./types";

let markets: Market[] = [];

async function main() {
    console.log("🚀 Starting Polymarket Bot (TypeScript)...");

    // 1. Initialize Client
    const client = await initializeClient();

    // 2. Market Discovery
    console.log("🔎 Discovering Markets...");
    markets = await updateMarkets(client);
    setInterval(async () => {
        markets = await updateMarkets(client);
    }, 5 * 60 * 1000);

    // 3. Connect to Binance
    console.log(`Connecting to ${CONFIG.BINANCE_WS_URL}...`);
    const ws = new WebSocket(CONFIG.BINANCE_WS_URL);

    ws.on("open", () => {
        console.log("✅ Connected to Binance WebSocket");
    });

    ws.on("message", async (data: string) => {
        try {
            const msg = JSON.parse(data);
            const price = parseFloat(msg.p);
            const time = msg.T; // Trade time

            await processPriceUpdate(price, time, client, markets);
        } catch (e) {
            console.error("Error parsing WS message:", e);
        }
    });

    ws.on("error", (err) => {
        console.error("WS Error:", err);
    });
}

main().catch(console.error);
