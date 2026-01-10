import { ClobClient } from "@polymarket/clob-client";
import { Wallet } from "ethers";
import * as dotenv from "dotenv";

dotenv.config();

const privateKey = process.env.POLYMARKET_PRIVATE_KEY;
if (!privateKey) {
  throw new Error("POLYMARKET_PRIVATE_KEY is not set in the environment variables");
}

const signer = new Wallet(privateKey);

console.log(signer);

const client = new ClobClient(
  "https://clob.polymarket.com",
  137,
  signer
);

// Derive API credentials from your wallet
const credentials = await client.deriveApiKey();
console.log("API Key:", credentials.key);
console.log("Secret:", credentials.secret);
console.log("Passphrase:", credentials.passphrase);