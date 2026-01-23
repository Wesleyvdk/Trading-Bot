export interface Market {
    condition_id: string;
    question_id: string;
    token_ids: string[]; // [YES, NO]
    outcomes: string[];
    end_date_iso: string;
    market_type: "15-MIN" | "60-MIN" | "DAILY";
    asset: string;
    strike_price: number | null;
}

export interface PricePoint {
    price: number;
    timestamp: number;
}

export interface MarketPrices {
    up_price: number;      // Current "Up" share mid price
    down_price: number;    // Current "Down" share mid price
    up_bid: number;        // Best bid for Up
    up_ask: number;        // Best ask for Up
    down_bid: number;      // Best bid for Down
    down_ask: number;      // Best ask for Down
    timestamp: number;     // When prices were fetched
}

export interface TradeOpportunity {
    market: Market;
    direction: "UP" | "DOWN";
    token_id: string;
    entry_price: number;   // Price we'd pay (ask)
    potential_upside: number; // Percentage upside if correct
    momentum: number;      // Momentum signal that triggered this
    spread: number;        // Bid-ask spread
}
