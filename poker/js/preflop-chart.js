/**
 * preflop-chart.js -- Preflop starting hand chart data and rendering.
 *
 * Owns the TAG range data, 13x13 grid rendering, cell updates, and
 * click handling. All rendering functions accept container elements as
 * parameters so they can be used in any context (popup, inline, etc.).
 *
 * Exports: getHandStrength, getAdjustedStrength, STRENGTH_LABELS,
 * renderGrid, updateCellsForPosition, attachGridClickHandler,
 * handNameForCell, fullHandNameForCell, isSuitedConnector,
 * isPocketPair, isOffsuitBroadway.
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

// ── Strength categories and master ranking ──────────────────────────
//
// Every hand has a numeric rank (1=best, 169=worst). Category boundaries
// slide based on position and opponent count. No hand is ever "unlisted."
//
// Strength categories:
//   "premium"  -- Always raise/re-raise (AA, KK, QQ, AKs, etc.)
//   "strong"   -- Raise from most positions
//   "playable" -- Open/call from wider positions
//   "marginal" -- Only in late position or blinds
//   "fold"     -- Rank exceeds the marginal cutoff

/** @typedef {'premium'|'strong'|'playable'|'marginal'|'fold'} StrengthCategory */

/**
 * Master ranking of all 169 starting hands, ordered by equity/playability.
 * Rank 1 = strongest (AA), rank 169 = weakest (72o).
 * Derived from full-ring equity analysis, cross-referenced across multiple sources.
 *
 * @type {Map<string, number>}
 */
const HAND_RANKINGS = new Map([
  ['AA',   1], ['KK',   2], ['QQ',   3], ['AKs',  4], ['JJ',   5],
  ['AQs',  6], ['KQs',  7], ['AJs',  8], ['KJs',  9], ['TT',  10],
  ['AKo', 11], ['ATs', 12], ['QJs', 13], ['KTs', 14], ['QTs', 15],
  ['JTs', 16], ['99',  17], ['AQo', 18], ['A9s', 19], ['KQo', 20],
  ['88',  21], ['K9s', 22], ['T9s', 23], ['A8s', 24], ['Q9s', 25],
  ['J9s', 26], ['AJo', 27], ['A5s', 28], ['77',  29], ['A7s', 30],
  ['KJo', 31], ['A4s', 32], ['A3s', 33], ['A6s', 34], ['QJo', 35],
  ['66',  36], ['K8s', 37], ['T8s', 38], ['A2s', 39], ['98s', 40],
  ['J8s', 41], ['ATo', 42], ['Q8s', 43], ['K7s', 44], ['KTo', 45],
  ['55',  46], ['JTo', 47], ['87s', 48], ['QTo', 49], ['44',  50],
  ['33',  51], ['22',  52], ['K6s', 53], ['97s', 54], ['K5s', 55],
  ['76s', 56], ['T7s', 57], ['K4s', 58], ['K3s', 59], ['K2s', 60],
  ['Q7s', 61], ['86s', 62], ['65s', 63], ['J7s', 64], ['54s', 65],
  ['Q6s', 66], ['75s', 67], ['96s', 68], ['Q5s', 69], ['64s', 70],
  ['Q4s', 71], ['Q3s', 72], ['T9o', 73], ['T6s', 74], ['Q2s', 75],
  ['A9o', 76], ['53s', 77], ['85s', 78], ['J6s', 79], ['J9o', 80],
  ['K9o', 81], ['J5s', 82], ['Q9o', 83], ['43s', 84], ['74s', 85],
  ['J4s', 86], ['J3s', 87], ['95s', 88], ['J2s', 89], ['63s', 90],
  ['A8o', 91], ['52s', 92], ['T5s', 93], ['84s', 94], ['T4s', 95],
  ['T3s', 96], ['42s', 97], ['T2s', 98], ['98o', 99], ['T8o',100],
  ['A5o',101], ['A7o',102], ['73s',103], ['A4o',104], ['32s',105],
  ['94s',106], ['93s',107], ['J8o',108], ['A3o',109], ['62s',110],
  ['92s',111], ['K8o',112], ['A6o',113], ['87o',114], ['Q8o',115],
  ['83s',116], ['A2o',117], ['82s',118], ['97o',119], ['72s',120],
  ['76o',121], ['K7o',122], ['65o',123], ['T7o',124], ['K6o',125],
  ['86o',126], ['54o',127], ['K5o',128], ['J7o',129], ['75o',130],
  ['Q7o',131], ['K4o',132], ['K3o',133], ['96o',134], ['K2o',135],
  ['64o',136], ['Q6o',137], ['53o',138], ['85o',139], ['T6o',140],
  ['Q5o',141], ['43o',142], ['Q4o',143], ['Q3o',144], ['74o',145],
  ['Q2o',146], ['J6o',147], ['63o',148], ['J5o',149], ['95o',150],
  ['52o',151], ['J4o',152], ['J3o',153], ['42o',154], ['J2o',155],
  ['84o',156], ['T5o',157], ['T4o',158], ['32o',159], ['T3o',160],
  ['73o',161], ['T2o',162], ['62o',163], ['94o',164], ['93o',165],
  ['92o',166], ['83o',167], ['82o',168], ['72o',169],
]);

