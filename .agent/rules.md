# Development Rules

## Tech Stack
- **Language**: Rust (Latest Stable)
- **Runtime**: Tokio (limited threads)
- **HTTP Client**: Reqwest (HTTP/2 enabled)
- **Ethereum**: Alloy (No Ethers-rs)

## Code Quality
- **Strict Types**: No `unwrap()` in production code (use `expect` with clear messages or handle errors).
- **Performance**: 
    - Prefer fixed-size integers (`u64`, `ruint`) over floats where possible.
    - Avoid unnecessary clones in hot paths.
    - Use `simd-json` for parsing.
- **Testing**: Unit tests for all strategy logic.

## Workflow
- **Commits**: Conventional Commits (e.g., `feat: add ingestion`, `fix: websocket reconnect`).
- **Formatting**: Run `cargo fmt` before committing.
- **Linting**: Run `cargo check` and `cargo clippy` to ensure code quality.
