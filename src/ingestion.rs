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

use tokio::time::{sleep, Duration};
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::MaybeTlsStream;
use tokio::net::TcpStream;

type WsStream = WebSocketStream<MaybeTlsStream<TcpStream>>;

async fn connect_with_retry(url: &str) -> WsStream {
    loop {
        match connect_async(Url::parse(url).expect("Bad URL")).await {
            Ok((stream, _)) => {
                println!("Connected to {}", url);
                return stream;
            }
            Err(e) => {
                eprintln!("Failed to connect to {}: {:?}. Retrying in 5s...", url, e);
                sleep(Duration::from_secs(5)).await;
            }
        }
    }
}

/// Symbol ID mapping:
/// 1 = BTC, 2 = ETH, 3 = SOL, 4 = XRP
fn get_symbol_id(symbol_str: Option<&str>) -> Option<u64> {
    match symbol_str {
        Some("BTCUSDT") => Some(1),
        Some("ETHUSDT") => Some(2),
        Some("SOLUSDT") => Some(3),
        Some("XRPUSDT") => Some(4),
        _ => None,
    }
}

pub async fn run_ingestion(mut producer: Producer<MarketUpdate>) {
    println!("Starting Ingestion Engine...");
    
    // Binance Combined Streams - BTC, ETH, SOL, XRP
    let binance_url = "wss://stream.binance.com:9443/stream?streams=btcusdt@trade/ethusdt@trade/solusdt@trade/xrpusdt@trade";
    
    // Polymarket Connection (CLOB WebSocket - Market Channel)
    let poly_url = "wss://ws-subscriptions-clob.polymarket.com/ws/market";

    println!("Connecting to Binance (BTC, ETH, SOL, XRP): {}", binance_url);
    let binance_stream = connect_with_retry(binance_url).await;

    println!("Connecting to Polymarket: {}", poly_url);
    let poly_stream = connect_with_retry(poly_url).await;

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
                                // Combined streams wrap data in {"stream": "...", "data": {...}}
                                let data = if json.get("data").is_some() {
                                    &json["data"]
                                } else {
                                    &json
                                };
                                
                                // Get symbol from the trade data (s field)
                                let symbol_id = get_symbol_id(data["s"].as_str());
                                
                                if let (Some(symbol), Some(price_str), Some(ts)) = (symbol_id, data["p"].as_str(), data["T"].as_f64()) {
                                    if let Ok(price_f) = price_str.parse::<f64>() {
                                        let price = (price_f * 100.0) as u64;
                                        let update = MarketUpdate {
                                            symbol,
                                            price,
                                            ts: ts as u64,
                                        };
                                        
                                        if let Err(e) = producer.push(update) {
                                            eprintln!("Ring Buffer Full! Dropping update: {:?}", e);
                                        }
                                    }
                                } else if let (Some(symbol), Some(price_str), Some(ts)) = (symbol_id, data["p"].as_str(), data["T"].as_u64()) {
                                    // Fallback if T is u64
                                    if let Ok(price_f) = price_str.parse::<f64>() {
                                        let price = (price_f * 100.0) as u64;
                                        let update = MarketUpdate {
                                            symbol,
                                            price,
                                            ts,
                                        };
                                        producer.push(update).ok();
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
                        // Polymarket sends JSON messages
                        let mut bytes = text.into_bytes();
                        match simd_json::to_owned_value(&mut bytes) {
                            Ok(json) => {
                                // Parse price from Polymarket format
                                // Example: {"event_type": "price_change", "price": "0.55", ...}
                                if let Some(price_str) = json["price"].as_str() {
                                    if let Ok(price_f) = price_str.parse::<f64>() {
                                        let price = (price_f * 100.0) as u64;
                                        let update = MarketUpdate {
                                            symbol: 2, // Polymarket
                                            price,
                                            ts: std::time::SystemTime::now()
                                                .duration_since(std::time::UNIX_EPOCH)
                                                .unwrap()
                                                .as_millis() as u64,
                                        };
                                        producer.push(update).ok();
                                    }
                                }
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