/**
 * Category cutoff thresholds indexed by [position][opponentCount].
 * Each entry is [P, S, L, M] where:
 *   ranks 1..P    = premium
 *   ranks P+1..S  = strong
 *   ranks S+1..L  = playable
 *   ranks L+1..M  = marginal
 *   ranks M+1..169 = fold
 *
 * @type {Record<string, Record<number, [number, number, number, number]>>}
 */
const CATEGORY_CUTOFFS = {
  // Position merging by opponent count (fewer opponents = fewer distinct seats):
  //   1 opp:  all positions identical (heads-up, position irrelevant)
  //   2 opp:  early=middle=late (just "BTN" vs blinds)
  //   3 opp:  early=middle (UTG/Middle merge), late and blinds separate
  //   4 opp:  all 4 positions distinct (BTN=Cutoff already same as "late")
  //   5+ opp: all 4 positions distinct (full table)
  early: {
    1: [10, 24, 56,130],  // = all positions (heads-up)
    2: [ 9, 22, 48,100],  // = late (just BTN vs blinds)
    3: [ 5, 12, 20, 32],  // = middle (UTG/Middle merge)
    4: [ 4,  8, 12, 16],
    5: [ 4,  7, 11, 15],
    6: [ 4,  6, 10, 14],
    7: [ 4,  6,  9, 13],
    8: [ 4,  5,  9, 12],
    9: [ 4,  5,  8, 11],
  },
  middle: {
    1: [10, 24, 56,130],  // = all positions (heads-up)
    2: [ 9, 22, 48,100],  // = late (just BTN vs blinds)
    3: [ 5, 12, 20, 32],  // UTG/Middle merged
    4: [ 5, 10, 16, 23],
    5: [ 5,  9, 15, 21],
    6: [ 4,  8, 14, 20],
    7: [ 4,  7, 12, 18],
    8: [ 4,  7, 11, 16],
    9: [ 4,  6, 10, 15],
  },
  late: {
    1: [10, 24, 56,130],  // = all positions (heads-up)
    2: [ 9, 22, 48,100],  // BTN group (early=middle=late)
    3: [ 7, 16, 32, 52],
    4: [ 6, 12, 24, 40],
    5: [ 6, 11, 22, 38],
    6: [ 5, 10, 20, 36],
    7: [ 5,  9, 18, 34],
    8: [ 4,  8, 16, 30],
    9: [ 4,  7, 14, 26],
  },
  blinds: {
    1: [10, 24, 56,130],  // = all positions (heads-up)
    2: [ 7, 18, 38, 74],  // blinds stays separate at 2 opp
    3: [ 5, 12, 22, 36],
    4: [ 5, 10, 18, 26],
    5: [ 5,  9, 16, 24],
    6: [ 4,  8, 14, 22],
    7: [ 4,  7, 13, 20],
    8: [ 4,  7, 12, 18],
    9: [ 4,  6, 11, 16],
  },
};

// Ordered from strongest to weakest for "all" position comparison
const STRENGTH_ORDER = ['premium', 'strong', 'playable', 'marginal', 'fold'];

/**
 * Compare a hand's rank against four cutoff thresholds and return the category.
 *
 * @param {number} rank - The hand's rank (1-169)
 * @param {[number, number, number, number]} cutoffs - [P, S, L, M] thresholds
 * @returns {StrengthCategory}
 */
function rankToCategory(rank, cutoffs) {
  const [P, S, L, M] = cutoffs;
  if (rank <= P) return 'premium';
  if (rank <= S) return 'strong';
  if (rank <= L) return 'playable';
  if (rank <= M) return 'marginal';
  return 'fold';
}

/**
 * Look up the strength category of a hand for a given position.
 * Uses the base cutoffs (opponent count = 4).
 * For "all" position: returns the strongest category across all four positions.
 *
 * @param {string} handAbbrev - E.g. "AKs", "TT", "72o"
 * @param {string} position - One of "all", "early", "middle", "late", "blinds"
 * @returns {StrengthCategory}
 */
export function getHandStrength(handAbbrev, position) {
  const rank = HAND_RANKINGS.get(handAbbrev);
  if (rank === undefined) return 'fold';

  // "all" position: strongest category across all four positions at base cutoffs (opp=4)
  if (position === 'all') {
    let best = /** @type {StrengthCategory} */ ('fold');
    for (const pos of ['early', 'middle', 'late', 'blinds']) {
      const cat = rankToCategory(rank, CATEGORY_CUTOFFS[pos][4]);
      if (STRENGTH_ORDER.indexOf(cat) < STRENGTH_ORDER.indexOf(best)) {
        best = cat;
      }
    }
    return best;
  }

  const positionCutoffs = CATEGORY_CUTOFFS[position];
  if (!positionCutoffs) return 'fold';

  return rankToCategory(rank, positionCutoffs[4]);
}

