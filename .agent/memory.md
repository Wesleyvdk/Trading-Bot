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
