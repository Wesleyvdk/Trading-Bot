use reqwest::{Client, ClientBuilder, header};
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};
use hmac::{Hmac, Mac};
use sha2::Sha256;
use base64::{Engine as _, engine::general_purpose};

type HmacSha256 = Hmac<Sha256>;

/// Polymarket CLOB Client for order management
#[derive(Debug, Clone)]
pub struct PolymarketClient {
    client: Client,
    api_key: String,
    api_secret: String,
    passphrase: String,
    base_url: String,
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
    pub question_id: String,
    pub tokens: Vec<Token>,
    pub active: bool,
    pub closed: bool,
    pub question: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Token {
    pub token_id: String,
    pub outcome: String,
    pub price: Option<f64>,
}

/// Order request payload
#[derive(Serialize, Debug)]
pub struct OrderRequest {
    pub order: SignedOrder,
}

#[derive(Serialize, Debug)]
pub struct SignedOrder {
    pub salt: String,
    pub maker: String,
    pub signer: String,
    pub taker: String,
    pub token_id: String,
    pub maker_amount: String,
    pub taker_amount: String,
    pub expiration: String,
    pub nonce: String,
    pub fee_rate_bps: String,
    pub side: String,  // "BUY" or "SELL"
    pub signature_type: u8,
    pub signature: String,
}

/// Order response from Polymarket API
#[derive(Deserialize, Debug)]
pub struct OrderResponse {
    pub success: bool,
    pub order_id: Option<String>,
    pub error: Option<String>,
}

impl PolymarketClient {
    /// Create a new client from environment variables
    pub fn from_env() -> Option<Self> {
        let api_key = std::env::var("POLYMARKET_API_KEY").ok()?;
        let api_secret = std::env::var("POLYMARKET_API_SECRET").ok()?;
        let passphrase = std::env::var("POLYMARKET_PASSPHRASE").ok()?;
        
        if api_key.is_empty() || api_secret.is_empty() || passphrase.is_empty() {
            return None;
        }
        
        Some(Self::new(api_key, api_secret, passphrase))
    }
    
    pub fn new(api_key: String, api_secret: String, passphrase: String) -> Self {
        let client = ClientBuilder::new()
            .http2_prior_knowledge()
            .tcp_nodelay(true)
            .build()
            .expect("Failed to build HTTP client");

        Self {
            client,
            api_key,
            api_secret,
            passphrase,
            base_url: "https://clob.polymarket.com".to_string(),
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
    
    /// Fetch active BTC hourly markets
    pub async fn fetch_btc_markets(&self) -> Result<Vec<Market>, String> {
        let path = "/markets";
        let url = format!("{}{}?tag=crypto-hourly-btc&active=true", self.base_url, path);
        
        let response = self.client
            .get(&url)
            .send()
            .await
            .map_err(|e| format!("Request failed: {:?}", e))?;
            
        if !response.status().is_success() {
            let status = response.status();
            let text = response.text().await.unwrap_or_default();
            return Err(format!("API error {}: {}", status, text));
        }
        
        let markets: Vec<Market> = response
            .json()
            .await
            .map_err(|e| format!("Failed to parse markets: {:?}", e))?;
        
        Ok(markets)
    }
    
    /// Place an order on the CLOB
    pub async fn place_order(&self, order: SignedOrder) -> Result<OrderResponse, String> {
        let path = "/order";
        let body = serde_json::to_string(&OrderRequest { order })
            .map_err(|e| format!("Failed to serialize order: {:?}", e))?;
        
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
        
        if !response.status().is_success() {
            let status = response.status();
            let text = response.text().await.unwrap_or_default();
            return Err(format!("Order failed {}: {}", status, text));
        }
        
        let order_response: OrderResponse = response
            .json()
            .await
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
    fn test_l2_header_generation() {
        let api_key = "test_key".to_string();
        let api_secret = "test_secret".to_string();
        let passphrase = "test_passphrase".to_string();

        let client = PolymarketClient::new(api_key.clone(), api_secret, passphrase.clone());

        let method = "GET";
        let path = "/orders";
        let body = "";

        let headers = client.generate_headers(method, path, body);

        assert_eq!(headers.key, api_key);
        assert_eq!(headers.passphrase, passphrase);
        assert!(!headers.sign.is_empty());
        assert!(!headers.timestamp.is_empty());
    }
}
