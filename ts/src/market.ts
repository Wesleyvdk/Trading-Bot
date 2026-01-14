import { ClobClient } from "@polymarket/clob-client";
import type { Market } from "./types";

export async function updateMarkets(client: ClobClient): Promise<Market[]> {
    try {
        console.log("🔎 Fetching markets from Gamma API...");
        // Fetch crypto-related markets (Bitcoin, Ethereum, etc.)
        const response = await fetch("https://gamma-api.polymarket.com/events?limit=100&active=true&closed=false");
        const data = await response.json() as any[];
        
        console.log(`📥 Received ${data.length} events`);

        const newMarkets: Market[] = [];
        
        for (const event of data) {
            if (!event.markets) continue;
            
            for (const market of event.markets) {
                const question = (market.question || "").toLowerCase();
                
                // Filter for crypto price prediction markets
                // Look for BTC/Bitcoin, ETH/Ethereum, etc. price-related markets
                const hasCrypto = question.includes("bitcoin") || 
                                  question.includes("btc") ||
                                  question.includes("ethereum") ||
                                  question.includes("eth");
                
                if (!hasCrypto) continue;
                
                // Markets use clobTokenIds as a JSON string, not a tokens array
                let tokenIds: string[] = [];
                if (market.clobTokenIds) {
                    try {
                        tokenIds = JSON.parse(market.clobTokenIds);
                    } catch (e) {
                        console.error("Failed to parse clobTokenIds:", market.clobTokenIds);
                        continue;
                    }
                }
                
                if (tokenIds.length === 2) {
                    // Parse outcomes from JSON string
                    let outcomes: string[] = [];
                    if (market.outcomes) {
                        try {
                            outcomes = JSON.parse(market.outcomes);
                        } catch (e) {
                            outcomes = ["Yes", "No"];
                        }
                    }
                    
                    newMarkets.push({
                        condition_id: market.conditionId,
                        question_id: market.questionID || market.id,
                        token_ids: tokenIds,
                        outcomes: outcomes,
                        end_date_iso: market.endDate || market.endDateIso,
                        market_type: question.includes("15") ? "15-MIN" : "60-MIN",
                        asset: question.includes("bitcoin") || question.includes("btc") ? "BTC" : "ETH"
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
