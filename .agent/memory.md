# Architectural Decisions Log

- **2026-01-08**: Initialized project with Rust. Archived legacy Python files.
- **2026-01-08**: Selected `alloy` for Ethereum interaction and `simd-json` for parsing based on performance requirements.
- **2026-01-13**: Switched Polymarket market discovery from `slug_contains` to `search` parameter with client-side filtering.
  - **Context**: `slug_contains` failed to correctly filter Bitcoin and Solana markets, returning unrelated results.
  - **Decision**: Use `search={asset}` to fetch candidates and filter locally for "above", "price on", and "up or down" patterns.
  - **Rationale**: Manual verification confirmed these markets exist but are not discoverable via the previous slug patterns.
