// Config mapping for status states
const STATE_CONFIGS = {
  'Up': {
    className: 'state-up',
    statusTitle: "Fully Operational",
    description: "No known issues",
    badgeText: 'Operational',
    iconHtml: `
      <svg class="icon-check-circle" viewBox="0 0 20 20" fill="currentColor" style="width: 22px; height: 22px; color: #10b981;">
        <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l5-5z" clip-rule="evenodd" />
      </svg>
    `
  },
  'Silent Failure': {
    className: 'state-silent',
    statusTitle: 'Partial Outage',
    description: 'The WebSocket connection is open, but no messages have arrived in the last 15 seconds.',
    badgeText: 'Silent Failure',
    iconHtml: `
      <svg class="icon-warning" viewBox="0 0 20 20" fill="currentColor" style="width: 22px; height: 22px; color: #f59e0b;">
        <path fill-rule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clip-rule="evenodd" />
      </svg>
    `
  },
  'Auth Error': {
    className: 'state-auth',
    statusTitle: 'Configuration Alert',
    description: 'Connection rejected or closed by the server. Please verify your API Key is valid.',
    badgeText: 'Auth Error',
    iconHtml: `
      <svg class="icon-warning" viewBox="0 0 20 20" fill="currentColor" style="width: 22px; height: 22px; color: #8b5cf6;">
        <path fill-rule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clip-rule="evenodd" />
      </svg>
    `
  },
  'Down': {
    className: 'state-down',
    statusTitle: 'Major Outage',
    description: 'The monitoring daemon cannot reach the server, or the API server is down.',
    badgeText: 'Major Outage',
    iconHtml: `
      <svg class="icon-error" viewBox="0 0 20 20" fill="currentColor" style="width: 22px; height: 22px; color: #ef4444;">
        <path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clip-rule="evenodd" />
      </svg>
    `
  },
  'Pending': {
    className: 'state-loading',
    statusTitle: 'Connecting...',
    description: 'Establishing WebSocket connection and awaiting initial ship data.',
    badgeText: 'Pending',
    iconHtml: `
      <svg class="animate-spin" viewBox="0 0 24 24" fill="none" style="width: 22px; height: 22px; color: #6b7280;">
        <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" style="opacity: 0.25;"></circle>
        <path fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
      </svg>
    `
  }
};

// Session and Vote Management
let sessionId = localStorage.getItem('ais_uptime_session_id');
if (!sessionId) {
  sessionId = 'sess_' + Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
  localStorage.setItem('ais_uptime_session_id', sessionId);
}
let currentBannerState = null;

async function updateVotes(state) {
  const statusVoting = document.getElementById('status-voting');
  const voteUpBtn = document.getElementById('vote-up-btn');
  const voteDownBtn = document.getElementById('vote-down-btn');
  const voteUpCount = document.getElementById('vote-up-count');
  const voteDownCount = document.getElementById('vote-down-count');

  if (!statusVoting || !voteUpBtn || !voteDownBtn || !voteUpCount || !voteDownCount) return;

  if (state === 'Pending') {
    statusVoting.style.display = 'none';
    return;
  }

  statusVoting.style.display = 'flex';

  try {
    const res = await fetch(`/api/v1/votes?session_id=${sessionId}&state=${encodeURIComponent(state)}`);
    if (res.ok) {
      const data = await res.json();
      // Ensure the state hasn't changed while we were fetching
      if (currentBannerState !== state) return;

      voteUpCount.textContent = data.up;
      voteDownCount.textContent = data.down;

      if (data.userVote === 'up') {
        voteUpBtn.classList.add('active');
        voteDownBtn.classList.remove('active');
      } else if (data.userVote === 'down') {
        voteDownBtn.classList.add('active');
        voteUpBtn.classList.remove('active');
      } else {
        voteUpBtn.classList.remove('active');
        voteDownBtn.classList.remove('active');
      }
    }
  } catch (err) {
    console.error("Failed to fetch votes:", err);
  }
}

