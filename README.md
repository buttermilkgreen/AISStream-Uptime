**AISStream Uptime Monitor**
A lightweight, high-performance, and self-contained uptime monitor for the live AIS WebSocket stream (stream.aisstream.io). Built with pure Node.js (no heavy web framework dependencies) and SQLite, it tracks service availability, identifies silent stream failures, logs error timelines, and serves a modern, responsive HTML5 monitoring dashboard.

**Features**
- Real-Time WebSocket Monitoring: Establishes a persistent connection to wss://stream.aisstream.io/v0/stream and monitors vessel position broadcasts.
- Intelligent Outage Classifications: Decodes connection issues into 4 distinct monitoring states:
 - Up: Active and receiving vessel position broadcasts.
 - Silent Failure: Connected to the server, but zero data frames received for 15+ seconds.
- Auth Error: Invalid API key or authorization rejection (e.g., WS 1008).
*  - - -Down: Disconnected, server unreachable, or network socket failures.
- Outage Flap Protection: Features a 120-second coalescing window. Intermittent flickers don't fragment log history; instead, they are merged into a single continuous incident timeline.
- Timeline-Based Incident Logging: Logs historical downtimes in SQLite with a nested JSON timeline detailing state mutations (e.g., transitioning from a network drop to an auth rejection during a single incident).
- Responsive Dashboard: Beautiful, glassmorphism-inspired single-page frontend that shows real-time heartbeat statuses, historical logs, active outages, and rolling 30-minute availability cards.
- Developer Simulation Controls: Allows local developers to toggle "Simulation Mode" and trigger arbitrary outage states to verify client/server logging responses.
- Docker-Ready: Packaged with a production-optimized Dockerfile and docker-compose.yml that includes persistent volume mapping for SQLite databases.
