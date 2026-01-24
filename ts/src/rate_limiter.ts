
/**
 * Simple Token Bucket Rate Limiter
 * Ensures we don't exceed a specific number of requests per time window.
 */
export class RateLimiter {
    private tokens: number;
    private maxTokens: number;
    private refillRateMs: number;
    private lastRefill: number;
    private queue: Array<() => void> = [];

    /**
     * @param maxRequests Maximum number of requests allowed in the window
     * @param windowMs Time window in milliseconds
     */
    constructor(maxRequests: number, windowMs: number) {
        this.maxTokens = maxRequests;
        this.tokens = maxRequests;
        this.refillRateMs = windowMs / maxRequests;
        this.lastRefill = Date.now();
    }

    /**
     * Wait for a token to be available
     */
    async waitForToken(): Promise<void> {
        this.refill();

        if (this.tokens >= 1) {
            this.tokens -= 1;
            return;
        }

        // If no tokens, wait in queue
        return new Promise<void>((resolve) => {
            this.queue.push(resolve);
            this.scheduleRefill();
        });
    }

    private refill() {
        const now = Date.now();
        const elapsed = now - this.lastRefill;
        
        if (elapsed >= this.refillRateMs) {
            const newTokens = Math.floor(elapsed / this.refillRateMs);
            this.tokens = Math.min(this.maxTokens, this.tokens + newTokens);
            this.lastRefill = now;
            
            this.processQueue();
        }
    }

    private scheduleRefill() {
        // Ensure we check back when next token is due
        setTimeout(() => {
            this.refill();
        }, this.refillRateMs);
    }

    private processQueue() {
        while (this.queue.length > 0 && this.tokens >= 1) {
            this.tokens -= 1;
            const resolve = this.queue.shift();
            if (resolve) resolve();
        }
    }
}

// Global instance: 10 requests per second (safe limit)
export const globalRateLimiter = new RateLimiter(10, 1000);
