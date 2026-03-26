/**
 * preflop-chart.js -- Preflop starting hand chart data and rendering.
 *
 * Owns the TAG range data, 13x13 grid rendering, cell updates, and
 * click handling. All rendering functions accept container elements as
 * parameters so they can be used in any context (popup, inline, etc.).
 *
 * Exports: getHandStrength, STRENGTH_LABELS, renderGrid,
 * updateCellsForPosition, attachGridClickHandler, handNameForCell,
 * fullHandNameForCell.
 *
 * @module preflop-chart
 */

import { RANK_NAMES, RANK_FULL_NAMES } from './poker-core.js';

// ── Grid layout ──────────────────────────────────────────────────────
//
// The standard 13x13 preflop chart layout:
//   - Rows and columns indexed by rank, Ace (12) down to Two (0)
//   - Diagonal: pocket pairs (AA, KK, ..., 22)
//   - Above diagonal (col > row): suited hands (higher rank first)
//   - Below diagonal (row > col): offsuit hands (higher rank first)
//
// We iterate row 0..12 (top to bottom) = Ace..Two for the row rank,
// and col 0..12 (left to right) = Ace..Two for the column rank.

/** @type {number} The grid dimension */
const GRID_SIZE = 13;

/**
 * Map row/col to the abbreviated hand name.
 * Row and col are 0-indexed from top-left, where index 0 = Ace, 12 = Two.
 *
 * @param {number} row - 0 (Ace) to 12 (Two)
 * @param {number} col - 0 (Ace) to 12 (Two)
 * @returns {string} E.g. "AA", "AKs", "AKo"
 */
export function handNameForCell(row, col) {
  // Rank indices in RANK_NAMES (0=2, 12=A), so we reverse for grid display
  const rowRank = 12 - row;
  const colRank = 12 - col;

  const highChar = RANK_NAMES[Math.max(rowRank, colRank)];
  const lowChar = RANK_NAMES[Math.min(rowRank, colRank)];

  if (row === col) {
    // Diagonal: pocket pair
    return highChar + lowChar;
  } else if (col > row) {
    // Above diagonal: suited (row rank > col rank in display terms)
    return highChar + lowChar + 's';
  } else {
    // Below diagonal: offsuit
    return highChar + lowChar + 'o';
  }
}

/**
 * Get the full human-readable hand name for a grid cell.
 *
 * @param {number} row
 * @param {number} col
 * @returns {string} E.g. "Pocket Aces", "Ace-King suited", "Queen-Jack offsuit"
 */
export function fullHandNameForCell(row, col) {
  const rowRank = 12 - row;
  const colRank = 12 - col;

  const highRank = Math.max(rowRank, colRank);
  const lowRank = Math.min(rowRank, colRank);

  if (row === col) {
    return `Pocket ${RANK_FULL_NAMES[highRank]}s`;
  } else if (col > row) {
    return `${RANK_FULL_NAMES[highRank]}-${RANK_FULL_NAMES[lowRank]} suited`;
  } else {
    return `${RANK_FULL_NAMES[highRank]}-${RANK_FULL_NAMES[lowRank]} offsuit`;
  }
}

// ── TAG range data ───────────────────────────────────────────────────
//
// Simplified tight-aggressive (TAG) ranges for each position.
// Each position maps a set of hand abbreviations to a strength category.
//
// Strength categories:
//   "premium"  -- Always raise/re-raise (AA, KK, QQ, AKs, etc.)
//   "strong"   -- Raise from most positions
//   "playable" -- Open/call from wider positions
//   "marginal" -- Only in late position or blinds
//   "fold"     -- Default: not listed means fold
//
// These ranges are beginner-friendly approximations, NOT GTO solutions.
// They are intentionally conservative (tight).

/** @typedef {'premium'|'strong'|'playable'|'marginal'|'fold'} StrengthCategory */

/**
 * Master range data. For the "all" filter we show inherent hand strength
 * (strongest category across all positions). For position filters we
 * show whether the hand is playable at that position.
 *
 * Structure: each position has a Map<handAbbrev, StrengthCategory>.
 * "all" uses the best category for each hand across all positions.
 *
 * @type {Record<string, Map<string, StrengthCategory>>}
 */
const POSITION_RANGES = buildPositionRanges();

/**
 * Build the position range maps from compact string definitions.
 * This keeps the data readable and minimizes repetition.
 *
 * @returns {Record<string, Map<string, StrengthCategory>>}
 */
