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
let simulatedModeActive = false;


// 2. Rolling log buffer (limit to 50 logs)
const systemLogs = [];
function logEvent(message, type = 'info') {
  const timestamp = new Date().toISOString();
  const logObj = { timestamp, message, type };
  systemLogs.push(logObj);
  if (systemLogs.length > 50) {
    systemLogs.shift();
  }
  console.log(`[${type.toUpperCase()}] ${message}`);
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

    // Append new event to timeline
    timelineDetails.errors.push({
      timestamp: new Date().toISOString(),
      type: type,
      message: friendlyMessage,
      raw: detailsObj.raw || detailsObj
    });
    timelineDetails.summary = friendlyMessage;

    db.run("UPDATE incidents SET details = ? WHERE id = ?", [JSON.stringify(timelineDetails), incidentId], (err) => {
      if (err) {
        logEvent(`Failed to append timeline event to incident #${incidentId}: ${err.message}`, "error");
      } else {
        logEvent(`Appended timeline event to incident #${incidentId}`, "info");
      }
    });
  });
}

/**
 * Handles state transitions and updates SQLite database outage history
 */
function updateState(newState, detailsObj = null) {
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
      db.run("UPDATE incidents SET end_time = ? WHERE id = ?", [endTime, activeId], (err) => {
        if (err) {
          logEvent(`Failed to close active incident: ${err.message}`, "error");
        } else {
          logEvent(`Incident #${activeId} marked resolved at ${endTime}`, "success");
        }
      });
    }
    return;
  }

  // Transitioning to a non-up state (Down, Silent Failure, Auth Error)
  
  // If transitioning between different failing states, keep the same incident active
  if (isOldStateFailing && isNewStateFailing && activeIncidentId !== null) {
    logEvent(`Transitioning within outage: changing type of #${activeIncidentId} to Instability`, "info");
    db.run("UPDATE incidents SET outage_type = 'Instability' WHERE id = ?", [activeIncidentId], (err) => {
      if (err) logEvent(`Failed to update incident type to Instability: ${err.message}`, "error");
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
    const startTime = new Date().toISOString();
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


const heartbeatHistory = [];
// Pre-populate history with 30 gray "Pending" blocks with decreasing minute timestamps
const nowMs = Date.now();
for (let i = 29; i >= 0; i--) {
  heartbeatHistory.push({
    timestamp: new Date(nowMs - i * 60000).toISOString(),
    state: "Pending"
  });
}


// WebSocket tracking references
let wsClient = null;
let reconnectTimer = null;
let silenceCheckInterval = null;
let lastMessageTime = 0;
let connectionOpenTime = 0;
let hasReceivedDataSinceConnect = false;

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
    logEvent("WebSocket connection established. Sending subscription payload...", "success");

    // Subscription payload for Singapore Strait
    const subscription = {
      APIKey: API_KEY,
      BoundingBoxes: [
        [[1.15, 103.6], [1.45, 104.1]]
      ],
      FilterMessageTypes: ["PositionReport"]
    };

    wsClient.send(JSON.stringify(subscription));
    logEvent("Subscription payload sent.", "info");
  });

  wsClient.on('message', (data) => {
    if (simulatedModeActive) return;
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
  logEvent("Scheduling reconnect in 10 seconds...", "info");
  reconnectTimer = setTimeout(connectAISStream, 10000);
}

/**
 * Timer to detect "Silent Failure" state.
 * Runs every 2 seconds. If connected but no message arrived in 15 seconds, trigger Silent Failure.
 */
function startSilenceCheck() {
  if (silenceCheckInterval) clearInterval(silenceCheckInterval);
  
  silenceCheckInterval = setInterval(() => {
    if (simulatedModeActive) return;
    if (wsClient && wsClient.readyState === WebSocket.OPEN && hasReceivedDataSinceConnect) {
      const secondsSinceLastMessage = (Date.now() - lastMessageTime) / 1000;
      if (secondsSinceLastMessage > 15) {
        logEvent(`Silent Failure detected! No message received for ${Math.round(secondsSinceLastMessage)}s.`, "warning");
        updateState("Silent Failure", {
          message: `No message received for ${Math.round(secondsSinceLastMessage)} seconds.`,
          raw: {
            secondsSinceLastMessage,
            lastMessageTime: new Date(lastMessageTime).toISOString(),
            currentTime: new Date().toISOString()
          }
        });
      }
    }
  }, 2000);
}

/**
 * Appends the current state into the rolling history array on the minute.
 */
function recordHeartbeat() {
  const timestamp = new Date().toISOString();
  heartbeatHistory.push({
    timestamp,
    state: currentStatus.state
  });
  if (heartbeatHistory.length > 30) {
    heartbeatHistory.shift();
  }
}

/**
 * Schedules the heartbeat checker to run at the start of the next minute, and then every 60s.
 */
function startHeartbeatInterval() {
  const now = new Date();
  const delay = (60 - now.getSeconds()) * 1000 - now.getMilliseconds();
  setTimeout(() => {
    recordHeartbeat();
    setInterval(recordHeartbeat, 60000);
  }, delay);
}

// Start polling checks
connectAISStream();
startSilenceCheck();
startHeartbeatInterval();

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

  // API - Status Endpoint
  if (req.url === '/api/status' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      state: currentStatus.state,
      lastChecked: currentStatus.lastChecked,
      lastMessageReceived: currentStatus.lastMessageReceived,
      history: heartbeatHistory,
      devMode: isDevMode,
      simulated: simulatedModeActive
    }));
    return;
  }

  // API - Simulate Outage (Dev Mode only)
  if (req.url === '/api/test/simulate' && req.method === 'POST') {
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
  if (req.url === '/api/test/resume' && req.method === 'POST') {
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
  if (req.url === '/api/logs' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(systemLogs));
    return;
  }

  // API - Incidents Endpoint
  if (req.url === '/api/incidents' && req.method === 'GET') {
    db.all("SELECT * FROM incidents ORDER BY start_time DESC", (err, rows) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(rows));
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
