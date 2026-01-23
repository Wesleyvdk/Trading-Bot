# Trading Bot Dashboard - Implementation Plan

Dashboard for monitoring and comparing **momentum** vs **latency** trading strategies during the A/B testing period.

---

## Dashboard Requirements

### Core Views

| View | Purpose | Priority |
|------|---------|----------|
| **Strategy Comparison** | Side-by-side momentum vs latency metrics | P0 |
| **Real-time P&L** | Live tracking of session profitability | P0 |
| **Trade History** | Filterable trade log with edge/outcome analysis | P1 |
| **Win Rate Charts** | Historical performance over time | P1 |
| **Risk Metrics** | Drawdown, edge decay monitoring | P2 |
| **Market Activity** | Active markets, time remaining | P2 |

---

## API Endpoints (Already Added)

The following endpoints have been added to `dashboard_api.ts`:

### GET /api/strategies?days=7
Returns comparison stats for both strategies.
```json
{
  "momentum": { "trades": 47, "wins": 34, "pnl": 42.50, "winRate": 0.723 },
  "latency": { "trades": 23, "wins": 20, "pnl": 31.20, "winRate": 0.870 }
}
```

### GET /api/trades?strategy=latency&limit=50
Returns recent trades with optional filters.

### GET /api/performance?strategy=latency&days=7
Returns daily performance rollup for charts.

---

## UI Components to Add

### 1. Strategy Comparison Card
Display side-by-side comparison:
- Total Trades
- Win Rate
- Total P&L
- Avg Edge

### 2. Trade History Table
Columns: Time | Strategy | Asset | Direction | Entry | Exit | Edge | P&L | Outcome

### 3. P&L Chart
Line chart with separate lines for each strategy, auto-refresh.

---

## Database Tables (Already Added)

- `strategy_trades` - Individual trades with strategy identifier
- `strategy_performance` - Daily rollup for dashboard charts

---

## Data Functions (Available in db.ts)

- `getStrategyComparison(days)` - Compare both strategies
- `getRecentTrades(strategy, limit)` - Trade history
- `getDailyPerformance(strategy, days)` - Daily P&L
- `insertStrategyTrade(trade)` - Log new trade
- `updateTradeOutcome(id, exitPrice, pnl, outcome)` - Update after resolution
