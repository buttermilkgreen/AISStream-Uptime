const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const sqlite3 = require('sqlite3').verbose();
const crypto = require('crypto');

// Banned IP lists for admin lockout
const bannedIPs = new Set();
const adminFailuresByIp = new Map();

// Timing safe comparison helper
function safeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) {
    crypto.timingSafeEqual(aBuf, aBuf);
    return false;
  }
  return crypto.timingSafeEqual(aBuf, bBuf);
}

// 1. Simple Custom .env Parser to keep dependencies minimal
function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf8');
    content.split('\n').forEach(line => {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
        const parts = trimmed.split('=');
        const key = parts[0].trim();
        const value = parts.slice(1).join('=').trim();
        if (process.env[key] === undefined) {
          process.env[key] = value;
        }
      }
    });
  }
}
loadEnv();

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.AISSTREAM_API_KEY;
const isDevMode = process.env.NODE_ENV === 'DEV' || process.env.DEV === 'true';
const SILENCE_TIMEOUT = parseInt(process.env.SILENCE_TIMEOUT_SECONDS, 10) || 15;
const SILENCE_TO_DOWN_TIMEOUT = parseInt(process.env.SILENCE_TO_DOWN_TIMEOUT_SECONDS, 10) || 1800;
const RATE_LIMIT_RPM = parseInt(process.env.API_RATE_LIMIT_RPM, 10) || 60;
const CACHE_TTL_SECONDS = parseInt(process.env.API_CACHE_TTL_SECONDS, 10) || 15;
let simulatedModeActive = false;
const serverStartTime = new Date().toISOString();

if (!process.env.ADMIN_API_KEY) {
  console.warn("\x1b[33m%s\x1b[0m", "WARNING: ADMIN_API_KEY is not configured. Manual incident editing will be unavailable.");
}

// Caching storage and helpers
const responseCache = {
  status: { data: null, expiresAt: 0 },
  incidents: { data: null, expiresAt: 0 }
};

function getCachedResponse(key) {
  const now = Date.now();
  const cache = responseCache[key];
  if (cache && cache.data && cache.expiresAt > now) {
    return cache.data;
  }
  return null;
}

function setCachedResponse(key, data) {
  const now = Date.now();
  responseCache[key] = {
    data: data,
    expiresAt: now + (CACHE_TTL_SECONDS * 1000)
  };
}

function invalidateCache() {
  responseCache.status = { data: null, expiresAt: 0 };
  responseCache.incidents = { data: null, expiresAt: 0 };
}

// Rate Limiting storage and helpers
const ipRequests = new Map();

function isRateLimited(ip) {
  const now = Date.now();
  const oneMinuteAgo = now - 60000;

  let timestamps = ipRequests.get(ip) || [];
  timestamps = timestamps.filter(t => t > oneMinuteAgo);

  if (timestamps.length >= RATE_LIMIT_RPM) {
    return true;
  }

  timestamps.push(now);
  ipRequests.set(ip, timestamps);
  return false;
}

// Clean up rate limit tracker map once per minute
setInterval(() => {
  const now = Date.now();
  const oneMinuteAgo = now - 60000;
  for (const [ip, timestamps] of ipRequests.entries()) {
    const fresh = timestamps.filter(t => t > oneMinuteAgo);
    if (fresh.length === 0) {
      ipRequests.delete(ip);
    } else {
      ipRequests.set(ip, fresh);
    }
  }
}, 60000);

// 2. Rolling log buffer (limit to 50 logs)
const systemLogs = [];


