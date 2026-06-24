# AISStream Uptime Monitor

A lightweight Node.js daemon and dashboard to monitor the live AIS shipping stream (`stream.aisstream.io`). It tracks WebSocket connection health, alerts on silent streams (where a connection is open but no shipping data is received), logs outages in SQLite, and provides a web dashboard to see the current status at a glance.

You can access the [live service here](https://aisuptime.buttermilkgreen.fyi) with API docs below. 

## How it works

1. **Active Checking**: The server maintains a persistent WebSocket connection to `stream.aisstream.io` and subscribes to a geographical bounding box.
2. **State Evaluation**: The connection is classified into one of these states:
   - `Up`: Connected and receiving data messages.
   - `Silent Failure`: Connected, but no ship messages received for 15+ seconds.
   - `Auth Error`: Rejected due to an invalid API key.
   - `Down`: Disconnected or network unreachable.
3. **Flap Protection**: If the connection drops and reconnects within 120 seconds, it appends the events to the same outage incident instead of creating fragmented logs.

## API Reference

#### GET `/api/v1/health`
A simple check to verify the HTTP server is responsive.
```json
{
  "status": "ok"
}
```

#### GET `/api/v1/status`
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

#### GET `/api/v1/incidents`
Returns a list of past and ongoing outages from the database, ordered newest first. Includes voting stats, override counts, and custom admin notes/links if configured.
```json
[
  {
    "id": 1,
    "start_time": "2026-06-22T10:00:00.000Z",
    "end_time": "2026-06-22T10:05:00.000Z",
    "outage_type": "Down",
    "details": "{\"summary\":\"Connection dropped: ECONNREFUSED\",\"errors\":[]}",
    "admin_notes": "ISP maintenance scheduled",
    "admin_link": "https://isp.status/incident/123",
    "admin_link_text": "ISP Status Page",
    "override_votes_up": null,
    "override_votes_down": null,
    "votes_up": 0,
    "votes_down": 0
  }
]
```



#### GET `/api/v1/votes`
Returns the user consensus vote counts (Agree / Disagree) for the current status state or a specified state, along with the current user's vote.
- **Query Parameter**: Add `?state=Up` to retrieve votes for a specific state (defaults to the current status state).

Example response:
```json
{
  "up": 12,
  "down": 3,
  "userVote": "up"
}
```

#### POST `/api/v1/vote`
Casts, updates, or clears a vote on a status state.
- **Request Body**: `{"state": "Up", "vote": "up"}` (where `vote` can be `"up"`, `"down"`, or `null` to undo/clear the vote).

Example response:
```json
{
  "up": 12,
  "down": 4,
  "userVote": "down"
}
```

#### GET `/api/v1/admin/api-usage`
Protected by `ADMIN_API_KEY`. Returns analytical data tracking API calls from external users, unique IP counts over 24h/7d/30d, daily volume patterns, and top consumer IPs.
- **Headers**: `Authorization: Bearer <ADMIN_API_KEY>`

Example response:
```json
{
  "uniqueIPs": {
    "last24h": 5,
    "last7d": 12,
    "last30d": 34
  },
  "dailyVolume": [
    { "date": "2026-06-23", "count": 150 }
  ],
  "endpoints": [
    { "endpoint": "/api/v1/status", "count": 120 }
  ],
  "statusCodes": [
    { "status_code": 200, "count": 140 }
  ],
  "topConsumers": [
    { "ip": "192.168.1.50", "count": 85 }
  ]
}
```

#### POST `/api/v1/admin/verify`
Checks if the sent admin key is correct.
- **Headers**: `Authorization: Bearer <ADMIN_API_KEY>`

Example response:
```json
{
  "success": true
}
```

#### PATCH `/api/v1/incidents/:id`
Updates parameters of an incident by ID.
- **Headers**: `Authorization: Bearer <ADMIN_API_KEY>`
- **Request Body** (all fields optional):
```json
{
  "start_time": "2026-06-22T10:00:00.000Z",
  "admin_notes": "ISP maintenance scheduled",
  "admin_link": "https://isp.status/incident/123",
  "admin_link_text": "ISP Status Page",
  "outage_type": "Down",
  "override_votes_up": 10,
  "override_votes_down": 0,
  "errors": [
    { "timestamp": "2026-06-22T10:00:00.000Z", "type": "Down", "message": "ECONNREFUSED" }
  ]
}
```
Example response:
```json
{
  "success": true,
  "message": "Incident updated successfully."
}
```

#### DELETE `/api/v1/incidents/:id`
Deletes an incident by its ID. If it is the currently active incident, the system state reverts to the previous incident or resets to operational.
- **Headers**: `Authorization: Bearer <ADMIN_API_KEY>`

Example response:
```json
{
  "success": true,
  "message": "Incident deleted."
}
```

### Dev only queries (if you are self hosting and `DEV=true` is set.)

#### GET `/api/v1/logs`
Returns the 50 most recent console log messages.

#### POST `/api/v1/test/simulate`
Forces a simulated outage status. 
- **Request Body**: `{"state": "Silent Failure"}`

#### POST `/api/v1/test/resume`
Resumes live monitoring and cancels the active simulation.


---

## Environment Variables

If self hosting, you can configure these environment variables or add them to a `.env` file in the project root:

| Variable | Default | Description |
| :--- | :--- | :--- |
| `AISSTREAM_API_KEY` | *None (Required)* | Your secret API key from `aisstream.io`. |
| `PORT` | `3000` | The port number on which the HTTP server and dashboard run. |
| `DEV` | `false` / `production` | Set `DEV=true` to enable dashboard simulation tools and developer logs. |
| `AISSTREAM_BOUNDING_BOXES` | `[[[1.15, 103.6], [1.45, 104.1]]]` | A JSON array defining coordinate bounding boxes to subscribe to (defaults to the Singapore Strait). |
| `SILENCE_TIMEOUT_SECONDS` | `15` | Seconds of inactivity on the socket before declaring a `Silent Failure`. |
| `SILENCE_TO_DOWN_TIMEOUT_SECONDS` | `1800` (30 mins) | Seconds a stream can remain in `Silent Failure` before being classified as `Down`. |
| `API_RATE_LIMIT_RPM` | `60` | Max API requests permitted per minute per IP address. |
| `API_CACHE_TTL_SECONDS` | `15` | Lifespan in seconds of cached JSON responses for status/incidents queries. |
| `ADMIN_API_KEY` | *None* | Cryptographically secure random token to authorize manual incident updates, deletes, and API usage stats. |



