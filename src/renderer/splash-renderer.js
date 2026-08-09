// Splash screen renderer
console.log('Splash renderer initialized');

// DOM elements
const tasksContainer = document.getElementById('tasks-container');
const actionPanel = document.getElementById('action-panel');
const actionTitle = document.getElementById('action-title');
const actionMessage = document.getElementById('action-message');
const actionDetails = document.getElementById('action-details');
const actionButtons = document.getElementById('action-buttons');
const errorPanel = document.getElementById('error-panel');
const errorMessage = document.getElementById('error-message');
const errorButtons = document.getElementById('error-buttons');
const overallStatus = document.getElementById('overall-status');
const overallFill = document.getElementById('overall-fill');
const versionLabel = document.getElementById('splash-version');

// Track current state
let currentAction = null;

/**
 * Advance the overall progress bar.
 *
 * Derived from how many task rows have finished rather than reported by main:
 * the startup sequence emits per-task progress only, and a second source of
 * truth would drift from what the list actually shows. Hidden rows (the SDE
 * download only appears when there IS one) are excluded so the bar reflects
 * the work actually being done.
 */
function updateOverallProgress() {
  if (!overallFill || !tasksContainer) return;

  const visible = [...tasksContainer.querySelectorAll('.task-item')].filter(
    (item) => item.style.display !== 'none'
  );
  if (visible.length === 0) return;

  const done = visible.filter((item) => item.classList.contains('completed')).length;

  // An in-progress task counts as a partial step, so the bar moves during a
  // long download instead of sitting still between whole tasks.
  const active = visible.find((item) => item.classList.contains('in-progress'));
  let partial = 0;
  if (active) {
    const fill = active.querySelector('.progress-fill');
    const pct = fill ? parseFloat(fill.style.width) : 0;
    partial = Number.isFinite(pct) ? pct / 100 : 0;
  }

  const ratio = Math.min((done + partial) / visible.length, 1);
  overallFill.style.width = `${Math.round(ratio * 100)}%`;
}

/**
 * Ask main to fit the window to the card.
 *
 * The card's height is not fixed: the SDE download row appears only when there
 * IS a download, and the action / error panels replace the task list with
 * something taller. A fixed window left a visible margin around the smaller
 * states, so the window follows the content instead.
 *
 * Measured off the CARD, not the body: the body is a full-height grid used to
 * centre the card, so `body.scrollHeight` always reports the viewport and the
 * window could only ever grow.
 *
 * Deferred to rAF because a class or display change made in the same tick has
 * not been laid out yet, and measuring first yields the PREVIOUS height.
 */
let fitPending = false;
function fitWindowToContent() {
  if (fitPending) return;
  fitPending = true;

  requestAnimationFrame(() => {
    fitPending = false;

    const card = document.querySelector('.splash-card');
    const api = window.electronAPI && window.electronAPI.startup;
    if (!card || !api || !api.fitToContent) return;

    // The card fills the window edge to edge - no container padding to add.
    const height = Math.ceil(card.getBoundingClientRect().height);
    api.fitToContent(height).catch(() => {
      /* the window is closing; nothing to fit */
    });
  });
}

/*
 * Watch the card and re-fit whenever its height changes.
 *
 * A ResizeObserver rather than a call at each mutation site: the card changes
 * shape from several places (a task row appearing, a panel swapping in, a
 * populated error path adding a log block, even a long status string wrapping),
 * and hooking each one by hand guarantees the one that gets missed is the one
 * that looks wrong. The observer catches all of them, including any added
 * later.
 *
 * Safe against feedback: main ignores a delta of <= 2px, so a resize triggered
 * by our own fit cannot start a loop.
 */
if (typeof ResizeObserver !== 'undefined') {
  const card = document.querySelector('.splash-card');
  if (card) {
    new ResizeObserver(() => fitWindowToContent()).observe(card);
  }
}

// The version is shown in the footer; failing to read it is not worth a
// visible error on a splash screen, so it simply stays blank.
if (versionLabel && window.electronAPI && window.electronAPI.app) {
  window.electronAPI.app
    .getVersion()
    .then((v) => { versionLabel.textContent = v ? `v${v}` : ''; })
    .catch(() => {});
}

// Listen for progress updates
window.electronAPI.startup.onProgress((progress) => {
  console.log('[Splash] Progress update:', progress);

  const { task, status, percentage, complete } = progress;

  // Update task UI
  updateTaskStatus(task, status, percentage, complete);

  // Update overall status
  if (status) {
    overallStatus.textContent = status;
  }
});

// Listen for action required
window.electronAPI.startup.onRequireAction((action) => {
  console.log('[Splash] Action required:', action);
  currentAction = action;
  showActionPanel(action);
});

// Listen for warnings
window.electronAPI.startup.onWarning((warning) => {
  console.log('[Splash] Warning:', warning);
  showWarningMessage(warning);
});

// Listen for errors
window.electronAPI.startup.onError((error) => {
  console.log('[Splash] Error:', error);
  showErrorPanel(error);
});

