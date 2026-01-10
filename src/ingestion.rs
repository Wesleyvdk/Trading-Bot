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

pub async fn run_ingestion(mut producer: Producer<MarketUpdate>) {
    println!("Starting Ingestion Engine...");
    
    // Binance Connection
    let binance_url = "wss://stream.binance.com:9443/ws/btcusdt@trade";
    
    // Polymarket Connection (CLOB WebSocket - Market Channel)
    let poly_url = "wss://ws-subscriptions-clob.polymarket.com/ws/market";

    println!("Connecting to Binance: {}", binance_url);
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
