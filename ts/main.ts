import { ClobClient, OrderType, Side } from "@polymarket/clob-client";
import { Wallet } from "ethers";
import * as dotenv from "dotenv";
import WebSocket from "ws";
import path from "path";

// Load .env from parent directory
dotenv.config({ path: path.resolve(__dirname, "../.env") });

// Configuration
const CONFIG = {
    BINANCE_WS_URL: process.env.BINANCE_WS_URL || "wss://stream.binance.com:9443/ws/btcusdt@trade",
    POLYMARKET_CLOB_URL: process.env.POLYMARKET_CLOB_URL || "https://clob.polymarket.com",
    CHAIN_ID: 137, // Polygon
    MOMENTUM_WINDOW_15M: 15,
    MOMENTUM_WINDOW_60M: 60,
    THRESHOLD_15M: 0.003, // 0.3%
    THRESHOLD_60M: 0.005, // 0.5%
    TRADE_SIZE_USD: 10, // $10 per trade
    LIVE_MODE: true, // Set to false for dry run
};

// Types
interface Market {
    condition_id: string;
    question_id: string;
    token_ids: string[]; // [YES, NO]
    outcomes: string[];
    end_date_iso: string;
    market_type: "15-MIN" | "60-MIN";
    asset: string;
}

interface PricePoint {
    price: number;
    timestamp: number;
}

// State
let prices: PricePoint[] = [];
let markets: Market[] = [];
let lastTradeTime = 0;

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
    await updateMarkets(client);
    setInterval(() => updateMarkets(client), 5 * 60 * 1000);

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

            processPriceUpdate(price, time, client);
        } catch (e) {
            console.error("Error parsing WS message:", e);
        }
    });

    ws.on("error", (err) => {
        console.error("WS Error:", err);
    });
}

async function updateMarkets(client: ClobClient) {
    try {
        console.log("🔎 Fetching markets from Gamma API...");
        const response = await fetch("https://gamma-api.polymarket.com/events?limit=50&active=true&closed=false&parent_slug_ne=banned&slug_contains=bitcoin");
        const data = await response.json() as any[];
        
        console.log(`📥 Received ${data.length} events`);

        const newMarkets: Market[] = [];
        
        for (const event of data) {
            for (const market of event.markets) {
                if (!market.question.toLowerCase().includes("bitcoin")) continue;
                
                if (market.tokens && market.tokens.length === 2) {
                    newMarkets.push({
                        condition_id: market.conditionId,
                        question_id: market.questionID,
                        token_ids: [market.tokens[0].tokenId, market.tokens[1].tokenId],
                        outcomes: JSON.parse(market.outcomes),
                        end_date_iso: market.endDate,
                        market_type: "15-MIN", 
                        asset: "BTC"
                    });
                }
            }
        }
        
        markets = newMarkets;
        console.log(`✅ Updated Market Cache: ${markets.length} markets found`);
        if (markets.length > 0) {
            console.log(`   Example: ${markets[0].question_id} (Outcomes: ${markets[0].outcomes})`);
        }
        
    } catch (e) {
        console.error("❌ Failed to update markets:", e);
    }
}

async function processPriceUpdate(price: number, time: number, client: ClobClient) {
    const now = Date.now();
    prices.push({ price, timestamp: now });
    
    // Prune old data (> 70 mins)
    const cutoff = now - 70 * 60 * 1000;
    while (prices.length > 0 && prices[0].timestamp < cutoff) {
        prices.shift();
    }

    if (prices.length < 10) return;

    const current = prices[prices.length - 1];
    const currentPrice = current.price;

    const target15 = now - CONFIG.MOMENTUM_WINDOW_15M * 60 * 1000;
    const target60 = now - CONFIG.MOMENTUM_WINDOW_60M * 60 * 1000;

    const p15 = findPriceAtTime(target15);
    const p60 = findPriceAtTime(target60);

    if (!p15 || !p60) return;

    const mom15 = (currentPrice - p15.price) / p15.price;
    const mom60 = (currentPrice - p60.price) / p60.price;

    if (Math.random() < 0.01) {
        console.log(`[STRATEGY] BTC: $${currentPrice.toFixed(2)} | Mom15: ${(mom15*100).toFixed(4)}% | Mom60: ${(mom60*100).toFixed(4)}%`);
    }

    if (Math.abs(mom15) > CONFIG.THRESHOLD_15M) {
        if (markets.length === 0) return;
        
        const market = markets[0]; 
        const tokenID = mom15 > 0 ? market.token_ids[0] : market.token_ids[1];
        
        await placeOrder(client, tokenID, Side.BUY, CONFIG.TRADE_SIZE_USD);
    }
}

function findPriceAtTime(timestamp: number): PricePoint | null {
    for (const p of prices) {
        if (p.timestamp >= timestamp) {
            return p;
        }
    }
    return null;
}

async function placeOrder(client: ClobClient, tokenId: string, side: Side, sizeUsd: number) {
    if (Date.now() - lastTradeTime < 5000) return;
    lastTradeTime = Date.now();

    console.log(`[EXEC] Placing Order: ${side} $${sizeUsd} on ${tokenId}`);
    
    if (!CONFIG.LIVE_MODE) {
        console.log("DRY RUN: Order skipped");
        return;
    }

    try {
        const price = 0.50; // TODO: Fetch order book
        const size = sizeUsd / price; 
        
        const order = await client.createOrder({
            tokenID: tokenId,
            price: price,
            side: side,
            size: size,
            feeRateBps: 0,
            nonce: 0, 
        });
        
        const resp = await client.postOrder(order);
        console.log("✅ Order Placed:", resp);
        
    } catch (e) {
        console.error("❌ Order Failed:", e);
    }
}

main().catch(console.error);