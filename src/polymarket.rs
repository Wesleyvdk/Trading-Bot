use reqwest::{Client, ClientBuilder, header};
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};
use hmac::{Hmac, Mac};
use sha2::{Sha256, Digest};
use base64::{Engine as _, engine::general_purpose};
use alloy::signers::Signer;
use alloy::signers::local::PrivateKeySigner;
use alloy::primitives::{keccak256, Address, U256, B256};
use std::str::FromStr;

type HmacSha256 = Hmac<Sha256>;

/// CTF Exchange contract address on Polygon mainnet
const CTF_EXCHANGE: &str = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E";
/// Neg Risk CTF Exchange contract address
const NEG_RISK_CTF_EXCHANGE: &str = "0xC5d563A36AE78145C45a50134d48A1215220f80a";

/// Order side
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub enum OrderSide {
    BUY,
    SELL,
}

impl OrderSide {
    pub fn as_str(&self) -> &str {
        match self {
            OrderSide::BUY => "BUY",
            OrderSide::SELL => "SELL",
        }
    }
}

/// Polymarket CLOB Client for order management
#[derive(Debug, Clone)]
pub struct PolymarketClient {
    client: Client,
    api_key: String,
    api_secret: String,
    passphrase: String,
    base_url: String,
    signer: PrivateKeySigner,
    funder: String, // Polymarket profile address
}

/// L2 Authentication Headers
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct L2Header {
    pub key: String,
    pub sign: String,
    pub timestamp: String,
    pub passphrase: String,
}

/// Market data from Polymarket API
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Market {
    pub condition_id: String,
    #[serde(default)]
    pub question_id: Option<String>,
    pub tokens: Vec<Token>,
    pub active: bool,
    pub closed: bool,
    pub question: Option<String>,
    #[serde(default)]
    pub neg_risk: Option<bool>,
    #[serde(default)]
    pub minimum_tick_size: Option<f64>,
}