async function castVote(voteType) {
  if (!currentBannerState || currentBannerState === 'Pending') return;

  const voteUpBtn = document.getElementById('vote-up-btn');
  const voteDownBtn = document.getElementById('vote-down-btn');
  if (!voteUpBtn || !voteDownBtn) return;

  let targetVote = voteType;
  if (voteType === 'up' && voteUpBtn.classList.contains('active')) {
    targetVote = null;
  } else if (voteType === 'down' && voteDownBtn.classList.contains('active')) {
    targetVote = null;
  }

  try {
    const res = await fetch('/api/v1/vote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: sessionId,
        state: currentBannerState,
        vote: targetVote
      })
    });
    if (res.ok) {
      const data = await res.json();
      // Ensure state hasn't changed since casting vote
      if (data.userVote !== targetVote) return;

      document.getElementById('vote-up-count').textContent = data.up;
      document.getElementById('vote-down-count').textContent = data.down;

      if (data.userVote === 'up') {
        voteUpBtn.classList.add('active');
        voteDownBtn.classList.remove('active');
      } else if (data.userVote === 'down') {
        voteDownBtn.classList.add('active');
        voteUpBtn.classList.remove('active');
      } else {
        voteUpBtn.classList.remove('active');
        voteDownBtn.classList.remove('active');
      }
    }
  } catch (err) {
    console.error("Failed to cast vote:", err);
  }
}

// DOM Elements
const statusBanner = document.getElementById('status-banner');
const statusBannerIcon = document.getElementById('status-banner-icon');
const statusBannerTitle = document.getElementById('status-banner-title');
const statusBannerDesc = document.getElementById('status-banner-desc');
const componentStatus = document.getElementById('component-status');
const lastCheckedEl = document.getElementById('last-checked');
const heartbeatContainer = document.getElementById('heartbeat-container');
const historyContainer = document.getElementById('history-container');

const consoleToggle = document.getElementById('console-toggle');
const consoleBody = document.getElementById('console-body');
const toggleIndicator = document.getElementById('toggle-indicator');
const logTerminal = document.getElementById('log-terminal');

let logsInterval = null;
let isLogsOpen = false;

/**
 * Update the UI based on the returned or calculated state.
 * @param {string} state - The status state
 * @param {string} lastChecked - Timestamp of the check
 */
function updateUI(state, lastChecked, silenceTimeout) {
  const config = STATE_CONFIGS[state] || {
    className: 'state-loading',
    statusTitle: 'Checking Status...',
    description: 'Current system status is undergoing verification.',
    badgeText: 'Checking',
    iconHtml: `
      <svg class="animate-spin" viewBox="0 0 24 24" fill="none" style="width: 22px; height: 22px; color: #6b7280;">
        <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" style="opacity: 0.25;"></circle>
        <path fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
      </svg>
    `
  };

  // Update Status Banner
  statusBanner.className = `status-banner ${config.className}`;
  statusBannerIcon.innerHTML = config.iconHtml;
  statusBannerTitle.textContent = config.statusTitle;

  if (state === 'Silent Failure') {
    const limit = silenceTimeout || 15;
    statusBannerDesc.textContent = `The WebSocket connection is open, but no messages have arrived in the last ${limit} seconds.`;
  } else {
    statusBannerDesc.textContent = config.description;
  }

  // Update Component Status Text
  componentStatus.className = `component-status-text ${state.replace(/\s+/g, '-')}`;
  componentStatus.textContent = config.badgeText;

  if (lastChecked) {
    const timeString = new Date(lastChecked).toLocaleTimeString();
    lastCheckedEl.textContent = timeString;
  } else {
    lastCheckedEl.textContent = 'Unknown';
  }

  currentBannerState = state;
  updateVotes(state);
}

/**
 * Renders the heartbeat history bar.
 * @param {Array} history - Array of { timestamp, state }
 */
