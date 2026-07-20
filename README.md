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


