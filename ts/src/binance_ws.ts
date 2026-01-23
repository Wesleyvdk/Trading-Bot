/**
 * Binance WebSocket - Real-time price feed with minimal latency
 * Connects to Binance trade streams for BTC, ETH, and SOL
 */

import { CONFIG } from "./config";

export interface PricePoint {
    price: number;
    timestamp: number;
}

interface AssetState {
    price: number;
    history: PricePoint[];
    lastUpdate: number;
}

type PriceCallback = (symbol: string, price: number, timestamp: number) => void;

/**
 * Real-time Binance WebSocket price feed
 * Maintains persistent connections with auto-reconnect
 */
export class BinanceWebSocket {
    private ws: WebSocket | null = null;
    private prices: Map<string, AssetState> = new Map();
    private callbacks: PriceCallback[] = [];
    private reconnectAttempts = 0;
    private maxReconnectAttempts = 10;
    private reconnectDelay = 1000; // Start with 1 second
    private isConnected = false;
    private shouldConnect = true;
    
    // Symbols to subscribe to (lowercase for Binance API)
    private symbols = ["btcusdt", "ethusdt", "solusdt"];
    
    // History window in milliseconds (5 minutes for volatility calculation)
    private historyWindowMs = 5 * 60 * 1000;
    
    constructor() {
        // Initialize price state for each asset
        for (const symbol of this.symbols) {
            this.prices.set(symbol, {
                price: 0,
                history: [],
                lastUpdate: 0
            });
        }
    }
    
    /**
     * Connect to Binance WebSocket
     */
    async connect(): Promise<void> {
        this.shouldConnect = true;
        return this._connect();
    }
    
    private async _connect(): Promise<void> {
        return new Promise((resolve, reject) => {
            try {
                // Combined stream for all symbols
                const streams = this.symbols.map(s => `${s}@trade`).join("/");
                const url = `wss://stream.binance.com:9443/stream?streams=${streams}`;
                
                console.log(`🔌 Connecting to Binance WebSocket...`);
                
                this.ws = new WebSocket(url);
                
                this.ws.onopen = () => {
                    console.log(`✅ Binance WebSocket connected`);
                    this.isConnected = true;
                    this.reconnectAttempts = 0;
                    this.reconnectDelay = 1000;
                    resolve();
                };
                
                this.ws.onmessage = (event) => {
                    this.handleMessage(event.data);
                };
                
                this.ws.onerror = (error) => {
                    console.error(`❌ Binance WebSocket error:`, error);
                    if (!this.isConnected) {
                        reject(error);
                    }
                };
                
                this.ws.onclose = () => {
                    console.log(`🔌 Binance WebSocket disconnected`);
                    this.isConnected = false;
                    this.attemptReconnect();
                };
                
            } catch (e) {
                reject(e);
            }
        });
    }
    
    /**
     * Handle incoming WebSocket message
     */
    private handleMessage(data: string): void {
        try {
            const message = JSON.parse(data);
            
            // Combined stream format: { stream: "btcusdt@trade", data: {...} }
            if (message.stream && message.data) {
                const trade = message.data;
                const symbol = trade.s?.toLowerCase(); // Symbol
                const price = parseFloat(trade.p);     // Price
                const timestamp = trade.T;             // Trade time
                
                if (symbol && !isNaN(price)) {
                    this.updatePrice(symbol, price, timestamp);
                }
            }
        } catch (e) {
            // Silently ignore parse errors
        }
    }
    
    /**
     * Update price for a symbol
     */
    private updatePrice(symbol: string, price: number, timestamp: number): void {
        const state = this.prices.get(symbol);
        if (!state) return;
        
        const now = Date.now();
        
        // Update current price
        state.price = price;
        state.lastUpdate = now;
        
        // Add to history
        state.history.push({ price, timestamp });
        
        // Trim history to window
        const cutoff = now - this.historyWindowMs;
        state.history = state.history.filter(p => p.timestamp > cutoff);
        
        // Notify callbacks
        for (const callback of this.callbacks) {
            try {
                callback(symbol, price, timestamp);
            } catch (e) {
                // Ignore callback errors
            }
        }
    }
    
