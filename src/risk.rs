//! Risk Management Module
//! 
//! Implements adaptive risk tiers based on session P&L.
//! Tiers: Conservative, Moderate, Aggressive

use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;

/// Risk tier levels
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum RiskTier {
    Conservative,  // Loss >= $10: $2/trade, 25% exposure
    Moderate,      // Default: $5/trade, 50% exposure
    Aggressive,    // Profit >= $10: $10/trade, 75% exposure
}

impl RiskTier {
    /// Get trade size in dollars for this tier
    pub fn trade_size(&self) -> u64 {
        match self {
            RiskTier::Conservative => 2,
            RiskTier::Moderate => 5,
            RiskTier::Aggressive => 10,
        }
    }
    
    /// Get max positions per asset for this tier
    pub fn max_positions_per_asset(&self) -> usize {
        match self {
            RiskTier::Conservative => 2,
            RiskTier::Moderate => 3,
            RiskTier::Aggressive => 4,
        }
    }
    
    /// Get exposure percentage for this tier
    pub fn exposure_percent(&self) -> f64 {
        match self {
            RiskTier::Conservative => 0.25,
            RiskTier::Moderate => 0.50,
            RiskTier::Aggressive => 0.75,
        }
    }
    
    /// Get tier name for logging
    pub fn name(&self) -> &'static str {
        match self {
            RiskTier::Conservative => "CONSERVATIVE",
            RiskTier::Moderate => "MODERATE",
            RiskTier::Aggressive => "AGGRESSIVE",
        }
    }
}

/// Thresholds for tier transitions (in cents to avoid floating point)
const PROFIT_THRESHOLD_CENTS: i64 = 1000;  // $10 profit -> Aggressive
const LOSS_THRESHOLD_CENTS: i64 = -1000;   // $10 loss -> Conservative

/// Thread-safe risk manager for tracking session P&L and tier
#[derive(Clone)]
pub struct RiskManager {
    /// Session P&L in cents (for atomic operations)
    session_pnl_cents: Arc<AtomicI64>,
    /// Starting balance in dollars
    starting_balance: f64,
}

impl RiskManager {
    /// Create a new RiskManager with starting balance
    pub fn new(starting_balance: f64) -> Self {
        println!("📊 RiskManager initialized: Starting balance ${:.2}, Tier: MODERATE", starting_balance);
        Self {
            session_pnl_cents: Arc::new(AtomicI64::new(0)),
            starting_balance,
        }
    }
    
    /// Update session P&L and return the new tier
    pub fn update_pnl(&self, pnl_dollars: f64) -> RiskTier {
        let pnl_cents = (pnl_dollars * 100.0) as i64;
        let new_total = self.session_pnl_cents.fetch_add(pnl_cents, Ordering::SeqCst) + pnl_cents;
        
        let tier = self.calculate_tier(new_total);
        println!("📊 Session P&L: ${:.2} | Tier: {}", new_total as f64 / 100.0, tier.name());
        tier
    }
    
    /// Get current tier based on session P&L
    pub fn current_tier(&self) -> RiskTier {
        let pnl = self.session_pnl_cents.load(Ordering::SeqCst);
        self.calculate_tier(pnl)
    }
    
    /// Calculate tier from P&L in cents
    fn calculate_tier(&self, pnl_cents: i64) -> RiskTier {
        if pnl_cents >= PROFIT_THRESHOLD_CENTS {
            RiskTier::Aggressive
        } else if pnl_cents <= LOSS_THRESHOLD_CENTS {
            RiskTier::Conservative
        } else {
            RiskTier::Moderate
        }
    }
    
    /// Get current trade size based on tier
    pub fn get_trade_size(&self) -> u64 {
        self.current_tier().trade_size()
    }
    
    /// Get max positions per asset based on tier
    pub fn get_max_positions(&self) -> usize {
        self.current_tier().max_positions_per_asset()
    }
    
    /// Get session P&L in dollars
    pub fn get_session_pnl(&self) -> f64 {
        self.session_pnl_cents.load(Ordering::SeqCst) as f64 / 100.0
    }
    
    /// Get max exposure in dollars based on tier and starting balance
    pub fn get_max_exposure(&self) -> f64 {
        self.starting_balance * self.current_tier().exposure_percent()
    }
}
