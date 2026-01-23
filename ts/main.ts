// @ts-nocheck
import { ClobClient } from "@polymarket/clob-client";
import { Wallet } from "ethers";
import * as dotenv from "dotenv";
import WebSocket from "ws";
import path from "path";

// Import modules
import { CONFIG } from "./src/config";
import { updateMarkets } from "./src/market";
import { processPriceUpdate } from "./src/strategy";
import type { Market } from "./src/types";

// Load .env from parent directory
dotenv.config({ path: path.resolve(__dirname, "../.env") });

// State
let markets: Market[] = [];

async function main() {
    console.log("🚀 Starting Polymarket Bot (TypeScript)...");

    // 1. Initialize Signer
    const privateKey = process.env.POLYMARKET_PRIVATE_KEY;
    if (!privateKey) throw new Error("Missing POLYMARKET_PRIVATE_KEY");
    const signer = new Wallet(privateKey);
    console.log(`🔑 Signer: ${signer.address}`);

    // 2. Initialize CLOB Client
    const apiKey = process.env.POLYMARKET_API_KEY;
    const apiSecret = process.env.POLYMARKET_API_SECRET;
    const passphrase = process.env.POLYMARKET_PASSPHRASE;

    let client: ClobClient;

    if (apiKey && apiSecret && passphrase) {
        console.log("✅ Using provided L2 API Credentials");
        client = new ClobClient(
            CONFIG.POLYMARKET_CLOB_URL,
            CONFIG.CHAIN_ID,
            signer,
            {
                key: apiKey,
                secret: apiSecret,
                passphrase: passphrase,
            }
        );
    } else {
        console.log("⚠️ No L2 Credentials found in env. Deriving from Private Key...");
        client = new ClobClient(
            CONFIG.POLYMARKET_CLOB_URL,
            CONFIG.CHAIN_ID,
            signer
        );
        try {
            const creds = await client.deriveApiKey();
            console.log("✅ Derived L2 Credentials");
        } catch (e) {
            console.error("❌ Failed to derive API keys:", e);
        }
    }

    // 3. Market Discovery
    console.log("🔎 Discovering Markets...");
    markets = await updateMarkets(client);
    
    // Refresh markets every 10 minutes
    setInterval(async () => {
        markets = await updateMarkets(client);
    }, 10 * 60 * 1000);

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

            // Pass to strategy
            await processPriceUpdate(price, time, client, markets);
        } catch (e) {
            console.error("Error parsing WS message:", e);
        }
    });

    ws.on("error", (err) => {
        console.error("WS Error:", err);
    });
    
    ws.on("close", () => {
        console.log("⚠️ Binance WebSocket closed. Reconnecting...");
        setTimeout(main, 5000); // Simple reconnect
    });
}

main().catch(console.error);