// ── Hand-type classification ────────────────────────────────────────
//
// Pure predicates exported for backward compatibility. No longer called
// by internal algorithm logic (the ranking/cutoff system replaces the
// shift-resistance rules), but kept as public API.

/**
 * Returns true if the hand is a suited connector (adjacent ranks with 's' suffix).
 * Adjacent means a rank-index gap of exactly 1. Ace is high-only for this check,
 * so A2s is NOT a connector and AKs IS (gap = 12 - 11 = 1).
 *
 * @param {string} handAbbrev - E.g. "T9s", "87s", "AKs", "A2s"
 * @returns {boolean}
 */
export function isSuitedConnector(handAbbrev) {
  if (!handAbbrev || handAbbrev.length !== 3 || handAbbrev[2] !== 's') {
    return false;
  }
  const highIdx = RANK_NAMES.indexOf(handAbbrev[0]);
  const lowIdx = RANK_NAMES.indexOf(handAbbrev[1]);
  if (highIdx === -1 || lowIdx === -1) return false;
  return Math.abs(highIdx - lowIdx) === 1;
}

/**
 * Returns true if the hand is a pocket pair (two identical rank chars, no suffix).
 *
 * @param {string} handAbbrev - E.g. "AA", "55", "22"
 * @returns {boolean}
 */
export function isPocketPair(handAbbrev) {
  return (
    !!handAbbrev &&
    handAbbrev.length === 2 &&
    handAbbrev[0] === handAbbrev[1] &&
    RANK_NAMES.indexOf(handAbbrev[0]) !== -1
  );
}

/**
 * Returns true if the hand is an offsuit broadway (both ranks >= T, 'o' suffix).
 * Broadway ranks: T (index 8), J (9), Q (10), K (11), A (12).
 *
 * @param {string} handAbbrev - E.g. "AKo", "KJo", "QTo"
 * @returns {boolean}
 */
export function isOffsuitBroadway(handAbbrev) {
  if (!handAbbrev || handAbbrev.length !== 3 || handAbbrev[2] !== 'o') {
    return false;
  }
  const highIdx = RANK_NAMES.indexOf(handAbbrev[0]);
  const lowIdx = RANK_NAMES.indexOf(handAbbrev[1]);
  if (highIdx === -1 || lowIdx === -1) return false;
  // Broadway threshold: rank index >= 8 (Ten or higher)
  return highIdx >= 8 && lowIdx >= 8;
}

// ── Opponent-count adjusted lookup ──────────────────────────────────

/**
 * Return the opponent-count-adjusted strength category for a hand.
 *
 * Looks up the hand's rank from HAND_RANKINGS, then resolves the category
 * using the cutoff thresholds for the given (position, opponentCount) pair.
 * Two lookups and four comparisons -- no chain walking or fallback passes.
 *
 * The "all" position bypasses opponent adjustment and returns the raw
 * best-across-positions lookup (strongest category at base cutoffs).
 *
 * @param {string} handAbbrev - E.g. "AKs", "T9s", "KJo"
 * @param {string} position - One of "all", "early", "middle", "late", "blinds"
 * @param {number} opponentCount - Number of opponents (1-9)
 * @returns {StrengthCategory}
 */
export function getAdjustedStrength(handAbbrev, position, opponentCount) {
  // "all" position: best-across-positions at base cutoffs, no opponent adjustment
  if (position === 'all') return getHandStrength(handAbbrev, 'all');

  const rank = HAND_RANKINGS.get(handAbbrev);
  if (rank === undefined) return 'fold';

  const positionCutoffs = CATEGORY_CUTOFFS[position];
  if (!positionCutoffs) return 'fold';

  // Clamp opponent count to valid range
  const opp = Math.max(1, Math.min(9, Math.round(opponentCount || 1)));

  return rankToCategory(rank, positionCutoffs[opp]);
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
 * @param {number} [opponentCount] - When provided and > 0, uses adjusted strength
 * @returns {HTMLButtonElement}
 */
function createGridCell(row, col, position, opponentCount) {
  const abbrev = handNameForCell(row, col);
  const strength = opponentCount
    ? getAdjustedStrength(abbrev, position, opponentCount)
    : getHandStrength(abbrev, position);

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
 * @param {number} [opponentCount] - When provided and > 0, uses adjusted strength
 * @returns {HTMLButtonElement[]} Flat array of all 169 cells, row-major order
 */
export function renderGrid(gridContainer, position, opponentCount) {
  const pos = position || 'all';
  const cells = [];

  for (let row = 0; row < GRID_SIZE; row++) {
    const rowDiv = document.createElement('div');
    rowDiv.setAttribute('role', 'row');
    // Row divs use display:contents so CSS Grid on the parent still controls layout
    rowDiv.style.display = 'contents';

    for (let col = 0; col < GRID_SIZE; col++) {
      const cell = createGridCell(row, col, pos, opponentCount);
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
 * @param {number} [opponentCount] - When provided and > 0, uses adjusted strength
 */
export function updateCellsForPosition(cells, position, opponentCount) {
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

    const strength = opponentCount
      ? getAdjustedStrength(abbrev, position, opponentCount)
      : getHandStrength(abbrev, position);
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
