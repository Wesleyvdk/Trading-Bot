export interface Market {
    condition_id: string;
    question_id: string;
    token_ids: string[]; // [YES, NO]
    outcomes: string[];
    end_date_iso: string;
    market_type: "15-MIN" | "60-MIN";
    asset: string;
}

export interface PricePoint {
    price: number;
    timestamp: number;
}
