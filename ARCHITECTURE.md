# AISStream Uptime Monitor - Architecture Documentation

This document describes the design, system flow, data models, and error handling architecture of the **AISStream Uptime Monitor**.

---

## 1. System Overview

The AISStream Uptime Monitor is a lightweight, low-dependency tool designed to monitor the reliability of the live AIS WebSocket stream at `stream.aisstream.io`. It is structured as a two-tier application:

```mermaid
graph TD
    subgraph Client (Frontend)
        A[HTML5 Dashboard] <-->|HTTP API / Static Files| B(app.js & style.css)
    end
    subgraph Server (Backend)
        C[HTTP & API Server] <-->|Reads/Writes| D[(SQLite: uptime.db)]
        E[Uptime Daemon] -->|Monitors| F[stream.aisstream.io]
        E -->|Logs Incidents| D
        C <-->|Retrieves Status & Logs| E
    end
```

---

## 2. Server Architecture (`server.js`)

The backend is built in pure Node.js without heavy frameworks (e.g., Express) to remain fast and portable. Its components are:

* **Static File Server**: Delivers the static assets located in the `/public` folder.
* **HTTP API Endpoints**:
  * `GET /api/v1/status`: Returns current system status state, last checked timestamps, rolling 30-minute heartbeat history, `devMode`, `simulated`, plus an `activeIncident` object (containing `id`, `start_time`, `admin_notes`, `admin_link`, `admin_link_text`) if there is currently an ongoing outage. Supports query parameter `?simple=true` to return only live connection metadata instantly.
  * `GET /api/v1/health`: A lightweight check returning `{"status":"ok"}` instantly without database queries or caching.
  * `GET /api/v1/logs` (DEV mode only): Returns the 50 most recent console log messages stored in memory. Returns `403 Forbidden` in production.
  * `GET /api/v1/incidents`: Query historical incidents and active outages ordered reverse-chronologically (`start_time DESC`).
  * `POST /api/v1/admin/verify`: Validate if a provided API key matches the configured `ADMIN_API_KEY`. Used to verify credentials before granting client-side access. Includes IP-lockout protection.
  * `GET /api/v1/admin/api-usage`: Retrieve aggregated API usage statistics (unique IPs, daily volume, endpoints, status codes, and top consumers) for direct API clients. Authorized via `Authorization: Bearer <ADMIN_API_KEY>`. Includes IP-lockout protection.
  * `PATCH /api/v1/incidents/:id`: Manually update an incident's fields such as `start_time`, `outage_type`, `admin_notes`, `admin_link`, and `admin_link_text` (authorized via `Authorization: Bearer <ADMIN_API_KEY>`). Includes IP-lockout protection for invalid attempts.
  * `DELETE /api/v1/incidents/:id`: Remove an incident from the database (authorized via `Authorization: Bearer <ADMIN_API_KEY>`). If it was the active ongoing incident, automatically rolls back and marks the next most recent incident as ongoing, resuming status and watchdog timers. Includes IP-lockout protection.
  * `GET /api/v1/votes`: Query consensus vote counts (Agree / Disagree) for a given status state, along with the caller's active vote.
  * `POST /api/v1/vote`: Submit, change, or withdraw a vote on a status state.
  * `POST /api/v1/test/simulate` (DEV mode only): Simulates manual state transitions (e.g. `Down`, `Silent Failure`, `Auth Error`, `Up`) with optional custom error message payloads.
  * `POST /api/v1/test/resume` (DEV mode only): Clears simulated state and resumes live monitoring of `stream.aisstream.io`.
* **WebSocket Client**: Establishes a persistent connection to `wss://stream.aisstream.io/v0/stream`, subscribes to shipping vessel position reports in a defined geographical bounding box, and monitors stream state.
* **Uptime State Machine**: Evaluates current health against five monitored states:
  * **Pending**: Initial startup state before a connection attempt completes. Displays as "Connecting..." with a spinner on the UI.
  * **Up**: Connected to WebSocket and receiving live data messages.
  * **Silent Failure**: WebSocket is open, but no ship messages have arrived for configured `SILENCE_TIMEOUT_SECONDS` (defaults to 15 seconds).
  * **Service Outage**: Prolonged loss of service. If a silent failure persists beyond `SILENCE_TO_DOWN_TIMEOUT_SECONDS` (defaults to 30 minutes), it escalates to `Down`.
  * **Auth Error**: WebSocket connection rejected due to credentials/API key failure.
  * **Down**: WebSocket connection dropped, host unreachable (DNS, socket timeout, etc.), or escalated from a prolonged silent failure.