function renderHeartbeat(history) {
  if (!heartbeatContainer) return;
  if (!history || history.length === 0) {
    heartbeatContainer.innerHTML = '';
    return;
  }

  heartbeatContainer.innerHTML = '';
  history.forEach(item => {
    const block = document.createElement('div');
    const stateClass = (item.state || 'Pending').replace(/\s+/g, '-');
    block.className = `heartbeat-block ${stateClass}`;

    // Create custom styled tooltip
    const tooltip = document.createElement('div');
    tooltip.className = 'tooltip';

    const stateSpan = document.createElement('span');
    stateSpan.className = `tooltip-state ${stateClass}`;
    stateSpan.textContent = item.state || 'Pending';

    const timeSpan = document.createElement('span');
    timeSpan.className = 'tooltip-time';
    const dateObj = new Date(item.timestamp);
    timeSpan.textContent = isNaN(dateObj.getTime())
      ? 'Pending'
      : `${dateObj.toLocaleDateString()} ${dateObj.toLocaleTimeString()}`;

    tooltip.appendChild(stateSpan);
    tooltip.appendChild(timeSpan);
    block.appendChild(tooltip);

    block.addEventListener('click', (e) => {
      e.stopPropagation();
      document.querySelectorAll('.heartbeat-block').forEach(b => {
        if (b !== block) b.classList.remove('active');
      });
      block.classList.toggle('active');
    });

    block.addEventListener('mouseenter', () => {
      document.querySelectorAll('.heartbeat-block').forEach(b => {
        b.classList.remove('active');
      });
    });

    heartbeatContainer.appendChild(block);
  });
}

/**
 * Renders the incident history dynamically.
 * @param {Array} incidents - Array of incident objects from SQLite database
 */