function buildPositionRanges() {
  // Compact range definitions per position.
  // Each category is a space-separated list of hand abbreviations.

  /** @type {Record<string, Record<StrengthCategory, string>>} */
  const rawRanges = {
    early: {
      premium:  'AA KK QQ AKs',
      strong:   'JJ TT AKo AQs',
      playable: '99 AJs AQo KQs',
      marginal: '88 ATs KJs QJs',
      fold:     '',
    },
    middle: {
      premium:  'AA KK QQ AKs',
      strong:   'JJ TT AKo AQs AJs',
      playable: '99 88 AQo ATs KQs KJs QJs',
      marginal: '77 A9s KTs QTs JTs T9s',
      fold:     '',
    },
    late: {
      premium:  'AA KK QQ AKs',
      strong:   'JJ TT AKo AQs AJs ATs',
      playable: '99 88 77 AQo AJo KQs KJs KTs QJs QTs JTs',
      marginal: '66 55 A9s A8s A7s A6s A5s A4s A3s A2s KQo KJo QJo T9s 98s 87s 76s 65s',
      fold:     '',
    },
    blinds: {
      premium:  'AA KK QQ AKs',
      strong:   'JJ TT AKo AQs AJs',
      playable: '99 88 AQo ATs KQs KJs QJs JTs',
      marginal: '77 66 A9s A8s KTs QTs T9s 98s 87s',
      fold:     '',
    },
  };

  /** @type {Record<string, Map<string, StrengthCategory>>} */
  const result = {};

  // Build per-position maps
  for (const [position, categories] of Object.entries(rawRanges)) {
    const map = new Map();
    for (const [category, hands] of Object.entries(categories)) {
      if (!hands) continue;
      for (const hand of hands.split(/\s+/)) {
        if (hand) {
          map.set(hand, /** @type {StrengthCategory} */ (category));
        }
      }
    }
    result[position] = map;
  }

  // Build the "all" map: take the best (strongest) category across positions
  const strengthOrder = ['premium', 'strong', 'playable', 'marginal'];
  const allMap = new Map();

  for (const posMap of Object.values(result)) {
    for (const [hand, category] of posMap) {
      const existing = allMap.get(hand);
      if (!existing || strengthOrder.indexOf(category) < strengthOrder.indexOf(existing)) {
        allMap.set(hand, category);
      }
    }
  }

  result['all'] = allMap;

  return result;
}

/**
 * Look up the strength category of a hand for a given position.
 *
 * @param {string} handAbbrev - E.g. "AKs", "TT", "72o"
 * @param {string} position - One of "all", "early", "middle", "late", "blinds"
 * @returns {StrengthCategory}
 */
export function getHandStrength(handAbbrev, position) {
  const rangeMap = POSITION_RANGES[position];
  if (!rangeMap) return 'fold';
  return rangeMap.get(handAbbrev) || 'fold';
}

// ── Non-color text indicators ────────────────────────────────────────
// These match the CSS custom properties but are used in DOM text content
// so they work independently of CSS.

/** @type {Record<StrengthCategory, string>} */
const STRENGTH_INDICATORS = {
  premium:  '\u2605\u2605', // two filled stars
  strong:   '\u2605',       // one filled star
  playable: '\u25CF',       // filled circle
  marginal: '\u25CB',       // open circle
  fold:     '',
};

/** @type {Record<StrengthCategory, string>} */
export const STRENGTH_LABELS = {
  premium:  'Premium',
  strong:   'Strong',
  playable: 'Playable',
  marginal: 'Marginal',
  fold:     'Fold',
};

// ── DOM rendering ────────────────────────────────────────────────────

/**
 * Create a single grid cell (button element) for the given row/col.
 *
 * @param {number} row
 * @param {number} col
 * @param {string} position - Current position filter
 * @returns {HTMLButtonElement}
 */
function createGridCell(row, col, position) {
  const abbrev = handNameForCell(row, col);
  const strength = getHandStrength(abbrev, position);

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'grid-cell';
  button.dataset.row = String(row);
  button.dataset.col = String(col);
  button.dataset.hand = abbrev;
  button.dataset.strength = strength;
  button.setAttribute('role', 'gridcell');
  button.setAttribute(
    'aria-label',
    `${fullHandNameForCell(row, col)} - ${STRENGTH_LABELS[strength]}`
  );

  // Hand name text
  const nameSpan = document.createElement('span');
  nameSpan.className = 'grid-cell__name';
  nameSpan.textContent = abbrev;
  button.appendChild(nameSpan);

  // Non-color indicator text (accessibility: color is not the only signal)
  const indicator = STRENGTH_INDICATORS[strength];
  if (indicator) {
    const indicatorSpan = document.createElement('span');
    indicatorSpan.className = 'grid-cell__indicator';
    indicatorSpan.textContent = indicator;
    indicatorSpan.setAttribute('aria-hidden', 'true');
    button.appendChild(indicatorSpan);
  }

  // Apply strength class for background color
  button.classList.add(`grid-cell--${strength}`);

  return button;
}