// Listen for completion
window.electronAPI.startup.onComplete(() => {
  console.log('[Splash] Startup complete!');
  overallStatus.textContent = 'Loading Quantum Forge...';
  // Window will close automatically
});

// Update task status in UI
function updateTaskStatus(task, status, percentage, complete) {
  const taskElement = document.querySelector(`[data-task="${task}"]`);
  if (!taskElement) {
    console.warn('[Splash] Task element not found:', task);
    return;
  }

  // Show the task if it was hidden (like sdeDownload)
  if (taskElement.style.display === 'none') {
    taskElement.style.display = 'flex';
  }

  // Update status text
  const statusEl = taskElement.querySelector('.task-status');
  if (statusEl && status) {
    statusEl.textContent = status;
  }

  // Update progress bar if percentage provided
  if (percentage !== undefined) {
    const progressContainer = taskElement.querySelector('.task-progress');
    const progressFill = taskElement.querySelector('.progress-fill');
    const progressText = taskElement.querySelector('.progress-text');

    // Show progress container if it exists
    if (progressContainer) {
      progressContainer.style.display = 'block';
    }

    if (progressFill) {
      progressFill.style.width = `${percentage}%`;
    }
    if (progressText) {
      progressText.textContent = `${Math.round(percentage)}%`;
    }
  }

  // Update task state classes
  taskElement.classList.remove('pending', 'in-progress', 'completed', 'error');

  if (complete === true) {
    taskElement.classList.add('completed');
  } else if (complete === false) {
    taskElement.classList.add('error');
  } else {
    taskElement.classList.add('in-progress');
  }

  updateOverallProgress();

  // A task row can appear (the SDE download) or change height, so re-fit.
  fitWindowToContent();
}

// Show action panel
function showActionPanel(action) {
  // Hide tasks and error panel
  tasksContainer.style.display = 'none';
  errorPanel.style.display = 'none';

  // Show action panel
  actionPanel.style.display = 'block';

  // Clear previous content
  actionButtons.innerHTML = '';
  actionDetails.innerHTML = '';

  // Configure based on action type
  switch (action.action) {
    case 'appUpdate':
      showAppUpdateAction(action.data);
      break;
    case 'sdeDownload':
      showSDEDownloadAction(action.data);
      break;
    case 'sdeCritical':
      showSDECriticalAction(action.data);
      break;
    case 'sdeOptional':
      showSDEOptionalAction(action.data);
      break;
    default:
      console.error('[Splash] Unknown action type:', action.action);
  }
}

// Show app update action
function showAppUpdateAction(data) {
  actionTitle.textContent = 'Application Update Available';
  actionMessage.textContent = 'A new version of Quantum Forge is available.';

  // Show version details
  actionDetails.innerHTML = `
    <div class="detail-row">
      <span class="detail-label">Current Version:</span>
      <span class="detail-value">${data.currentVersion || 'Unknown'}</span>
    </div>
    <div class="detail-row">
      <span class="detail-label">New Version:</span>
      <span class="detail-value highlight">${data.newVersion || 'Unknown'}</span>
    </div>
  `;

  // Add buttons
  const updateBtn = document.createElement('button');
  updateBtn.className = 'primary-button';
  updateBtn.innerHTML = `
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
      <polyline points="7 10 12 15 17 10"></polyline>
      <line x1="12" y1="15" x2="12" y2="3"></line>
    </svg>
    Update Now
  `;
  updateBtn.onclick = () => {
    console.log('[Splash] User chose to update app');
    window.electronAPI.startup.updateApp();
    hideActionPanel();
  };

  const laterBtn = document.createElement('button');
  laterBtn.className = 'secondary-button';
  laterBtn.textContent = 'Update Later';
  laterBtn.onclick = () => {
    console.log('[Splash] User chose to skip app update');
    window.electronAPI.startup.skipAppUpdate();
    hideActionPanel();
  };

  actionButtons.appendChild(updateBtn);
  actionButtons.appendChild(laterBtn);
}

// Show SDE download action (missing SDE)
function showSDEDownloadAction(data) {
  actionTitle.textContent = 'Static Data Export Required';
  actionMessage.textContent = 'The Eve Online Static Data Export is required for Quantum Forge to function properly. This is a one-time download.';

  // Show download details
  if (data.size) {
    actionDetails.innerHTML = `
      <div class="detail-row">
        <span class="detail-label">Download Size:</span>
        <span class="detail-value">${formatBytes(data.size)}</span>
      </div>
    `;
  }

  // Add download button (no skip option)
  const downloadBtn = document.createElement('button');
  downloadBtn.className = 'primary-button';
  downloadBtn.innerHTML = `
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
      <polyline points="7 10 12 15 17 10"></polyline>
      <line x1="12" y1="15" x2="12" y2="3"></line>
    </svg>
    Download SDE
  `;
  downloadBtn.onclick = () => {
    console.log('[Splash] User chose to download SDE');
    window.electronAPI.startup.downloadSDE();
    hideActionPanel();
  };

  actionButtons.appendChild(downloadBtn);
}

