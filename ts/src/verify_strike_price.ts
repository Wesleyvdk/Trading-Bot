// @ts-nocheck
import { updateMarkets } from "./market";
import { ClobClient } from "@polymarket/clob-client";
import { Wallet } from "ethers";
import * as dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

async function verify() {
    console.log("Verifying Strike Price Fetching...");
    
    // Mock client (we don't need real credentials for fetching markets via Gamma API)
    const client = {} as ClobClient;
    
    const markets = await updateMarkets(client);
    
    console.log("\n--- Market Verification ---");
    for (const market of markets) {
        console.log(`Asset: ${market.asset}`);
        console.log(`Type: ${market.market_type}`);
        console.log(`Question: ${market.question_id}`); // question_id holds the question text in our mapping
        console.log(`Strike Price: $${market.strike_price}`);
        console.log(`Event Start: ${market.end_date_iso}`); // We mapped end_date_iso, but strike price depends on eventStartTime which isn't in the Market interface, but we logged it in updateMarkets
        console.log("---------------------------");
    }
}

verify();
