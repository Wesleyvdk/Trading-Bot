import { ClobClient, Side } from "@polymarket/clob-client";
import { CONFIG } from "./config";

let lastTradeTime = 0;

export async function placeOrder(client: ClobClient, tokenId: string, side: Side, sizeUsd: number) {
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
