# Architectural Decisions Log

- **2026-01-08**: Initialized project with Rust. Archived legacy Python files.
- **2026-01-08**: Selected `alloy` for Ethereum interaction and `simd-json` for parsing based on performance requirements.
- **2026-01-13**: Switched Polymarket market discovery from `slug_contains` to `search` parameter with client-side filtering.
  - **Context**: `slug_contains` failed to correctly filter Bitcoin and Solana markets, returning unrelated results.
  - **Decision**: Use `search={asset}` to fetch candidates and filter locally for "above", "price on", and "up or down" patterns.
  - **Rationale**: Manual verification confirmed these markets exist but are not discoverable via the previous slug patterns.
- **2026-01-13**: Ported bot to TypeScript (`/ts`) using official `@polymarket/clob-client`.
  - **Rationale**: Official client provides better support and stability than custom Rust implementation.
- **2026-01-13**: Initiated refactor of Rust bot to use `polymarket-rs` crate.
  - **Rationale**: Leverage community-maintained library for cleaner API and potential Cloudflare handling, replacing custom `reqwest` implementation.
- **2026-01-14**: Updated market discovery to use specific daily market slugs.
  - **Context**: Generic event fetching was returning unrelated markets.
  - **Decision**: Generate dynamic slugs based on date pattern: `{asset}-up-or-down-on-{month}-{day}` (e.g., `bitcoin-up-or-down-on-january-14`).
  - **Implementation**: Both Rust (`polymarket.rs`) and TypeScript (`market.ts`) updated with new slug generation logic.
  - **Rationale**: Direct slug-based fetching is more reliable and returns exact markets for daily crypto "Up or Down" predictions.

---

## 2026-01-15: Momentum + Value Strategy Implementation

### New Strategy: Momentum + Value Filtering
- **Context**: Original strategy only used Binance momentum signals. Trades were placed at arbitrary prices without considering Polymarket share prices.
- **Decision**: Implement value-based filtering before trade execution.
- **Implementation**:
  - New `prices.rs` (Rust) and `prices.ts` (TypeScript) modules for fetching Polymarket orderbook data
  - Value filters: `MAX_ENTRY_PRICE=0.65`, `MIN_UPSIDE=0.30`, `MAX_SPREAD=0.10`
  - Orders skipped if filters fail, with logging of skip reason
- **Rationale**: Prevents buying overpriced shares with poor risk/reward.

### Magic.Link Wallet Support
- **Context**: Polymarket uses Magic.Link for embedded wallets. The private key generates a different address than the one holding funds.
- **Decision**: Add `POLYMARKET_FUNDER_ADDRESS` env variable for the proxy wallet address.
- **Implementation**:
  - TypeScript: `client.ts` updated with `signature_type=1` and `funderAddress` parameter
  - Rust: `polymarket.rs` updated with `SignatureType::PolyProxy` and funder address parsing
- **Rationale**: Magic.Link wallets use a proxy contract. The funder address is required for balance queries and order placement.

### Market Discovery Improvements
- **Context**: Hourly series slugs (`btc-up-or-down-hourly`) return unrelated markets (MicroStrategy, Trump deportation, etc.).
- **Decision**: Add "up or down" keyword filter to hourly market discovery.
- **Implementation**: Both Rust and TypeScript filter markets by checking `question.contains("up or down")`.
- **Finding**: Polymarket appears to only have DAILY crypto markets, not hourly.

### Date Fallback for Daily Markets
- **Context**: Daily markets close at end of day. If bot starts after closure, no markets found.
- **Decision**: Try today's market first, then tomorrow's if today is closed.
- **Implementation**: `polymarket.rs` calculates both today and tomorrow slugs, tries in order.

### P&L Tracking Fix
- **Context**: Session P&L was incrementing for ALL trades, even those skipped by value filters.
- **Decision**: Wrap P&L tracking in `_order_success` check.
- **Implementation**: `execution.rs` now only logs trades and updates P&L when `_order_success == true`.

### Execution Engine: Market Type Fallback
- **Context**: Strategy signals 60-MIN trades but only DAILY markets exist.
- **Decision**: Add fallback logic in execution to use DAILY markets when 60-MIN not found.
- **Implementation**: `execution.rs` tries exact market type first, then falls back to DAILY.

---

## Key Learnings

1. **Polymarket Market Structure**: No dedicated hourly crypto markets exist. Only daily "Up or Down" predictions.
2. **Orderbook vs UI Price**: The `/book` endpoint may return empty orderbook (bid=0, ask=1) while UI shows a price. UI likely shows last trade or indicative price.
3. **Magic.Link Complexity**: Private key → EOA address ≠ Proxy wallet address. Need both for API calls.
4. **Strategy-Execution Decoupling**: Ring buffer between strategy and execution means strategy can't know if trade succeeded. Position tracking should be in execution, not strategy.