function sanitizeLog(message) {
  if (typeof message !== 'string') {
    message = String(message);
  }
  if (API_KEY) {
    message = message.split(API_KEY).join('[REDACTED_API_KEY]');
  }
  // Replace JSON/Query key formats (case-insensitive keys: APIKey, apiKey, apikey, key, token)
  message = message.replace(/(["']?apiKey["']?\s*:\s*["'])([^"']+)(["'])/gi, '$1[REDACTED_API_KEY]$3');
  message = message.replace(/(["']?key["']?\s*:\s*["'])([^"']+)(["'])/gi, '$1[REDACTED_API_KEY]$3');
  message = message.replace(/(["']?token["']?\s*:\s*["'])([^"']+)(["'])/gi, '$1[REDACTED_API_KEY]$3');
  return message;
}

function logEvent(message, type = 'info') {
  const sanitized = sanitizeLog(message);
  const timestamp = new Date().toISOString();
  const logObj = { timestamp, message: sanitized, type };
  systemLogs.push(logObj);
  if (systemLogs.length > 50) {
    systemLogs.shift();
  }
  console.log(`[${timestamp}] [${type.toUpperCase()}] ${sanitized}`);
}

// 3. Database Initialization & Seeding
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}
const dbPath = path.join(dataDir, 'uptime.db');
const db = new sqlite3.Database(dbPath);
let activeIncidentId = null;
let lastIncidentUpdateTime = 0;
let resumedOnStartup = false;

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS incidents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      start_time TEXT NOT NULL,
      end_time TEXT,
      outage_type TEXT NOT NULL,
      details TEXT
    )
  `);

  db.run(`
    ALTER TABLE incidents ADD COLUMN admin_notes TEXT
  `, (err) => {
    // Ignore error if column already exists
  });

  db.run(`
    ALTER TABLE incidents ADD COLUMN admin_link TEXT
  `, (err) => {
    // Ignore error
  });

  db.run(`
    ALTER TABLE incidents ADD COLUMN admin_link_text TEXT
  `, (err) => {
    // Ignore error
  });

  db.run(`
    CREATE TABLE IF NOT EXISTS status_votes (
      client_ip TEXT NOT NULL,
      status_state TEXT NOT NULL,
      vote_type TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      PRIMARY KEY (client_ip, status_state)
    )
  `);

  // Database is initialized empty. No mock seeding logic.
});

// Load active incident from database on startup, closing any stale/duplicate active ones
db.all("SELECT id, start_time, outage_type FROM incidents WHERE end_time IS NULL ORDER BY start_time DESC", (err, rows) => {
  if (err) {
    logEvent(`Failed to query active incidents on startup: ${err.message}`, "error");
    return;
  }
  if (rows && rows.length > 0) {
    activeIncidentId = rows[0].id;
    resumedOnStartup = true;

    // Resume ongoing outage state on boot so status is not "Pending"
    const lastOutageType = rows[0].outage_type;
    currentStatus.state = lastOutageType;
    logEvent(`Resumed ongoing outage state on startup: ${lastOutageType}`, "info");
    logEvent(`Loaded active incident #${activeIncidentId} on startup.`, "info");

    const incidentStartMs = new Date(rows[0].start_time).getTime();
    lastMessageTime = incidentStartMs;
    
    if (rows.length > 1) {
      const idsToClose = rows.slice(1).map(r => r.id);
      const now = new Date().toISOString();
      const placeholders = idsToClose.map(() => '?').join(',');
      db.run(`UPDATE incidents SET end_time = ? WHERE id IN (${placeholders})`, [now, ...idsToClose], (updateErr) => {
        if (updateErr) {
          logEvent(`Failed to close stale incidents on startup: ${updateErr.message}`, "error");
        } else {
          logEvent(`Closed ${idsToClose.length} stale/duplicate open incidents on startup: ${idsToClose.join(', ')}`, "info");
        }
      });
    }
  }
});

// 4. Uptime State variables and Heartbeat History (30 minutes)
let currentStatus = {
  state: "Pending", // Starts as pending status until connection established
  lastChecked: new Date().toISOString(),
  lastMessageReceived: null
};

/**
 * Appends a new error event to the timeline of an active incident
 */
/**
 * Interprets raw WebSocket close, socket error, and HTTP response errors, returning a user-friendly description.
 */
function interpretError(detailsObj) {
  if (!detailsObj) return "No further details logged.";

  const msg = detailsObj.message || "";
  const rawStr = JSON.stringify(detailsObj.raw || detailsObj).toLowerCase();

  // 1. Auth Failures
  if (rawStr.includes("1008") || rawStr.includes("auth") || rawStr.includes("key") || msg.toLowerCase().includes("key")) {
    return "Authentication failure: The provided API key is invalid or rejected by the server.";
  }

  // 2. Service-level gateway issues
  if (rawStr.includes("503") || msg.includes("503")) {
    return "AISStream Server Overloaded (503 Service Temporarily Unavailable).";
  }
  if (rawStr.includes("502") || msg.includes("502")) {
    return "Bad Gateway (502) - Gateway cannot reach upstream AISStream servers.";
  }
  if (rawStr.includes("504") || msg.includes("504")) {
    return "Gateway Timeout (504) - Connection timed out at gateway level.";
  }
  if (rawStr.includes("429") || msg.includes("429")) {
    return "Rate Limit Exceeded (429) - Too many connections requested.";
  }

  // 3. Socket-level issues
  if (rawStr.includes("enotfound")) {
    return "Local network disconnected (DNS Lookup Failed).";
  }
  if (rawStr.includes("etimedout")) {
    return "Connection timed out - The server did not respond in time.";
  }
  if (rawStr.includes("econnrefused")) {
    return "Connection refused - The server port is closed or offline.";
  }

  // 4. Inactivity
  if (msg.includes("No message received")) {
    return msg;
  }

  return msg || "Connection dropped or unreachable.";
}

/**
 * Formats a duration in seconds into a friendly human-readable string.
 */
function formatDuration(seconds) {
  if (seconds < 60) {
    const s = Math.max(1, Math.round(seconds));
    return `${s} second${s === 1 ? '' : 's'}`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60);
  if (minutes < 60) {
    if (remainingSeconds === 0) {
      return `${minutes} minute${minutes === 1 ? '' : 's'}`;
    }
    return `${minutes} minute${minutes === 1 ? '' : 's'} and ${remainingSeconds} second${remainingSeconds === 1 ? '' : 's'}`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;

  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    const remainingHours = hours % 24;
    const daysStr = `${days} day${days === 1 ? '' : 's'}`;
    const hoursStr = remainingHours > 0 ? `${remainingHours} hour${remainingHours === 1 ? '' : 's'}` : '';
    const minutesStr = remainingMinutes > 0 ? `${remainingMinutes} minute${remainingMinutes === 1 ? '' : 's'}` : '';

    if (hoursStr && minutesStr) {
      return `${daysStr}, ${hoursStr} and ${minutesStr}`;
    } else if (hoursStr) {
      return `${daysStr} and ${hoursStr}`;
    } else if (minutesStr) {
      return `${daysStr} and ${minutesStr}`;
    } else {
      return daysStr;
    }
  }

  if (remainingMinutes === 0) {
    return `${hours} hour${hours === 1 ? '' : 's'}`;
  }
  return `${hours} hour${hours === 1 ? '' : 's'} and ${remainingMinutes} minute${remainingMinutes === 1 ? '' : 's'}`;
}

/**
 * Replaces the duration string in standard outage messages with a new duration text.
 */
function replaceDurationInMessage(msg, newDurationText) {
  if (!msg) return msg;
  if (msg.includes("Connection established but no ship data received for ")) {
    return `Connection established but no ship data received for ${newDurationText}.`;
  }
  if (msg.includes("No message received for ")) {
    return `No message received for ${newDurationText}.`;
  }
  return msg;
}

/**
 * Appends a new error event to the timeline of an active incident
 */
function appendIncidentEvent(incidentId, type, detailsObj) {
  if (!detailsObj) return;

  db.get("SELECT details FROM incidents WHERE id = ?", [incidentId], (err, row) => {
    if (err || !row) {
      logEvent(`Failed to retrieve incident #${incidentId} for update: ${err?.message}`, "error");
      return;
    }

    let timelineDetails = { summary: "", errors: [] };
    if (row.details) {
      try {
        timelineDetails = JSON.parse(row.details);
        // If it was a flat legacy object, convert it
        if (!timelineDetails.errors) {
          timelineDetails = {
            summary: timelineDetails.message || `Outage in progress`,
            errors: [{
              timestamp: new Date().toISOString(),
              type: type,
              message: timelineDetails.message || "Outage initial event",
              raw: timelineDetails
            }]
          };
        }
      } catch (e) {
        timelineDetails = {
          summary: row.details,
          errors: [{
            timestamp: new Date().toISOString(),
            type: type,
            message: row.details,
            raw: null
          }]
        };
      }
    }

    const friendlyMessage = interpretError(detailsObj);

    // If the last error was of the same state type, update the event in-place to prevent timeline bloat
    const lastError = timelineDetails.errors[timelineDetails.errors.length - 1];
    if (lastError && lastError.type === type) {
      lastError.timestamp = new Date().toISOString();
      lastError.message = friendlyMessage;
      lastError.raw = detailsObj.raw || detailsObj;
    } else {
      timelineDetails.errors.push({
        timestamp: new Date().toISOString(),
        type: type,
        message: friendlyMessage,
        raw: detailsObj.raw || detailsObj
      });
    }
    timelineDetails.summary = friendlyMessage;

    db.run("UPDATE incidents SET details = ? WHERE id = ?", [JSON.stringify(timelineDetails), incidentId], (err) => {
      if (err) {
        logEvent(`Failed to append timeline event to incident #${incidentId}: ${err.message}`, "error");
      } else {
        logEvent(`Appended/updated timeline event for incident #${incidentId}`, "info");
        invalidateCache();
      }
    });
  });
}

/**
 * Handles state transitions and updates SQLite database outage history
 */
function updateState(newState, detailsObj = null) {
  invalidateCache();
  const oldState = currentStatus.state;
  currentStatus.lastChecked = new Date().toISOString();

  const isOldStateFailing = oldState !== "Up" && oldState !== "Pending";
  const isNewStateFailing = newState !== "Up" && newState !== "Pending";

  if (resumedOnStartup) {
    const elapsed = Date.now() - new Date(serverStartTime).getTime();
    if (elapsed >= 60000) {
      resumedOnStartup = false;
    }
  }

  if (oldState === newState) {
    // If state is the same, but we are in a failing state and have new details, append to the timeline
    if (isNewStateFailing && detailsObj && activeIncidentId !== null) {
      const now = Date.now();
      if (now - lastIncidentUpdateTime >= 60000) {
        lastIncidentUpdateTime = now;
        if (resumedOnStartup) {
          logEvent(`Skipping timeline event append for resumed incident #${activeIncidentId} during startup grace period`, "info");
        } else {
          appendIncidentEvent(activeIncidentId, newState, detailsObj);
        }
      }
    }
    return;
  }

  logEvent(`State transition: ${oldState} -> ${newState}`, "info");
  currentStatus.state = newState;

  if (isNewStateFailing) {
    lastIncidentUpdateTime = Date.now();
  } else {
    lastIncidentUpdateTime = 0;
  }

  // We do not record incidents for transition to/from "Pending" on boot.
  if (oldState === "Pending" && newState === "Up") {
    return;
  }

  // If returning to "Up", close any active incident
  if (newState === "Up") {
    resumedOnStartup = false;
    if (activeIncidentId !== null) {
      const activeId = activeIncidentId;
      activeIncidentId = null;
      const endTime = new Date().toISOString();

      // Retrieve incident to update final silent failure duration if applicable
      db.get("SELECT start_time, outage_type, details FROM incidents WHERE id = ?", [activeId], (err, row) => {
        if (!err && row) {
          let timelineDetails = { summary: "", errors: [] };
          try {
            timelineDetails = JSON.parse(row.details) || timelineDetails;
          } catch (e) { }

          const isSilent = row.outage_type === "Silent Failure" ||
            (row.outage_type === "Service Outage" && timelineDetails.errors.some(e => e.type === "Silent Failure"));

          if (isSilent) {
            const startMs = new Date(row.start_time).getTime();
            const endMs = new Date(endTime).getTime();
            const durationSec = (endMs - startMs) / 1000;
            const durationText = formatDuration(durationSec);
            const finalMsg = `No message received for ${durationText}.`;

            timelineDetails.summary = finalMsg;
            if (timelineDetails.errors && timelineDetails.errors.length > 0) {
              const lastErr = timelineDetails.errors[timelineDetails.errors.length - 1];
              if (lastErr.type === "Silent Failure") {
                lastErr.message = finalMsg;
              }
            }

            db.run(
              "UPDATE incidents SET end_time = ?, details = ? WHERE id = ?",
              [endTime, JSON.stringify(timelineDetails), activeId],
              (updateErr) => {
                if (updateErr) {
                  logEvent(`Failed to close active incident with details: ${updateErr.message}`, "error");
                } else {
                  logEvent(`Incident #${activeId} marked resolved at ${endTime} with final duration: ${durationText}`, "success");
                }
              }
            );
            return;
          }
        }

        // Fallback for non-silent failure outages
        db.run("UPDATE incidents SET end_time = ? WHERE id = ?", [endTime, activeId], (err) => {
          if (err) {
            logEvent(`Failed to close active incident: ${err.message}`, "error");
          } else {
            logEvent(`Incident #${activeId} marked resolved at ${endTime}`, "success");
          }
        });
      });
    }
    return;
  }

  // If transitioning to Pending, just return without closing or creating incidents
  if (newState === "Pending") {
    return;
  }

  // Transitioning to a non-up state (Down, Silent Failure, Auth Error)

  // If we already have an active incident, continue using it (and update its state/timeline)
  if (isNewStateFailing && activeIncidentId !== null) {
    if (isOldStateFailing) {
      logEvent(`Transitioning within outage: changing type of #${activeIncidentId} to Service Outage`, "info");
      db.run("UPDATE incidents SET outage_type = 'Service Outage' WHERE id = ?", [activeIncidentId], (err) => {
        if (err) logEvent(`Failed to update incident type to Service Outage: ${err.message}`, "error");
      });
    } else {
      logEvent(`Continuing active incident #${activeIncidentId} after state transition from ${oldState} to ${newState}`, "info");
    }
    if (resumedOnStartup) {
      logEvent(`Skipping timeline event append for resumed incident #${activeIncidentId} during startup grace period`, "info");
    } else {
      appendIncidentEvent(activeIncidentId, newState, detailsObj);
    }
    return;
  }

  // Entering a failure state from Up/Pending. Check if we should coalesce (Flap protection)
  db.get("SELECT id, start_time, end_time, details FROM incidents ORDER BY id DESC LIMIT 1", (err, lastInc) => {
    if (!err && lastInc && lastInc.end_time) {
      const resolutionTime = new Date(lastInc.end_time).getTime();
      const secondsSinceResolution = (Date.now() - resolutionTime) / 1000;

      if (secondsSinceResolution < 120) {
        // Re-open!
        activeIncidentId = lastInc.id;
        logEvent(`Coalescing flapping outage. Re-opening incident #${activeIncidentId} (${Math.round(secondsSinceResolution)}s since resolution)`, "warning");
        db.run("UPDATE incidents SET end_time = NULL WHERE id = ?", [activeIncidentId], (updateErr) => {
          if (updateErr) {
            logEvent(`Failed to re-open incident: ${updateErr.message}`, "error");
          } else {
            appendIncidentEvent(activeIncidentId, newState, detailsObj);
          }
        });
        return;
      }
    }

    // Otherwise, start a new incident window
    let startTime = new Date().toISOString();
    if (newState === "Silent Failure" && lastMessageTime > 0) {
      startTime = new Date(lastMessageTime).toISOString();
    }
    const friendlyMessage = interpretError(detailsObj);
    const timelineDetails = {
      summary: friendlyMessage,
      errors: []
    };
    timelineDetails.errors.push({
      timestamp: startTime,
      type: newState,
      message: friendlyMessage,
      raw: detailsObj?.raw || detailsObj || null
    });

    const details = JSON.stringify(timelineDetails);
    db.run(
      "INSERT INTO incidents (start_time, end_time, outage_type, details) VALUES (?, NULL, ?, ?)",
      [startTime, newState, details],
      function (err) {
        if (err) {
          logEvent(`Failed to insert incident: ${err.message}`, "error");
        } else {
          activeIncidentId = this.lastID;
          logEvent(`Incident #${activeIncidentId} (${newState}) recorded starting at ${startTime}`, "warning");
        }
      }
    );
  });
}





// WebSocket tracking references
let wsClient = null;
let reconnectTimer = null;
let silenceCheckInterval = null;
let lastMessageTime = 0;
let lastSavedTime = 0;
const lastSeenPath = path.join(dataDir, 'last_seen.txt');

// Load persistent lastMessageTime on startup
if (fs.existsSync(lastSeenPath)) {
  try {
    const val = fs.readFileSync(lastSeenPath, 'utf8').trim();
    const parsedTime = parseInt(val, 10);
    if (!isNaN(parsedTime) && parsedTime > 0) {
      lastMessageTime = parsedTime;
      lastSavedTime = parsedTime;
      currentStatus.lastMessageReceived = new Date(parsedTime).toISOString();
      logEvent(`Loaded persistent last message time from disk: ${currentStatus.lastMessageReceived}`, "info");
    }
  } catch (e) {
    logEvent(`Failed to read persistent last message time: ${e.message}`, "error");
  }
}

let connectionOpenTime = 0;
let hasReceivedDataSinceConnect = false;
let messageCounter = 0;
let reconnectAttempts = 0;

// Periodic 30-second message throughput logger
setInterval(() => {
  if (wsClient && wsClient.readyState === WebSocket.OPEN && hasReceivedDataSinceConnect && !simulatedModeActive) {
    const rate = (messageCounter / 30).toFixed(1);
    logEvent(`Stream telemetry: Received ${messageCounter} vessel messages in the last 30s (${rate} msg/s).`, "info");
    messageCounter = 0;
  }
}, 30000);

/**
 * Connects to the AISStream WebSocket and starts monitoring state
 */
function connectAISStream() {
  if (!API_KEY || API_KEY === 'YOUR_API_KEY_HERE') {
    logEvent("No valid API key configured in .env file.", "error");
    updateState("Auth Error", { message: "No valid API key configured in .env file." });
    return;
  }

  if (wsClient) {
    try {
      wsClient.terminate();
    } catch (e) { }
  }

  logEvent("Attempting to connect to stream.aisstream.io...", "info");

  try {
    wsClient = new WebSocket("wss://stream.aisstream.io/v0/stream");
  } catch (err) {
    logEvent(`Failed to instantiate WebSocket: ${err.message}`, "error");
    updateState("Down", { message: `Failed to instantiate WebSocket: ${err.message}` });
    scheduleReconnect();
    return;
  }

  // Set timeout if connection takes too long to open
  const connectionTimeout = setTimeout(() => {
    if (wsClient && wsClient.readyState === WebSocket.CONNECTING) {
      logEvent("Connection attempt timed out.", "warning");
      wsClient.terminate();
    }
  }, 10000);

  wsClient.on('open', () => {
    clearTimeout(connectionTimeout);
    connectionOpenTime = Date.now();
    hasReceivedDataSinceConnect = false;
    messageCounter = 0;
    reconnectAttempts = 0;
    logEvent("WebSocket connection established. Constructing subscription...", "success");

    // Subscription payload with fallback default (Singapore Strait)
    let boundingBoxes = [[[1.15, 103.6], [1.45, 104.1]]];
    if (process.env.AISSTREAM_BOUNDING_BOXES) {
      try {
        boundingBoxes = JSON.parse(process.env.AISSTREAM_BOUNDING_BOXES);
      } catch (err) {
        logEvent(`Failed to parse AISSTREAM_BOUNDING_BOXES: ${err.message}. Using default.`, "warning");
      }
    }

    logEvent(`Subscription settings: BoundingBoxes=${JSON.stringify(boundingBoxes)} Filters=["PositionReport"]`, "info");

    const subscription = {
      APIKey: API_KEY,
      BoundingBoxes: boundingBoxes,
      FilterMessageTypes: ["PositionReport"]
    };

    wsClient.send(JSON.stringify(subscription));
    logEvent("Subscription payload sent.", "info");
  });

  wsClient.on('message', (data) => {
    if (simulatedModeActive) return;
    messageCounter++;
    lastMessageTime = Date.now();
    currentStatus.lastMessageReceived = new Date().toISOString();

    const now = Date.now();
    if (now - lastSavedTime >= 10000) {
      lastSavedTime = now;
      fs.writeFile(lastSeenPath, String(lastMessageTime), (err) => {
        if (err) logEvent(`Failed to persist last seen time: ${err.message}`, "error");
      });
    }

    // Parse message metadata if needed
    let parsed = null;
    try {
      parsed = JSON.parse(data.toString());
    } catch (e) { }

    if (!hasReceivedDataSinceConnect) {
      hasReceivedDataSinceConnect = true;
      logEvent("Receiving active live data stream!", "success");
    }

    updateState("Up");

    // Periodically log some ship info to show data is streaming in, but don't spam
    if (parsed && parsed.MetaData && Math.random() < 0.05) {
      const shipName = parsed.MetaData.ShipName ? parsed.MetaData.ShipName.trim() : "Unknown Ship";
      const mmsi = parsed.MetaData.MMSI;
      logEvent(`Data message received: Vessel "${shipName}" (MMSI: ${mmsi})`, "info");
    }
  });

  let lastSocketError = null;

  wsClient.on('close', (code, reason) => {
    clearTimeout(connectionTimeout);
    const reasonStr = reason.toString() || 'None';
    logEvent(`WebSocket connection closed. Code: ${code}, Reason: ${reasonStr}`, "warning");

    if (simulatedModeActive) {
      lastSocketError = null;
      scheduleReconnect();
      return;
    }

    const duration = Date.now() - connectionOpenTime;

    const errorDetails = {
      message: "",
      raw: {
        code,
        reason: reasonStr,
        socketError: lastSocketError ? { message: lastSocketError.message, code: lastSocketError.code } : null
      }
    };

    // Determine state on close
    if (code === 1008 || reasonStr.toLowerCase().includes("key") || (!hasReceivedDataSinceConnect && duration < 5000 && duration > 0)) {
      logEvent("Authentication failed or rejected by server.", "error");
      errorDetails.message = `Authentication failed or rejected by server. Code: ${code}, Reason: ${reasonStr}`;
      updateState("Auth Error", errorDetails);
    } else {
      logEvent("Connection dropped or unreachable.", "warning");
      if (lastSocketError) {
        errorDetails.message = `Connection dropped or unreachable: ${lastSocketError.message} (${lastSocketError.code || 'UNKNOWN'})`;
      } else {
        errorDetails.message = `Connection dropped or unreachable. Code: ${code}, Reason: ${reasonStr}`;
      }
      updateState("Down", errorDetails);
    }

    lastSocketError = null;
    scheduleReconnect();
  });

  wsClient.on('error', (err) => {
    logEvent(`WebSocket Error: ${err.message}`, "error");
    lastSocketError = err;
    // Under error, we let the close event handle the state update and reconnect
  });
}

/**
 * Schedule reconnection back to the WebSocket
 */
function scheduleReconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectAttempts++;
  logEvent(`Scheduling reconnect attempt #${reconnectAttempts} in 10 seconds...`, "info");
  reconnectTimer = setTimeout(connectAISStream, 10000);
}

/**
 * Timer to detect "Silent Failure" state.
 * Runs every 2 seconds. If connected but no message arrived in SILENCE_TIMEOUT seconds, trigger Silent Failure.
 */
function startSilenceCheck() {
  if (silenceCheckInterval) clearInterval(silenceCheckInterval);

  silenceCheckInterval = setInterval(() => {
    if (simulatedModeActive) return;
    if (wsClient && wsClient.readyState === WebSocket.OPEN) {
      const checkStartTime = (lastMessageTime > 0) ? lastMessageTime : connectionOpenTime;
      if (checkStartTime === 0) return; // Connection established but open time not recorded yet

      const secondsSinceLastMessage = (Date.now() - checkStartTime) / 1000;

      if (secondsSinceLastMessage > SILENCE_TO_DOWN_TIMEOUT) {
        const friendlyDuration = formatDuration(secondsSinceLastMessage);
        const detailedMsg = `Connection established but no ship data received for ${friendlyDuration}.`;
        const oldState = currentStatus.state;
        const now = Date.now();

        if (oldState !== "Down" || now - lastIncidentUpdateTime >= 60000) {
          logEvent(`Escalating to Down: ${detailedMsg}`, "error");
          updateState("Down", {
            message: detailedMsg,
            raw: {
              secondsSinceLastMessage,
              checkStartTime: new Date(checkStartTime).toISOString(),
              currentTime: new Date().toISOString()
            }
          });
        }
      } else if (secondsSinceLastMessage > SILENCE_TIMEOUT) {
        const friendlyDuration = formatDuration(secondsSinceLastMessage);
        const detailedMsg = `Connection established but no ship data received for ${friendlyDuration}.`;
        const oldState = currentStatus.state;
        const now = Date.now();

        if (oldState !== "Silent Failure" || now - lastIncidentUpdateTime >= 60000) {
          logEvent(`Silent Failure detected: ${detailedMsg}`, "warning");
          updateState("Silent Failure", {
            message: detailedMsg,
            raw: {
              secondsSinceLastMessage,
              checkStartTime: new Date(checkStartTime).toISOString(),
              currentTime: new Date().toISOString()
            }
          });
        }
      }
    }
  }, 2000);
}

// Start polling checks
connectAISStream();
startSilenceCheck();

// 4. HTTP API and Static Server
const mimeTypes = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon'
};

const server = http.createServer((req, res) => {
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  if (bannedIPs.has(clientIp)) {
    req.socket.destroy();
    return;
  }

  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PATCH');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // Rate Limiting Check (Only on /api/v1/ routes)
  if (req.url.startsWith('/api/v1/')) {
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
    if (isRateLimited(clientIp)) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'Too Many Requests: Rate limit exceeded. Please wait a minute.',
        limit: RATE_LIMIT_RPM
      }));
      return;
    }
  }

  // API - Health Check Endpoint (Lightweight, bypassed cache & DB)
  if (req.url === '/api/v1/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  // API - Status Endpoint
  if (req.url.startsWith('/api/v1/status') && req.method === 'GET') {
    const isSimple = req.url.includes('simple=true');
    if (isSimple) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        state: currentStatus.state,
        lastChecked: currentStatus.lastChecked,
        lastMessageReceived: currentStatus.lastMessageReceived
      }));
      return;
    }

    const cached = getCachedResponse('status');
    if (cached) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(cached);
      return;
    }

    const cutoffTime = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    db.all(
      "SELECT id, start_time, end_time, outage_type, admin_notes, admin_link, admin_link_text FROM incidents WHERE end_time IS NULL OR end_time >= ?",
      [cutoffTime],
      (err, rows) => {
        if (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
          return;
        }

        const slots = [];
        const now = Date.now();
        const slotDuration = 30 * 60 * 1000; // 30 minutes
        const serverStartMs = new Date(serverStartTime).getTime();

        for (let i = 0; i < 48; i++) {
          const slotStart = now - (48 - i) * slotDuration;
          const slotEnd = slotStart + slotDuration;

          let worstOverlap = null;
          const priority = { "Down": 3, "Auth Error": 2, "Silent Failure": 1, "Service Outage": 2.5 };

          rows.forEach(row => {
            const incStart = new Date(row.start_time).getTime();
            const incEnd = row.end_time ? new Date(row.end_time).getTime() : now;

            // Overlap check
            if (incStart < slotEnd && incEnd > slotStart) {
              const rowType = row.outage_type;
              if (!worstOverlap || (priority[rowType] || 0) > (priority[worstOverlap] || 0)) {
                worstOverlap = rowType;
              }
            }
          });

          let slotState = "Up";
          if (worstOverlap) {
            slotState = worstOverlap;
          } else if (slotEnd < serverStartMs) {
            slotState = "Pending";
          }

          slots.push({
            timestamp: new Date(slotEnd).toISOString(),
            state: slotState
          });
        }

        let activeIncident = null;
        const activeRow = rows.find(r => r.end_time === null);
        if (activeRow) {
          activeIncident = {
            id: activeRow.id,
            start_time: activeRow.start_time,
            admin_notes: activeRow.admin_notes,
            admin_link: activeRow.admin_link,
            admin_link_text: activeRow.admin_link_text
          };
        }

        const payload = JSON.stringify({
          state: currentStatus.state,
          lastChecked: currentStatus.lastChecked,
          lastMessageReceived: currentStatus.lastMessageReceived,
          history: slots,
          devMode: isDevMode,
          simulated: simulatedModeActive,
          silenceTimeout: SILENCE_TIMEOUT,
          activeIncident: activeIncident
        });

        setCachedResponse('status', payload);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(payload);
      }
    );
    return;
  }

  // API - Get Votes Endpoint
  if (req.url.startsWith('/api/v1/votes') && req.method === 'GET') {
    const urlObj = new URL(req.url, 'http://localhost');
    const state = urlObj.searchParams.get('state') || currentStatus.state;
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';

    db.all(
      "SELECT vote_type, COUNT(*) as count FROM status_votes WHERE status_state = ? GROUP BY vote_type",
      [state],
      (err, rows) => {
        if (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
          return;
        }
        let upCount = 0;
        let downCount = 0;
        rows.forEach(r => {
          if (r.vote_type === 'up') upCount = r.count;
          if (r.vote_type === 'down') downCount = r.count;
        });

        db.get(
          "SELECT vote_type FROM status_votes WHERE client_ip = ? AND status_state = ?",
          [clientIp, state],
          (err2, row) => {
            const userVote = row ? row.vote_type : null;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ up: upCount, down: downCount, userVote }));
          }
        );
      }
    );
    return;
  }

  // API - Cast Vote Endpoint
  if (req.url === '/api/v1/vote' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const { state, vote } = payload;
        if (!state) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing state' }));
          return;
        }
        const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';

        const performVote = (callback) => {
          if (vote === 'up' || vote === 'down') {
            const timestamp = new Date().toISOString();
            db.run(
              "INSERT OR REPLACE INTO status_votes (client_ip, status_state, vote_type, timestamp) VALUES (?, ?, ?, ?)",
              [clientIp, state, vote, timestamp],
              callback
            );
          } else {
            db.run(
              "DELETE FROM status_votes WHERE client_ip = ? AND status_state = ?",
              [clientIp, state],
              callback
            );
          }
        };

        performVote((err) => {
          if (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
            return;
          }

          // Get updated counts for the client
          db.all(
            "SELECT vote_type, COUNT(*) as count FROM status_votes WHERE status_state = ? GROUP BY vote_type",
            [state],
            (errCount, rows) => {
              if (errCount) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: errCount.message }));
                return;
              }
              let upCount = 0;
              let downCount = 0;
              rows.forEach(r => {
                if (r.vote_type === 'up') upCount = r.count;
                if (r.vote_type === 'down') downCount = r.count;
              });
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ up: upCount, down: downCount, userVote: vote || null }));
            }
          );
        });
      } catch (jsonErr) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      }
    });
    return;
  }

  // API - Simulate Outage (Dev Mode only)
  if (req.url === '/api/v1/test/simulate' && req.method === 'POST') {
    if (!isDevMode) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Forbidden: Simulation endpoint only available in DEV environment.' }));
      return;
    }

    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const { state, message, raw } = payload;

        if (!state) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing required state field.' }));
          return;
        }

        logEvent(`Simulating outage status update to: ${state}`, 'info');
        simulatedModeActive = true;

        // Formulate detailsObj matching timeline expected details
        let detailsObj = null;
        if (message || raw) {
          detailsObj = {
            message: message || `Simulated ${state}`,
            raw: raw || null
          };
        }

        updateState(state, detailsObj);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, state, simulated: simulatedModeActive }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Invalid JSON body: ${err.message}` }));
      }
    });
    return;
  }

  // API - Resume Live Monitoring (Dev Mode only)
  if (req.url === '/api/v1/test/resume' && req.method === 'POST') {
    if (!isDevMode) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Forbidden: Simulation endpoint only available in DEV environment.' }));
      return;
    }

    logEvent('Resuming live monitor from simulation mode...', 'info');
    simulatedModeActive = false;

    // Clear ws state, transition back to Pending, and reconnect
    updateState('Pending');
    connectAISStream();

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, simulated: simulatedModeActive }));
    return;
  }

  // API - Logs Endpoint
  if (req.url === '/api/v1/logs' && req.method === 'GET') {
    if (!isDevMode) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Forbidden: Logs endpoint is only available in DEV environment.' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(systemLogs));
    return;
  }

  // API - Incidents Endpoint
  if (req.url === '/api/v1/incidents' && req.method === 'GET') {
    const cached = getCachedResponse('incidents');
    if (cached) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(cached);
      return;
    }

    db.all("SELECT * FROM incidents ORDER BY start_time DESC", (err, rows) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
        return;
      }
      const payload = JSON.stringify(rows);
      setCachedResponse('incidents', payload);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(payload);
    });
    return;
  }

  // API - Verify Admin Key Endpoint
  if (req.url === '/api/v1/admin/verify' && req.method === 'POST') {
    const authHeader = req.headers['authorization'];
    const adminKey = process.env.ADMIN_API_KEY;

    if (!adminKey) {
      res.writeHead(501, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Server configuration error: ADMIN_API_KEY is not set.' }));
      return;
    }

    let authenticated = false;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const sentToken = authHeader.substring(7);
      authenticated = safeCompare(sentToken, adminKey);
    }

    if (!authenticated) {
      const attempts = (adminFailuresByIp.get(clientIp) || 0) + 1;
      adminFailuresByIp.set(clientIp, attempts);
      logEvent(`Failed admin verification attempt from ${clientIp}. Total attempts: ${attempts}`, "warning");
      
      if (attempts >= 3) {
        bannedIPs.add(clientIp);
        logEvent(`IP ${clientIp} has been banned due to consecutive verification failures.`, "error");
      }

      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized: Invalid admin key.' }));
      return;
    }

    adminFailuresByIp.delete(clientIp);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
    return;
  }

  // API - Patch/Edit Incident Endpoint (Protected by ADMIN_API_KEY)
  const incidentPatchMatch = req.url.match(/^\/api\/v1\/incidents\/(\d+)$/);
  if (incidentPatchMatch && req.method === 'PATCH') {
    const authHeader = req.headers['authorization'];
    const adminKey = process.env.ADMIN_API_KEY;

    if (!adminKey) {
      res.writeHead(501, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Server configuration error: ADMIN_API_KEY is not set.' }));
      return;
    }

    let authenticated = false;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const sentToken = authHeader.substring(7);
      authenticated = safeCompare(sentToken, adminKey);
    }

    if (!authenticated) {
      const attempts = (adminFailuresByIp.get(clientIp) || 0) + 1;
      adminFailuresByIp.set(clientIp, attempts);
      logEvent(`Failed admin authentication attempt from ${clientIp}. Total attempts: ${attempts}`, "warning");
      
      if (attempts >= 3) {
        bannedIPs.add(clientIp);
        logEvent(`IP ${clientIp} has been banned due to consecutive admin authentication failures.`, "error");
      }

      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized: Invalid admin key.' }));
      return;
    }

    adminFailuresByIp.delete(clientIp);
    const incidentId = parseInt(incidentPatchMatch[1], 10);

    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });

    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const { start_time, admin_notes, admin_link, admin_link_text, outage_type } = payload;

        if (start_time) {
          const date = new Date(start_time);
          if (isNaN(date.getTime())) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid start_time format. Must be a valid ISO-8601 string.' }));
            return;
          }
        }

        if (outage_type) {
          const validTypes = ["Down", "Silent Failure", "Service Outage", "Auth Error"];
          if (!validTypes.includes(outage_type)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid outage_type value.' }));
            return;
          }
        }

        db.get("SELECT start_time, end_time, outage_type, details FROM incidents WHERE id = ?", [incidentId], (err, row) => {
          if (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `Database error: ${err.message}` }));
            return;
          }

          if (!row) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Incident not found' }));
            return;
          }

          const newStartTime = start_time || row.start_time;
          const newAdminNotes = admin_notes !== undefined ? admin_notes : null;
          const newAdminLink = admin_link !== undefined ? admin_link : null;
          const newAdminLinkText = admin_link_text !== undefined ? admin_link_text : null;
          const newOutageType = outage_type || row.outage_type;

          let newDetails = row.details;
          if (newDetails && (start_time || outage_type)) {
            try {
              let timelineDetails = JSON.parse(row.details);
              if (timelineDetails) {
                const startMs = new Date(newStartTime).getTime();
                const endMs = row.end_time ? new Date(row.end_time).getTime() : Date.now();
                const durationSec = Math.max(0, (endMs - startMs) / 1000);
                const durationText = formatDuration(durationSec);

                if (timelineDetails.summary) {
                  timelineDetails.summary = replaceDurationInMessage(timelineDetails.summary, durationText);
                }

                if (timelineDetails.errors && Array.isArray(timelineDetails.errors)) {
                  timelineDetails.errors.forEach(err => {
                    if (err.message) {
                      err.message = replaceDurationInMessage(err.message, durationText);
                    }
                  });
                }
                newDetails = JSON.stringify(timelineDetails);
              }
            } catch (e) {
              logEvent(`Failed to recalculate details duration: ${e.message}`, "error");
            }
          }

          db.run(
            "UPDATE incidents SET start_time = ?, admin_notes = ?, admin_link = ?, admin_link_text = ?, outage_type = ?, details = ? WHERE id = ?",
            [newStartTime, newAdminNotes, newAdminLink, newAdminLinkText, newOutageType, newDetails, incidentId],
            (updateErr) => {
              if (updateErr) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: `Update failed: ${updateErr.message}` }));
                return;
              }

              invalidateCache();

              // If the edited incident is currently the active one, update the currentStatus state in memory
              if (incidentId === activeIncidentId) {
                currentStatus.state = newOutageType;
              }

              logEvent(`Incident #${incidentId} updated manually. Start Time: ${newStartTime}, Type: ${newOutageType}`, "success");

              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: true, message: 'Incident updated successfully.' }));
            }
          );
        });

      } catch (parseErr) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Malformed JSON payload.' }));
      }
    });
    return;
  }

  // API - Delete Incident Endpoint (Protected by ADMIN_API_KEY)
  const incidentDeleteMatch = req.url.match(/^\/api\/v1\/incidents\/(\d+)$/);
  if (incidentDeleteMatch && req.method === 'DELETE') {
    const authHeader = req.headers['authorization'];
    const adminKey = process.env.ADMIN_API_KEY;

    if (!adminKey) {
      res.writeHead(501, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Server configuration error: ADMIN_API_KEY is not set.' }));
      return;
    }

    let authenticated = false;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const sentToken = authHeader.substring(7);
      authenticated = safeCompare(sentToken, adminKey);
    }

    if (!authenticated) {
      const attempts = (adminFailuresByIp.get(clientIp) || 0) + 1;
      adminFailuresByIp.set(clientIp, attempts);
      logEvent(`Failed admin authentication attempt from ${clientIp}. Total attempts: ${attempts}`, "warning");
      
      if (attempts >= 3) {
        bannedIPs.add(clientIp);
        logEvent(`IP ${clientIp} has been banned due to consecutive admin authentication failures.`, "error");
      }

      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized: Invalid admin key.' }));
      return;
    }

    adminFailuresByIp.delete(clientIp);
    const incidentId = parseInt(incidentDeleteMatch[1], 10);

    db.get("SELECT end_time FROM incidents WHERE id = ?", [incidentId], (err, row) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Database error: ${err.message}` }));
        return;
      }

      if (!row) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Incident not found' }));
        return;
      }

      const wasActive = row.end_time === null;

      db.run("DELETE FROM incidents WHERE id = ?", [incidentId], (deleteErr) => {
        if (deleteErr) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Delete failed: ${deleteErr.message}` }));
          return;
        }

        invalidateCache();

        if (wasActive || incidentId === activeIncidentId) {
          db.get("SELECT id, outage_type, start_time FROM incidents ORDER BY start_time DESC LIMIT 1", (nextErr, nextRow) => {
            if (!nextErr && nextRow) {
              activeIncidentId = nextRow.id;
              currentStatus.state = nextRow.outage_type;
              
              const incidentStartMs = new Date(nextRow.start_time).getTime();
              lastMessageTime = incidentStartMs;

              db.run("UPDATE incidents SET end_time = NULL WHERE id = ?", [activeIncidentId], (updateErr) => {
                logEvent(`Deleted active incident #${incidentId}. Restored previous incident #${activeIncidentId} to ongoing.`, "success");
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, message: 'Incident deleted. Previous incident restored to ongoing.' }));
              });
            } else {
              activeIncidentId = null;
              currentStatus.state = "Up";
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: true, message: 'Incident deleted. System state reset to operational.' }));
            }
          });
        } else {
          logEvent(`Deleted historical incident #${incidentId}.`, "success");
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, message: 'Incident deleted.' }));
        }
      });
    });
    return;
  }

  // Static File Serving
  const parsedUrl = req.url.split('?')[0];
  let filePath = parsedUrl === '/' ? '/index.html' : parsedUrl;
  const safePath = path.normalize(filePath).replace(/^(\.\.[\/\\])+/, '');
  const absolutePath = path.join(__dirname, 'public', safePath);



  fs.stat(absolutePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Not Found');
      return;
    }

    const ext = path.extname(absolutePath).toLowerCase();
    const contentType = mimeTypes[ext] || 'application/octet-stream';

    res.writeHead(200, { 
      'Content-Type': contentType,
      'Cache-Control': 'no-cache'
    });
    const stream = fs.createReadStream(absolutePath);
    stream.pipe(res);
  });
});


server.listen(PORT, () => {
  logEvent(`System server running at http://localhost:${PORT}/`, "success");
});