/**
 * Populate the grid container with 169 button cells wrapped in role="row" divs.
 * ARIA grid spec requires gridcell elements to be owned by role="row" elements.
 * Creates cells once; subsequent position changes only update classes.
 *
 * Works with any container element -- not tied to a specific DOM location.
 *
 * @param {HTMLElement} gridContainer - Any element to render the grid into
 * @param {string} [position='all'] - Initial position filter
 * @returns {HTMLButtonElement[]} Flat array of all 169 cells, row-major order
 */
export function renderGrid(gridContainer, position) {
  const pos = position || 'all';
  const cells = [];

  for (let row = 0; row < GRID_SIZE; row++) {
    const rowDiv = document.createElement('div');
    rowDiv.setAttribute('role', 'row');
    // Row divs use display:contents so CSS Grid on the parent still controls layout
    rowDiv.style.display = 'contents';

    for (let col = 0; col < GRID_SIZE; col++) {
      const cell = createGridCell(row, col, pos);
      rowDiv.appendChild(cell);
      cells.push(cell);
    }

    gridContainer.appendChild(rowDiv);
  }

  return cells;
}

/**
 * Update all cells' strength classes and indicators for a new position.
 * This avoids destroying/recreating DOM nodes on filter change, which
 * would cause flicker on low-end devices.
 *
 * @param {HTMLButtonElement[]} cells - All 169 grid cells
 * @param {string} position - New position filter
 */
export function updateCellsForPosition(cells, position) {
  const strengthClasses = [
    'grid-cell--premium',
    'grid-cell--strong',
    'grid-cell--playable',
    'grid-cell--marginal',
    'grid-cell--fold',
    'grid-cell--dimmed',
  ];

  for (const cell of cells) {
    const abbrev = cell.dataset.hand;
    if (!abbrev) continue;

    const strength = getHandStrength(abbrev, position);
    cell.dataset.strength = strength;

    // Remove all strength classes at once, then add the correct one
    cell.classList.remove(...strengthClasses);
    cell.classList.add(`grid-cell--${strength}`);

    // Dim hands that are "fold" for non-"all" positions to visually separate
    // playable from non-playable
    if (position !== 'all' && strength === 'fold') {
      cell.classList.add('grid-cell--dimmed');
    }

    // Update the indicator text
    const indicatorSpan = cell.querySelector('.grid-cell__indicator');
    const indicator = STRENGTH_INDICATORS[strength];
    if (indicatorSpan) {
      indicatorSpan.textContent = indicator;
    } else if (indicator) {
      // Create indicator span if it didn't exist (e.g., was fold before)
      const newIndicator = document.createElement('span');
      newIndicator.className = 'grid-cell__indicator';
      newIndicator.textContent = indicator;
      newIndicator.setAttribute('aria-hidden', 'true');
      cell.appendChild(newIndicator);
    }

    // Update aria-label to reflect new strength
    const row = Number(cell.dataset.row);
    const col = Number(cell.dataset.col);
    cell.setAttribute(
      'aria-label',
      `${fullHandNameForCell(row, col)} - ${STRENGTH_LABELS[strength]}`
    );
  }
}

/**
 * Attach event delegation to the grid container for cell tap/click.
 * Shows the full hand name and recommendation in the hand-detail area.
 *
 * Works with any grid/detail container pair -- not tied to a specific DOM location.
 *
 * @param {HTMLElement} gridContainer - The element containing grid cells
 * @param {HTMLElement} detailContainer - The element containing .hand-detail__text
 * @param {HTMLButtonElement[]} cells - All 169 grid cells
 */
export function attachGridClickHandler(gridContainer, detailContainer, cells) {
  const detailText = detailContainer.querySelector('.hand-detail__text');
  if (!detailText) return;

  let selectedCell = /** @type {HTMLButtonElement|null} */ (null);

  gridContainer.addEventListener('click', (event) => {
    const target = /** @type {HTMLElement} */ (event.target);
    const cell = /** @type {HTMLButtonElement|null} */ (
      target.closest('.grid-cell')
    );
    if (!cell) return;

    // Remove selection from previously selected cell
    if (selectedCell) {
      selectedCell.classList.remove('grid-cell--selected');
    }

    // Select the new cell
    cell.classList.add('grid-cell--selected');
    selectedCell = cell;

    const row = Number(cell.dataset.row);
    const col = Number(cell.dataset.col);
    const abbrev = cell.dataset.hand || '';
    const strength = cell.dataset.strength || 'fold';
    const fullName = fullHandNameForCell(row, col);

    // Describe the hand type (pair, suited, offsuit)
    let handType = '';
    if (row === col) {
      handType = 'Pocket pair';
    } else if (col > row) {
      handType = 'Suited';
    } else {
      handType = 'Offsuit';
    }

    const strengthLabel = STRENGTH_LABELS[/** @type {StrengthCategory} */ (strength)];

    detailText.textContent =
      `${fullName} (${abbrev}) -- ${handType} -- ${strengthLabel}`;
  });
}
