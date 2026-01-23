import WebSocket from "ws";
import { CONFIG } from "./config";
import { initializeClient } from "./client";
import { updateMarkets, refetchMissingStrikePrices, countMissingStrikePrices } from "./market";
import { processPriceUpdate } from "./strategy";
import type { Market } from "./types";
import { AssetType } from "@polymarket/clob-client";

let markets: Market[] = [];

async function main() {
    console.log("🚀 Starting Polymarket Bot (TypeScript)...");

    // 1. Initialize Client
    const client = await initializeClient();

    // 2. Fetch Initial Balance
    try {
        const balanceAllowance = await client.getBalanceAllowance({
            asset_type: AssetType.COLLATERAL // USDC balance
        });
        const balanceRaw = parseFloat(balanceAllowance?.balance || "0");
        const balance = balanceRaw / 1_000_000; // Convert from 6 decimals
        console.log(`💰 Initial Balance: $${balance.toFixed(2)}`);
    } catch (e) {
        console.error("⚠️ Could not fetch balance:", e);
    }

    // 3. Market Discovery
    console.log("🔎 Discovering Markets...");
    markets = await updateMarkets(client);

    // Full market refresh every 5 minutes
    setInterval(async () => {
        markets = await updateMarkets(client);
    }, 5 * 60 * 1000);

    // Re-fetch missing strike prices every 30 seconds
    // This catches markets that just started and haven't had their strike price set yet
    setInterval(async () => {
        const missingCount = countMissingStrikePrices(markets);
        if (missingCount > 0) {
            markets = await refetchMissingStrikePrices(markets);
        }
    }, 30 * 1000);

    // 4. Connect to Binance
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
