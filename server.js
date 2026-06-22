const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const sqlite3 = require('sqlite3').verbose();

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
        process.env[key] = value;
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

  // Database is initialized empty. No mock seeding logic.
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
  if (remainingMinutes === 0) {
    return `${hours} hour${hours === 1 ? '' : 's'}`;
  }
  return `${hours} hour${hours === 1 ? '' : 's'} and ${remainingMinutes} minute${remainingMinutes === 1 ? '' : 's'}`;
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
  
  if (oldState === newState) {
    // If state is the same, but we are in a failing state and have new details, append to the timeline
    if (isNewStateFailing && detailsObj && activeIncidentId !== null) {
      appendIncidentEvent(activeIncidentId, newState, detailsObj);
    }
    return;
  }

  logEvent(`State transition: ${oldState} -> ${newState}`, "info");
  currentStatus.state = newState;

  // We do not record incidents for transition to/from "Pending" on boot.
  if (oldState === "Pending" && newState === "Up") {
    return;
  }

  // If returning to "Up" (or "Pending"), close any active incident
  if (!isNewStateFailing) {
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
          } catch (e) {}

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

  // Transitioning to a non-up state (Down, Silent Failure, Auth Error)
  
  // If transitioning between different failing states, keep the same incident active
  if (isOldStateFailing && isNewStateFailing && activeIncidentId !== null) {
    logEvent(`Transitioning within outage: changing type of #${activeIncidentId} to Service Outage`, "info");
    db.run("UPDATE incidents SET outage_type = 'Service Outage' WHERE id = ?", [activeIncidentId], (err) => {
      if (err) logEvent(`Failed to update incident type to Service Outage: ${err.message}`, "error");
    });
    appendIncidentEvent(activeIncidentId, newState, detailsObj);
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
    } catch (e) {}
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
    
    // Parse message metadata if needed
    let parsed = null;
    try {
      parsed = JSON.parse(data.toString());
    } catch (e) {}

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
      const checkStartTime = hasReceivedDataSinceConnect ? lastMessageTime : connectionOpenTime;
      if (checkStartTime === 0) return; // Connection established but open time not recorded yet
      
      const secondsSinceLastMessage = (Date.now() - checkStartTime) / 1000;
      
      if (secondsSinceLastMessage > SILENCE_TO_DOWN_TIMEOUT) {
        const friendlyDuration = formatDuration(secondsSinceLastMessage);
        const detailedMsg = `Connection established but no ships received for ${friendlyDuration}.`;
        
        logEvent(`Escalating to Down: ${detailedMsg}`, "error");
        updateState("Down", {
          message: detailedMsg,
          raw: {
            secondsSinceLastMessage,
            checkStartTime: new Date(checkStartTime).toISOString(),
            currentTime: new Date().toISOString()
          }
        });
      } else if (secondsSinceLastMessage > SILENCE_TIMEOUT) {
        const friendlyDuration = formatDuration(secondsSinceLastMessage);
        const detailedMsg = `Connection established but no ships received for ${friendlyDuration}.`;
        
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
  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

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
      "SELECT start_time, end_time, outage_type FROM incidents WHERE end_time IS NULL OR end_time >= ?",
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

        const payload = JSON.stringify({
          state: currentStatus.state,
          lastChecked: currentStatus.lastChecked,
          lastMessageReceived: currentStatus.lastMessageReceived,
          history: slots,
          devMode: isDevMode,
          simulated: simulatedModeActive,
          silenceTimeout: SILENCE_TIMEOUT
        });

        setCachedResponse('status', payload);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(payload);
      }
    );
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

  // Static File Serving
  let filePath = req.url === '/' ? '/index.html' : req.url;
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

    res.writeHead(200, { 'Content-Type': contentType });
    const stream = fs.createReadStream(absolutePath);
    stream.pipe(res);
  });
});


server.listen(PORT, () => {
  logEvent(`System server running at http://localhost:${PORT}/`, "success");
});