function renderIncidentHistory(incidents) {
  if (!historyContainer) return;

  // 1. Capture currently open drawers/raw containers before rewriting the innerHTML
  const activeTimelineDrawers = new Set(
    Array.from(document.querySelectorAll('.timeline-drawer:not(.collapsed)')).map(el => el.id)
  );
  const activeRawContainers = new Set(
    Array.from(document.querySelectorAll('.timeline-raw-container:not(.collapsed)')).map(el => el.id)
  );

  historyContainer.innerHTML = '';

  const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const today = new Date();
  const targetMonths = [];

  // Initialize the list for the last 4 calendar months (only from June 2026 onwards)
  for (let i = 0; i < 4; i++) {
    const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
    // Only show June 2026 (month index 5) and later
    if (d.getFullYear() < 2026 || (d.getFullYear() === 2026 && d.getMonth() < 5)) {
      continue;
    }
    targetMonths.push({
      monthIndex: d.getMonth(),
      year: d.getFullYear(),
      monthName: monthNames[d.getMonth()],
      incidents: []
    });
  }

  // Helper to escape HTML characters
  function escapeHtml(text) {
    if (typeof text !== 'string') return JSON.stringify(text);
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  // Populate incidents into target months
  incidents.forEach(inc => {
    const start = new Date(inc.start_time);
    if (isNaN(start.getTime())) return;

    const match = targetMonths.find(m => m.monthIndex === start.getMonth() && m.year === start.getFullYear());
    if (match) {
      const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
      const dayNum = String(start.getDate()).padStart(2, '0');
      const dayName = days[start.getDay()];

      const stateTitleMap = {
        'Down': 'Complete Loss of Service',
        'Silent Failure': 'Silent Failure: Connected but No Data Received',
        'Service Outage': 'Complete Loss of Service',
        'Auth Error': 'Authentication Failure'
      };
      let title = stateTitleMap[inc.outage_type] || inc.outage_type;
      let description = "No further details logged.";
      let errorsTimeline = null;
      if (inc.details) {
        try {
          const parsed = JSON.parse(inc.details);
          if (parsed) {
            if (parsed.errors && Array.isArray(parsed.errors)) {
              errorsTimeline = parsed.errors;
              if (errorsTimeline.length > 0) {
                description = errorsTimeline[errorsTimeline.length - 1].message;
              }
            } else if (parsed.message) {
              description = parsed.message;
            }
          }
        } catch (e) { }
      }

      let timeText = "";
      const isOngoing = !inc.end_time;
      if (isOngoing) {
        timeText = "Ongoing";
      } else {
        const end = new Date(inc.end_time);
        const diffMins = Math.round((end - start) / 60000);
        if (diffMins < 1) {
          timeText = "< 1m";
        } else if (diffMins < 60) {
          timeText = `${diffMins}m outage`;
        } else {
          const hours = Math.floor(diffMins / 60);
          const mins = diffMins % 60;
          timeText = `${hours}h ${mins}m outage`;
        }
      }

      // Truncate the main view description to 140 characters
      const displayDescription = description.length > 140 ? description.substring(0, 137) + "..." : description;
      const startTimeFormatted = start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

      match.incidents.push({
        id: inc.id,
        dayNum,
        dayName,
        startTimeFormatted,
        title,
        description: displayDescription,
        time: timeText,
        isOngoing,
        outageType: inc.outage_type,
        timeline: errorsTimeline
      });
    }
  });

  targetMonths.forEach(item => {
    const monthBlock = document.createElement('div');
    monthBlock.className = 'history-month-block';

    if (item.incidents.length === 0) {
      monthBlock.innerHTML = `
        <div class="month-no-incidents">
          <span class="month-name">${item.monthName}</span>
          <span class="no-incidents-status">
            <svg class="icon-check-circle" viewBox="0 0 20 20" fill="currentColor">
              <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l5-5z" clip-rule="evenodd" />
            </svg>
            No incidents reported
          </span>
        </div>
      `;
    } else {
      let incidentsHtml = `<h3 class="month-header">${item.monthName}</h3>`;
      item.incidents.forEach(inc => {
        const rowClass = `incident-row ${inc.outageType.replace(/\s+/g, '-')} ${inc.isOngoing ? 'ongoing' : ''}`;

        let timelineHtml = "";
        if (inc.timeline && inc.timeline.length > 0) {
          const drawerId = `timeline-drawer-${inc.id}`;
          const isDrawerExpanded = activeTimelineDrawers.has(drawerId);
          const drawerClass = isDrawerExpanded ? "timeline-drawer" : "timeline-drawer collapsed";
          const btnClass = isDrawerExpanded ? "btn-timeline-toggle expanded" : "btn-timeline-toggle";
          const btnText = isDrawerExpanded ? "Hide detailed timeline" : `Show detailed timeline (${inc.timeline.length} events)`;

          // Reverse timeline events so most recent is at the top
          const reversedTimelineEvents = inc.timeline.map((event, index) => ({ event, index })).reverse();

          timelineHtml = `
            <div class="timeline-toggle-wrapper">
              <button class="${btnClass}" onclick="toggleTimeline(${inc.id})">
                <svg viewBox="0 0 20 20" fill="currentColor" class="icon-chevron">
                  <path fill-rule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clip-rule="evenodd" />
                </svg>
                <span>${btnText}</span>
              </button>
            </div>
            <div id="${drawerId}" class="${drawerClass}">
              <div class="timeline-events">
                ${reversedTimelineEvents.map(({ event, index }) => {
            const eventTime = new Date(event.timestamp).toLocaleTimeString();
            const rawJson = JSON.stringify(event.raw || event, null, 2);
            const containerId = `timeline-raw-container-${inc.id}-${index}`;
            const isRawExpanded = activeRawContainers.has(containerId);
            const rawClass = isRawExpanded ? "timeline-raw-container" : "timeline-raw-container collapsed";

            const rawMessage = event.message || 'No description';
            const displayMessage = rawMessage.length > 140 ? rawMessage.substring(0, 137) + '...' : rawMessage;

            return `
                    <div class="timeline-event-item">
                      <div class="timeline-event-dot ${event.type.replace(/\s+/g, '-')}"></div>
                      <div class="timeline-event-body">
                        <div class="timeline-event-header">
                          <span class="timeline-event-time">${eventTime}</span>
                          <span class="timeline-event-type-badge ${event.type.replace(/\s+/g, '-')}">${event.type}</span>
                        </div>
                        <div class="timeline-event-msg">${escapeHtml(displayMessage)}</div>
                        
                        <div class="raw-toggle-wrapper">
                          <button class="btn-raw-toggle" onclick="toggleRaw(${inc.id}, ${index})" title="Inspect Raw Details">
                            <svg viewBox="0 0 20 20" fill="currentColor" class="icon-code">
                              <path fill-rule="evenodd" d="M12.316 3.051a1 1 0 01.633 1.265l-4 12a1 1 0 11-1.898-.632l4-12a1 1 0 011.265-.633zM5.707 6.293a1 1 0 010 1.414L3.414 10l2.293 2.293a1 1 0 11-1.414 1.414l-3-3a1 1 0 010-1.414l3-3a1 1 0 011.414 0zm8.586 0a1 1 0 011.414 0l3 3a1 1 0 010 1.414l-3 3a1 1 0 11-1.414-1.414L16.586 10l-2.293-2.293a1 1 0 010-1.414z" clip-rule="evenodd" />
                            </svg>
                            <span>Inspect Raw</span>
                          </button>
                          <button class="btn-copy-raw" onclick="copyRaw(this, 'timeline-raw-code-${inc.id}-${index}')">
                            <svg viewBox="0 0 20 20" fill="currentColor" class="icon-copy">
                              <path d="M8 3a1 1 0 011-1h2a1 1 0 110 2H9a1 1 0 01-1-1z" />
                              <path d="M6 3a2 2 0 00-2 2v11a2 2 0 002 2h8a2 2 0 002-2V5a2 2 0 00-2-2 3 3 0 01-3 3H9a3 3 0 01-3-3z" />
                            </svg>
                            <span>Copy</span>
                          </button>
                        </div>
                        <div id="${containerId}" class="${rawClass}">
                          <pre class="raw-code-pre"><code id="timeline-raw-code-${inc.id}-${index}">${escapeHtml(rawJson)}</code></pre>
                        </div>
                      </div>
                    </div>
                  `;
          }).join('')}
              </div>
            </div>
          `;
        }

        incidentsHtml += `
          <div class="incident-row-container">
            <div class="${rowClass}">
              <div class="incident-date">
                <div class="date-row">
                  <span class="date-num">${inc.dayNum}</span>
                  <span class="date-day">${inc.dayName}</span>
                </div>
                <div class="date-time-start">${inc.startTimeFormatted}</div>
              </div>
              <div class="incident-content">
                <div class="incident-name">${inc.title}</div>
                <div class="incident-desc">${inc.description}</div>
              </div>
              <div class="incident-time">${inc.time}</div>
            </div>
            ${timelineHtml}
          </div>
        `;
      });
      monthBlock.innerHTML = incidentsHtml;
    }

    historyContainer.appendChild(monthBlock);
  });
}

// Global UI interactive handlers
window.toggleTimeline = function (id) {
  const drawer = document.getElementById(`timeline-drawer-${id}`);
  const btn = drawer.previousElementSibling.querySelector('.btn-timeline-toggle');
  if (drawer.classList.contains('collapsed')) {
    drawer.classList.remove('collapsed');
    btn.classList.add('expanded');
    btn.querySelector('span').textContent = 'Hide detailed timeline';
  } else {
    drawer.classList.add('collapsed');
    btn.classList.remove('expanded');
    const eventCount = drawer.querySelectorAll('.timeline-event-item').length;
    btn.querySelector('span').textContent = `Show detailed timeline (${eventCount} events)`;
  }
};

window.toggleRaw = function (incidentId, index) {
  const container = document.getElementById(`timeline-raw-container-${incidentId}-${index}`);
  if (container.classList.contains('collapsed')) {
    container.classList.remove('collapsed');
  } else {
    container.classList.add('collapsed');
  }
};

window.copyRaw = async function (btn, elementId) {
  const code = document.getElementById(elementId).textContent;
  try {
    await navigator.clipboard.writeText(code);
    const originalText = btn.textContent;
    btn.textContent = 'Copied!';
    btn.classList.add('copied');
    setTimeout(() => {
      btn.textContent = originalText;
      btn.classList.remove('copied');
    }, 2000);
  } catch (err) {
    console.error('Failed to copy text: ', err);
  }
};

/**
 * Fetch incident history from SQLite backend
 */
async function fetchIncidentHistory() {
  try {
    const response = await fetch('/api/v1/incidents');
    if (!response.ok) throw new Error("Failed to fetch incidents");
    const incidents = await response.json();
    renderIncidentHistory(incidents);
  } catch (error) {
    console.error("Failed to load incident history:", error);
  }
}

/**
 * Fetch status from the backend API
 */
async function fetchStatus() {
  try {
    const response = await fetch('/api/v1/status');
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const data = await response.json();
    updateUI(data.state, data.lastChecked, data.silenceTimeout);
    renderHeartbeat(data.history);

    // Dev HUD visibility
    const devHud = document.getElementById('developer-hud');
    const simBadge = document.getElementById('simulation-badge');
    const consoleDrawer = document.getElementById('console-drawer');
    if (data.devMode) {
      if (devHud) devHud.style.display = 'block';
      if (consoleDrawer) consoleDrawer.style.display = 'block';
      if (simBadge) {
        simBadge.style.display = data.simulated ? 'inline-block' : 'none';
      }
      if (statusBanner) {
        if (data.simulated) {
          statusBanner.classList.add('simulation-active');
        } else {
          statusBanner.classList.remove('simulation-active');
        }
      }
    } else {
      if (devHud) devHud.style.display = 'none';
      if (consoleDrawer) {
        consoleDrawer.style.display = 'none';
        // Clear log intervals if active
        if (logsInterval) {
          clearInterval(logsInterval);
          logsInterval = null;
        }
        isLogsOpen = false;
        const consoleBody = document.getElementById('console-body');
        if (consoleBody) consoleBody.classList.add('collapsed');
        const toggleIndicator = document.getElementById('toggle-indicator');
        if (toggleIndicator) toggleIndicator.textContent = 'Show';
      }
      if (statusBanner) statusBanner.classList.remove('simulation-active');
    }
  } catch (error) {
    console.error('Failed to fetch status:', error);
    updateUI('Down', new Date().toISOString());
    const offlineHistory = Array.from({ length: 30 }, (_, i) => ({
      timestamp: new Date(Date.now() - (29 - i) * 60000).toISOString(),
      state: 'Down'
    }));
    renderHeartbeat(offlineHistory);
  }
}

/**
 * Fetch connection logs from backend and render inside terminal
 */
async function fetchLogs() {
  try {
    const response = await fetch('/api/v1/logs');
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

// Setup Developer HUD event listeners
document.addEventListener('DOMContentLoaded', () => {
  const simButtons = document.querySelectorAll('#developer-hud .hud-btn[data-state]');
  const payloadField = document.getElementById('sim-error-payload');
  const resumeBtn = document.getElementById('btn-resume-live');

  // Setup Status Voting event listeners
  const voteUpBtn = document.getElementById('vote-up-btn');
  const voteDownBtn = document.getElementById('vote-down-btn');
  if (voteUpBtn) {
    voteUpBtn.addEventListener('click', () => castVote('up'));
  }
  if (voteDownBtn) {
    voteDownBtn.addEventListener('click', () => castVote('down'));
  }

  simButtons.forEach(btn => {
    btn.addEventListener('click', async () => {
      const state = btn.getAttribute('data-state');
      const rawVal = payloadField.value.trim();
      let payload = { state };

      if (rawVal) {
        try {
          // Attempt to parse text as JSON
          const parsed = JSON.parse(rawVal);
          if (parsed && typeof parsed === 'object') {
            payload.message = parsed.message || `Simulated ${state}`;
            payload.raw = parsed.raw || parsed;
          } else {
            payload.message = rawVal;
          }
        } catch (e) {
          // If not JSON, send it as a raw string message
          payload.message = rawVal;
        }
      }

      try {
        const res = await fetch('/api/v1/test/simulate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });

        if (res.ok) {
          // Immediate update to show user the simulation result
          await fetchStatus();
          await fetchIncidentHistory();
          if (isLogsOpen) await fetchLogs();
        } else {
          const err = await res.json();
          alert(`Simulation failed: ${err.error}`);
        }
      } catch (err) {
        console.error("Simulation request error:", err);
      }
    });
  });

  if (resumeBtn) {
    resumeBtn.addEventListener('click', async () => {
      try {
        const res = await fetch('/api/v1/test/resume', {
          method: 'POST'
        });
        if (res.ok) {
          payloadField.value = ''; // clear payload helper
          await fetchStatus();
          await fetchIncidentHistory();
          if (isLogsOpen) await fetchLogs();
        } else {
          const err = await res.json();
          alert(`Failed to resume live monitor: ${err.error}`);
        }
      } catch (err) {
        console.error("Resume request error:", err);
      }
    });
  }
});

// Clear active heartbeat tooltips when clicking anywhere else
document.addEventListener('click', () => {
  document.querySelectorAll('.heartbeat-block').forEach(b => {
    b.classList.remove('active');
  });
});

// Initial runs
fetchStatus();
setInterval(fetchStatus, 10000);
fetchIncidentHistory();
setInterval(fetchIncidentHistory, 10000);

