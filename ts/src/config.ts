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
    THRESHOLD_15M: 0.00085, // 0.085% (~$80 move on $95k BTC)
    THRESHOLD_60M: 0.00085, // 0.085% (~$80 move on $95k BTC)
    STRIKE_PRICE_BUFFER: 0.005, // 0.5% buffer around strike price
    TRADE_SIZE_USD: 10, // $10 per trade
    LIVE_MODE: true, // Set to false for dry run
    
    // Value Strategy Parameters
    MAX_ENTRY_PRICE: 0.65,      // Don't buy shares above $0.65
    MIN_UPSIDE: 0.30,           // Require at least 30% potential upside  
    MAX_SPREAD: 0.10,           // Max bid-ask spread to accept
    PRICE_CACHE_TTL_MS: 5000,   // Cache prices for 5 seconds
    
    // Latency Strategy Parameters
    LATENCY_MIN_EDGE: 0.05,              // 5% minimum edge to trade
    LATENCY_MIN_TIME_REMAINING: 30,      // Don't trade with < 30 seconds left
    LATENCY_MAX_TIME_REMAINING: 300,     // Don't trade more than 5 min before expiry
    LATENCY_KELLY_FRACTION: 0.25,        // Use 25% Kelly
    LATENCY_MAX_POSITION_SIZE: 50,       // Max $50 per trade
    LATENCY_LOOP_INTERVAL_MS: 500,       // Evaluate every 500ms
    
    // Secrets
    POLYMARKET_PRIVATE_KEY: process.env.POLYMARKET_PRIVATE_KEY,
    POLYMARKET_API_KEY: process.env.POLYMARKET_API_KEY,
    POLYMARKET_API_SECRET: process.env.POLYMARKET_API_SECRET,
    POLYMARKET_PASSPHRASE: process.env.POLYMARKET_PASSPHRASE,
};
