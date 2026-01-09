use reqwest::{Client, ClientBuilder};
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};
use hex;
use hmac::{Hmac, Mac};
use sha2::Sha256;
use base64::{Engine as _, engine::general_purpose};

type HmacSha256 = Hmac<Sha256>;

#[derive(Debug, Clone)]
pub struct PolymarketClient {
    client: Client,
    api_key: String,
    api_secret: String,
    passphrase: String,
    base_url: String,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct L2Header {
    pub key: String,
    pub sign: String,
    pub timestamp: String,
    pub passphrase: String,
}

impl PolymarketClient {
    pub fn new(api_key: String, api_secret: String, passphrase: String) -> Self {
        let client = ClientBuilder::new()
            .http2_prior_knowledge() // Force HTTP/2
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
        
        println!("Generated Headers: {:?}", headers);
    }
}
