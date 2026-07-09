// Intercept all fetch requests to inject X-App-Source header for relative calls
(function() {
  const originalFetch = window.fetch;
  window.fetch = function(input, init) {
    init = init || {};
    init.headers = init.headers || {};
    
    let isRelativeOrSameOrigin = false;
    if (typeof input === 'string') {
      if (input.startsWith('/') || input.startsWith(window.location.origin)) {
        isRelativeOrSameOrigin = true;
      }
    }
    
    if (isRelativeOrSameOrigin) {
      if (init.headers instanceof Headers) {
        init.headers.set('X-App-Source', 'web-frontend');
      } else {
        init.headers['X-App-Source'] = 'web-frontend';
      }
    }
    
    return originalFetch(input, init).then(response => {
      if (response.status === 429 && isRelativeOrSameOrigin) {
        response.clone().json().then(data => {
          showRateLimitToast(data.error);
        }).catch(() => {
          showRateLimitToast("Too many refreshes. Please wait one minute.");
        });
      }
      return response;
    });
  };
})();

function showRateLimitToast(message) {
  let toast = document.getElementById('rate-limit-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'rate-limit-toast';
    toast.className = 'rate-limit-toast';
    toast.innerHTML = `
      <svg class="rate-limit-toast-icon" viewBox="0 0 20 20" fill="currentColor">
        <path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clip-rule="evenodd" />
      </svg>
      <span id="rate-limit-toast-text"></span>
    `;
    document.body.appendChild(toast);
  }
  const textEl = document.getElementById('rate-limit-toast-text');
  textEl.textContent = message || "Too many refreshes. Please wait one minute.";
  toast.classList.add('show');
  
  if (toast.timeoutId) {
    clearTimeout(toast.timeoutId);
  }
  toast.timeoutId = setTimeout(() => {
    toast.classList.remove('show');
  }, 5000);
}


function escapeHtml(text) {
  if (typeof text !== 'string') return JSON.stringify(text);
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

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

// Config mapping for status states
let isAdminVerified = false;


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
    description: 'The connection to the AISStream server has been lost, or the service is currently unreachable.',
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
  },
  'Service Outage': {
    className: 'state-down',
    statusTitle: 'Major Outage',
    description: 'Complete Loss of Service (Service Outage).',
    badgeText: 'Service Outage',
    iconHtml: `
      <svg class="icon-error" viewBox="0 0 20 20" fill="currentColor" style="width: 22px; height: 22px; color: #ef4444;">
        <path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clip-rule="evenodd" />
      </svg>
    `
  }
};

// Session and Vote Management
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
    const res = await fetch(`/api/v1/votes?state=${encodeURIComponent(state)}`);
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
      
      // Refresh history counts
      fetchIncidentHistory();
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


/**
 * Update the UI based on the returned or calculated state.
 * @param {string} state - The status state
 * @param {string} lastChecked - Timestamp of the check
 */
