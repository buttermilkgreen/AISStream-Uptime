const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

// Placeholder variable for the current state.
// In the future, this will be dynamically updated by probeAISStream().
// Possible states: "Operational", "Silent Failure", "Auth Error", "Offline"
let currentStatus = {
  state: "Operational",
  lastChecked: new Date().toISOString()
};

/**
 * Placeholder function for probing the wss://stream.aisstream.io/v0/stream WebSocket.
 * For now, this just keeps the hardcoded "Operational" state.
 */
function probeAISStream() {
  console.log(`[${new Date().toISOString()}] Probing AISStream WebSocket (Placeholder)...`);
  // TODO: Implement WebSocket connection and active message reception check.
  // currentStatus.state = "Operational";
  currentStatus.lastChecked = new Date().toISOString();
}

// Run the probe placeholder immediately, and simulate periodic runs every 30 seconds
probeAISStream();
setInterval(probeAISStream, 30000);

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
  console.log(`${req.method} ${req.url}`);

  // API Endpoint
  if (req.url === '/api/status' && req.method === 'GET') {
    res.writeHead(200, { 
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*' // CORS header in case frontend is hosted separately
    });
    res.end(JSON.stringify(currentStatus));
    return;
  }

  // Static File Serving
  // Normalize path to prevent directory traversal
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
  console.log(`Server running at http://localhost:${PORT}/`);
});
