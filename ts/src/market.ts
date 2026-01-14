import { ClobClient } from "@polymarket/clob-client";
import type { Market } from "./types";

export async function updateMarkets(client: ClobClient): Promise<Market[]> {
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
        
        console.log(`✅ Updated Market Cache: ${newMarkets.length} markets found`);
        if (newMarkets.length > 0) {
            console.log(`   Example: ${newMarkets[0].question_id} (Outcomes: ${newMarkets[0].outcomes})`);
        }
        
        return newMarkets;
    } catch (e) {
        console.error("❌ Failed to update markets:", e);
        return [];
    }
}