// Show critical SDE update action
function showSDECriticalAction(data) {
  actionTitle.textContent = 'Critical SDE Update Required';
  actionMessage.textContent = 'Your Static Data Export version is too old and must be updated to continue.';

  // Show version details
  actionDetails.innerHTML = `
    <div class="detail-row">
      <span class="detail-label">Current Version:</span>
      <span class="detail-value">${data.currentVersion || 'Unknown'}</span>
    </div>
    <div class="detail-row">
      <span class="detail-label">Required Version:</span>
      <span class="detail-value highlight">${data.latestVersion || 'Unknown'}</span>
    </div>
  `;

  // Add update button (no skip option)
  const updateBtn = document.createElement('button');
  updateBtn.className = 'primary-button';
  updateBtn.innerHTML = `
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
      <polyline points="7 10 12 15 17 10"></polyline>
      <line x1="12" y1="15" x2="12" y2="3"></line>
    </svg>
    Update Now
  `;
  updateBtn.onclick = () => {
    console.log('[Splash] User chose to update SDE (critical)');
    window.electronAPI.startup.downloadSDE();
    hideActionPanel();
  };

  actionButtons.appendChild(updateBtn);
}

// Show optional SDE update action
function showSDEOptionalAction(data) {
  actionTitle.textContent = 'SDE Update Available';
  actionMessage.textContent = 'A new version of the Eve Online Static Data Export is available.';

  // Show version details
  actionDetails.innerHTML = `
    <div class="detail-row">
      <span class="detail-label">Current Version:</span>
      <span class="detail-value">${data.currentVersion || 'Unknown'}</span>
    </div>
    <div class="detail-row">
      <span class="detail-label">New Version:</span>
      <span class="detail-value highlight">${data.latestVersion || 'Unknown'}</span>
    </div>
  `;

  // Add buttons
  const updateBtn = document.createElement('button');
  updateBtn.className = 'primary-button';
  updateBtn.innerHTML = `
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
      <polyline points="7 10 12 15 17 10"></polyline>
      <line x1="12" y1="15" x2="12" y2="3"></line>
    </svg>
    Update Now
  `;
  updateBtn.onclick = () => {
    console.log('[Splash] User chose to update SDE');
    window.electronAPI.startup.downloadSDE();
    hideActionPanel();
  };

  const laterBtn = document.createElement('button');
  laterBtn.className = 'secondary-button';
  laterBtn.textContent = 'Update Later';
  laterBtn.onclick = () => {
    console.log('[Splash] User chose to skip SDE update');
    window.electronAPI.startup.skipSDEUpdate();
    hideActionPanel();
  };

  actionButtons.appendChild(updateBtn);
  actionButtons.appendChild(laterBtn);
}

// Hide action panel and show tasks again
function hideActionPanel() {
  actionPanel.style.display = 'none';
  tasksContainer.style.display = 'flex';
  fitWindowToContent();
}

// Show error panel
async function showErrorPanel(error) {
  // Hide tasks and action panel
  tasksContainer.style.display = 'none';
  actionPanel.style.display = 'none';

  // Show error panel
  errorPanel.style.display = 'block';
  errorMessage.textContent = error.message || 'An error occurred during startup.';

  // Fetch and display log file path
  try {
    const logPath = await window.electronAPI.errorLog.getPath();
    const logPathElement = document.getElementById('error-log-path');
    if (logPathElement) {
      logPathElement.textContent = logPath;
    }

    // Show the log info section
    const logInfoSection = document.getElementById('error-log-info');
    if (logInfoSection) {
      logInfoSection.style.display = 'block';
    }
  } catch (err) {
    console.error('[Splash] Error fetching log path:', err);
  }

  // Update retry button
  const retryBtn = document.getElementById('retry-btn');
  if (retryBtn) {
    retryBtn.onclick = () => {
      console.log('[Splash] User chose to retry');
      window.electronAPI.startup.retry();
      hideErrorPanel();
    };
  }

  // Setup open log folder button
  const openLogBtn = document.getElementById('open-log-btn');
  if (openLogBtn) {
    openLogBtn.onclick = async () => {
      console.log('[Splash] User chose to open log folder');
      try {
        await window.electronAPI.errorLog.openFolder();
      } catch (err) {
        console.error('[Splash] Error opening log folder:', err);
      }
    };
  }
}

// Hide error panel
function hideErrorPanel() {
  errorPanel.style.display = 'none';
  tasksContainer.style.display = 'flex';
  fitWindowToContent();
}

// Utility: Format bytes to human readable
function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

// Show warning message for non-critical issues
function showWarningMessage(warning) {
  const taskElement = document.querySelector(`[data-task="${warning.task}"]`);
  if (!taskElement) {
    console.warn('[Splash] Task element not found for warning:', warning.task);
    return;
  }

  // Add warning indicator to task element (triggers CSS styling)
  taskElement.classList.add('warning');

  // Update status text with warning
  const statusEl = taskElement.querySelector('.task-status');
  if (statusEl) {
    // If character name provided, include it in the message
    if (warning.character) {
      statusEl.textContent = `${warning.character}: ${warning.message}`;
    } else {
      statusEl.textContent = warning.message;
    }
  }

  console.log('[Splash] Warning displayed:', warning);
}
