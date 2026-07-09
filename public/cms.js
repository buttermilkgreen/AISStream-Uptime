document.addEventListener('DOMContentLoaded', () => {
  const authGate = document.getElementById('auth-gate');
  const cmsWorkspace = document.getElementById('cms-workspace');
  const adminPassKey = document.getElementById('admin-pass-key');
  const btnSubmitAuth = document.getElementById('btn-submit-auth');
  const btnLogout = document.getElementById('btn-logout');
  const cmsForm = document.getElementById('cms-form');
  const saveStatusMsg = document.getElementById('save-status-msg');
  const btnReset = document.getElementById('btn-reset');

  let activeToken = localStorage.getItem('admin_api_key') || '';
  let cmsData = [];

  // Toggle Tabs
  const tabButtons = document.querySelectorAll('.cms-tab-btn');
  const tabPanes = document.querySelectorAll('.tab-pane');

  tabButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      tabButtons.forEach(b => b.classList.remove('active'));
      tabPanes.forEach(p => {
        p.classList.remove('active');
        p.style.display = 'none';
      });

      btn.classList.add('active');
      const targetTab = btn.getAttribute('data-tab');
      const activePane = document.getElementById(`tab-${targetTab}`);
      if (activePane) {
        activePane.classList.add('active');
        activePane.style.display = 'flex';
      }
    });
  });

  // Verify Auth and Load CMS Config
  async function checkAuthAndLoad() {
    if (!activeToken) {
      showGate();
      return;
    }

    try {
      const verifyRes = await fetch('/api/v1/admin/verify', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${activeToken}`
        }
      });

      if (verifyRes.ok) {
        const res = await fetch('/api/v1/cms');
        if (res.ok) {
          cmsData = await res.json();
          hideGate();
          renderCMSForm();
        } else {
          alert('Error loading CMS content.');
        }
      } else {
        localStorage.removeItem('admin_api_key');
        activeToken = '';
        showGate();
        alert('Verification failed or session expired. Please enter API Key again.');
      }
    } catch (e) {
      console.error(e);
      alert('Error contacting server. Make sure server is running.');
    }
  }

  function showGate() {
    authGate.style.display = 'block';
    cmsWorkspace.style.display = 'none';
    btnLogout.style.display = 'none';
  }

  function hideGate() {
    authGate.style.display = 'none';
    cmsWorkspace.style.display = 'flex';
    btnLogout.style.display = 'inline-flex';
  }

  // Handle Login Submit
  btnSubmitAuth.addEventListener('click', async () => {
    const key = adminPassKey.value.trim();
    if (!key) return;

    try {
      const verifyRes = await fetch('/api/v1/admin/verify', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${key}`
        }
      });

      if (verifyRes.ok) {
        activeToken = key;
        localStorage.setItem('admin_api_key', key);
        const res = await fetch('/api/v1/cms');
        if (res.ok) {
          cmsData = await res.json();
          hideGate();
          renderCMSForm();
        } else {
          alert('Error loading CMS content.');
        }
      } else {
        alert('Invalid Admin API Key.');
      }
    } catch (e) {
      console.error(e);
      alert('Error verifying key.');
    }
  });

  adminPassKey.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      btnSubmitAuth.click();
    }
  });

  // Logout Action
  btnLogout.addEventListener('click', () => {
    localStorage.removeItem('admin_api_key');
    activeToken = '';
    showGate();
  });

  // Render Form Items
  function renderCMSForm() {
    const tabGeneral = document.getElementById('tab-general-fields');
    const tabStates = document.getElementById('tab-states-fields');
    const tabFaqs = document.getElementById('tab-faqs-fields');

    tabGeneral.innerHTML = '';
    tabStates.innerHTML = '';
    tabFaqs.innerHTML = '';

    // Sub-group elements for the general tab to keep things structured
    const generalGroups = {
      'Main Site Branding': [],
      'About Section Content': [],
      'Connection State Reference Cards': [],
      'API Check Guide': []
    };

    // Sub-group elements for the states tab to keep things highly structured
    const stateGroups = {
      'Operational State (Up)': [],
      'Silent Failure State (Connected, No Data)': [],
      'Authentication Error State (Invalid API Key)': [],
      'Offline State (Connection Down)': [],
      'Connecting State (Awaiting Startup)': []
    };

    cmsData.forEach(item => {
      const formGroup = document.createElement('div');
      formGroup.className = 'form-group';
      formGroup.style.display = 'flex';
      formGroup.style.flexDirection = 'column';
      formGroup.style.gap = '0.5rem';
      formGroup.style.marginBottom = '0.5rem';

      const label = document.createElement('label');
      label.textContent = item.label || item.key;
      label.style.fontWeight = '600';
      label.style.fontSize = '0.9rem';
      label.style.color = 'var(--text-primary)';

      formGroup.appendChild(label);

      let input;
      if (item.type === 'textarea') {
        input = document.createElement('textarea');
        input.rows = 3;
        input.style.resize = 'vertical';
      } else {
        input = document.createElement('input');
        input.type = 'text';
      }

      input.id = `input-${item.key}`;
      input.className = 'cms-input';
      input.value = item.value;

      // Standard styles matching index/admin dashboard theme
      input.style.background = '#ffffff';
      input.style.border = '1px solid var(--border-color)';
      input.style.borderRadius = '6px';
      input.style.padding = '0.75rem';
      input.style.color = 'var(--text-primary)';
      input.style.fontFamily = 'inherit';
      input.style.fontSize = '0.95rem';

      formGroup.appendChild(input);

      // Add help text hint if available
      if (item.help_text) {
        const hint = document.createElement('span');
        hint.textContent = item.help_text;
        hint.style.fontSize = '0.8rem';
        hint.style.color = '#64748b'; // Sleek slate grey
        hint.style.fontStyle = 'italic';
        hint.style.marginTop = '0.2rem';
        formGroup.appendChild(hint);
      }

      // Distribute to corresponding tabs
      if (item.group_id === 'general') {
        let matchedGroup = 'Main Site Branding';
        if (item.key === 'site.about_title' || item.key === 'site.about_text') {
          matchedGroup = 'About Section Content';
        } else if (item.key === 'site.states_title' || item.key.startsWith('site.state_')) {
          matchedGroup = 'Connection State Reference Cards';
        } else if (item.key === 'site.api_check_title') {
          matchedGroup = 'API Check Guide';
        }
        generalGroups[matchedGroup].push(formGroup);
      } else if (item.group_id === 'states') {
        let matchedGroup = 'Operational State (Up)';
        if (item.key.includes('.silent.') || item.key === 'site.state_silent_desc') {
          matchedGroup = 'Silent Failure State (Connected, No Data)';
        } else if (item.key.includes('.auth.') || item.key === 'site.state_auth_desc') {
          matchedGroup = 'Authentication Error State (Invalid API Key)';
        } else if (item.key.includes('.down.') || item.key === 'site.state_down_desc') {
          matchedGroup = 'Offline State (Connection Down)';
        } else if (item.key.includes('.pending.')) {
          matchedGroup = 'Connecting State (Awaiting Startup)';
        }
        stateGroups[matchedGroup].push(formGroup);
      } else if (item.group_id === 'faqs') {
        tabFaqs.appendChild(formGroup);
      }
    });

    // Append general group elements to general tab with clean section subheadings
    for (const [groupTitle, elements] of Object.entries(generalGroups)) {
      if (elements.length > 0) {
        const sectionHeader = document.createElement('div');
        sectionHeader.style.marginTop = '1.75rem';
        sectionHeader.style.marginBottom = '1rem';
        sectionHeader.style.borderBottom = '2px solid var(--border-color)';
        sectionHeader.style.paddingBottom = '0.4rem';

        const heading = document.createElement('h3');
        heading.textContent = groupTitle;
        heading.style.margin = '0';
        heading.style.fontSize = '1.05rem';
        heading.style.fontWeight = '700';
        heading.style.color = 'var(--text-primary)';

        sectionHeader.appendChild(heading);
        tabGeneral.appendChild(sectionHeader);

        elements.forEach(el => tabGeneral.appendChild(el));
      }
    }

    // Append state group elements to states tab with clean section subheadings
    for (const [groupTitle, elements] of Object.entries(stateGroups)) {
      if (elements.length > 0) {
        const sectionHeader = document.createElement('div');
        sectionHeader.style.marginTop = '1.75rem';
        sectionHeader.style.marginBottom = '1rem';
        sectionHeader.style.borderBottom = '2px solid var(--border-color)';
        sectionHeader.style.paddingBottom = '0.4rem';

        const heading = document.createElement('h3');
        heading.textContent = groupTitle;
        heading.style.margin = '0';
        heading.style.fontSize = '1.05rem';
        heading.style.fontWeight = '700';
        heading.style.color = 'var(--text-primary)';

        sectionHeader.appendChild(heading);
        tabStates.appendChild(sectionHeader);

        elements.forEach(el => tabStates.appendChild(el));
      }
    }
  }

  // Handle Reset/Discard
  btnReset.addEventListener('click', () => {
    if (confirm('Discard all unsaved edits?')) {
      renderCMSForm();
    }
  });

  // Handle Form Submit (Save Copy)
  cmsForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    const payload = cmsData.map(item => {
      const inputEl = document.getElementById(`input-${item.key}`);
      return {
        key: item.key,
        value: inputEl ? inputEl.value : item.value
      };
    });

    try {
      btnSaveActiveState(true);

      const res = await fetch('/api/v1/cms', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${activeToken}`
        },
        body: JSON.stringify(payload)
      });

      const result = await res.json();

      if (res.ok && result.success) {
        showSaveToast('Content changes saved!', 'success');
        // Update local memory data so resets work properly
        cmsData.forEach(item => {
          const inputEl = document.getElementById(`input-${item.key}`);
          if (inputEl) item.value = inputEl.value;
        });
      } else {
        showSaveToast(`Save failed: ${result.error || 'Unknown error'}`, 'error');
      }
    } catch (err) {
      console.error(err);
      showSaveToast('Error communicating with server.', 'error');
    } finally {
      btnSaveActiveState(false);
    }
  });

  function btnSaveActiveState(isActive) {
    const btn = document.getElementById('btn-save');
    if (isActive) {
      btn.disabled = true;
      btn.textContent = 'Saving Changes...';
      btn.style.opacity = '0.7';
    } else {
      btn.disabled = false;
      btn.textContent = 'Save Copy Updates';
      btn.style.opacity = '1';
    }
  }

  function showSaveToast(message, type) {
    saveStatusMsg.textContent = message;
    saveStatusMsg.style.color = type === 'success' ? '#10b981' : '#ef4444';
    saveStatusMsg.style.opacity = '1';
    setTimeout(() => {
      saveStatusMsg.style.opacity = '0';
    }, 4000);
  }

  // Auto trigger check
  checkAuthAndLoad();
});