/// Wrapper for markets API response
#[derive(Deserialize, Debug)]
pub struct MarketsResponse {
    pub data: Vec<Market>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Token {
    pub token_id: String,
    pub outcome: String,
    pub price: Option<f64>,
}

/// Gamma API event response for auto-discovery
#[derive(Deserialize, Debug)]
pub struct GammaEvent {
    #[serde(default)]
    pub id: String,
    pub slug: String,
    pub title: String,
    #[serde(default)]
    pub active: bool,
    #[serde(default)]
    pub closed: bool,
}

/// Gamma API market response for auto-discovery
#[derive(Deserialize, Debug)]
pub struct GammaMarket {
    #[serde(default)]
    pub id: String,
    pub slug: String,
    pub question: String,
    #[serde(default)]
    pub active: bool,
    #[serde(default)]
    pub closed: bool,
    #[serde(rename = "conditionId")]
    pub condition_id: Option<String>,
    #[serde(rename = "questionID")]
    pub question_id: Option<String>,
    #[serde(rename = "clobTokenIds")]
    pub clob_token_ids: Option<String>,
    pub outcomes: Option<String>,
    #[serde(rename = "endDate")]
    pub end_date: Option<String>,
    #[serde(rename = "orderMinSize")]
    pub order_min_size: Option<f64>,
    #[serde(rename = "orderPriceMinTickSize")]
    pub order_price_min_tick_size: Option<f64>,
}

/// Order to be signed and submitted
#[derive(Debug, Clone)]
pub struct Order {
    pub token_id: String,
    pub price: f64,
    pub size: f64,
    pub side: OrderSide,
    pub fee_rate_bps: u64,
    pub nonce: u64,
    pub expiration: u64,
    pub neg_risk: bool,
    pub tick_size: f64,
}

/// Order request payload for CLOB API
#[derive(Serialize, Debug)]
pub struct OrderRequest {
    pub order: SignedOrderPayload,
    #[serde(rename = "orderType")]
    pub order_type: String,
}

#[derive(Serialize, Debug)]
pub struct SignedOrderPayload {
    pub salt: String,
    pub maker: String,
    pub signer: String,
    pub taker: String,
    #[serde(rename = "tokenId")]
    pub token_id: String,
    #[serde(rename = "makerAmount")]
    pub maker_amount: String,
    #[serde(rename = "takerAmount")]
    pub taker_amount: String,
    pub expiration: String,
    pub nonce: String,
    #[serde(rename = "feeRateBps")]
    pub fee_rate_bps: String,
    pub side: String,
    #[serde(rename = "signatureType")]
    pub signature_type: u8,
    pub signature: String,
}

/// Order response from Polymarket API
#[derive(Deserialize, Debug)]
pub struct OrderResponse {
    pub success: bool,
    #[serde(rename = "orderID")]
    pub order_id: Option<String>,
    #[serde(rename = "errorMsg")]
    pub error_msg: Option<String>,
}

impl PolymarketClient {
    /// Create a new client from environment variables
    pub fn from_env() -> Option<Self> {
        let api_key = match std::env::var("POLYMARKET_API_KEY") {
            Ok(v) if !v.is_empty() => v,
            Ok(_) => {
                eprintln!("❌ POLYMARKET_API_KEY is set but empty");
                return None;
            }
            Err(_) => {
                eprintln!("❌ POLYMARKET_API_KEY is not set");
                return None;
            }
        };
        
        let api_secret = match std::env::var("POLYMARKET_API_SECRET") {
            Ok(v) if !v.is_empty() => v,
            Ok(_) => {
                eprintln!("❌ POLYMARKET_API_SECRET is set but empty");
                return None;
            }
            Err(_) => {
                eprintln!("❌ POLYMARKET_API_SECRET is not set");
                return None;
            }
        };
        
        let passphrase = match std::env::var("POLYMARKET_PASSPHRASE") {
            Ok(v) if !v.is_empty() => v,
            Ok(_) => {
                eprintln!("❌ POLYMARKET_PASSPHRASE is set but empty");
                return None;
            }
            Err(_) => {
                eprintln!("❌ POLYMARKET_PASSPHRASE is not set");
                return None;
            }
        };
        
        let private_key = match std::env::var("POLYMARKET_PRIVATE_KEY") {
            Ok(v) if !v.is_empty() => v,
            Ok(_) => {
                eprintln!("❌ POLYMARKET_PRIVATE_KEY is set but empty");
                return None;
            }
            Err(_) => {
                eprintln!("❌ POLYMARKET_PRIVATE_KEY is not set");
                return None;
            }
        };
        
        let funder = std::env::var("POLYMARKET_FUNDER").unwrap_or_default();
        
        let signer = match PrivateKeySigner::from_str(&private_key) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("❌ Invalid POLYMARKET_PRIVATE_KEY: {:?}", e);
                return None;
            }
        };
        
