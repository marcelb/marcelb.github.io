/**
 * app.js -- Application entry point and position state manager.
 *
 * Imports postflop-advisor and calls init() on it. Manages the top-level
 * position selector buttons (single source of truth for position state).
 * Handles info-text toggle delegation on <main>. Wires up the "Preflop
 * Table" popup button and Clear All position reset.
 *
 * @module app
 */

import { init as initPostflopAdvisor, onPositionChanged, onOpponentCountChanged, openPreflopPopup } from './postflop-advisor.js';

// ---------------------------------------------------------------------------
// Position state -- single source of truth
// ---------------------------------------------------------------------------

/** @type {string} Current table position. One of "early", "middle", "late", "blinds". */
let currentPosition = 'blinds';

/** @type {number} Current opponent count from the main-page dropdown (1-9). */
let currentOpponentCount = 1;

// ---------------------------------------------------------------------------
// Tool module initialization
// ---------------------------------------------------------------------------

/**
 * Initialize the postflop-advisor module by calling init() with its
 * container element from the DOM.
 */
function initializeToolModules() {
  const container = document.querySelector('.postflop-advisor');
  if (!container) {
    console.warn(
      'app.js: Container ".postflop-advisor" not found. ' +
      'The advisor will not be initialized.'
    );
    return;
  }
  try {
    initPostflopAdvisor(/** @type {HTMLElement} */ (container));
  } catch (err) {
    console.error('app.js: Failed to initialize postflop-advisor:', err);
  }
}

// ---------------------------------------------------------------------------
// Position selector
// ---------------------------------------------------------------------------

/**
 * Initialize position filter buttons. Queries the .position-filters
 * group, attaches click handlers that update currentPosition, toggle
 * the active class, and notify postflop-advisor of the change.
 */
function initializePositionSelector() {
  const filtersContainer = document.querySelector('.position-filters');
  if (!filtersContainer) {
    console.warn('app.js: .position-filters element not found. Position selector not initialized.');
    return;
  }

  filtersContainer.addEventListener('click', (event) => {
    const target = /** @type {HTMLElement} */ (event.target);
    const button = /** @type {HTMLButtonElement|null} */ (
      target.closest('.position-button')
    );
    if (!button) return;

    const position = button.dataset.position;
    if (!position) return;

    // Update active button styling and aria-pressed
    const allButtons = filtersContainer.querySelectorAll('.position-button');
    for (const btn of allButtons) {
      btn.classList.remove('position-button--active');
      btn.setAttribute('aria-pressed', 'false');
    }
    button.classList.add('position-button--active');
    button.setAttribute('aria-pressed', 'true');

    // Update state and broadcast to postflop-advisor
    currentPosition = position;
    onPositionChanged(position);
  });
}

/**
 * Reset the position selector to "Blinds" (default). Updates state,
 * active button styling, and notifies postflop-advisor. Called when
 * Clear All is clicked.
 */
function resetPositionToBlinds() {
  currentPosition = 'blinds';

  const filtersContainer = document.querySelector('.position-filters');
  if (filtersContainer) {
    const allButtons = filtersContainer.querySelectorAll('.position-button');
    for (const btn of allButtons) {
      btn.classList.remove('position-button--active');
      btn.setAttribute('aria-pressed', 'false');
      if (/** @type {HTMLElement} */ (btn).dataset.position === 'blinds') {
        btn.classList.add('position-button--active');
        btn.setAttribute('aria-pressed', 'true');
      }
    }
  }

  // Notify postflop-advisor of the reset
  onPositionChanged('blinds');
}

// ---------------------------------------------------------------------------
// Clear All -- position reset listener
// ---------------------------------------------------------------------------

/**
 * Attach a click listener on the Clear All button that resets the
 * position selector to "All". This is independent of postflop-advisor's
 * own Clear All handler (which clears cards/state). Both listeners
 * coexist on the same button.
 */
function attachClearAllPositionReset() {
  const clearBtn = document.querySelector('.clear-button');
  if (!clearBtn) {
    console.warn('app.js: .clear-button not found. Clear All position reset not attached.');
    return;
  }

  // Position is intentionally NOT reset by Clear All

}

