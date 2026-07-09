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
      const res = await fetch('/api/v1/cms', {
        headers: {
          'Authorization': `Bearer ${activeToken}`
        }
      });

      if (res.ok) {
        cmsData = await res.json();
        hideGate();
        renderCMSForm();
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
      const res = await fetch('/api/v1/cms', {
        headers: {
          'Authorization': `Bearer ${key}`
        }
      });

      if (res.ok) {
        activeToken = key;
        localStorage.setItem('admin_api_key', key);
        cmsData = await res.json();
        hideGate();
        renderCMSForm();
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
    const tabGeneral = document.getElementById('tab-general');
    const tabStates = document.getElementById('tab-states');
    const tabFaqs = document.getElementById('tab-faqs');

    tabGeneral.innerHTML = '';
    tabStates.innerHTML = '';
    tabFaqs.innerHTML = '';

    cmsData.forEach(item => {
      const formGroup = document.createElement('div');
      formGroup.className = 'form-group';
      formGroup.style.display = 'flex';
      formGroup.style.flexDirection = 'column';
      formGroup.style.gap = '0.5rem';

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

      // Distribute to corresponding tabs
      if (item.group_id === 'general') {
        tabGeneral.appendChild(formGroup);
      } else if (item.group_id === 'states') {
        tabStates.appendChild(formGroup);
      } else if (item.group_id === 'faqs') {
        tabFaqs.appendChild(formGroup);
      }
    });
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
