# AISStream Uptime Monitor

A lightweight Node.js daemon and dashboard to monitor the live AIS shipping stream (`stream.aisstream.io`). It tracks WebSocket connection health, alerts on silent streams (where a connection is open but no shipping data is received), logs outages in SQLite, and provides a web dashboard to see the current status at a glance.

You can access the live service here with API docs below. 

## How it works

1. **Active Checking**: The server maintains a persistent WebSocket connection to `stream.aisstream.io` and subscribes to a geographical bounding box.
2. **State Evaluation**: The connection is classified into one of these states:
   - `Up`: Connected and receiving data messages.
   - `Silent Failure`: Connected, but no ship messages received for 15+ seconds.
   - `Auth Error`: Rejected due to an invalid API key.
   - `Down`: Disconnected or network unreachable.
3. **Flap Protection**: If the connection drops and reconnects within 120 seconds, it appends the events to the same outage incident instead of creating fragmented logs.

## API Reference

All endpoints return JSON and are rate-limited to the configured RPM per IP.

### GET `/api/v1/health`
A simple check to verify the HTTP server is responsive.
```json
{
  "status": "ok"
}
```

### GET `/api/v1/status`
Returns the current monitoring state, active settings, and a rolling 24-hour heartbeat grid.
- **Query Parameter**: Add `?simple=true` to skip database queries and get only the live connection metadata.

Example response:
```json
{
  "state": "Up",
  "lastChecked": "2026-06-22T12:00:00.000Z",
  "lastMessageReceived": "2026-06-22T11:59:58.000Z",
  "history": [
    { "timestamp": "2026-06-22T11:30:00.000Z", "state": "Up" }
  ],
  "devMode": false,
  "simulated": false
}
```

### GET `/api/v1/incidents`
Returns a list of past and ongoing outages from the database, ordered newest first.
```json
[
  {
    "id": 1,
    "start_time": "2026-06-22T10:00:00.000Z",
    "end_time": "2026-06-22T10:05:00.000Z",
    "outage_type": "Down",
    "details": "{\"summary\":\"Connection dropped: ECONNREFUSED\",\"errors\":[]}"
  }
]
```

### GET `/api/v1/logs`
Returns the 50 most recent console log messages. *Only accessible if `DEV=true` is set.*

### POST `/api/v1/test/simulate`
Forces a simulated outage status. *Only accessible if `DEV=true` is set.*
- **Request Body**: `{"state": "Silent Failure"}`

### POST `/api/v1/test/resume`
Resumes live monitoring and cancels the active simulation. *Only accessible if `DEV=true` is set.*


---

## Environment Variables

Configure the application by setting these environment variables or adding them to a `.env` file in the project root:

| Variable | Default | Description |
| :--- | :--- | :--- |
| `AISSTREAM_API_KEY` | *None (Required)* | Your secret API key from `aisstream.io`. |
| `PORT` | `3000` | The port number on which the HTTP server and dashboard run. |
| `DEV` / `NODE_ENV` | `false` / `production` | Set `DEV=true` or `NODE_ENV=DEV` to enable dashboard simulation tools and developer logs. |
| `AISSTREAM_BOUNDING_BOXES` | `[[[1.15, 103.6], [1.45, 104.1]]]` | A JSON array defining coordinate bounding boxes to subscribe to (defaults to the Singapore Strait). |
| `SILENCE_TIMEOUT_SECONDS` | `15` | Seconds of inactivity on the socket before declaring a `Silent Failure`. |
| `SILENCE_TO_DOWN_TIMEOUT_SECONDS` | `1800` (30 mins) | Seconds a stream can remain in `Silent Failure` before being classified as `Down`. |
| `API_RATE_LIMIT_RPM` | `60` | Max API requests permitted per minute per IP address. |
| `API_CACHE_TTL_SECONDS` | `15` | Lifespan in seconds of cached JSON responses for status/incidents queries. |

---

## Setup & Running

### Requirements
- Node.js (v18+)

### 1. Install Dependencies
```bash
npm install
```

### 2. Run the App
```bash
npm start
```
Go to `http://localhost:3000` to view the status dashboard.

---

## Production Deployment (Docker)

To run the application inside Docker with database persistence, use Docker Compose:

```bash
docker-compose up -d
```

This mounts a persistent volume `db_data` mapping to `/app/data/` to keep your outage history across container updates.

---

