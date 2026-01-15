import { ClobClient, Side } from "@polymarket/clob-client";
import { CONFIG } from "./config";

let lastTradeTime = 0;

/**
 * Place an order on Polymarket
 * @param client - The CLOB client
 * @param tokenId - The token ID to trade
 * @param side - BUY or SELL
 * @param sizeUsd - Size in USD
 * @param price - The share price (from orderbook)
 */
export async function placeOrder(
    client: ClobClient, 
    tokenId: string, 
    side: Side, 
    sizeUsd: number,
    price: number
) {
    // Rate limit check
    if (Date.now() - lastTradeTime < 5000) {
        console.log("⏳ Rate limited - skipping order");
        return;
    }
    lastTradeTime = Date.now();

    // Calculate number of shares we can buy
    const size = sizeUsd / price;
    
    console.log(`[EXEC] ${side} ${size.toFixed(2)} shares @ $${price.toFixed(3)} = $${sizeUsd.toFixed(2)} total`);
    console.log(`       Token: ${tokenId.slice(0, 30)}...`);
    
    if (!CONFIG.LIVE_MODE) {
        console.log("🔶 DRY RUN: Order not submitted");
        return;
    }

    try {
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

/**
 * Place a market order (uses best available price)
 * This is a convenience wrapper that fetches the current price first
 */
export async function placeMarketOrder(
    client: ClobClient,
    tokenId: string,
    side: Side,
    sizeUsd: number
) {
    // For market orders, we need to fetch the current orderbook
    // This is handled by the caller in strategy.ts
    console.warn("⚠️ placeMarketOrder called without price - use placeOrder with explicit price");
}