        println!("✅ Polymarket API credentials loaded");
        Some(Self::new(api_key, api_secret, passphrase, signer, funder))
    }
    
    pub fn new(api_key: String, api_secret: String, passphrase: String, signer: PrivateKeySigner, funder: String) -> Self {
        let client = ClientBuilder::new()
            .tcp_nodelay(true)
            .timeout(std::time::Duration::from_secs(10))
            .build()
            .expect("Failed to build HTTP client");

        Self {
            client,
            api_key,
            api_secret,
            passphrase,
            base_url: "https://clob.polymarket.com".to_string(),
            signer,
            funder,
        }
    }

    /// Generate L2 authentication headers
    pub fn generate_headers(&self, method: &str, path: &str, body: &str) -> L2Header {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("Time went backwards")
            .as_millis()
            .to_string();

        let message = format!("{}{}{}{}", timestamp, method, path, body);
        
        let mut mac = HmacSha256::new_from_slice(self.api_secret.as_bytes())
            .expect("HMAC can take key of any size");
        mac.update(message.as_bytes());
        let result = mac.finalize();
        let signature = general_purpose::STANDARD.encode(result.into_bytes());

        L2Header {
            key: self.api_key.clone(),
            sign: signature,
            timestamp,
            passphrase: self.passphrase.clone(),
        }
    }
    
    /// Fetch active crypto hourly markets using gamma-api auto-discovery
    pub async fn fetch_crypto_markets(&self, asset: &str) -> Result<Vec<Market>, String> {
        println!("[POLY] Auto-discovering {} crypto markets...", asset);
        
        // Search gamma-api markets for up-or-down crypto markets
        let asset_lower = asset.to_lowercase();
        let search_url = format!(
            "https://gamma-api.polymarket.com/markets?closed=false&active=true&limit=50"
        );
        
        println!("[POLY] Searching gamma-api markets...");
        
        let response = self.client
            .get(&search_url)
            .send()
            .await
            .map_err(|e| format!("Request failed: {:?}", e))?;
        
        if !response.status().is_success() {
            let status = response.status();
            let text = response.text().await.unwrap_or_default();
            return Err(format!("Gamma API error {}: {}", status, text));
        }
        
        let text = response.text().await
            .map_err(|e| format!("Failed to read response: {:?}", e))?;
        
        // Parse gamma-api markets and filter for crypto up/down markets
        if let Ok(gamma_markets) = serde_json::from_str::<Vec<GammaMarket>>(&text) {
            let mut markets: Vec<Market> = Vec::new();
            
            for gm in gamma_markets {
                // Check if this is a crypto up/down market for our asset
                let question_lower = gm.question.to_lowercase();
                let slug_lower = gm.slug.to_lowercase();
                
                let is_crypto_market = (question_lower.contains(&asset_lower) || 
                                        slug_lower.contains(&asset_lower)) &&
                                       (slug_lower.contains("up-or-down") || 
                                        question_lower.contains("up or down"));
                
                if is_crypto_market && gm.active && !gm.closed {
                    println!("[POLY] Found: {} ({})", gm.question, gm.slug);
                    
                    // Parse the clobTokenIds and outcomes
                    if let (Some(token_ids_str), Some(outcomes_str)) = (&gm.clob_token_ids, &gm.outcomes) {
                        // Parse JSON arrays
                        if let (Ok(token_ids), Ok(outcomes)) = (
                            serde_json::from_str::<Vec<String>>(token_ids_str),
                            serde_json::from_str::<Vec<String>>(outcomes_str)
                        ) {
                            if token_ids.len() >= 2 && outcomes.len() >= 2 {
                                // Build tokens from the parsed data
                                let tokens: Vec<Token> = token_ids.iter().zip(outcomes.iter())
                                    .map(|(id, outcome)| Token {
                                        token_id: id.clone(),
                                        outcome: outcome.clone(),
                                        price: None,
                                    }).collect();
                                
                                let market = Market {
                                    condition_id: gm.condition_id.unwrap_or_default(),
                                    question_id: gm.question_id.clone(),
                                    tokens,
                                    question: Some(gm.question.clone()),
                                    active: gm.active,
                                    closed: gm.closed,
                                    neg_risk: None,
                                    minimum_tick_size: gm.order_price_min_tick_size,
                                };
                                
                                markets.push(market);
                            }
                        }
                    }
                }
            }
            
            println!("[POLY] Found {} {} crypto markets", markets.len(), asset);
            return Ok(markets);
        }
        
        Err("Failed to parse gamma-api response".to_string())
    }
    
    /// Fetch markets for a specific event slug
    async fn fetch_markets_for_event(&self, event_slug: &str) -> Result<Vec<Market>, String> {
        let url = format!("{}/markets?event_slug={}", self.base_url, event_slug);
        
        let response = self.client
            .get(&url)
            .send()
            .await
            .map_err(|e| format!("Request failed: {:?}", e))?;
            
        if !response.status().is_success() {
            return Err(format!("Event markets fetch failed"));
        }
        
        let markets: Vec<Market> = response
            .json()
            .await
            .map_err(|e| format!("Failed to parse: {:?}", e))?;
        
        Ok(markets)
    }
    
    /// Get wallet address as string
    pub fn wallet_address(&self) -> String {
        format!("{:?}", self.signer.address())
    }
    
    /// Create and sign an order using EIP-712
    pub async fn create_signed_order(&self, order: &Order) -> Result<SignedOrderPayload, String> {
        let maker = if self.funder.is_empty() {
            self.wallet_address()
        } else {
            self.funder.clone()
        };
        let signer_addr = self.wallet_address();
        
        // Calculate amounts based on side
        // For BUY: makerAmount = size * price (USDC), takerAmount = size (shares)
        // For SELL: makerAmount = size (shares), takerAmount = size * price (USDC)
        let size_raw = (order.size * 1_000_000.0) as u128; // Convert to USDC units (6 decimals)
        let price_scaled = (order.price * 1_000_000.0) as u128;
        
        let (maker_amount, taker_amount) = match order.side {
            OrderSide::BUY => {
                // Buying shares: pay USDC, receive shares
                let usdc_amount = (order.size * order.price * 1_000_000.0) as u128;
                (usdc_amount.to_string(), size_raw.to_string())
            },
            OrderSide::SELL => {
                // Selling shares: pay shares, receive USDC
                let usdc_amount = (order.size * order.price * 1_000_000.0) as u128;
                (size_raw.to_string(), usdc_amount.to_string())
            }
        };
        
        // Generate salt
        let salt = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
            .to_string();
        
        // EIP-712 Domain
        let exchange = if order.neg_risk { NEG_RISK_CTF_EXCHANGE } else { CTF_EXCHANGE };
        
        // Build order struct for hashing
        let order_struct = format!(
            "{}{}{}{}{}{}{}{}{}{}{}",
            salt,
            maker,
            signer_addr,
            "0x0000000000000000000000000000000000000000", // taker (zero = anyone)
            order.token_id,
            maker_amount,
            taker_amount,
            order.expiration,
            order.nonce,
            order.fee_rate_bps,
            if order.side == OrderSide::BUY { "0" } else { "1" }
        );
        
        // Create EIP-712 typed data hash
        // Domain: { name: "Polymarket CTF Exchange", version: "1", chainId: 137, verifyingContract: exchange }
        let domain_separator = self.compute_domain_separator(exchange);
        let struct_hash = self.compute_struct_hash(
            &salt, &maker, &signer_addr, 
            "0x0000000000000000000000000000000000000000",
            &order.token_id, &maker_amount, &taker_amount,
            order.expiration, order.nonce, order.fee_rate_bps,
            &order.side
        );
        
        // \x19\x01 + domainSeparator + structHash
        let mut data = Vec::new();
        data.push(0x19);
        data.push(0x01);
        data.extend_from_slice(domain_separator.as_slice());
        data.extend_from_slice(struct_hash.as_slice());
        
        let hash = keccak256(&data);
        
        // Sign the hash
        let signature = self.signer.sign_hash(&hash.into())
            .await
            .map_err(|e| format!("Signing failed: {:?}", e))?;
        
        let sig_hex = format!("0x{}", hex::encode(signature.as_bytes()));
        
        Ok(SignedOrderPayload {
            salt,
            maker,
            signer: signer_addr,
            taker: "0x0000000000000000000000000000000000000000".to_string(),
            token_id: order.token_id.clone(),
            maker_amount,
            taker_amount,
            expiration: order.expiration.to_string(),
            nonce: order.nonce.to_string(),
            fee_rate_bps: order.fee_rate_bps.to_string(),
            side: if order.side == OrderSide::BUY { "BUY".to_string() } else { "SELL".to_string() },
            signature_type: 0, // EOA signature
            signature: sig_hex,
        })
    }
    
    /// Compute EIP-712 domain separator
    fn compute_domain_separator(&self, exchange: &str) -> B256 {
        let type_hash = keccak256(b"EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
        let name_hash = keccak256(b"Polymarket CTF Exchange");
        let version_hash = keccak256(b"1");
        let chain_id: U256 = U256::from(137); // Polygon
        let contract = Address::from_str(exchange).unwrap();
        
        let mut data = Vec::new();
        data.extend_from_slice(type_hash.as_slice());
        data.extend_from_slice(name_hash.as_slice());
        data.extend_from_slice(version_hash.as_slice());
        data.extend_from_slice(&chain_id.to_be_bytes::<32>());
        data.extend_from_slice(contract.as_slice());
        
        keccak256(&data)
    }
    
    /// Compute struct hash for order
    fn compute_struct_hash(
        &self, salt: &str, maker: &str, signer: &str, taker: &str,
        token_id: &str, maker_amount: &str, taker_amount: &str,
        expiration: u64, nonce: u64, fee_rate_bps: u64, side: &OrderSide
    ) -> B256 {
        let type_hash = keccak256(
            b"Order(uint256 salt,address maker,address signer,address taker,uint256 tokenId,uint256 makerAmount,uint256 takerAmount,uint256 expiration,uint256 nonce,uint256 feeRateBps,uint8 side,uint8 signatureType)"
        );
        
        let salt_u256 = U256::from_str(salt).unwrap_or_default();
        let maker_addr = Address::from_str(maker).unwrap_or_default();
        let signer_addr = Address::from_str(signer).unwrap_or_default();
        let taker_addr = Address::from_str(taker).unwrap_or_default();
        let token_u256 = U256::from_str(token_id).unwrap_or_default();
        let maker_amt = U256::from_str(maker_amount).unwrap_or_default();
        let taker_amt = U256::from_str(taker_amount).unwrap_or_default();
        let exp_u256 = U256::from(expiration);
        let nonce_u256 = U256::from(nonce);
        let fee_u256 = U256::from(fee_rate_bps);
        let side_u8: u8 = if *side == OrderSide::BUY { 0 } else { 1 };
        
        let mut data = Vec::new();
        data.extend_from_slice(type_hash.as_slice());
        data.extend_from_slice(&salt_u256.to_be_bytes::<32>());
        data.extend_from_slice(&[0u8; 12]); // padding for address
        data.extend_from_slice(maker_addr.as_slice());
        data.extend_from_slice(&[0u8; 12]);
        data.extend_from_slice(signer_addr.as_slice());
        data.extend_from_slice(&[0u8; 12]);
        data.extend_from_slice(taker_addr.as_slice());
        data.extend_from_slice(&token_u256.to_be_bytes::<32>());
        data.extend_from_slice(&maker_amt.to_be_bytes::<32>());
        data.extend_from_slice(&taker_amt.to_be_bytes::<32>());
        data.extend_from_slice(&exp_u256.to_be_bytes::<32>());
        data.extend_from_slice(&nonce_u256.to_be_bytes::<32>());
        data.extend_from_slice(&fee_u256.to_be_bytes::<32>());
        data.push(side_u8);
        data.push(0); // signatureType = EOA
        
        keccak256(&data)
    }
    
    /// Place an order on the CLOB
    pub async fn place_order(&self, signed_order: SignedOrderPayload) -> Result<OrderResponse, String> {
        let path = "/order";
        
        let request = OrderRequest {
            order: signed_order,
            order_type: "GTC".to_string(), // Good Till Cancelled
        };
        
        let body = serde_json::to_string(&request)
            .map_err(|e| format!("Failed to serialize order: {:?}", e))?;
        
        println!("[POLY] Placing order: {}", body);
        
        let headers = self.generate_headers("POST", path, &body);
        let url = format!("{}{}", self.base_url, path);
        
        let response = self.client
            .post(&url)
            .header(header::CONTENT_TYPE, "application/json")
            .header("POLY_API_KEY", &headers.key)
            .header("POLY_SIGNATURE", &headers.sign)
            .header("POLY_TIMESTAMP", &headers.timestamp)
            .header("POLY_PASSPHRASE", &headers.passphrase)
            .body(body)
            .send()
            .await
            .map_err(|e| format!("Request failed: {:?}", e))?;
        
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        
        println!("[POLY] Response {}: {}", status, text);
        
        if !status.is_success() {
            return Err(format!("Order failed {}: {}", status, text));
        }
        
        let order_response: OrderResponse = serde_json::from_str(&text)
            .map_err(|e| format!("Failed to parse response: {:?}", e))?;
        
        Ok(order_response)
    }
    
    /// Get server time (for testing connectivity)
    pub async fn get_server_time(&self) -> Result<String, reqwest::Error> {
        let url = format!("{}/time", self.base_url);
        let resp = self.client.get(&url).send().await?;
        resp.text().await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_order_side() {
        assert_eq!(OrderSide::BUY.as_str(), "BUY");
        assert_eq!(OrderSide::SELL.as_str(), "SELL");
    }
}

