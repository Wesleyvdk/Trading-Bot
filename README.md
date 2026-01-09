# Rust HFT Trading Bot

High-frequency trading bot for Polymarket arbitrage, written in Rust.

## Architecture
- **Language**: Rust (Tokio runtime)
- **Pattern**: Lock-free Ring Buffer (`rtrb`) connecting Ingestion -> Strategy -> Execution.
- **Connectivity**:
    - **Binance**: WebSocket (`tungstenite`) for price discovery.
    - **Polymarket**: WebSocket + HTTP/2 (`reqwest`) for execution.
- **Performance**:
    - `simd-json` for parsing.
    - `core_affinity` for thread pinning.
    - `alloy` for local signing.

## Prerequisites
- **OS**: Amazon Linux 2023 (Recommended) or Ubuntu 22.04.
- **Hardware**: Compute Optimized (c6i.xlarge or better) for stable clock speeds.
- **Network**: AWS `eu-west-2` (London) for proximity to Polymarket/Binance servers.

## Setup & Deployment

1.  **Clone the Repository**:
    ```bash
    git clone <repo_url>
    cd trading_bot
    ```

2.  **Run Setup Script**:
    This script installs Rust, build tools, and applies kernel tuning for low latency.
    ```bash
    chmod +x setup.sh
    ./setup.sh
    ```
    *Note: You may need to reboot after kernel tuning.*

3.  **Configuration**:
    Create a `.env` file in the root directory:
    ```env
    POLYMARKET_API_KEY=your_api_key
    POLYMARKET_SECRET=your_secret
    POLYMARKET_PASSPHRASE=your_passphrase
    ```

4.  **Build for Production**:
    ```bash
    cargo build --release
    ```

## Operation

### Running the Bot
```bash
# Run with release profile
./target/release/trading_bot
```

### Dry Run vs. Live
- **Default**: The bot is currently hardcoded to "Dry Run" mode in `src/execution.rs` (it logs trades but does not send them).
- **Go Live**: To enable live trading, modify `src/execution.rs` to uncomment the HTTP request logic and remove the "Dry Run" print statements.

### Monitoring
- **Logs**: Standard output contains trade logs and errors. Redirect to a file or use `systemd` for persistence.
- **Latency**: Monitor "Tick-to-Trade" latency logs (if enabled).

## Troubleshooting
- **DNS Errors**: If you see `No such host is known` for Polymarket, ensure your instance has outbound internet access and DNS is configured correctly (`8.8.8.8`).
- **Websocket Disconnects**: The bot handles basic reconnections, but for high availability, run under `systemd` with `Restart=always`.
