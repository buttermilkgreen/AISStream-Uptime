const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const sqlite3 = require('sqlite3').verbose();
const crypto = require('crypto');

// Banned IP lists for admin lockout (IP maps to ban expiration timestamp)
const bannedIPs = new Map();
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

// Helper to hash IP using SHA-256 for privacy
function hashIp(ip) {
  if (!ip) return '';
  let cleanIp = ip;
  if (cleanIp.startsWith('::ffff:')) {
    cleanIp = cleanIp.substring(7);
  }
  return crypto.createHash('sha256').update(cleanIp).digest('hex');
}

let telemetrySalt = null;
function getTelemetrySalt() {
  if (!telemetrySalt) {
    telemetrySalt = process.env.TELEMETRY_SALT || process.env.ADMIN_API_KEY || 'default-telemetry-salt';
  }
  return telemetrySalt;
}

function hashTelemetryIp(ip) {
  if (!ip) return '';
  let cleanIp = ip;
  if (cleanIp.startsWith('::ffff:')) {
    cleanIp = cleanIp.substring(7);
  }
  return crypto.createHmac('sha256', getTelemetrySalt()).update(cleanIp).digest('hex');
}

// Helper to check if string is raw IP
function isRawIp(str) {
  if (!str) return false;
  if (str.length !== 64) return true;
  return !/^[0-9a-f]{64}$/i.test(str);
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
const AISSTREAM_WS_URL = process.env.AISSTREAM_WS_URL || "wss://stream.aisstream.io/v0/stream";
const isDevMode = process.env.NODE_ENV === 'DEV' || process.env.DEV === 'true';
const SILENCE_TIMEOUT = parseInt(process.env.SILENCE_TIMEOUT_SECONDS, 10) || 15;
const SILENCE_TO_DOWN_TIMEOUT = parseInt(process.env.SILENCE_TO_DOWN_TIMEOUT_SECONDS, 10) || 1800;
const RATE_LIMIT_RPM = parseInt(process.env.API_RATE_LIMIT_RPM, 10) || 60;
const CACHE_TTL_SECONDS = parseInt(process.env.API_CACHE_TTL_SECONDS, 10) || 15;
let simulatedModeActive = false;
let simulatedStaleActive = false;
const serverStartTime = new Date().toISOString();

// Periodic simulation timer to keep times fresh in Dev Simulation mode unless stale is simulated
setInterval(() => {
  if (simulatedModeActive && !simulatedStaleActive) {
    const nowStr = new Date().toISOString();
    currentStatus.lastChecked = nowStr;
    if (currentStatus.state === 'Up') {
      currentStatus.lastMessageReceived = nowStr;
    }
    invalidateCache();
  }
}, 2000);

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
    ALTER TABLE incidents ADD COLUMN override_votes_up INTEGER
  `, (err) => {
    // Ignore error
  });

  db.run(`
    ALTER TABLE incidents ADD COLUMN override_votes_down INTEGER
  `, (err) => {
    // Ignore error
  });

  // Create telemetry table if not exists
  db.run(`
    CREATE TABLE IF NOT EXISTS telemetry (
      uuid TEXT PRIMARY KEY,
      version TEXT NOT NULL,
      enable_map_entities INTEGER DEFAULT 0,
      include_class_b INTEGER DEFAULT 1,
      clear_map_on_startup INTEGER DEFAULT 0,
      map_timeout_minutes INTEGER DEFAULT 30,
      enable_api_monitoring INTEGER DEFAULT 1,
      watchlist_count INTEGER DEFAULT 0,
      last_seen TEXT NOT NULL,
      created_at TEXT,
      ip_signature TEXT
    )
  `, () => {
    db.run(`ALTER TABLE telemetry ADD COLUMN created_at TEXT`, (err) => {
      db.run(`UPDATE telemetry SET created_at = last_seen WHERE created_at IS NULL`);
    });
    db.run(`ALTER TABLE telemetry ADD COLUMN ip_signature TEXT`, (err) => {
      // Ignore error
    });
    db.run(`ALTER TABLE telemetry DROP COLUMN ip_hash`, (err) => {
      // Ignore error if column not found or DROP COLUMN is not supported
    });
  });

  // Create or Migrate status_votes table to support incident-based voting and hashed IPs
  db.all("PRAGMA table_info(status_votes)", (err, columns) => {
    if (!err && columns && columns.length > 0) {
      const hasClientIp = columns.some(c => c.name === 'client_ip');
      const hasClientIpHash = columns.some(c => c.name === 'client_ip_hash');
      const hasIncidentId = columns.some(c => c.name === 'incident_id');

      // Helper to do status_votes migration chain
      const runStatusVotesMigration = () => {
        if (hasClientIp && !hasClientIpHash) {
          logEvent("Migrating status_votes table: renaming client_ip to client_ip_hash...", "info");
          db.run("ALTER TABLE status_votes RENAME COLUMN client_ip TO client_ip_hash", (alterErr) => {
            if (alterErr) {
              logEvent(`Failed to rename client_ip to client_ip_hash: ${alterErr.message}`, "error");
            } else {
              db.all("SELECT client_ip_hash, status_state, vote_type, timestamp FROM status_votes", (err2, rows) => {
                if (!err2 && rows) {
                  let count = 0;
                  db.serialize(() => {
                    rows.forEach(row => {
                      if (isRawIp(row.client_ip_hash)) {
                        db.run(
                          "UPDATE status_votes SET client_ip_hash = ? WHERE client_ip_hash = ? AND status_state = ? AND vote_type = ? AND timestamp = ?",
                          [hashIp(row.client_ip_hash), row.client_ip_hash, row.status_state, row.vote_type, row.timestamp]
                        );
                        count++;
                      }
                    });
                    if (count > 0) logEvent(`Anonymized ${count} existing records in status_votes.`, "success");
                  });
                }
              });
            }
          });
        }
      };

      if (!hasIncidentId) {
        logEvent("Migrating status_votes table to support incident-based voting...", "info");
        db.serialize(() => {
          db.run("ALTER TABLE status_votes RENAME TO status_votes_old", (renameErr) => {
            if (renameErr) {
              logEvent(`Failed to rename status_votes: ${renameErr.message}`, "error");
              return;
            }
            db.run(`
              CREATE TABLE status_votes (
                client_ip_hash TEXT NOT NULL,
                status_state TEXT NOT NULL,
                vote_type TEXT NOT NULL,
                timestamp TEXT NOT NULL,
                incident_id INTEGER
              )
            `, (createErr) => {
              if (createErr) {
                logEvent(`Failed to create new status_votes table: ${createErr.message}`, "error");
                return;
              }
              const selectIpCol = hasClientIp ? "client_ip" : "client_ip_hash";
              db.run(`
                INSERT INTO status_votes (client_ip_hash, status_state, vote_type, timestamp)
                SELECT ${selectIpCol}, status_state, vote_type, timestamp FROM status_votes_old
              `, (insertErr) => {
                db.run("DROP TABLE status_votes_old");
                db.run(`
                  CREATE UNIQUE INDEX IF NOT EXISTS idx_status_votes_incident 
                  ON status_votes(client_ip_hash, incident_id) 
                  WHERE incident_id IS NOT NULL
                `);
                db.run(`
                  CREATE UNIQUE INDEX IF NOT EXISTS idx_status_votes_state 
                  ON status_votes(client_ip_hash, status_state) 
                  WHERE incident_id IS NULL
                `);
                logEvent("Migrated status_votes successfully to support incident-based voting.", "success");
                db.all("SELECT client_ip_hash, status_state, vote_type, timestamp FROM status_votes", (err2, rows) => {
                  if (!err2 && rows) {
                    db.serialize(() => {
                      rows.forEach(row => {
                        if (isRawIp(row.client_ip_hash)) {
                          db.run(
                            "UPDATE status_votes SET client_ip_hash = ? WHERE client_ip_hash = ? AND status_state = ? AND vote_type = ? AND timestamp = ?",
                            [hashIp(row.client_ip_hash), row.client_ip_hash, row.status_state, row.vote_type, row.timestamp]
                          );
                        }
                      });
                    });
                  }
                });
              });
            });
          });
        });
      } else {
        runStatusVotesMigration();
      }
    } else {
      db.run(`
        CREATE TABLE IF NOT EXISTS status_votes (
          client_ip_hash TEXT NOT NULL,
          status_state TEXT NOT NULL,
          vote_type TEXT NOT NULL,
          timestamp TEXT NOT NULL,
          incident_id INTEGER
        )
      `);
      db.run(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_status_votes_incident 
        ON status_votes(client_ip_hash, incident_id) 
        WHERE incident_id IS NOT NULL
      `);
      db.run(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_status_votes_state 
        ON status_votes(client_ip_hash, status_state) 
        WHERE incident_id IS NULL
      `);
    }
  });

  // Migrate api_logs table
  db.all("PRAGMA table_info(api_logs)", (err, columns) => {
    if (err) {
      logEvent(`Failed to get schema info for api_logs: ${err.message}`, "error");
      return;
    }
    const hasIp = columns.some(c => c.name === 'ip');
    const hasIpHash = columns.some(c => c.name === 'ip_hash');
    const hasUserAgent = columns.some(c => c.name === 'user_agent');

    if (hasIp && !hasIpHash) {
      logEvent("Migrating api_logs table: renaming ip to ip_hash...", "info");
      db.run("ALTER TABLE api_logs RENAME COLUMN ip TO ip_hash", (alterErr) => {
        if (alterErr) {
          logEvent(`Failed to rename ip to ip_hash: ${alterErr.message}`, "error");
        } else {
          db.all("SELECT id, ip_hash FROM api_logs", (err2, rows) => {
            if (!err2 && rows) {
              let count = 0;
              db.serialize(() => {
                const stmt = db.prepare("UPDATE api_logs SET ip_hash = ? WHERE id = ?");
                rows.forEach(row => {
                  if (isRawIp(row.ip_hash)) {
                    stmt.run(hashIp(row.ip_hash), row.id);
                    count++;
                  }
                });
                stmt.finalize(() => {
                  if (count > 0) logEvent(`Anonymized ${count} existing records in api_logs.`, "success");
                });
              });
            }
          });
        }
      });
    } else if (!hasIp && !hasIpHash) {
      db.run(`
        CREATE TABLE IF NOT EXISTS api_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp TEXT NOT NULL,
          ip_hash TEXT NOT NULL,
          endpoint TEXT NOT NULL,
          status_code INTEGER NOT NULL,
          response_time_ms INTEGER NOT NULL,
          user_agent TEXT
        )
      `);
    }

    if (!hasUserAgent) {
      logEvent("Migrating api_logs table: adding user_agent column...", "info");
      db.run("ALTER TABLE api_logs ADD COLUMN user_agent TEXT", (alterErr) => {
        if (alterErr) logEvent(`Failed to add user_agent column: ${alterErr.message}`, "error");
      });
    }
  });

  // Seed dummy logs for visualization if empty (DEV environment only)
  db.get("SELECT COUNT(*) AS count FROM api_logs", (err, row) => {
    if (isDevMode && !err && row && row.count === 0) {
      logEvent("Seeding dummy API logs for visualization...", "info");
      const endpoints = ['/api/v1/status', '/api/v1/incidents', '/api/v1/votes'];
      const ips = ['192.168.1.50', '8.8.8.8', '1.1.1.1', '10.0.0.5', '172.16.0.2', '82.10.45.12', '90.4.52.88'];
      const statusCodes = [200, 200, 200, 429, 200, 401, 500];
      
      const stmt = db.prepare("INSERT INTO api_logs (timestamp, ip_hash, endpoint, status_code, response_time_ms) VALUES (?, ?, ?, ?, ?)");
      const now = Date.now();
      
      for (let i = 0; i < 200; i++) {
        const daysAgo = Math.floor(Math.random() * 30);
        const hoursAgo = Math.floor(Math.random() * 24);
        const timestamp = new Date(now - (daysAgo * 24 * 60 * 60 * 1000) - (hoursAgo * 60 * 60 * 1000)).toISOString();
        const ip = hashIp(ips[Math.floor(Math.random() * ips.length)]);
        const endpoint = endpoints[Math.floor(Math.random() * endpoints.length)];
        const statusCode = statusCodes[Math.floor(Math.random() * statusCodes.length)];
        const responseTime = Math.floor(Math.random() * 150) + 10;
        
        stmt.run(timestamp, ip, endpoint, statusCode, responseTime);
      }
      stmt.finalize();
    }
  });

  // Create indexes to optimize admin dashboard performance
  db.run("DROP INDEX IF EXISTS idx_api_logs_timestamp");
  db.run("DROP INDEX IF EXISTS idx_api_logs_ip_hash");
  db.run("CREATE INDEX IF NOT EXISTS idx_api_logs_timestamp_ip ON api_logs(timestamp, ip_hash)");
  db.run("CREATE INDEX IF NOT EXISTS idx_api_logs_user_agent ON api_logs(user_agent)");
  db.run("CREATE INDEX IF NOT EXISTS idx_telemetry_last_seen ON telemetry(last_seen)");
  db.run("CREATE INDEX IF NOT EXISTS idx_telemetry_created_at ON telemetry(created_at)");
  db.run("CREATE INDEX IF NOT EXISTS idx_telemetry_ip_signature ON telemetry(ip_signature)");
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
  // Ignore temporary rate limits (429) from triggering public outages or incidents
  if (detailsObj) {
    const msg = detailsObj.message || "";
    const rawStr = JSON.stringify(detailsObj.raw || detailsObj).toLowerCase();
    if (rawStr.includes("429") || msg.toLowerCase().includes("429") || msg.toLowerCase().includes("rate limit") || rawStr.includes("too many requests")) {
      logEvent("Rate Limit Exceeded (429) detected from upstream websocket. Skipping state transition and incident logging.", "warning");
      return;
    }
  }

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

  logEvent(`Attempting to connect to ${AISSTREAM_WS_URL}...`, "info");

  try {
    wsClient = new WebSocket(AISSTREAM_WS_URL);
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

    let isRateLimit = false;
    if (lastSocketError) {
      const errMsg = lastSocketError.message || "";
      if (errMsg.includes("429") || errMsg.toLowerCase().includes("rate limit") || errMsg.toLowerCase().includes("too many requests")) {
        isRateLimit = true;
      }
    }

    lastSocketError = null;
    if (isRateLimit) {
      logEvent("Rate Limit Exceeded (429) detected from upstream websocket. Backing off reconnection for 90 seconds.", "warning");
      scheduleReconnect(90000);
    } else {
      scheduleReconnect();
    }
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
function scheduleReconnect(customDelayMs = null) {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectAttempts++;
  const delayMs = customDelayMs || 10000;
  const seconds = delayMs / 1000;
  logEvent(`Scheduling reconnect attempt #${reconnectAttempts} in ${seconds} seconds...`, "info");
  reconnectTimer = setTimeout(connectAISStream, delayMs);
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

