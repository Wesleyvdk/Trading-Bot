import { ClobClient, Side } from "@polymarket/clob-client";
import { CONFIG } from "./config";
import type { Market, PricePoint } from "./types";
import { placeOrder } from "./execution";

let prices: PricePoint[] = [];

export async function processPriceUpdate(
    price: number, 
    time: number, 
    client: ClobClient,
    markets: Market[]
) {
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
