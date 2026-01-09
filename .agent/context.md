# Project Context: Low-Latency Polymarket Arbitrage Engine

## Architectural Overview
This project is a high-frequency trading (HFT) bot designed to arbitrage price differences between Binance (Spot) and Polymarket (CLOB).

### Core Modules
- **Ingestion Engine ("The Ear")**: Consumes WebSocket data from Binance and Polymarket. Uses `tokio-tungstenite` and `simd-json` for low-latency parsing.
- **Strategy Engine ("The Brain")**: Deterministic, single-threaded logic pinned to a CPU core. Uses a Ring Buffer (`rtrb`) for lock-free communication.
- **Execution Engine ("The Hand")**: Handles order signing and dispatch via HTTP/2. Uses `alloy` for EIP-712 signing and `reqwest` for networking.

### Key Patterns
- **Single-Producer Multi-Consumer (SPMC)**: Uses ring buffers to avoid mutex locking.
- **Zero-Copy Parsing**: Minimizes memory allocation during hot paths.
- **Core Pinning**: Dedicates CPU cores to critical threads to reduce cache misses.

## Directory Structure
- `src/`: Source code
    - `ingestion.rs`: WebSocket consumption
    - `strategy.rs`: Core logic
    - `execution.rs`: Order management
    - `main.rs`: Entry point and orchestration
