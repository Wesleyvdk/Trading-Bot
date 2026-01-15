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
        
        // For Magic.Link wallets, we need to specify the funder (proxy wallet) address
        const funderAddress = process.env.POLYMARKET_FUNDER_ADDRESS;
        if (funderAddress) {
            console.log(`📝 Using Funder (Proxy) Address: ${funderAddress}`);
        }
        
        client = new ClobClient(
            CONFIG.POLYMARKET_CLOB_URL,
            CONFIG.CHAIN_ID,
            signer,
            {
                key: CONFIG.POLYMARKET_API_KEY,
                secret: CONFIG.POLYMARKET_API_SECRET,
                passphrase: CONFIG.POLYMARKET_PASSPHRASE,
            },
            1, // signature_type: 1 = Magic.Link / Email wallet
            funderAddress // The proxy wallet address that holds your funds
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
