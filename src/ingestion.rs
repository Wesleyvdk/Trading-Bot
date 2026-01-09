use futures_util::StreamExt;
use simd_json::prelude::*;
use tokio_tungstenite::{connect_async, tungstenite::protocol::Message};
use url::Url;

use rtrb::Producer;

pub struct MarketUpdate {
    pub symbol: u64,
    pub price: u64,
    pub ts: u64,
}

pub async fn run_ingestion(mut producer: Producer<MarketUpdate>) {
    println!("Starting Ingestion Engine...");
    
    // Binance Connection
    let binance_url = "wss://stream.binance.com:9443/ws/btcusdt@trade";
    let binance_ws_url = Url::parse(binance_url).expect("Bad URL");
    
    // Polymarket Connection
    let poly_url = "wss://ws-fidelity.polymarket.com";
    let poly_ws_url = Url::parse(poly_url).expect("Bad URL");

    println!("Connecting to Binance: {}", binance_url);
    let (binance_stream, _) = connect_async(binance_ws_url).await.expect("Failed to connect to Binance");
    println!("Connected to Binance!");

    println!("Connecting to Polymarket: {}", poly_url);
    let (poly_stream, _) = connect_async(poly_ws_url).await.expect("Failed to connect to Polymarket");
    println!("Connected to Polymarket!");

    let (_, mut binance_read) = binance_stream.split();
    let (_, mut poly_read) = poly_stream.split();

    loop {
        tokio::select! {
            Some(msg) = binance_read.next() => {
                match msg {
                    Ok(Message::Text(text)) => {
                        let mut bytes = text.into_bytes();
                        match simd_json::to_owned_value(&mut bytes) {
                            Ok(json) => {
                                if let (Some(price_str), Some(ts)) = (json["p"].as_str(), json["T"].as_f64()) {
                                    // Parse price (fixed point)
                                    if let Ok(price_f) = price_str.parse::<f64>() {
                                        let price = (price_f * 100.0) as u64;
                                        let update = MarketUpdate {
                                            symbol: 1, // BTC
                                            price,
                                            ts: ts as u64,
                                        };
                                        
                                        // Push to Ring Buffer
                                        if let Err(e) = producer.push(update) {
                                            eprintln!("Ring Buffer Full! Dropping update: {:?}", e);
                                        }
                                    }
                                } else {
                                    // Fallback if T is not f64 (maybe i64/u64?)
                                    if let (Some(price_str), Some(ts)) = (json["p"].as_str(), json["T"].as_u64()) {
                                         if let Ok(price_f) = price_str.parse::<f64>() {
                                            let price = (price_f * 100.0) as u64;
                                            let update = MarketUpdate {
                                                symbol: 1, // BTC
                                                price,
                                                ts,
                                            };
                                            producer.push(update).ok();
                                         }
                                    }
                                }
                            }
                            Err(e) => eprintln!("Binance JSON Error: {:?}", e),
                        }
                    }
                    _ => {}
                }
            }
            Some(msg) = poly_read.next() => {
                match msg {
                    Ok(Message::Text(text)) => {
                         // Polymarket sends array of events
                        let mut bytes = text.into_bytes();
                        match simd_json::to_owned_value(&mut bytes) {
                            Ok(json) => {
                                // TODO: Parse specific Polymarket fields
                                // println!("Polymarket Tick: {:?}", json);
                            }
                            Err(e) => eprintln!("Polymarket JSON Error: {:?}", e),
                        }
                    }
                    _ => {}
                }
            }
        }
    }
}
