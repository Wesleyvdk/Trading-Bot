import { ClobClient } from "@polymarket/clob-client";
import { Wallet } from "ethers";
import { CONFIG } from "./config";

export async function initializeClient(): Promise<ClobClient> {
    if (!CONFIG.POLYMARKET_PRIVATE_KEY) {
        throw new Error("Missing POLYMARKET_PRIVATE_KEY");
    }

    const signer = new Wallet(CONFIG.POLYMARKET_PRIVATE_KEY);
    console.log(`🔑 Signer: ${signer.address}`);

    let client: ClobClient;

    if (CONFIG.POLYMARKET_API_KEY && CONFIG.POLYMARKET_API_SECRET && CONFIG.POLYMARKET_PASSPHRASE) {
        console.log("✅ Using provided L2 API Credentials");
        client = new ClobClient(
            CONFIG.POLYMARKET_CLOB_URL,
            CONFIG.CHAIN_ID,
            signer,
            {
                key: CONFIG.POLYMARKET_API_KEY,
                secret: CONFIG.POLYMARKET_API_SECRET,
                passphrase: CONFIG.POLYMARKET_PASSPHRASE,
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
            throw e;
        }
    }

    return client;
}