* **Log Redaction & Safety**: The system sanitizes log messages using a multi-layered filter (`sanitizeLog`) to prevent accidental API key leaks. It redacts the literal value of `AISSTREAM_API_KEY` and scrubs JSON/Query patterns matching `apiKey`, `key`, or `token`.
* **Stream Telemetry**: The server tracks message counts and logs 30-second throughput statistics (total reports, average reports/sec) to connection logs.

### 2.1 Error Interpretation
The server includes a translation layer `interpretError(detailsObj)` that scans raw errors (e.g. status codes, socket flags) and produces a human-friendly description:
- **WebSocket 1008**: *"Authentication failure: Invalid or expired API Key"*
- **HTTP 502/503/504**: Translated to friendly Gateway/Overload states (e.g., *"Server Overloaded (503)"*)
- **ENOTFOUND / ETIMEDOUT / ECONNREFUSED**: Translated to readable local connection or timeout failures.

### 2.2 Flapping Outage Coalescing (Flap Protection)
To prevent creating separate, fragmented incident records when a connection fluctuates rapidly (e.g. going Down -> Up for 10s -> Down again), the backend enforces a **120-second coalescing window**:
1. When a new failure occurs, the server queries the database for the most recent incident.
2. If that incident was resolved **less than 120 seconds ago**, the server deletes the resolution timestamp (re-opens the incident) and appends the new failure details to its existing timeline events.
3. If the server transitions *directly* between different failure states (e.g. `Down` -> `Auth Error` -> `Silent Failure`), the active incident's database type is updated to `Service Outage` while retaining the single continuous incident entry.

### 2.3 Silent Failure In-Place Updates, Escalation & Resolution Formatting
To prevent timeline database bloat from polling checks that run every 2 seconds during a long silent failure:
- **In-Place Updates**: If consecutive failures are of type `Silent Failure`, the backend updates the existing timeline entry in-place instead of appending a new object.
- **Escalation**: If the silent failure continues for longer than `SILENCE_TO_DOWN_TIMEOUT_SECONDS` (defaults to 30 minutes / 1800s), the system automatically updates the incident to a full `"Down"` state, documenting that the connection remains active but no vessel data has been received for the duration.
- **Ongoing State**: During the outage, the database record reads `"Connection established but no ships received for [Duration]"` using a friendly formatted description.
- **Resolved State**: When the connection resumes, the backend calculates the exact outage duration and formats it dynamically (seconds, minutes/seconds, or hours/minutes), rewriting the final database summary and matching timeline node to `"No message received for [duration]"`.

### 2.4 Rate Limiting & Response Caching
To protect resource-constrained servers (such as a home lab environment) from abuse and performance bottlenecks, the backend implements:
* **IP-based Rate Limiting**: Tracks incoming requests per IP address in an in-memory sliding window. If an IP exceeds `API_RATE_LIMIT_RPM` within a 1-minute period, it is throttled with an `HTTP 429 Too Many Requests` status code. Throttling is *only* applied to `/api/v1/...` routes; static files (HTML, CSS, JS) remain unthrottled.
* **In-Memory Caching**: Caches JSON responses for resource-heavy endpoints (`GET /api/v1/status` and `GET /api/v1/incidents`) for a configurable duration (`API_CACHE_TTL_SECONDS`). Caches are cleared instantly upon state transitions or new incident records (including consensus votes) to ensure users always receive accurate real-time data when a status change happens.
* **WebSocket Connection Rate-Limit Backoff**: If the background daemon encounters a `429` rate limit or connection error from `stream.aisstream.io`, it will automatically back off the reconnection timer for 90 seconds. This prevents aggressive reconnect attempts from sustaining an API-key or IP-level connection block.


### 2.5 Environment Configuration
The backend loads configuration settings from a local `.env` file or from the environment:
* **`AISSTREAM_API_KEY`**: The API key required to authenticate with the AISStream WebSocket server.
* **`PORT`**: The local port number on which the HTTP server listens (defaults to `3000`).
* **`NODE_ENV` / `DEV`**: Setting `NODE_ENV=DEV` or `DEV=true` activates local developer simulation features.
* **`AISSTREAM_BOUNDING_BOXES`**: A JSON string array defining geographical bounding boxes to subscribe to (defaults to Singapore Strait: `[[[1.15, 103.6], [1.45, 104.1]]]`).
* **`SILENCE_TIMEOUT_SECONDS`**: Inactivity period in seconds before a connected stream is marked as a `Silent Failure` (defaults to `15`).
* **`SILENCE_TO_DOWN_TIMEOUT_SECONDS`**: Interval in seconds before escalating a `Silent Failure` to `Down` / `Service Outage` (defaults to `1800` / 30 minutes).
* **`API_RATE_LIMIT_RPM`**: Maximum requests per minute allowed per client IP (defaults to `60`).
* **`API_CACHE_TTL_SECONDS`**: Response caching duration in seconds for status and incident history (defaults to `15`).

