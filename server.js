const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

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

// 3. Uptime State variables
let currentStatus = {
  state: "Offline", // Starts as offline until established
  lastChecked: new Date().toISOString(),
  lastMessageReceived: null
};

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
    currentStatus.state = "Auth Error";
    currentStatus.lastChecked = new Date().toISOString();
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
    currentStatus.state = "Offline";
    currentStatus.lastChecked = new Date().toISOString();
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
    lastMessageTime = Date.now();
    currentStatus.lastChecked = new Date().toISOString();
    currentStatus.lastMessageReceived = currentStatus.lastChecked;
    
    // Parse message metadata if needed
    let parsed = null;
    try {
      parsed = JSON.parse(data.toString());
    } catch (e) {}

    if (!hasReceivedDataSinceConnect) {
      hasReceivedDataSinceConnect = true;
      logEvent("Receiving active live data stream!", "success");
    }

    currentStatus.state = "Operational";

    // Periodically log some ship info to show data is streaming in, but don't spam
    if (parsed && parsed.MetaData && Math.random() < 0.05) {
      const shipName = parsed.MetaData.ShipName ? parsed.MetaData.ShipName.trim() : "Unknown Ship";
      const mmsi = parsed.MetaData.MMSI;
      logEvent(`Data message received: Vessel "${shipName}" (MMSI: ${mmsi})`, "info");
    }
  });

  wsClient.on('close', (code, reason) => {
    clearTimeout(connectionTimeout);
    logEvent(`WebSocket connection closed. Code: ${code}, Reason: ${reason.toString() || 'None'}`, "warning");
    
    const duration = Date.now() - connectionOpenTime;
    
    // Determine state on close
    if (code === 1008 || reason.toString().toLowerCase().includes("key") || (!hasReceivedDataSinceConnect && duration < 5000 && duration > 0)) {
      // If server closed it quickly without data, likely Auth error
      logEvent("Authentication failed or rejected by server.", "error");
      currentStatus.state = "Auth Error";
    } else {
      logEvent("Connection dropped or unreachable.", "warning");
      currentStatus.state = "Offline";
    }
    
    currentStatus.lastChecked = new Date().toISOString();
    scheduleReconnect();
  });

  wsClient.on('error', (err) => {
    logEvent(`WebSocket Error: ${err.message}`, "error");
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
    if (wsClient && wsClient.readyState === WebSocket.OPEN && hasReceivedDataSinceConnect) {
      const secondsSinceLastMessage = (Date.now() - lastMessageTime) / 1000;
      if (secondsSinceLastMessage > 15) {
        if (currentStatus.state !== "Silent Failure") {
          logEvent(`Silent Failure detected! No message received for ${Math.round(secondsSinceLastMessage)}s.`, "warning");
          currentStatus.state = "Silent Failure";
          currentStatus.lastChecked = new Date().toISOString();
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
  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // API - Status Endpoint
  if (req.url === '/api/status' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(currentStatus));
    return;
  }

  // API - Logs Endpoint
  if (req.url === '/api/logs' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(systemLogs));
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
