#!/bin/bash
set -e

echo "Starting Environment Setup..."

# 1. Install Dependencies
if command -v apt-get &> /dev/null; then
    echo "Detected Debian/Ubuntu system..."
    sudo apt-get update -y
    sudo apt-get install -y git build-essential libssl-dev pkg-config
elif command -v dnf &> /dev/null; then
    echo "Detected Amazon Linux/Fedora system..."
    sudo dnf update -y
    sudo dnf install -y git gcc openssl-devel pkgconfig
else
    echo "Unsupported package manager. Please install git, gcc, openssl, and pkg-config manually."
    exit 1
fi

# 2. Install Rust
if ! command -v cargo &> /dev/null; then
    echo "Installing Rust..."
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
    . "$HOME/.cargo/env"
else
    echo "Rust is already installed."
fi

# 3. Kernel Tuning for Low Latency
echo "Applying Kernel Tuning..."
cat <<EOF | sudo tee /etc/sysctl.d/99-low-latency.conf
# Network Tuning
net.core.rmem_max = 16777216
net.core.wmem_max = 16777216
net.ipv4.tcp_rmem = 4096 87380 16777216
net.ipv4.tcp_wmem = 4096 65536 16777216
net.ipv4.tcp_no_metrics_save = 1
net.ipv4.tcp_moderate_rcvbuf = 1
net.ipv4.tcp_window_scaling = 1
net.ipv4.tcp_timestamps = 0
net.ipv4.tcp_sack = 0

# CPU Tuning
kernel.sched_migration_cost_ns = 5000000
kernel.sched_min_granularity_ns = 10000000
vm.swappiness = 10
EOF

sudo sysctl -p /etc/sysctl.d/99-low-latency.conf

echo "Setup Complete! Please reboot for all kernel changes to take effect."