/**
 * Periodically deletes API request logs and telemetry check-ins older than configured retention days.
 */
function pruneApiLogs() {
  const retentionDays = parseInt(process.env.TELEMETRY_RETENTION_DAYS, 10) || 90;
  const cutoffTime = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();

  db.run("DELETE FROM api_logs WHERE timestamp < ?", [cutoffTime], (err) => {
    if (err) {
      logEvent(`Failed to prune API logs: ${err.message}`, "error");
    } else {
      logEvent(`API logs pruned. Removed records older than ${retentionDays} days.`, "info");
    }
  });

  db.run("DELETE FROM telemetry WHERE last_seen < ?", [cutoffTime], (err) => {
    if (err) {
      logEvent(`Failed to prune telemetry: ${err.message}`, "error");
    } else {
      logEvent(`Telemetry pruned. Removed records older than ${retentionDays} days.`, "info");
    }
  });
}

// Start polling checks
connectAISStream();
startSilenceCheck();
pruneApiLogs();
setInterval(pruneApiLogs, 24 * 60 * 60 * 1000); // Clean once a day

// Helper to send standard simplified status response
function sendSimpleStatusResponse(res) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    state: currentStatus.state,
    lastChecked: currentStatus.lastChecked,
    lastMessageReceived: currentStatus.lastMessageReceived,
    simulated: simulatedModeActive,
    simulatedStale: simulatedStaleActive
  }));
}

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

  // Helper to check if a route is an admin route
  const checkIsAdminRoute = (url, method) => {
    if (!url) return false;
    const pathPart = url.split('?')[0];
    if (pathPart.startsWith('/api/v1/admin/')) return true;
    if (pathPart.match(/^\/api\/v1\/incidents\/\d+$/) && (method === 'PATCH' || method === 'DELETE')) return true;
    return false;
  };

  // Clean up expired bans
  if (bannedIPs.has(clientIp) && Date.now() > bannedIPs.get(clientIp)) {
    bannedIPs.delete(clientIp);
  }

  // Block admin requests if IP is temporarily banned
  if (bannedIPs.has(clientIp) && checkIsAdminRoute(req.url, req.method)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Forbidden: Admin access temporarily locked due to consecutive verification failures. Please try again in 15 minutes.' }));
    return;
  }

  const startTime = Date.now();
  res.on('finish', () => {
    const url = req.url || '';
    if (url.startsWith('/api/v1/')) {
      const referer = req.headers['referer'];
      const origin = req.headers['origin'];
      const host = req.headers['host'];
      const forwardedHost = req.headers['x-forwarded-host'];
      
      let isFromSameHost = false;
      const checkSameHost = (urlStr) => {
        if (!urlStr) return false;
        try {
          const urlObj = new URL(urlStr);
          const urlHost = urlObj.host.toLowerCase();
          const targetHosts = [host, forwardedHost].filter(Boolean).map(h => h.toLowerCase());
          return targetHosts.some(h => urlHost === h || urlHost.split(':')[0] === h.split(':')[0]);
        } catch (e) {
          return false;
        }
      };

      if (checkSameHost(referer) || checkSameHost(origin)) {
        isFromSameHost = true;
      }
      
      const isWebFrontend = req.headers['x-app-source'] === 'web-frontend' || isFromSameHost;
      const isAdmin = url.startsWith('/api/v1/admin/');
      const isHealth = url === '/api/v1/health';
      
      if (!isWebFrontend && !isAdmin && !isHealth) {
        const responseTime = Date.now() - startTime;
        const statusCode = res.statusCode;
        const endpoint = url.split('?')[0];
        
        db.run(
          `INSERT INTO api_logs (timestamp, ip_hash, endpoint, status_code, response_time_ms, user_agent) VALUES (?, ?, ?, ?, ?, ?)`,
          [new Date().toISOString(), hashIp(clientIp), endpoint, statusCode, responseTime, req.headers['user-agent'] || null],
          (err) => {
            if (err) {
              console.error('Error logging API usage:', err.message);
            }
          }
        );
      }
    }
  });

  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PATCH');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // Rate Limiting Check (Only on non-admin /api/v1/ routes)
  if (req.url.startsWith('/api/v1/') && !checkIsAdminRoute(req.url, req.method)) {
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

  // API - Status Endpoint (POST for Telemetry)
  if (req.url.startsWith('/api/v1/status') && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const {
          uuid,
          version,
          enable_map_entities,
          include_class_b,
          clear_map_on_startup,
          map_timeout_minutes,
          enable_api_monitoring,
          watchlist_count
        } = payload;

        if (!uuid || !version) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing uuid or version in telemetry payload' }));
          return;
        }

        const lastSeen = new Date().toISOString();
        const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
        const ipSignature = hashTelemetryIp(clientIp);

        db.run(
          `INSERT INTO telemetry (
            uuid, version, enable_map_entities, include_class_b, 
            clear_map_on_startup, map_timeout_minutes, enable_api_monitoring, 
            watchlist_count, last_seen, created_at, ip_signature
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(uuid) DO UPDATE SET
            version = excluded.version,
            enable_map_entities = excluded.enable_map_entities,
            include_class_b = excluded.include_class_b,
            clear_map_on_startup = excluded.clear_map_on_startup,
            map_timeout_minutes = excluded.map_timeout_minutes,
            enable_api_monitoring = excluded.enable_api_monitoring,
            watchlist_count = excluded.watchlist_count,
            last_seen = excluded.last_seen,
            ip_signature = excluded.ip_signature`,
          [
            uuid,
            version,
            enable_map_entities ? 1 : 0,
            include_class_b ? 1 : 0,
            clear_map_on_startup ? 1 : 0,
            parseInt(map_timeout_minutes, 10) || 30,
            enable_api_monitoring ? 1 : 0,
            parseInt(watchlist_count, 10) || 0,
            lastSeen,
            lastSeen,
            ipSignature
          ],
          (err) => {
            if (err) {
              console.error('Error saving telemetry:', err.message);
            }
            sendSimpleStatusResponse(res);
          }
        );
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON payload' }));
      }
    });
    return;
  }

  // API - Status Endpoint (GET)
  if (req.url.startsWith('/api/v1/status') && req.method === 'GET') {
    const isSimple = req.url.includes('simple=true');
    if (isSimple) {
      sendSimpleStatusResponse(res);
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
          simulatedStale: simulatedStaleActive,
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

    // Determine if we should query by active incident ID or by state
    const useActiveIncident = (state === currentStatus.state && activeIncidentId !== null);
    const cutoffTime = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const countQuery = useActiveIncident
      ? "SELECT vote_type, COUNT(*) as count FROM status_votes WHERE incident_id = ? AND timestamp >= ? GROUP BY vote_type"
      : "SELECT vote_type, COUNT(*) as count FROM status_votes WHERE status_state = ? AND incident_id IS NULL AND timestamp >= ? GROUP BY vote_type";
    
    const countParams = useActiveIncident ? [activeIncidentId, cutoffTime] : [state, cutoffTime];

    db.all(
      countQuery,
      countParams,
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

        const userQuery = useActiveIncident
          ? "SELECT vote_type FROM status_votes WHERE client_ip_hash = ? AND incident_id = ? AND timestamp >= ?"
          : "SELECT vote_type FROM status_votes WHERE client_ip_hash = ? AND status_state = ? AND incident_id IS NULL AND timestamp >= ?";
        
        const userParams = useActiveIncident ? [hashIp(clientIp), activeIncidentId, cutoffTime] : [hashIp(clientIp), state, cutoffTime];

        db.get(
          userQuery,
          userParams,
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

        const useActiveIncident = (state === currentStatus.state && activeIncidentId !== null);
        const incidentIdToUse = useActiveIncident ? activeIncidentId : null;

        const performVote = (callback) => {
          const hashedClientIp = hashIp(clientIp);
          if (vote === 'up' || vote === 'down') {
            const timestamp = new Date().toISOString();
            db.run(
              "INSERT OR REPLACE INTO status_votes (client_ip_hash, status_state, vote_type, timestamp, incident_id) VALUES (?, ?, ?, ?, ?)",
              [hashedClientIp, state, vote, timestamp, incidentIdToUse],
              callback
            );
          } else {
            if (useActiveIncident) {
              db.run(
                "DELETE FROM status_votes WHERE client_ip_hash = ? AND incident_id = ?",
                [hashedClientIp, incidentIdToUse],
                callback
              );
            } else {
              db.run(
                "DELETE FROM status_votes WHERE client_ip_hash = ? AND status_state = ? AND incident_id IS NULL",
                [hashedClientIp, state],
                callback
              );
            }
          }
        };

        performVote((err) => {
          if (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
            return;
          }

          invalidateCache();

          const cutoffTime = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
          const countQuery = useActiveIncident
            ? "SELECT vote_type, COUNT(*) as count FROM status_votes WHERE incident_id = ? AND timestamp >= ? GROUP BY vote_type"
            : "SELECT vote_type, COUNT(*) as count FROM status_votes WHERE status_state = ? AND incident_id IS NULL AND timestamp >= ? GROUP BY vote_type";
          
          const countParams = useActiveIncident ? [incidentIdToUse, cutoffTime] : [state, cutoffTime];

          db.all(
            countQuery,
            countParams,
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
        simulatedStaleActive = false;

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
        res.end(JSON.stringify({ success: true, state, simulated: simulatedModeActive, simulatedStale: simulatedStaleActive }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Invalid JSON body: ${err.message}` }));
      }
    });
    return;
  }

  // API - Toggle Simulation Stale Mode (Dev Mode only)
  if (req.url === '/api/v1/test/stale' && req.method === 'POST') {
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
        simulatedStaleActive = !!payload.stale;
        logEvent(`Simulation stale mode set to: ${simulatedStaleActive}`, 'info');
        invalidateCache();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, simulatedStale: simulatedStaleActive }));
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
    simulatedStaleActive = false;

    // Clear ws state, transition back to Pending, and reconnect
    updateState('Pending');
    connectAISStream();

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, simulated: simulatedModeActive, simulatedStale: simulatedStaleActive }));
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

    db.all(`
      SELECT 
        i.*,
        COALESCE(i.override_votes_up, (SELECT COUNT(*) FROM status_votes WHERE incident_id = i.id AND vote_type = 'up')) AS votes_up,
        COALESCE(i.override_votes_down, (SELECT COUNT(*) FROM status_votes WHERE incident_id = i.id AND vote_type = 'down')) AS votes_down
      FROM incidents i
      ORDER BY i.start_time DESC
    `, (err, rows) => {
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

  // API - Get Admin Telemetry Stats (Protected by ADMIN_API_KEY)
  if (req.url === '/api/v1/admin/telemetry' && req.method === 'GET') {
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
      logEvent(`Failed admin telemetry attempt from ${clientIp}. Total attempts: ${attempts}`, "warning");
      
      if (attempts >= 5) {
        bannedIPs.set(clientIp, Date.now() + 15 * 60 * 1000); // 15-minute ban
        logEvent(`IP ${clientIp} temporarily locked out from admin endpoints due to repeated authentication failures.`, "error");
      }
      
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized: Invalid Admin Key' }));
      return;
    }

    // Reset failure counter on success
    adminFailuresByIp.delete(clientIp);

    const runQuery = (sql, params = []) => {
      return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        });
      });
    };

    const now = new Date();
    const time24h = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const time7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const time30d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();

    Promise.all([
      runQuery("SELECT COUNT(*) AS count FROM telemetry"),
      runQuery("SELECT COUNT(*) AS count FROM telemetry WHERE last_seen >= ?", [time24h]),
      runQuery("SELECT COUNT(*) AS count FROM telemetry WHERE last_seen >= ?", [time7d]),
      runQuery("SELECT COUNT(*) AS count FROM telemetry WHERE last_seen >= ?", [time30d]),
      runQuery("SELECT COUNT(*) AS count FROM telemetry WHERE created_at >= ?", [time7d]),
      runQuery("SELECT COUNT(*) AS count FROM telemetry WHERE created_at >= ?", [time30d]),
      runQuery("SELECT version, COUNT(*) AS count FROM telemetry GROUP BY version ORDER BY count DESC"),
      runQuery("SELECT enable_map_entities, COUNT(*) AS count FROM telemetry GROUP BY enable_map_entities"),
      runQuery("SELECT include_class_b, COUNT(*) AS count FROM telemetry GROUP BY include_class_b"),
      runQuery("SELECT clear_map_on_startup, COUNT(*) AS count FROM telemetry GROUP BY clear_map_on_startup"),
      runQuery("SELECT enable_api_monitoring, COUNT(*) AS count FROM telemetry GROUP BY enable_api_monitoring"),
      runQuery("SELECT user_agent, COUNT(*) AS count FROM api_logs WHERE user_agent IS NOT NULL GROUP BY user_agent ORDER BY count DESC LIMIT 15"),
      runQuery("SELECT t.uuid, t.version, t.enable_map_entities, t.include_class_b, t.clear_map_on_startup, t.map_timeout_minutes, t.enable_api_monitoring, t.watchlist_count, t.last_seen, t.created_at, (dup.cnt > 1) AS is_duplicate FROM telemetry t LEFT JOIN (SELECT ip_signature, COUNT(*) AS cnt FROM telemetry WHERE ip_signature IS NOT NULL AND ip_signature != '' GROUP BY ip_signature) dup ON t.ip_signature = dup.ip_signature ORDER BY t.last_seen DESC")
    ]).then(([
      totalInstalls,
      dau,
      wau,
      mau,
      newThisWeek,
      new30d,
      versions,
      mapEntities,
      classB,
      clearOnStartup,
      apiMonitoring,
      userAgents,
      installsList
    ]) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        totalInstalls: totalInstalls[0] ? totalInstalls[0].count : 0,
        dau: dau[0] ? dau[0].count : 0,
        wau: wau[0] ? wau[0].count : 0,
        mau: mau[0] ? mau[0].count : 0,
        newThisWeek: newThisWeek[0] ? newThisWeek[0].count : 0,
        new30d: new30d[0] ? new30d[0].count : 0,
        versions,
        mapEntities,
        classB,
        clearOnStartup,
        apiMonitoring,
        userAgents,
        installsList: installsList.map(item => ({
          ...item,
          short_uuid: item.uuid ? item.uuid.substring(0, 8) + '...' : 'unknown'
        }))
      }));
    }).catch(err => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    });

    return;
  }

  // API - Get Admin API Usage Stats (Protected by ADMIN_API_KEY)
  if (req.url === '/api/v1/admin/api-usage' && req.method === 'GET') {
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
        bannedIPs.set(clientIp, Date.now() + 15 * 60 * 1000); // 15-minute ban
        logEvent(`IP ${clientIp} temporarily locked out from admin endpoints due to consecutive authentication failures.`, "error");
      }

      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized: Invalid admin key.' }));
      return;
    }

    adminFailuresByIp.delete(clientIp);

    const runQuery = (sql, params = []) => {
      return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        });
      });
    };

    const now = new Date();
    const time24h = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const time7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const time30d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const time60d = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000).toISOString();
    const time90d = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString();

    Promise.all([
      runQuery(`
        SELECT 
          COUNT(DISTINCT CASE WHEN timestamp >= ? THEN ip_hash END) AS count24h,
          COUNT(DISTINCT CASE WHEN timestamp >= ? THEN ip_hash END) AS count7d,
          COUNT(DISTINCT CASE WHEN timestamp >= ? THEN ip_hash END) AS count30d,
          COUNT(DISTINCT CASE WHEN timestamp >= ? THEN ip_hash END) AS count60d,
          COUNT(DISTINCT CASE WHEN timestamp >= ? THEN ip_hash END) AS count90d
        FROM api_logs
        WHERE timestamp >= ?
      `, [time24h, time7d, time30d, time60d, time90d, time90d]),
      runQuery("SELECT strftime('%Y-%m-%d', timestamp) AS date, COUNT(*) AS count FROM api_logs WHERE timestamp >= ? GROUP BY date ORDER BY date ASC", [time30d]),
      runQuery("SELECT endpoint, COUNT(*) AS count FROM api_logs WHERE timestamp >= ? GROUP BY endpoint ORDER BY count DESC", [time30d]),
      runQuery("SELECT ip_hash AS ip, COUNT(*) AS count, MAX(user_agent) AS user_agent FROM api_logs WHERE timestamp >= ? GROUP BY ip_hash ORDER BY count DESC LIMIT 100", [time30d])
    ]).then(([uniqueCounts, dailyVolume, endpoints, topConsumers]) => {
      const counts = uniqueCounts[0] || {};
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        uniqueIPs: {
          last24h: counts.count24h || 0,
          last7d: counts.count7d || 0,
          last30d: counts.count30d || 0,
          last60d: counts.count60d || 0,
          last90d: counts.count90d || 0
        },
        dailyVolume,
        endpoints,
        topConsumers: topConsumers.map(c => ({
          ip: c.ip ? (c.ip.length === 64 ? c.ip.substring(0, 8) + '...' : c.ip) : 'unknown',
          count: c.count,
          user_agent: c.user_agent || ''
        }))
      }));
    }).catch(err => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
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
        bannedIPs.set(clientIp, Date.now() + 15 * 60 * 1000); // 15-minute ban
        logEvent(`IP ${clientIp} temporarily locked out from admin endpoints due to consecutive verification failures.`, "error");
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
        bannedIPs.set(clientIp, Date.now() + 15 * 60 * 1000); // 15-minute ban
        logEvent(`IP ${clientIp} temporarily locked out from admin endpoints due to consecutive authentication failures.`, "error");
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
        const { start_time, admin_notes, admin_link, admin_link_text, outage_type, errors, override_votes_up, override_votes_down } = JSON.parse(body);

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

        if (errors) {
          if (!Array.isArray(errors)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid errors format. Must be an array.' }));
            return;
          }
          for (const errItem of errors) {
            if (errItem.timestamp) {
              const d = new Date(errItem.timestamp);
              if (isNaN(d.getTime())) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: `Invalid timestamp format for event: ${errItem.timestamp}` }));
                return;
              }
            }
          }
        }

        db.get("SELECT start_time, end_time, outage_type, details, override_votes_up, override_votes_down FROM incidents WHERE id = ?", [incidentId], (err, row) => {
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
          const newOverrideVotesUp = override_votes_up !== undefined ? override_votes_up : row.override_votes_up;
          const newOverrideVotesDown = override_votes_down !== undefined ? override_votes_down : row.override_votes_down;

          let newDetails = row.details;
          try {
            let timelineDetails = row.details ? JSON.parse(row.details) : {};
            if (errors && Array.isArray(errors)) {
              timelineDetails.errors = errors.map((errItem, idx) => {
                const originalErr = (timelineDetails.errors && timelineDetails.errors[idx]) || {};
                return {
                  timestamp: errItem.timestamp || originalErr.timestamp || new Date().toISOString(),
                  type: errItem.type || originalErr.type || 'Down',
                  message: errItem.message || originalErr.message || '',
                  raw: originalErr.raw || {}
                };
              });
            }

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

          db.run(
            "UPDATE incidents SET start_time = ?, admin_notes = ?, admin_link = ?, admin_link_text = ?, outage_type = ?, details = ?, override_votes_up = ?, override_votes_down = ? WHERE id = ?",
            [newStartTime, newAdminNotes, newAdminLink, newAdminLinkText, newOutageType, newDetails, newOverrideVotesUp, newOverrideVotesDown, incidentId],
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
        bannedIPs.set(clientIp, Date.now() + 15 * 60 * 1000); // 15-minute ban
        logEvent(`IP ${clientIp} temporarily locked out from admin endpoints due to consecutive authentication failures.`, "error");
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
  let filePath = parsedUrl;
  if (filePath === '/') {
    filePath = '/index.html';
  } else if (filePath === '/admin') {
    filePath = '/admin.html';
  }
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