function updateUI(state, lastChecked, silenceTimeout, activeIncident) {
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

  let desc = config.description || '';
 
  if (activeIncident && activeIncident.start_time && (state === 'Down' || state === 'Silent Failure')) {
    const start = new Date(activeIncident.start_time);
    const startMs = start.getTime();
    const durationSec = Math.max(0, (Date.now() - startMs) / 1000);
    const friendlyDuration = formatDuration(durationSec);
    let timeString = start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const isToday = start.toDateString() === new Date().toDateString();
    if (!isToday) {
      const dateStr = start.toLocaleDateString([], { month: 'short', day: 'numeric' });
      timeString += `, ${dateStr}`;
    }
 
    let activeTemplate = config.activeDescription;
    if (!activeTemplate) {
      if (state === 'Silent Failure') {
        activeTemplate = "Connection established but no ship data received for {duration} (since {since}).";
      } else {
        activeTemplate = "The connection to the AISStream server has been lost, and no ship data has been received for {duration} (since {since}).";
      }
    }
    desc = activeTemplate.replace('{duration}', friendlyDuration).replace('{since}', timeString);
  } else {
    // Process regular description placeholder (e.g. {seconds} limit)
    const limit = silenceTimeout || 15;
    desc = desc.replace('{seconds}', limit);
  }
 
  statusBannerDesc.textContent = desc;

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

  const bannerNotesEl = document.getElementById('status-banner-admin-notes');
  const bannerLinkWrapper = document.getElementById('status-banner-link-wrapper');

  if (bannerNotesEl) {
    if (activeIncident && activeIncident.admin_notes && state !== 'Pending' && state !== 'Up' && STATE_CONFIGS[state]) {
      bannerNotesEl.textContent = activeIncident.admin_notes;
      bannerNotesEl.style.display = 'block';
    } else {
      bannerNotesEl.textContent = '';
      bannerNotesEl.style.display = 'none';
    }
  }

  if (bannerLinkWrapper) {
    if (activeIncident && activeIncident.admin_link && state !== 'Pending' && state !== 'Up' && STATE_CONFIGS[state]) {
      let text = activeIncident.admin_link_text || "View Details";
      let isGithub = activeIncident.admin_link.includes('github.com');
      let iconHtml = '';
      if (isGithub) {
        iconHtml = `
          <svg viewBox="0 0 24 24" fill="currentColor" style="width: 14px; height: 14px; display: inline-block; vertical-align: middle; margin-right: 4px;">
            <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
          </svg>
        `;
      }
      bannerLinkWrapper.innerHTML = `
        <a id="status-banner-link" href="${escapeHtml(activeIncident.admin_link)}" target="_blank" class="btn" style="display: inline-flex; align-items: center; gap: 6px; padding: 0.4rem 0.8rem; font-size: 0.85rem; background: #18181b; color: white; border: none; border-radius: 6px; text-decoration: none; font-weight: 600;">
          ${iconHtml}
          <span>${escapeHtml(text)}</span>
        </a>
      `;
      bannerLinkWrapper.style.display = 'block';
    } else {
      bannerLinkWrapper.innerHTML = '';
      bannerLinkWrapper.style.display = 'none';
    }
  }
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
 * Helper to get a friendly date with ordinal suffix, e.g. "21st June"
 * @param {Date} dateObj 
 * @returns {string}
 */
function getFriendlyOrdinalDate(dateObj) {
  const day = dateObj.getDate();
  const monthNames = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"
  ];
  
  let suffix = 'th';
  if (day === 1 || day === 21 || day === 31) suffix = 'st';
  else if (day === 2 || day === 22) suffix = 'nd';
  else if (day === 3 || day === 23) suffix = 'rd';
  
  return `${day}${suffix} ${monthNames[dateObj.getMonth()]}`;
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
  if (window.isHistoryExpanded) {
    historyContainer.classList.add('expanded');
  } else {
    historyContainer.classList.remove('expanded');
  }

  const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const today = new Date();
  const targetMonths = [];
  let totalIncidentsCount = 0;

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

  // Populate incidents into target months
  incidents.forEach(inc => {
    const start = new Date(inc.start_time);
    if (isNaN(start.getTime())) return;

    const match = targetMonths.find(m => m.monthIndex === start.getMonth() && m.year === start.getFullYear());
    if (match) {
      totalIncidentsCount++;
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

      // Recalculate duration on the client side based on start_time
      const startMs = start.getTime();
      const endMs = inc.end_time ? new Date(inc.end_time).getTime() : Date.now();
      const durationSec = Math.max(0, (endMs - startMs) / 1000);
      const friendlyDuration = formatDuration(durationSec);
      const isLongerThanADay = durationSec > 86400;
      const friendlyStartDate = getFriendlyOrdinalDate(start);

      description = replaceDurationInMessage(description, friendlyDuration);
      if (errorsTimeline && Array.isArray(errorsTimeline)) {
        errorsTimeline.forEach(err => {
          if (err.message) {
            err.message = replaceDurationInMessage(err.message, friendlyDuration);
          }
        });
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
        startTimeRaw: inc.start_time,
        friendlyStartDate,
        isLongerThanADay,
        title,
        description: displayDescription,
        time: timeText,
        isOngoing,
        outageType: inc.outage_type,
        timeline: errorsTimeline,
        adminNotes: inc.admin_notes || "",
        adminLink: inc.admin_link || "",
        adminLinkText: inc.admin_link_text || "",
        votesUp: inc.votes_up || 0,
        votesDown: inc.votes_down || 0
      });
    }
  });

  let globalIdx = 0;

  targetMonths.forEach(item => {
    const monthBlock = document.createElement('div');
    const isMonthBlockExtra = globalIdx >= 2;
    monthBlock.className = `history-month-block${isMonthBlockExtra ? ' history-extra-item' : ''}`;

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
        globalIdx++;
        const isExtra = globalIdx > 2;
        const extraClass = isExtra ? ' history-extra-item' : '';
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
            const eventDate = new Date(event.timestamp);
            const eventTime = eventDate.toLocaleTimeString();
            const eventDateFriendly = getFriendlyOrdinalDate(eventDate);
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
                          <span class="timeline-event-time">
                            ${eventTime}
                            ${inc.isLongerThanADay ? `<span class="timeline-event-date" style="font-size: 0.7rem; color: #6b7280; margin-left: 6px; font-weight: normal; background: rgba(107, 114, 128, 0.08); padding: 1px 4px; border-radius: 3px;">${eventDateFriendly}</span>` : ''}
                          </span>
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
          <div class="incident-row-container${extraClass}">
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
                ${inc.adminNotes ? `<div class="incident-admin-notes" style="margin-top: 6px; padding: 6px 10px; background: rgba(59, 130, 246, 0.05); border-left: 2px solid #3b82f6; font-size: 0.85rem; border-radius: 0 4px 4px 0;">${escapeHtml(inc.adminNotes)}</div>` : ''}
                ${inc.adminLink ? `
                  <div style="margin-top: 8px;">
                    <a href="${escapeHtml(inc.adminLink)}" target="_blank" class="btn" style="display: inline-flex; align-items: center; gap: 6px; padding: 0.3rem 0.6rem; font-size: 0.8rem; background: #18181b; color: white; border: none; border-radius: 4px; text-decoration: none; font-weight: 600;">
                       ${inc.adminLink.includes('github.com') ? `
                        <svg viewBox="0 0 24 24" fill="currentColor" style="width: 14px; height: 14px; display: inline-block; vertical-align: middle;">
                          <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
                        </svg>
                       ` : ''}
                      <span>${escapeHtml(inc.adminLinkText || "View Details")}</span>
                    </a>
                  </div>
                ` : ''}
                
                <!-- History Votes Display -->
                ${(() => {
                  if (inc.votesUp === 0 && inc.votesDown === 0) {
                    return '';
                  }
                  const activeVoteUp = document.getElementById('vote-up-btn')?.classList.contains('active');
                  const activeVoteDown = document.getElementById('vote-down-btn')?.classList.contains('active');
                  const currentUserVote = activeVoteUp ? 'up' : (activeVoteDown ? 'down' : null);

                  return `
                    <div class="history-votes-wrapper">
                      <div class="history-votes ${inc.isOngoing ? 'interactive' : 'readonly'}">
                        <button class="history-vote-btn up ${inc.isOngoing && currentUserVote === 'up' ? 'active' : ''}" 
                                ${inc.isOngoing ? `onclick="castVote('up')"` : 'disabled'}
                                title="${inc.isOngoing ? 'Thumbs Up' : 'Total Thumbs Up'}">
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="history-vote-icon">
                            <path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"></path>
                          </svg>
                          <span class="count">${inc.votesUp}</span>
                        </button>
                        <button class="history-vote-btn down ${inc.isOngoing && currentUserVote === 'down' ? 'active' : ''}" 
                                ${inc.isOngoing ? `onclick="castVote('down')"` : 'disabled'}
                                title="${inc.isOngoing ? 'Thumbs Down' : 'Total Thumbs Down'}">
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="history-vote-icon">
                            <path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3zm7-13h3a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-3"></path>
                          </svg>
                          <span class="count">${inc.votesDown}</span>
                        </button>
                      </div>
                    </div>
                  `;
                })()}
              </div>
              <div class="incident-time" style="display: flex; flex-direction: column; align-items: flex-end; gap: 8px;">
                <span>${inc.time}</span>
                ${isAdminVerified ? `
                  <button class="btn-edit-incident" onclick="openEditModal(${inc.id})" title="Edit Incident" style="background: none; border: none; color: #6b7280; cursor: pointer; padding: 4px; border-radius: 4px; transition: all 0.2s;">
                    <svg viewBox="0 0 20 20" fill="currentColor" style="width: 16px; height: 16px; display: inline-block;">
                      <path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793L3 14.172V17h2.828l8.38-8.379-2.83-2.828z" />
                    </svg>
                  </button>
                ` : ''}
              </div>
            </div>
            ${timelineHtml}
          </div>
        `;

        if (globalIdx === 2 && totalIncidentsCount > 2) {
          const btnText = window.isHistoryExpanded ? 'Show Less' : 'Show More';
          incidentsHtml += `
            <div class="history-expand-wrapper">
              <button id="btn-history-toggle" class="btn-history-toggle" onclick="toggleHistoryExpansion()">
                <span>${btnText}</span>
                <svg class="icon-chevron" viewBox="0 0 20 20" fill="currentColor" style="width: 20px; height: 20px; transition: transform 0.2s;">
                  <path fill-rule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clip-rule="evenodd" />
                </svg>
              </button>
            </div>
          `;
        }
      });
      monthBlock.innerHTML = incidentsHtml;
    }

    historyContainer.appendChild(monthBlock);
  });
}

window.isHistoryExpanded = false;

window.toggleHistoryExpansion = function () {
  window.isHistoryExpanded = !window.isHistoryExpanded;
  const container = document.getElementById('history-container');
  const btn = document.getElementById('btn-history-toggle');
  if (container) {
    if (window.isHistoryExpanded) {
      container.classList.add('expanded');
      if (btn) {
        btn.querySelector('span').textContent = 'Show Less';
      }
    } else {
      container.classList.remove('expanded');
      if (btn) {
        btn.querySelector('span').textContent = 'Show More';
      }
    }
  }
};

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
    window.allIncidents = incidents;
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
    updateUI(data.state, data.lastChecked, data.silenceTimeout, data.activeIncident);
    renderHeartbeat(data.history);

    // Dev HUD visibility
    if (data.devMode) {
      if (statusBanner) {
        if (data.simulated) {
          statusBanner.classList.add('simulation-active');
        } else {
          statusBanner.classList.remove('simulation-active');
        }
      }
    } else {
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


// Setup Developer HUD event listeners
document.addEventListener('DOMContentLoaded', () => {

  // Admin verification helper
  async function verifyAdminKey(token) {
    if (!token) return { valid: false, status: 400 };
    try {
      const res = await fetch('/api/v1/admin/verify', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
      });

      const contentType = res.headers.get('content-type') || '';
      if (contentType.includes('text/html')) {
        return { valid: false, status: 200, isIntercepted: true };
      }

      if (res.ok) {
        return { valid: true };
      }
      return { valid: false, status: res.status };
    } catch (e) {
      return { valid: false, status: 0, error: e };
    }
  }

  // Check saved key on page load
  const savedKey = localStorage.getItem('adminApiKey');
  if (savedKey) {
    verifyAdminKey(savedKey).then(result => {
      if (result.valid) {
        isAdminVerified = true;
        fetchIncidentHistory(); // re-render history with edit options visible
      } else {
        // ONLY clear the token if the server explicitly confirmed it is invalid (401 Unauthorized)
        if (result.status === 401) {
          console.warn("Saved admin key is invalid. Evicting from storage.");
          localStorage.removeItem('adminApiKey');
        } else if (result.isIntercepted) {
          console.warn("Verification request was intercepted (e.g. Cloudflare 2FA). Key retained.");
          // Still assume verified locally so that they can see edit buttons
          isAdminVerified = true;
          fetchIncidentHistory();
        } else {
          console.warn(`Verification failed with status ${result.status} or network error. Key retained.`);
          // Assume verified locally so they can still try to edit
          isAdminVerified = true;
          fetchIncidentHistory();
        }
      }
    });
  }

  // Edit Incident Modal UI bindings
  const editIncidentModal = document.getElementById('edit-incident-modal');
  const closeEditIncidentBtn = document.getElementById('btn-close-edit-incident');
  const cancelEditIncidentBtn = document.getElementById('btn-cancel-edit-incident');
  const submitEditIncidentBtn = document.getElementById('btn-submit-edit-incident');

  const editIdInput = document.getElementById('edit-incident-id');
  const editTypeSelect = document.getElementById('edit-incident-type');
  const editStartTimeInput = document.getElementById('edit-incident-start-time');
  const editNotesInput = document.getElementById('edit-incident-notes');

  const editLinkInput = document.getElementById('edit-incident-link');
  const editLinkTextInput = document.getElementById('edit-incident-link-text');
  const editVotesUpInput = document.getElementById('edit-incident-votes-up');
  const editVotesDownInput = document.getElementById('edit-incident-votes-down');

  window.openEditModal = function(id) {
    const inc = (window.allIncidents || []).find(i => i.id === id);
    if (!inc) return;
    editIdInput.value = inc.id;
    if (editTypeSelect) {
      editTypeSelect.value = inc.outage_type;
    }
    editStartTimeInput.value = inc.start_time;
    editNotesInput.value = inc.admin_notes || '';
    editLinkInput.value = inc.admin_link || '';
    editLinkTextInput.value = inc.admin_link_text || '';
    if (editVotesUpInput) {
      editVotesUpInput.value = (inc.override_votes_up !== null && inc.override_votes_up !== undefined) ? inc.override_votes_up : '';
    }
    if (editVotesDownInput) {
      editVotesDownInput.value = (inc.override_votes_down !== null && inc.override_votes_down !== undefined) ? inc.override_votes_down : '';
    }

    // Parse timeline events from details
    let timeline = [];
    if (inc.details) {
      try {
        const parsed = JSON.parse(inc.details);
        if (parsed && Array.isArray(parsed.errors)) {
          timeline = parsed.errors;
        }
      } catch (e) {
        console.error("Failed to parse incident details", e);
      }
    }

    const container = document.getElementById('edit-timeline-events-container');
    if (container) {
      container.innerHTML = '';
      if (timeline.length > 0) {
        const header = document.createElement('div');
        header.className = 'edit-timeline-section-title';
        header.textContent = 'Detailed Timeline Events';
        container.appendChild(header);

        timeline.forEach((event, idx) => {
          const item = document.createElement('div');
          item.className = 'edit-timeline-event-item';
          const eventTypeClass = event.type.replace(/\s+/g, '-');
          item.innerHTML = `
            <div class="edit-timeline-event-header">
              <span class="edit-timeline-event-title">Event #${idx + 1}</span>
              <span class="edit-timeline-event-badge ${eventTypeClass}">${escapeHtml(event.type)}</span>
            </div>
            <div class="form-group">
              <label style="font-size: 0.8rem; color: #94a3b8;">Event Timestamp (ISO 8601)</label>
              <input type="text" class="edit-timeline-event-time-input" data-index="${idx}" value="${escapeHtml(event.timestamp)}" style="background: #0f172a; border: 1px solid #312e81; border-radius: 6px; padding: 0.5rem; color: #f1f5f9; font-family: inherit; font-size: 0.9rem;">
            </div>
            <div class="form-group">
              <label style="font-size: 0.8rem; color: #94a3b8;">Event Description</label>
              <input type="text" class="edit-timeline-event-message-input" data-index="${idx}" value="${escapeHtml(event.message || '')}" style="background: #0f172a; border: 1px solid #312e81; border-radius: 6px; padding: 0.5rem; color: #f1f5f9; font-family: inherit; font-size: 0.9rem;">
            </div>
          `;
          container.appendChild(item);
        });
      }
    }

    editIncidentModal.style.display = 'flex';
  };

  const closeEditModal = () => {
    editIncidentModal.style.display = 'none';
  };

  if (closeEditIncidentBtn) closeEditIncidentBtn.addEventListener('click', closeEditModal);
  if (cancelEditIncidentBtn) cancelEditIncidentBtn.addEventListener('click', closeEditModal);

  if (submitEditIncidentBtn) {
    submitEditIncidentBtn.addEventListener('click', async () => {
      const id = editIdInput.value;
      const startTime = editStartTimeInput.value.trim();
      const notes = editNotesInput.value.trim();
      const token = localStorage.getItem('adminApiKey');

      if (!token) {
        alert("Admin API Key is missing. Please authenticate via the admin page first.");
        editIncidentModal.style.display = 'none';
        return;
      }

      const link = editLinkInput.value.trim();
      const linkText = editLinkTextInput.value.trim();
      const outageType = editTypeSelect ? editTypeSelect.value : undefined;
      const votesUpVal = editVotesUpInput ? editVotesUpInput.value.trim() : '';
      const votesDownVal = editVotesDownInput ? editVotesDownInput.value.trim() : '';

      // Compile updated timeline events
      const errors = [];
      const eventTimeInputs = document.querySelectorAll('.edit-timeline-event-time-input');
      const eventMessageInputs = document.querySelectorAll('.edit-timeline-event-message-input');

      eventTimeInputs.forEach(timeInput => {
        const idx = parseInt(timeInput.getAttribute('data-index'), 10);
        const msgInput = Array.from(eventMessageInputs).find(m => parseInt(m.getAttribute('data-index'), 10) === idx);

        errors[idx] = {
          timestamp: timeInput.value.trim(),
          message: msgInput ? msgInput.value.trim() : ''
        };
      });

      try {
        const res = await fetch(`/api/v1/incidents/${id}`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          },
          body: JSON.stringify({
            start_time: startTime || undefined,
            admin_notes: notes,
            admin_link: link,
            admin_link_text: linkText,
            outage_type: outageType,
            errors: errors.length > 0 ? errors : undefined,
            override_votes_up: votesUpVal === '' ? null : parseInt(votesUpVal, 10),
            override_votes_down: votesDownVal === '' ? null : parseInt(votesDownVal, 10)
          })
        });

        if (res.ok) {
          closeEditModal();
          await fetchStatus();
          await fetchIncidentHistory();
        } else {
          const data = await res.json();
          alert(`Failed to update: ${data.error}`);
        }
      } catch (err) {
        console.error("Error editing incident:", err);
        alert("Failed to connect to server.");
      }
    });
  }

  const deleteEditIncidentBtn = document.getElementById('btn-delete-incident');
  if (deleteEditIncidentBtn) {
    deleteEditIncidentBtn.addEventListener('click', async () => {
      const id = editIdInput.value;
      if (!id) return;

      const token = localStorage.getItem('adminApiKey');
      if (!token) {
        alert("Admin API Key is missing. Please set it first.");
        return;
      }

      const confirmed = confirm("Are you sure you want to delete this incident? If this is the active/latest incident, the previous incident will automatically be restored to ongoing.");
      if (!confirmed) return;

      try {
        const res = await fetch(`/api/v1/incidents/${id}`, {
          method: 'DELETE',
          headers: {
            'Authorization': `Bearer ${token}`
          }
        });

        if (res.ok) {
          closeEditModal();
          await fetchStatus();
          await fetchIncidentHistory();
        } else {
          const data = await res.json();
          alert(`Failed to delete: ${data.error}`);
        }
      } catch (err) {
        console.error("Error deleting incident:", err);
        alert("Failed to connect to server.");
      }
    });
  }

  // Setup Status Voting event listeners
  const voteUpBtn = document.getElementById('vote-up-btn');
  const voteDownBtn = document.getElementById('vote-down-btn');
  if (voteUpBtn) {
    voteUpBtn.addEventListener('click', () => castVote('up'));
  }
  if (voteDownBtn) {
    voteDownBtn.addEventListener('click', () => castVote('down'));
  }

});

// Clear active heartbeat tooltips when clicking anywhere else
document.addEventListener('click', () => {
  document.querySelectorAll('.heartbeat-block').forEach(b => {
    b.classList.remove('active');
  });
});

// Fetch CMS content and hydrate SEO/copy elements
async function fetchCMS() {
  try {
    const res = await fetch('/api/v1/cms');
    if (!res.ok) throw new Error('Failed to load CMS data');
    const data = await res.json();
    
    // Map list of {key, value} to a key-value object
    const cms = {};
    data.forEach(item => {
      cms[item.key] = item.value;
    });

    // 1. Hydrate Site Copy
    const titleEl = document.getElementById('html-title');
    if (titleEl && cms['site.title']) titleEl.textContent = cms['site.title'];
    
    const appTitleEl = document.getElementById('app-title');
    if (appTitleEl && cms['site.title']) appTitleEl.textContent = cms['site.title'].split('|')[0].trim();

    const subtitleEl = document.querySelector('.logo-subtitle');
    if (subtitleEl && cms['site.subtitle']) subtitleEl.textContent = cms['site.subtitle'];

    const aboutTitleEl = document.getElementById('about-title');
    if (aboutTitleEl && cms['site.about_title']) aboutTitleEl.textContent = cms['site.about_title'];

    const aboutTextEl = document.getElementById('about-text');
    if (aboutTextEl && cms['site.about_text']) aboutTextEl.textContent = cms['site.about_text'];

    const statesTitleEl = document.getElementById('states-title');
    if (statesTitleEl && cms['site.states_title']) statesTitleEl.textContent = cms['site.states_title'];

    const stateUpEl = document.getElementById('state-explain-up');
    if (stateUpEl && cms['site.state_up_desc']) stateUpEl.textContent = cms['site.state_up_desc'];

    const stateSilentEl = document.getElementById('state-explain-silent');
    if (stateSilentEl && cms['site.state_silent_desc']) stateSilentEl.textContent = cms['site.state_silent_desc'];

    const stateAuthEl = document.getElementById('state-explain-auth');
    if (stateAuthEl && cms['site.state_auth_desc']) stateAuthEl.textContent = cms['site.state_auth_desc'];

    const stateDownEl = document.getElementById('state-explain-down');
    if (stateDownEl && cms['site.state_down_desc']) stateDownEl.textContent = cms['site.state_down_desc'];

    const apiTitleEl = document.getElementById('api-check-title');
    if (apiTitleEl && cms['site.api_check_title']) apiTitleEl.textContent = cms['site.api_check_title'];

    const footerEl = document.getElementById('app-footer');
    if (footerEl && cms['site.footer']) {
      footerEl.innerHTML = `<p>${escapeHtml(cms['site.footer'])}</p>`;
    }

    // Hydrate FAQs
    for (let i = 1; i <= 4; i++) {
      const qEl = document.getElementById(`faq-${i}-q`);
      const aEl = document.getElementById(`faq-${i}-a`);
      if (qEl && cms[`faq.${i}.q`]) qEl.textContent = cms[`faq.${i}.q`];
      if (aEl && cms[`faq.${i}.a`]) aEl.textContent = cms[`faq.${i}.a`];
    }

    // 2. Hydrate Status State Configs
    const stateMapping = {
      'Up': 'state.up',
      'Silent Failure': 'state.silent',
      'Auth Error': 'state.auth',
      'Down': 'state.down',
      'Pending': 'state.pending'
    };

    for (const [stateName, prefix] of Object.entries(stateMapping)) {
      if (STATE_CONFIGS[stateName]) {
        if (cms[`${prefix}.title`]) STATE_CONFIGS[stateName].statusTitle = cms[`${prefix}.title`];
        if (cms[`${prefix}.desc`]) STATE_CONFIGS[stateName].description = cms[`${prefix}.desc`];
        if (cms[`${prefix}.active_desc`]) STATE_CONFIGS[stateName].activeDescription = cms[`${prefix}.active_desc`];
        if (cms[`${prefix}.badge`]) STATE_CONFIGS[stateName].badgeText = cms[`${prefix}.badge`];
      }
    }

    // 3. Inject JSON-LD structured schemas
    injectJsonLd(cms);

  } catch (err) {
    console.error('Error fetching/applying CMS content:', err);
    // Fall back to default static HTML schema
    injectJsonLd();
  }
}

// Injects Google JSON-LD schema tags for WebSite and FAQPage SEO
function injectJsonLd(cms = {}) {
  // Remove existing dynamic json-ld script tags if any
  document.querySelectorAll('script[type="application/ld+json"]').forEach(s => s.remove());

  // WebSite Schema
  const websiteSchema = {
    "@context": "https://schema.org",
    "@type": "WebSite",
    "name": "AISStream Uptime Monitor",
    "url": "https://aisuptime.buttermilkgreen.fyi",
    "description": cms['site.about_text'] || "Real-time status tracking for the aisstream.io WebSocket API."
  };

  const wsScript = document.createElement('script');
  wsScript.type = 'application/ld+json';
  wsScript.text = JSON.stringify(websiteSchema);
  document.head.appendChild(wsScript);

  // FAQPage Schema
  const faqs = [];
  for (let i = 1; i <= 4; i++) {
    const q = cms[`faq.${i}.q`] || document.getElementById(`faq-${i}-q`)?.textContent;
    const a = cms[`faq.${i}.a`] || document.getElementById(`faq-${i}-a`)?.textContent;
    if (q && a) {
      faqs.push({
        "@type": "Question",
        "name": q,
        "acceptedAnswer": {
          "@type": "Answer",
          "text": a
        }
      });
    }
  }

  if (faqs.length > 0) {
    const faqSchema = {
      "@context": "https://schema.org",
      "@type": "FAQPage",
      "mainEntity": faqs
    };

    const faqScript = document.createElement('script');
    faqScript.type = 'application/ld+json';
    faqScript.text = JSON.stringify(faqSchema);
    document.head.appendChild(faqScript);
  }
}

// Initial runs
(async () => {
  await fetchCMS();
  fetchStatus();
  setInterval(fetchStatus, 10000);
  fetchIncidentHistory();
  setInterval(fetchIncidentHistory, 10000);
})();

