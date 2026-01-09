use rtrb::{Consumer, Producer};
use crate::ingestion::MarketUpdate;
use crate::execution::TradeInstruction;

pub fn run_strategy(mut consumer: Consumer<MarketUpdate>, mut producer: Producer<TradeInstruction>) {
    println!("Starting Strategy Engine...");
    
    // Strategy State
    let strike_price = 9800000; // $98,000.00 (Fixed Point)
    let fair_value_threshold = 55; // $0.55
    
    // Core Affinity (Pin to Core 2 - Example)
    if let Some(core_ids) = core_affinity::get_core_ids() {
        if core_ids.len() > 2 {
            core_affinity::set_for_current(core_ids[2]);
            println!("Strategy Pinned to Core 2");
        }
    }

    loop {
        // Busy Poll (Low Latency)
        if let Ok(update) = consumer.pop() {
            // 1. Filter: Only process BTC updates (Symbol 1)
            if update.symbol != 1 {
                continue;
            }

            // 2. Logic: Simple Arbitrage
            // IF Binance Price > Strike Price
            // AND we can buy "YES" < Fair Value
            if update.price > strike_price {
                // Trigger Trade
                let instruction = TradeInstruction {
                    symbol: update.symbol,
                    side: 0, // Buy YES
                    price: fair_value_threshold,
                    size: 10, // $10
                };

                // Push to Execution
                if let Err(e) = producer.push(instruction) {
                    eprintln!("Execution Ring Buffer Full! Dropping trade: {:?}", e);
                }
            }
        }
    }
}
