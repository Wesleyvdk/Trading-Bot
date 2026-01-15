import * as dotenv from "dotenv";
import path from "path";

// Load .env from parent directory
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

export const CONFIG = {
    BINANCE_WS_URL: process.env.BINANCE_WS_URL || "wss://stream.binance.com:9443/ws/btcusdt@trade",
    POLYMARKET_CLOB_URL: process.env.POLYMARKET_CLOB_URL || "https://clob.polymarket.com",
    CHAIN_ID: 137, // Polygon
    MOMENTUM_WINDOW_15M: 15,
    MOMENTUM_WINDOW_60M: 60,
    THRESHOLD_15M: 0.003, // 0.3%
    THRESHOLD_60M: 0.005, // 0.5%
    TRADE_SIZE_USD: 10, // $10 per trade
    LIVE_MODE: true, // Set to false for dry run
    
    // Value Strategy Parameters
    MAX_ENTRY_PRICE: 0.65,      // Don't buy shares above $0.65
    MIN_UPSIDE: 0.30,           // Require at least 30% potential upside  
    MAX_SPREAD: 0.10,           // Max bid-ask spread to accept
    PRICE_CACHE_TTL_MS: 5000,   // Cache prices for 5 seconds
    
    // Secrets
    POLYMARKET_PRIVATE_KEY: process.env.POLYMARKET_PRIVATE_KEY,
    POLYMARKET_API_KEY: process.env.POLYMARKET_API_KEY,
    POLYMARKET_API_SECRET: process.env.POLYMARKET_API_SECRET,
    POLYMARKET_PASSPHRASE: process.env.POLYMARKET_PASSPHRASE,
};