    /**
     * Attempt to reconnect with exponential backoff
     */
    private attemptReconnect(): void {
        if (!this.shouldConnect) return;
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            console.error(`❌ Max reconnect attempts reached (${this.maxReconnectAttempts})`);
            return;
        }
        
        this.reconnectAttempts++;
        const delay = Math.min(this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1), 30000);
        
        console.log(`🔄 Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);
        
        setTimeout(() => {
            this._connect().catch(e => {
                console.error(`❌ Reconnect failed:`, e);
            });
        }, delay);
    }
    
    /**
     * Get current price for a symbol
     * @param symbol - Full symbol like "BTCUSDT" or short like "BTC"
     */
    getPrice(symbol: string): number | null {
        const key = this.normalizeSymbol(symbol);
        const state = this.prices.get(key);
        
        if (!state || state.price === 0) return null;
        
        // Check if price is stale (> 10 seconds old)
        if (Date.now() - state.lastUpdate > 10000) {
            return null;
        }
        
        return state.price;
    }
    
    /**
     * Get price history for a symbol
     */
    getPriceHistory(symbol: string): PricePoint[] {
        const key = this.normalizeSymbol(symbol);
        const state = this.prices.get(key);
        return state?.history || [];
    }
    
    /**
     * Calculate volatility (standard deviation of returns) for a symbol
     * @param symbol - Asset symbol
     * @param windowMinutes - Time window in minutes (default: 5)
     * @returns Per-minute volatility (std dev of percent changes)
     */
    getVolatility(symbol: string, windowMinutes: number = 5): number {
        const key = this.normalizeSymbol(symbol);
        const state = this.prices.get(key);
        
        if (!state || state.history.length < 10) {
            // Return default volatility if insufficient data
            return this.getDefaultVolatility(symbol);
        }
        
        const cutoff = Date.now() - (windowMinutes * 60 * 1000);
        const recentHistory = state.history.filter(p => p.timestamp > cutoff);
        
        if (recentHistory.length < 10) {
            return this.getDefaultVolatility(symbol);
        }
        
        // Sample every ~10 seconds for volatility calculation
        const sampleInterval = 10000; // 10 seconds
        const samples: number[] = [];
        let lastSample = recentHistory[0]!;
        
        for (const point of recentHistory) {
            if (point.timestamp - lastSample.timestamp >= sampleInterval) {
                const pctChange = (point.price - lastSample.price) / lastSample.price;
                samples.push(pctChange);
                lastSample = point;
            }
        }
        
        if (samples.length < 5) {
            return this.getDefaultVolatility(symbol);
        }
        
        // Calculate standard deviation
        const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
        const variance = samples.reduce((sum, x) => sum + Math.pow(x - mean, 2), 0) / samples.length;
        const stdDev = Math.sqrt(variance);
        
        // Scale to per-minute volatility
        // We sampled every 10 seconds, so multiply by sqrt(6) to get per-minute
        return stdDev * Math.sqrt(6) * 100; // Return as percentage
    }
    
    /**
     * Get default volatility for an asset
     */
    private getDefaultVolatility(symbol: string): number {
        const defaults: Record<string, number> = {
            btcusdt: 0.015,
            ethusdt: 0.020,
            solusdt: 0.035,
        };
        const key = this.normalizeSymbol(symbol);
        return defaults[key] || 0.025;
    }
    
    /**
     * Normalize symbol to lowercase with usdt suffix
     */
    private normalizeSymbol(symbol: string): string {
        const lower = symbol.toLowerCase();
        if (lower.endsWith("usdt")) return lower;
        return `${lower}usdt`;
    }
    
    /**
     * Register a callback for price updates
     */
    onPriceUpdate(callback: PriceCallback): void {
        this.callbacks.push(callback);
    }
    
    /**
     * Check if connected
     */
    get connected(): boolean {
        return this.isConnected;
    }
    
    /**
     * Disconnect from WebSocket
     */
    disconnect(): void {
        this.shouldConnect = false;
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        this.isConnected = false;
    }
}

// Singleton instance
let instance: BinanceWebSocket | null = null;

/**
 * Get the shared BinanceWebSocket instance
 */
export function getBinanceWS(): BinanceWebSocket {
    if (!instance) {
        instance = new BinanceWebSocket();
    }
    return instance;
}
