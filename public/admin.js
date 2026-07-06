document.addEventListener('DOMContentLoaded', () => {
  const authGate = document.getElementById('auth-gate');
  const dashboardContent = document.getElementById('dashboard-content');
  const btnSubmitAuth = document.getElementById('btn-submit-auth');
  const btnLogout = document.getElementById('btn-logout');
  const adminPassKey = document.getElementById('admin-pass-key');

  // Chart instances
  let chartVolume = null;
  let chartEndpoints = null;
  let chartUserAgents = null;
  let chartTelemetryVersions = null;
  let chartTelemetryAdoption = null;

  // Local data copies
  let allConsumers = [];
  let filteredConsumers = [];
  let consumerPage = 1;
  const consumerPageSize = 5;

  let allInstallations = [];
  let sortedInstallations = [];
  let sortColumn = 'last_seen';
  let sortAscending = false;
  let installsPage = 1;
  const installsPageSize = 5;

  const fontConfig = {
    family: "'Outfit', sans-serif",
    size: 11
  };

  // Auth gate checks
  const savedKey = localStorage.getItem('adminApiKey');
  if (savedKey) {
    verifyAndLoad(savedKey);
  } else {
    showAuthGate();
  }

  btnSubmitAuth.addEventListener('click', () => {
    const key = adminPassKey.value.trim();
    if (key) {
      verifyAndLoad(key);
    } else {
      alert('Please enter a key.');
    }
  });

  adminPassKey.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      btnSubmitAuth.click();
    }
  });

  btnLogout.addEventListener('click', () => {
    localStorage.removeItem('adminApiKey');
    showAuthGate();
  });

  function showAuthGate() {
    authGate.style.display = 'block';
    dashboardContent.style.display = 'none';
    btnLogout.style.display = 'none';
    adminPassKey.value = '';
  }

  async function verifyAndLoad(token) {
    try {
      const res = await fetch('/api/v1/admin/verify', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) {
        localStorage.setItem('adminApiKey', token);
        authGate.style.display = 'none';
        dashboardContent.style.display = 'block';
        btnLogout.style.display = 'inline-block';
        loadDashboardData(token);
      } else {
        alert('Invalid Admin Key. Access denied.');
        if (savedKey) {
          localStorage.removeItem('adminApiKey');
          showAuthGate();
        }
      }
    } catch (e) {
      alert('Network or server error during validation.');
    }
  }

  async function loadDashboardData(key) {
    try {
      const [usageRes, telemetryRes] = await Promise.all([
        fetch('/api/v1/admin/api-usage', { headers: { 'Authorization': `Bearer ${key}` } }),
        fetch('/api/v1/admin/telemetry', { headers: { 'Authorization': `Bearer ${key}` } })
      ]);

      if (!usageRes.ok || !telemetryRes.ok) {
        throw new Error('Unauthorized or server error');
      }

      const usageData = await usageRes.json();
      const telemetryData = await telemetryRes.json();

      renderApiUsage(usageData);
      renderTelemetry(telemetryData);

    } catch (err) {
      console.error(err);
      localStorage.removeItem('adminApiKey');
      showAuthGate();
    }
  }

  // --- API USAGE SECTION ---
  function renderApiUsage(data) {
    // 1. Render Metrics
    document.getElementById('metric-ips-24h').textContent = data.uniqueIPs.last24h;
    document.getElementById('metric-ips-7d').textContent = data.uniqueIPs.last7d;
    document.getElementById('metric-ips-30d').textContent = data.uniqueIPs.last30d;
    document.getElementById('metric-ips-60d').textContent = data.uniqueIPs.last60d;
    document.getElementById('metric-ips-90d').textContent = data.uniqueIPs.last90d;

    // Destroy old charts
    if (chartVolume) chartVolume.destroy();
    if (chartEndpoints) chartEndpoints.destroy();
    if (chartUserAgents) chartUserAgents.destroy();

    // Volume Chart
    const volCtx = document.getElementById('chart-daily-volume').getContext('2d');
    const volLabels = data.dailyVolume.map(v => v.date);
    const volCounts = data.dailyVolume.map(v => v.count);
    chartVolume = new Chart(volCtx, {
      type: 'bar',
      data: {
        labels: volLabels.length ? volLabels : ['No Data'],
        datasets: [{
          label: 'Requests',
          data: volCounts.length ? volCounts : [0],
          backgroundColor: '#3b82f6',
          borderRadius: 4
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { titleFont: fontConfig, bodyFont: fontConfig }
        },
        scales: {
          x: { grid: { display: false }, ticks: { font: fontConfig } },
          y: { beginAtZero: true, ticks: { precision: 0, font: fontConfig } }
        }
      }
    });

    // Endpoints Chart
    const epCtx = document.getElementById('chart-endpoints').getContext('2d');
    const epLabels = data.endpoints.map(e => e.endpoint);
    const epCounts = data.endpoints.map(e => e.count);
    chartEndpoints = new Chart(epCtx, {
      type: 'doughnut',
      data: {
        labels: epLabels.length ? epLabels : ['No Data'],
        datasets: [{
          data: epCounts.length ? epCounts : [0],
          backgroundColor: ['#3b82f6', '#10b981', '#f59e0b', '#ec4899', '#8b5cf6', '#64748b']
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: 'bottom', labels: { font: fontConfig, boxWidth: 12 } }
        }
      }
    });

    // User Agents Chart
    const uaCtx = document.getElementById('chart-user-agents').getContext('2d');
    const uaGroups = {};
    
    // Aggregate user agents from both endpoint inputs or usage list
    const userAgentRawList = data.topConsumers.map(c => ({ user_agent: c.user_agent, count: c.count }));
    userAgentRawList.forEach(item => {
      if (!item.user_agent) return;
      const ua = item.user_agent.toLowerCase();
      let name = 'Other';
      if (ua.includes('uptime-kuma') || ua.includes('uptimekuma')) {
        name = 'Uptime Kuma';
      } else if (ua.includes('shiptracker') || ua.includes('ship-tracker')) {
        name = 'Ship Tracker App';
      } else if (ua.includes('curl') || ua.includes('wget')) {
        name = 'curl/commandline';
      } else if (ua.includes('mozilla') || ua.includes('chrome') || ua.includes('safari') || ua.includes('firefox')) {
        name = 'Web Browser';
      }
      uaGroups[name] = (uaGroups[name] || 0) + item.count;
    });

    const uaLabels = Object.keys(uaGroups);
    const uaCounts = Object.values(uaGroups);
    chartUserAgents = new Chart(uaCtx, {
      type: 'doughnut',
      data: {
        labels: uaLabels.length ? uaLabels : ['No Data'],
        datasets: [{
          data: uaCounts.length ? uaCounts : [0],
          backgroundColor: ['#6366f1', '#14b8a6', '#f43f5e', '#eab308', '#64748b']
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: 'bottom', labels: { font: fontConfig, boxWidth: 12 } }
        }
      }
    });

    // Consumers Table logic
    allConsumers = data.topConsumers || [];
    consumerPage = 1;
    applyConsumersFilterAndRender();
  }

  // Consumers Filter & Pagination Handlers
  const filterShipTrackerCheckbox = document.getElementById('filter-shiptracker');
  filterShipTrackerCheckbox.addEventListener('change', () => {
    consumerPage = 1;
    applyConsumersFilterAndRender();
  });

  document.getElementById('btn-prev-page').addEventListener('click', () => {
    if (consumerPage > 1) {
      consumerPage--;
      renderConsumersPage();
    }
  });

  document.getElementById('btn-next-page').addEventListener('click', () => {
    const totalPages = Math.ceil(filteredConsumers.length / consumerPageSize) || 1;
    if (consumerPage < totalPages) {
      consumerPage++;
      renderConsumersPage();
    }
  });

  function applyConsumersFilterAndRender() {
    const excludeShipTracker = filterShipTrackerCheckbox.checked;
    if (excludeShipTracker) {
      filteredConsumers = allConsumers.filter(c => {
        const ua = (c.user_agent || '').toLowerCase();
        return !ua.includes('shiptracker') && !ua.includes('ship-tracker');
      });
    } else {
      filteredConsumers = [...allConsumers];
    }
    renderConsumersPage();
  }

  function renderConsumersPage() {
    const tbody = document.getElementById('top-consumers-body');
    tbody.innerHTML = '';

    const totalPages = Math.ceil(filteredConsumers.length / consumerPageSize) || 1;
    if (consumerPage > totalPages) consumerPage = totalPages;

    const startIdx = (consumerPage - 1) * consumerPageSize;
    const endIdx = startIdx + consumerPageSize;
    const pageItems = filteredConsumers.slice(startIdx, endIdx);

    if (pageItems.length > 0) {
      pageItems.forEach(consumer => {
        const tr = document.createElement('tr');

        const tdIp = document.createElement('td');
        tdIp.textContent = consumer.ip;

        const tdUa = document.createElement('td');
        tdUa.textContent = consumer.user_agent || 'unknown';
        tdUa.style.maxWidth = '300px';
        tdUa.style.overflow = 'hidden';
        tdUa.style.textOverflow = 'ellipsis';
        tdUa.style.whiteSpace = 'nowrap';
        tdUa.title = consumer.user_agent || '';

        const tdCount = document.createElement('td');
        tdCount.textContent = consumer.count;

        tr.appendChild(tdIp);
        tr.appendChild(tdUa);
        tr.appendChild(tdCount);
        tbody.appendChild(tr);
      });
    } else {
      tbody.innerHTML = '<tr><td colspan="3" style="text-align: center; color: var(--text-muted); padding: 1rem;">No consumers recorded</td></tr>';
    }

    // Update pagination controls
    document.getElementById('page-indicator').textContent = `Page ${consumerPage} of ${totalPages}`;
    document.getElementById('btn-prev-page').disabled = (consumerPage === 1);
    document.getElementById('btn-next-page').disabled = (consumerPage === totalPages);
  }

  // --- TELEMETRY SECTION ---
  function renderTelemetry(data) {
    // 1. Render Metrics
    document.getElementById('metric-telemetry-total').textContent = data.totalInstalls;
    document.getElementById('metric-telemetry-dau').textContent = data.dau;
    document.getElementById('metric-telemetry-wau').textContent = data.wau;
    document.getElementById('metric-telemetry-mau').textContent = data.mau;
    document.getElementById('metric-telemetry-new-7d').textContent = data.newThisWeek;
    document.getElementById('metric-telemetry-new-30d').textContent = data.new30d;

    // Destroy old charts
    if (chartTelemetryVersions) chartTelemetryVersions.destroy();
    if (chartTelemetryAdoption) chartTelemetryAdoption.destroy();

    // App Versions Chart
    const tvCtx = document.getElementById('chart-telemetry-versions').getContext('2d');
    const tvLabels = data.versions.map(v => v.version);
    const tvCounts = data.versions.map(v => v.count);
    chartTelemetryVersions = new Chart(tvCtx, {
      type: 'doughnut',
      data: {
        labels: tvLabels.length ? tvLabels : ['No Data'],
        datasets: [{
          data: tvCounts.length ? tvCounts : [0],
          backgroundColor: ['#3b82f6', '#10b981', '#f59e0b', '#ec4899', '#8b5cf6', '#64748b']
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: 'bottom', labels: { font: fontConfig, boxWidth: 12 } }
        }
      }
    });

    // Adoption Rates Chart
    const taCtx = document.getElementById('chart-telemetry-adoption').getContext('2d');
    const total = data.totalInstalls || 1;
    const getAdoptionCount = (list, keyVal) => {
      const item = list.find(x => Object.values(x)[0] === keyVal);
      return item ? item.count : 0;
    };
    
    const mapAdoption = Math.round((getAdoptionCount(data.mapEntities, 1) / total) * 100);
    const classBAdoption = Math.round((getAdoptionCount(data.classB, 1) / total) * 100);
    const apiMonitorAdoption = Math.round((getAdoptionCount(data.apiMonitoring, 1) / total) * 100);
    const clearStartupAdoption = Math.round((getAdoptionCount(data.clearOnStartup, 1) / total) * 100);

    chartTelemetryAdoption = new Chart(taCtx, {
      type: 'bar',
      data: {
        labels: ['Map Entities', 'Include Class B', 'API Monitor', 'Clear Startup'],
        datasets: [{
          label: 'Adoption Rate %',
          data: [mapAdoption, classBAdoption, apiMonitorAdoption, clearStartupAdoption],
          backgroundColor: ['#3b82f6', '#10b981', '#f59e0b', '#ec4899'],
          borderRadius: 4
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { titleFont: fontConfig, bodyFont: fontConfig }
        },
        scales: {
          x: { grid: { display: false }, ticks: { font: fontConfig } },
          y: { beginAtZero: true, max: 100, ticks: { font: fontConfig, callback: value => value + '%' } }
        }
      }
    });

    // Telemetry installations table sorting & pagination logic
    allInstallations = data.installsList || [];
    sortedInstallations = [...allInstallations];
    installsPage = 1;
    sortAndRenderInstallations();
  }

  // Installations Pagination Event Listeners
  document.getElementById('btn-prev-installs-page').addEventListener('click', () => {
    if (installsPage > 1) {
      installsPage--;
      renderInstallations();
    }
  });

  document.getElementById('btn-next-installs-page').addEventListener('click', () => {
    const totalPages = Math.ceil(sortedInstallations.length / installsPageSize) || 1;
    if (installsPage < totalPages) {
      installsPage++;
      renderInstallations();
    }
  });

  const headers = document.querySelectorAll('table.dashboard-table th[data-sort]');
  headers.forEach(header => {
    header.addEventListener('click', () => {
      const field = header.getAttribute('data-sort');
      if (sortColumn === field) {
        sortAscending = !sortAscending;
      } else {
        sortColumn = field;
        sortAscending = true;
      }
      // Update header indicator icons
      headers.forEach(h => {
        const icon = h.querySelector('.sort-icon');
        if (h === header) {
          icon.textContent = sortAscending ? '▲' : '▼';
        } else {
          icon.textContent = ' ';
        }
      });
      sortAndRenderInstallations();
    });
  });

  function sortAndRenderInstallations() {
    sortedInstallations.sort((a, b) => {
      let valA = a[sortColumn];
      let valB = b[sortColumn];

      // Handle null/undefined values
      if (valA === undefined || valA === null) valA = '';
      if (valB === undefined || valB === null) valB = '';

      if (typeof valA === 'string') {
        return sortAscending ? valA.localeCompare(valB) : valB.localeCompare(valA);
      } else {
        return sortAscending ? valA - valB : valB - valA;
      }
    });
    installsPage = 1;
    renderInstallations();
  }

  function renderInstallations() {
    const tbody = document.getElementById('telemetry-clients-body');
    tbody.innerHTML = '';

    const totalPages = Math.ceil(sortedInstallations.length / installsPageSize) || 1;
    if (installsPage > totalPages) installsPage = totalPages;

    const startIdx = (installsPage - 1) * installsPageSize;
    const endIdx = startIdx + installsPageSize;
    const displayList = sortedInstallations.slice(startIdx, endIdx);

    if (displayList.length > 0) {
      displayList.forEach(client => {
        const tr = document.createElement('tr');

        // Status glowing dot
        const tdStatus = document.createElement('td');
        tdStatus.className = 'status-cell';
        tdStatus.style.textAlign = 'center';
        
        const lastSeenDate = new Date(client.last_seen);
        const msDiff = Date.now() - lastSeenDate.getTime();
        const hoursDiff = msDiff / (1000 * 60 * 60);

        let dotColor = 'red';
        if (hoursDiff <= 4) {
          dotColor = 'green';
        } else if (hoursDiff <= 24) {
          dotColor = 'amber';
        }

        const uuidPart = client.uuid ? client.uuid.split('-')[0] : 'unknown';
        let checkinLine = '';
        if (hoursDiff <= 24) {
          const timeStr = lastSeenDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
          checkinLine = `Last check-in: ${timeStr}`;
        } else {
          const dateStr = lastSeenDate.toLocaleDateString([], { year: 'numeric', month: '2-digit', day: '2-digit' });
          const timeStr = lastSeenDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
          checkinLine = `Last check-in: ${dateStr} ${timeStr}`;
        }

        const spanDotContainer = document.createElement('span');
        spanDotContainer.className = 'status-dot-container';

        const spanDot = document.createElement('span');
        spanDot.className = `status-dot ${dotColor}`;
        
        const divTooltip = document.createElement('div');
        divTooltip.className = 'status-tooltip';
        divTooltip.style.display = 'flex';
        divTooltip.style.flexDirection = 'column';
        divTooltip.style.gap = '2px';
        divTooltip.innerHTML = `
          <div>${checkinLine}</div>
          <div style="font-size: 0.65rem; color: #a1a1aa; font-family: monospace; font-weight: normal; text-align: left;">ID: ${uuidPart}</div>
        `;

        spanDotContainer.appendChild(spanDot);
        spanDotContainer.appendChild(divTooltip);
        tdStatus.appendChild(spanDotContainer);

        // If duplicate signature exists, add ⓘ info icon with hover tooltip
        if (client.is_duplicate) {
          const dupContainer = document.createElement('span');
          dupContainer.className = 'duplicate-container';
          dupContainer.textContent = ' ⓘ';

          const dupTooltip = document.createElement('div');
          dupTooltip.className = 'status-tooltip';
          dupTooltip.textContent = 'Duplicate User (Same Network)';

          dupContainer.appendChild(dupTooltip);
          tdStatus.appendChild(dupContainer);
        }

        const tdVer = document.createElement('td');
        tdVer.textContent = client.version;

        const tdMap = document.createElement('td');
        tdMap.innerHTML = client.enable_map_entities ? '<span style="color: #10b981;">✔</span>' : '<span style="color: #ef4444;">✘</span>';
        tdMap.style.textAlign = 'center';

        const tdClassB = document.createElement('td');
        tdClassB.innerHTML = client.include_class_b ? '<span style="color: #10b981;">✔</span>' : '<span style="color: #ef4444;">✘</span>';
        tdClassB.style.textAlign = 'center';

        const tdClear = document.createElement('td');
        tdClear.innerHTML = client.clear_map_on_startup ? '<span style="color: #10b981;">✔</span>' : '<span style="color: #ef4444;">✘</span>';
        tdClear.style.textAlign = 'center';

        const tdTimeout = document.createElement('td');
        tdTimeout.textContent = client.map_timeout_minutes + 'm';
        tdTimeout.style.textAlign = 'center';

        const tdWatch = document.createElement('td');
        tdWatch.textContent = client.watchlist_count;
        tdWatch.style.textAlign = 'center';

        // Install date showing age
        const tdCreated = document.createElement('td');
        tdCreated.className = 'status-cell';
        if (client.created_at) {
          const createdDate = new Date(client.created_at);
          const msCreatedDiff = Date.now() - createdDate.getTime();
          const daysAge = Math.floor(msCreatedDiff / (1000 * 60 * 60 * 24));
          
          const textSpan = document.createElement('span');
          textSpan.textContent = `${daysAge}d ago`;

          const dateStr = createdDate.toLocaleDateString([], { year: 'numeric', month: '2-digit', day: '2-digit' });
          const timeStr = createdDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
          
          const divTooltip = document.createElement('div');
          divTooltip.className = 'status-tooltip right-aligned';
          divTooltip.textContent = `Installed: ${dateStr} ${timeStr}`;

          tdCreated.appendChild(textSpan);
          tdCreated.appendChild(divTooltip);
        } else {
          tdCreated.textContent = 'unknown';
        }

        tr.appendChild(tdStatus);
        tr.appendChild(tdVer);
        tr.appendChild(tdMap);
        tr.appendChild(tdClassB);
        tr.appendChild(tdClear);
        tr.appendChild(tdTimeout);
        tr.appendChild(tdWatch);
        tr.appendChild(tdCreated);

        tbody.appendChild(tr);
      });
    } else {
      tbody.innerHTML = '<tr><td colspan="8" style="text-align: center; color: var(--text-muted); padding: 1rem;">No installations registered</td></tr>';
    }

    // Update pagination controls
    document.getElementById('installs-page-indicator').textContent = `Page ${installsPage} of ${totalPages}`;
    document.getElementById('btn-prev-installs-page').disabled = (installsPage === 1);
    document.getElementById('btn-next-installs-page').disabled = (installsPage === totalPages);
  }

  // Setup toggle behavior for metric tooltips on mobile / touch events
  document.addEventListener('click', (e) => {
    const container = e.target.closest('.metric-tooltip-container');
    document.querySelectorAll('.metric-tooltip-container').forEach(c => {
      if (c !== container) {
        c.classList.remove('active');
      }
    });
    if (container) {
      e.stopPropagation();
      container.classList.toggle('active');
    }
  });

});
