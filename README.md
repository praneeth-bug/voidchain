# VoidChain

VoidChain is a fully decentralised, anonymity-focused video communication system that combines Tor hidden services for signalling with the Yggdrasil overlay network for encrypted peer-to-peer media routing. It is designed to avoid central servers, STUN/TURN infrastructure, and metadata leakage by making each participant an independent node with cryptographically owned identities and complete control over signalling and media transport.

## Key ideas

- Signalling over Tor v3 hidden services (.onion) to protect signalling metadata and hide IPs.
- Media transport over Yggdrasil (an encrypted IPv6 overlay) to avoid STUN/TURN and public IP exposure.
- WebRTC for end-to-end media encryption (DTLS → SRTP). ICE candidates are restricted to Yggdrasil IPv6 addresses only.
- Local Node.js node per user that hosts a hidden-service-backed WebSocket signalling endpoint and a lightweight frontend.
- Identity rotation: ephemeral .onion keys and Yggdrasil keys to reduce linkability across sessions.


## Features

- Fully decentralised signalling (no central signalling server).
- Enforced Yggdrasil-only ICE candidates (no STUN/TURN reliance).
- Dual-layer encryption: WebRTC + Yggdrasil.
- Tor-based contact addresses (.onion) as disposable identifiers.
- Tools for rotating identities and managing call state locally.

## Architecture overview

1. Each node runs:
   - A Tor hidden service (v3) exposing a local WebSocket signalling endpoint.
   - A Yggdrasil node for encrypted IPv6 peer-to-peer routing.
   - A Node.js process that manages signalling, filters ICE candidates, and serves a small frontend.
2. Caller connects to callee's .onion address over Tor (outgoing via SOCKS5).
3. SDP offers/answers and ICE candidates are exchanged over the Tor WebSocket channel.
4. ICE candidates are rewritten/filtered so only Yggdrasil IPv6 addresses are used.
5. Media flows directly over Yggdrasil between peers using WebRTC’s DTLS→SRTP.

## Security & privacy considerations

- Signalling metadata is protected by Tor circuits; Tor itself does not reveal the user’s public IP to the remote hidden service.
- Yggdrasil encrypts transport-level routing between peers; WebRTC encrypts actual media.
- No STUN/TURN servers are used; this avoids IP leaks and third-party metadata.
- The system is intentionally privacy-forward: by default it does not store logs. If you modify the code to add logging, ensure logs are encrypted and purged.
- Identity rotation (recreating hidden-service keypairs and regenerating Yggdrasil keys) is recommended to avoid long-term correlation.

## Quickstart

> This quickstart assumes some familiarity with Tor, Yggdrasil, and Node.js. VoidChain prioritises privacy and therefore requires these components to be installed and configured on each peer.

### Prerequisites

- Node.js (LTS) and npm or yarn
- Tor (with support for v3 hidden services)
- Yggdrasil (https://yggdrasil-network.github.io)
- A modern browser with WebRTC support (Chromium-based or Firefox)

### Installation

1. Clone the repository:

   git clone https://github.com/praneeth-bug/voidchain.git
   cd voidchain

2. Install Node dependencies:

   npm install
   # or
   yarn install

3. Ensure Tor and Yggdrasil are installed and runnable on your machine.

### Configuration (high-level)

1. Tor hidden service
   - Create a torrc snippet to expose the local signalling port as a hidden service.
   - Example (torrc):

     HiddenServiceDir /path/to/hidden_service
     HiddenServiceVersion 3
     HiddenServicePort 9000 127.0.0.1:9000

   - Start Tor and note the generated .onion address in the `hidden_service/hostname` file.

2. Yggdrasil
   - Install and start yggdrasil with a configuration that allows peers to discover each other.
   - Note your Yggdrasil-assigned IPv6 address. This is used in ICE candidates.

3. Node.js app
   - Configure the Node.js node to:
     - Listen on the local port configured for the hidden service (e.g., 9000).
     - Read the Yggdrasil IPv6 address (from OS or local yggdrasil admin API) and inject it into ICE candidates.
     - Use Tor SOCKS5 localhost:9050 (or your Tor SOCKS port) for outbound .onion connections.

Check configuration files provided in the `config/` or root (e.g., example torrc and yggdrasil.conf included in the project appendix).

### Running (example)

1. Start Tor. Ensure the hidden service directory exists and the `hostname` file contains your .onion address.
2. Start Yggdrasil and confirm your interface is up (you should see a global IPv6 address assigned by Yggdrasil).
3. Start the Node.js node:

   npm start

4. Open the local frontend (usually served on http://127.0.0.1:3000 or the URL printed by the server). Use the provided UI to:
   - View your .onion address and Yggdrasil IPv6.
   - Share the .onion address with a peer (out-of-band) to receive calls.
   - Paste a peer’s .onion address and initiate a call.

## Usage

- To initiate a call:
  1. Obtain the callee’s .onion address.
  2. From the frontend, connect to the callee’s .onion signalling endpoint (the Node.js app will create a Tor SOCKS5 connection for this).
  3. The signalling exchange (SDP + Yggdrasil-only ICE candidates) takes place over Tor.
  4. Once a Yggdrasil path is found, media flows over the Yggdrasil overlay.

- Identity rotation:
  - Regenerate the Tor hidden service keys (replace the files in HiddenServiceDir) and restart Tor to obtain a new .onion.
  - Recreate or rotate the Yggdrasil keypair/configuration and restart yggdrasil.

## Project structure (high-level)

- package.json — Node.js project metadata
- server.js — Signalling engine and local node logic (see appendix in the project report)
- public/ or frontend/ — Static frontend served by the node (index.html, JS/CSS)
- config/ — Example torrc, yggdrasil.conf, and helper scripts
- README.md — This file

(Refer to Chapter 6 of the project report for full source listings and configuration snippets.)

## Limitations

- Higher latency during signalling due to Tor.
- Yggdrasil peer graph may cause suboptimal routing and occasional media jitter.
- Requires both peers to run Tor and Yggdrasil (increases setup complexity).
- No TURN fallback — intentionally designed to avoid third-party relays and metadata leakage.

## Future work

- Cross-platform GUI (Flutter) for easier installation and management of Tor/Yggdrasil and the node.
- Blockchain-based decentralized identity discovery without revealing personal information.
- Automated installers, packaging, and better NAT traversal strategies compatible with privacy goals.

## References

- Tor Project — https://www.torproject.org/
- Yggdrasil Network — https://yggdrasil-network.github.io/
- WebRTC — https://webrtc.org/