---

## 3. Database Schema & Incident Timeline

All downtime windows are tracked persistently using SQLite (`uptime.db`) via the `sqlite3` driver.

### Database Table: `incidents`

| Column | Type | Description |
| :--- | :--- | :--- |
| `id` | `INTEGER` | Primary key (Auto-incremented) |
| `start_time` | `TEXT` | ISO-8601 Timestamp of outage start |
| `end_time` | `TEXT` | ISO-8601 Timestamp of outage resolution (Null if ongoing) |
| `outage_type` | `TEXT` | State type: `Down`, `Silent Failure`, `Service Outage`, or `Auth Error` |
| `details` | `TEXT` | Structured JSON containing error event logs and raw diagnostics |
| `admin_notes` | `TEXT` | Optional manually entered notes/details regarding the outage |
| `admin_link` | `TEXT` | Optional manually added external reference URL (e.g. GitHub Issue) |
| `admin_link_text` | `TEXT` | Custom label text for the link button |

### Database Table: `status_votes`
Used to manage consensus votes for system status states and active outage incidents (Agree / Disagree).
- Restricts voters to one vote per unique incident window (where `incident_id` is defined) or one vote per unique status state (where `incident_id` is null, e.g. for the "Up" state).
- Stores the client's IP address, the status state name, the vote type (`up` or `down`), a timestamp, and the associated `incident_id` (which is NULL if there is no active outage).


### Database Table: `api_logs`
Used to log and analyze direct client calls to public endpoints (excluding the frontend dashboard requests and health check metrics). A background pruning interval automatically deletes logs older than 30 days.

| Column | Type | Description |
| :--- | :--- | :--- |
| `id` | `INTEGER` | Primary key (Auto-incremented) |
| `timestamp` | `TEXT` | ISO-8601 Timestamp of the request |
| `ip` | `TEXT` | Client IP address of the caller |
| `endpoint` | `TEXT` | Target API path (query parameters stripped) |
| `status_code` | `INTEGER` | HTTP response code (e.g. 200, 429, 500) |
| `response_time_ms` | `INTEGER` | Latency in milliseconds between request and finished response |

### Incident Timeline JSON Structure (`details`)
To track how errors mutate during a single outage (e.g., transitioning from a network drop to successive connection timeouts), the `details` field is stored as a structured timeline payload:

```json
{
  "summary": "Connection dropped or unreachable: getaddrinfo ENOTFOUND stream.aisstream.io",
  "errors": [
    {
      "timestamp": "2026-06-16T19:10:00.000Z",
      "type": "Down",
      "message": "Connection dropped or unreachable. Code: 1006, Reason: Abnormal closure",
      "raw": {
        "code": 1006,
        "reason": "Abnormal closure",
        "socketError": null
      }
    },
    {
      "timestamp": "2026-06-16T19:10:10.000Z",
      "type": "Down",
      "message": "Connection dropped or unreachable: getaddrinfo ENOTFOUND stream.aisstream.io",
      "raw": {
        "code": 1006,
        "reason": "None",
        "socketError": {
          "message": "getaddrinfo ENOTFOUND stream.aisstream.io",
          "code": "ENOTFOUND"
        }
      }
    }
  ]
}
```

---

## 4. Frontend Architecture

The frontend is a single-page app built using semantic HTML5, Vanilla JavaScript, and flexible CSS.

