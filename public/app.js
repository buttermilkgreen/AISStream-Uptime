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

// Initial fetch and set interval for every 10 seconds
fetchStatus();
setInterval(fetchStatus, 10000);