// ---------------------------------------------------------------------------
// Opponent count selector
// ---------------------------------------------------------------------------

/**
 * Initialize the opponent-count dropdown. Queries #opponent-count-select
 * from the DOM (placed in .position-filters by index.html), attaches a
 * change listener, and notifies postflop-advisor of the initial value.
 */
function initializeOpponentSelector() {
  const selectEl = /** @type {HTMLSelectElement|null} */ (
    document.querySelector('#opponent-count-select')
  );
  if (!selectEl) {
    console.warn('app.js: #opponent-count-select not found. Opponent selector not initialized.');
    return;
  }

  selectEl.addEventListener('change', () => {
    const count = parseInt(selectEl.value, 10);
    if (Number.isFinite(count) && count >= 1) {
      currentOpponentCount = count;
      onOpponentCountChanged(count);
    }
  });

  // Sync initial value (HTML default is 1)
  currentOpponentCount = parseInt(selectEl.value, 10) || 1;
}

// ---------------------------------------------------------------------------
// Preflop Table popup button
// ---------------------------------------------------------------------------

/**
 * Attach a click listener on the "Preflop Table" button that opens the
 * preflop popup with the current position. The popup rendering is
 * implemented by dev2 in postflop-advisor.js (Wave 2).
 */
function attachPreflopPopupButton() {
  const preflopBtn = document.querySelector('.preflop-table-btn');
  if (!preflopBtn) {
    console.warn('app.js: .preflop-table-btn not found. Preflop popup button not wired.');
    return;
  }

  preflopBtn.addEventListener('click', () => {
    openPreflopPopup(currentPosition, currentOpponentCount);
  });
}

// ---------------------------------------------------------------------------
// Info-text toggle
// ---------------------------------------------------------------------------

/**
 * Handle a click on an `.info-toggle` button. Toggles aria-expanded
 * and switches display between none and block on the associated
 * info-content element.
 *
 * Info-content elements start with inline style `display: none` set by
 * the module that builds them (e.g. postflop-advisor.js), so we toggle
 * the inline style directly rather than using a CSS class.
 *
 * @param {HTMLButtonElement} toggleButton - The info toggle that was clicked
 */
function toggleInfoText(toggleButton) {
  const expanded = toggleButton.getAttribute('aria-expanded') === 'true';
  toggleButton.setAttribute('aria-expanded', String(!expanded));

  const contentId = toggleButton.getAttribute('aria-controls');
  if (!contentId) {
    console.warn('app.js: Info toggle missing aria-controls attribute.', toggleButton);
    return;
  }

  const content = document.getElementById(contentId);
  if (!content) {
    console.warn(`app.js: No element found with id "${contentId}".`);
    return;
  }

  // Toggle between hidden and visible. The info-content starts with
  // style.display = 'none' set inline by the module that creates it.
  content.style.display = expanded ? 'none' : 'block';
}

/**
 * Attach a single delegated click listener on <main> that handles
 * info-text collapse/expand. Using delegation means we do not need to
 * attach listeners to each individual button, and dynamically-added
 * info-toggles (e.g. from postflop-advisor.js) are handled automatically.
 */
function attachInfoTextListeners() {
  const mainContent = document.querySelector('.main-content');
  if (!mainContent) {
    console.warn('app.js: .main-content element not found. Info-text listeners not attached.');
    return;
  }

  mainContent.addEventListener('click', (event) => {
    const target = /** @type {HTMLElement} */ (event.target);

    const infoToggle = target.closest('.info-toggle');
    if (infoToggle) {
      toggleInfoText(/** @type {HTMLButtonElement} */ (infoToggle));
    }
  });
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

/**
 * Application bootstrap. Called once when the module loads (after DOM is
 * ready, since the script tag is at the end of <body>).
 */
function main() {
  initializeToolModules();
  attachInfoTextListeners();
  initializePositionSelector();
  initializeOpponentSelector();
  attachClearAllPositionReset();
  attachPreflopPopupButton();
}

main();