* **Status Banner**: Located at the top of the viewport. It dynamically changes colors, icons, and descriptions based on the overall system health state returned by `/api/status`. If in simulation mode, it renders a warning indicator overlay.
* **Heartbeat Bar**: A rolling grid of 30 blocks representing the status for each of the last 30 minutes. Hovering over a block displays a tooltipped snapshot of status and timestamp.
* **Console Terminal**: A slide-out drawer that appears only when developer mode is active (`DEV=true` or `NODE_ENV=DEV`). It polls `/api/logs` every 2 seconds, displaying color-coded daemon operations, subscription configurations, reconnection statistics, and message throughput telemetry in a terminal-like environment. Hidden entirely in production environments.
* **Incidents feed**:
  * Displays history grouped by the last 4 calendar months.
  * Shows the aggregate historical thumbs-up and thumbs-down vote counts on each incident card.
  * For the active ongoing incident card, the vote buttons are interactive and mirror the main banner's voting state and actions. For closed historical incidents, the buttons are disabled and styled as read-only.
  * Truncates long summary text descriptions in the main feed and detailed timeline event logs to 140 characters, while retaining the full unabridged event log text exclusively inside the raw inspect pre block.
  * Supports interactive timelines with a **reverse-chronological event sorting** flow, placing the newest error occurrences at the top.
  * Preserves UI drawer state: Prior to periodic data poll cycles, the application caches the expanded/collapsed state of each `.timeline-drawer` and `.timeline-raw-container` ID, restoring their visibility classes automatically on DOM re-renders.
  * Includes a **Raw Response Inspector**: Clicking the `</>` SVG icon expands a formatted dark code container containing the raw JSON object. The text wraps naturally (`white-space: pre-wrap` and `word-break: break-all`) to accommodate smaller screen viewports, allowing developers to copy the full string to their clipboard.
* **Rate Limit Toast Notification**: If the client exceeds the local API rate limit, the global fetch interceptor catches the `HTTP 429` status code and displays a non-intrusive, premium floating toast notification warning at the top of the viewport, which automatically auto-dismisses after 5 seconds.
* **Developer Simulation HUD**: Appears only in development environments (`NODE_ENV=DEV` or `DEV=true`). Allows triggering simulated outages, inputting simulated raw error text, and reverting back to live tracking.
* **Admin API Usage Dashboard**: Visible at the bottom of the main layout only when verified as administrator. It shows:
  * **Metric Cards**: Active user counts (unique IPs) over the last 24 hours, 7 days, and 30 days.
  * **Charts**: Visualizations of Daily Request Volume (bar chart), Endpoint Distribution (doughnut chart), and Status Code Distribution (doughnut chart).
  * **Top Consumers**: Data table summarizing the 10 most active client IP addresses and their request volumes.
  * **Responsive Grid**: Flexes to full-width stacked list on mobile devices and 2-column grid layout on larger screens, keeping charts readable and aligned.

---

## 5. Dependency Management & Native Modules

To keep the project lightweight and fast, direct runtime dependencies are minimized:

* **`ws`** (`^8.21.0`): The WebSocket engine used to communicate with the `aisstream.io` server.
* **`sqlite3`** (`^6.0.1`): The database driver used to persist outage incidents.

### Transitive and Native Modules
While only two dependencies are declared in `package.json`, installing them downloads nested (transitive) helper packages in `node_modules`:

1. **Native Compilation & OS Bindings**:
   * `sqlite3` requires compiling native C++ database bindings for the host OS (macOS).
   * Utilities like **`bindings`**, **`napi-build-utils`**, and **`detect-libc`** are loaded to manage and interface with the compiled C++ SQLite binary directly in Node.js.
2. **Buffer and Stream Processing Utilities**:
   * Packages such as **`bl`** (Buffer List), **`buffer`**, and **`base64-js`** provide cross-platform stream handling.
   * **`minipass`** and **`graceful-fs`** manage high-performance, error-resilient filesystem I/O for database operations.

---

## 6. Simulation & Testing Subsystem

To test the application's response to outages without relying on actual service disruptions, a test system is built directly into the codebase.

### Gating & Environment Configuration
The simulation subsystem is restricted to local development environments. It is controlled via standard environment variables defined in `.env`:
* **`NODE_ENV=DEV`** or **`DEV=true`**: Activates simulation mode. The backend enables test-only endpoints and exposes the `devMode` status flag to the client.
* **Production / Normal mode**: Simulation routes are locked (`403 Forbidden` response), and the Developer HUD is completely hidden from the UI.

### Live Monitor Suspension
When a simulation begins (`simulatedModeActive === true`):
1. **WS Message Bypass:** Live incoming data messages from `stream.aisstream.io` are ignored and will not transition the system state back to `Up`.
2. **Silence Check Bypass:** The periodic silence check daemon is suspended, preventing it from overriding the manually set simulated state.
3. **Restoring Live Stream:** When the developer clicks **Resume Live Monitor**, the simulation flag resets, and the server establishes a fresh WebSocket connection, restoring standard uptime checks.


