// Config mapping for status states
const STATE_CONFIGS = {
  'Operational': {
    className: 'state-operational',
    badgeText: 'Operational',
    description: 'Connected and actively receiving live AIS messages from stream.aisstream.io.'
  },
  'Silent Failure': {
    className: 'state-silent',
    badgeText: 'Silent Failure',
    description: 'The WebSocket connection is open, but no messages have arrived in the last 15 seconds.'
  },
  'Auth Error': {
    className: 'state-auth',
    badgeText: 'Auth Error',
    description: 'Connection rejected or closed by the server. Please verify your API Key is valid.'
  },
  'Offline': {
    className: 'state-offline',
    badgeText: 'Offline',
    description: 'The monitoring daemon cannot reach the server, or the API server is down.'
  }
};

// DOM Elements
const statusCard = document.getElementById('status-card');
const statusBadge = document.getElementById('status-badge');
const statusText = document.getElementById('status-text');
const statusDescription = document.getElementById('status-description');
const lastCheckedEl = document.getElementById('last-checked');

const consoleToggle = document.getElementById('console-toggle');
const consoleBody = document.getElementById('console-body');
const toggleIndicator = document.getElementById('toggle-indicator');
const logTerminal = document.getElementById('log-terminal');

let logsInterval = null;
let isLogsOpen = false;
let lastLogTimestamp = '';

/**
 * Update the UI based on the returned or calculated state.
 * @param {string} state - The status state
 * @param {string} lastChecked - Timestamp of the check
 */
function updateUI(state, lastChecked) {
  const config = STATE_CONFIGS[state] || {
    className: 'state-loading',
    badgeText: state,
    description: 'Current system status is undergoing verification.'
  };

  // Reset existing state classes
  statusCard.className = 'status-card';
  // Add new state class
  statusCard.classList.add(config.className);

  // Update text elements
  statusBadge.textContent = config.badgeText;
  statusText.textContent = state;
  statusDescription.textContent = config.description;
  
  if (lastChecked) {
    const timeString = new Date(lastChecked).toLocaleTimeString();
    lastCheckedEl.textContent = timeString;
  } else {
    lastCheckedEl.textContent = 'Unknown';
  }
}

/**
 * Fetch status from the backend API
 */
async function fetchStatus() {
  try {
    const response = await fetch('/api/status');
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const data = await response.json();
    updateUI(data.state, data.lastChecked);
  } catch (error) {
    console.error('Failed to fetch status:', error);
    // If backend cannot be reached, the system monitor itself is offline
    updateUI('Offline', new Date().toISOString());
  }
}

/**
 * Fetch connection logs from backend and render inside terminal
 */
async function fetchLogs() {
  try {
    const response = await fetch('/api/logs');
    if (!response.ok) throw new Error('Failed to fetch logs');
    const logs = await response.json();
    
    if (logs.length === 0) {
      logTerminal.innerHTML = '<div class="log-entry system"><span class="log-msg">-- No connection events logged yet --</span></div>';
      return;
    }

    logTerminal.innerHTML = '';
    logs.forEach(log => {
      const entry = document.createElement('div');
      entry.className = `log-entry ${log.type || 'info'}`;
      
      const timeSpan = document.createElement('span');
      timeSpan.className = 'log-time';
      timeSpan.textContent = new Date(log.timestamp).toLocaleTimeString();
      
      const msgSpan = document.createElement('span');
      msgSpan.className = 'log-msg';
      msgSpan.textContent = log.message;

      entry.appendChild(timeSpan);
      entry.appendChild(msgSpan);
      logTerminal.appendChild(entry);
    });

    // Auto-scroll to bottom
    logTerminal.scrollTop = logTerminal.scrollHeight;
  } catch (err) {
    console.error('Error loading logs:', err);
    logTerminal.innerHTML = '<div class="log-entry error"><span class="log-msg">Failed to connect to backend logs stream.</span></div>';
  }
}

// Collapsible drawer toggle handling
consoleToggle.addEventListener('click', () => {
  isLogsOpen = !isLogsOpen;
  
  if (isLogsOpen) {
    consoleBody.classList.remove('collapsed');
    toggleIndicator.textContent = 'Hide';
    fetchLogs(); // Immediate fetch
    logsInterval = setInterval(fetchLogs, 2000); // Poll every 2 seconds
  } else {
    consoleBody.classList.add('collapsed');
    toggleIndicator.textContent = 'Show';
    if (logsInterval) {
      clearInterval(logsInterval);
      logsInterval = null;
    }
  }
});

// Initial fetch and set interval for status polling (every 10 seconds)
fetchStatus();
setInterval(fetchStatus, 10000);
