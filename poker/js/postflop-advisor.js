/**
 * postflop-advisor.js -- Unified Page 2 controller.
 *
 * Replaces odds-calculator.js, outs-reference.js, and pot-odds.js with a
 * single module that manages card selection (click + drag-and-drop), triggers
 * outs detection and equity calculation on selection change, manages pot/bet
 * inputs, computes pot odds, compares improvement probability to pot odds,
 * and renders a unified recommendation table with per-row verdicts.
 *
 * @module postflop-advisor
 */

import {
  RANK_NAMES,
  SUIT_SYMBOLS,
  SUIT_NAMES,
  cardRank,
  cardSuit,
  formatCardSymbol,
} from './poker-core.js';

import { detectDraws } from './outs-detection.js';

import {
  getHandStrength,
  STRENGTH_LABELS,
  renderGrid,
  updateCellsForPosition,
  attachGridClickHandler,
} from './preflop-chart.js';

// -- Module state -----------------------------------------------------------

/** @type {number[]} Selected hole cards (max 2), stored as card integers 0-51 */
let holeCards = [];

/** @type {number[]} Selected board cards (max 5), stored as card integers 0-51 */
let boardCards = [];

/** @type {Worker | null} Reference to the active Web Worker */
let worker = null;

/** @type {number | null} Latest equity result (win percentage, 0-100) */
let latestEquity = null;

/** @type {boolean} Whether an equity calculation is currently in progress */
let equityInProgress = false;

/** @type {{ madeHand: { name: string, rank: number } | null, draws: Array<{ name: string, outs: number[], description: string, probability: { nextCard: number, byRiver: number } }>, totalOuts: number[], probabilities: { nextCard: number, byRiver: number } } | null} */
let latestDrawResult = null;

/** @type {number} Number of opponents for equity simulation (1-9) */
let opponentCount = 1;

/** @type {{ wins: number, ties: number, losses: number, total: number } | null} Latest raw equity breakdown */
let latestEquityBreakdown = null;

/** @type {Array<{ drawIndex: number, wins: number, total: number }> | null} Per-draw win-if-hit results */
let winIfHitResults = null;

/** @type {number} Generation counter for discarding stale async results */
let currentGeneration = 0;

/** @type {boolean} Whether the worker is in win-if-hit phase (do not terminate after equity) */
let winIfHitPending = false;

/** @type {string} Current table position, synchronized from app.js via onPositionChanged */
let currentPosition = 'blinds';

/**
 * Human-readable labels for position values.
 * @type {Record<string, string>}
 */
const POSITION_DISPLAY_NAMES = {
  all: 'All',
  early: 'UTG (Early)',
  middle: 'Middle',
  late: 'Cutoff/BTN',
  blinds: 'Blinds (SB/BB)',
};

// -- DOM element references (set during init) --------------------------------

/** @type {HTMLElement} The .postflop-advisor container */
let container;

/** @type {HTMLElement} Card slot container for hole cards */
let holeSlotsEl;

/** @type {HTMLElement} Card slot container for flop cards */
let flopSlotsEl;

/** @type {HTMLElement} Card slot container for turn card */
let turnSlotsEl;

/** @type {HTMLElement} Card slot container for river card */
let riverSlotsEl;

/** @type {HTMLElement} The card picker grid container */
let cardPickerEl;

/** @type {HTMLElement} The draws results area */
let drawsAreaEl;

/** @type {HTMLElement} The equity results area */
let equityAreaEl;

/** @type {HTMLElement} The control panel container (opponents + pot + bet) */
let controlPanelEl;

/** @type {HTMLElement} The recommendation area */
let recommendationAreaEl;

/** @type {HTMLInputElement} Pot size input */
let potInput;

/** @type {HTMLInputElement} Bet to call input */
let betInput;

/** @type {HTMLSelectElement} Opponent count dropdown */
let opponentSelectEl;


// -- Suit CSS class mapping --------------------------------------------------

const SUIT_CLASSES = ['clubs', 'diamonds', 'hearts', 'spades'];

// -- Slot definitions (order for sequential click-to-fill) -------------------

/**
 * Each slot has a type ('hole' or 'board'), a logical index within that type,
 * and a reference to the DOM element housing it. The array order determines
 * the fill sequence when clicking cards in the picker.
 *
 * @type {Array<{ type: string, index: number, el: HTMLElement | null }>}
 */
const SLOT_DEFS = [
  { type: 'hole', index: 0, el: null },
  { type: 'hole', index: 1, el: null },
  { type: 'board', index: 0, el: null }, // flop 1
  { type: 'board', index: 1, el: null }, // flop 2
  { type: 'board', index: 2, el: null }, // flop 3
  { type: 'board', index: 3, el: null }, // turn
  { type: 'board', index: 4, el: null }, // river
];

// -- Initialization ----------------------------------------------------------

/**
 * Initialize the post-flop advisor. Called once on page load.
 * Builds all child DOM elements inside the provided container.
 *
 * @param {HTMLElement} containerElement - The .postflop-advisor element
 */
export function init(containerElement) {
  container = containerElement;

  // Locate the sub-areas built in index.html
  const cardArea = container.querySelector('.advisor-card-area');
  cardPickerEl = container.querySelector('.card-picker');
  drawsAreaEl = container.querySelector('.advisor-draws-area');
  equityAreaEl = container.querySelector('.advisor-equity-area');
  controlPanelEl = container.querySelector('.advisor-control-panel');
  recommendationAreaEl = container.querySelector('.advisor-recommendation-area');

  // Locate slot containers within the card area groups
  const slotContainers = cardArea.querySelectorAll('.card-selection__slots');
  holeSlotsEl = slotContainers[0];  // "Your Hole Cards" group
  flopSlotsEl = slotContainers[1];  // "Flop" group
  turnSlotsEl = slotContainers[2];  // "Turn" group
  riverSlotsEl = slotContainers[3]; // "River" group

  // Build control panel first so opponentSelectEl is available
  buildControlPanel();

  buildCardSlots();
  buildCardPicker();
  attachEventListeners();

  // Show initial prompts
  showEquityPrompt('Select 2 hole cards to see equity.');
}

// -- Card slot rendering -----------------------------------------------------

/**
 * Build the 7 card slot elements across the grouped containers.
 * 2 hole slots, 3 flop slots, 1 turn slot, 1 river slot.
 */
function buildCardSlots() {
  // Hole cards (2)
  for (let i = 0; i < 2; i++) {
    const slot = createSlotElement('hole', i, `Hole card ${i + 1}`);
    holeSlotsEl.appendChild(slot);
    SLOT_DEFS[i].el = slot;
  }

  // Flop (3)
  for (let i = 0; i < 3; i++) {
    const slot = createSlotElement('board', i, `Flop card ${i + 1}`);
    flopSlotsEl.appendChild(slot);
    SLOT_DEFS[2 + i].el = slot;
  }

  // Turn (1)
  {
    const slot = createSlotElement('board', 3, 'Turn card');
    turnSlotsEl.appendChild(slot);
    SLOT_DEFS[5].el = slot;
  }

  // River (1)
  {
    const slot = createSlotElement('board', 4, 'River card');
    riverSlotsEl.appendChild(slot);
    SLOT_DEFS[6].el = slot;
  }
}

/**
 * Create a single card slot DOM element.
 *
 * @param {string} slotType - 'hole' or 'board'
 * @param {number} slotIndex - Index within the type
 * @param {string} label - Accessible label text
 * @returns {HTMLElement}
 */
function createSlotElement(slotType, slotIndex, label) {
  const slot = document.createElement('button');
  slot.type = 'button';
  slot.className = 'card-slot';
  slot.dataset.slotType = slotType;
  slot.dataset.slotIndex = String(slotIndex);
  slot.setAttribute('aria-label', `${label}: empty`);
  slot.textContent = '?';
  return slot;
}

/**
 * Get the card value placed in a specific slot, or -1 if empty.
 *
 * @param {string} slotType - 'hole' or 'board'
 * @param {number} slotIndex - Index within the type
 * @returns {number} Card integer or -1
 */
function getCardInSlot(slotType, slotIndex) {
  const cards = slotType === 'hole' ? holeCards : boardCards;
  if (slotIndex < cards.length) {
    return cards[slotIndex];
  }
  return -1;
}

/**
 * Update the visual state of all 7 card slots to reflect current selections.
 */
function renderSlots() {
  for (const def of SLOT_DEFS) {
    const slot = def.el;
    const card = getCardInSlot(def.type, def.index);

    // Clear all suit classes first
    for (const sc of SUIT_CLASSES) {
      slot.classList.remove('card-picker__card--' + sc);
    }

    if (card >= 0) {
      slot.textContent = formatCardSymbol(card);
      slot.classList.add('card-slot--filled');
      slot.classList.add('card-picker__card--' + SUIT_CLASSES[cardSuit(card)]);
      const label = def.type === 'hole'
        ? `Hole card ${def.index + 1}: ${formatCardSymbol(card)}`
        : `Board card ${def.index + 1}: ${formatCardSymbol(card)}`;
      slot.setAttribute('aria-label', label);
    } else {
      slot.textContent = '?';
      slot.classList.remove('card-slot--filled');
      const label = def.type === 'hole'
        ? `Hole card ${def.index + 1}: empty`
        : `Board card ${def.index + 1}: empty`;
      slot.setAttribute('aria-label', label);
    }
  }
}

// -- Card picker grid --------------------------------------------------------

/**
 * Build the 52-card picker grid. Cards arranged by suit (4 rows)
 * with 13 cards each (2 through Ace). Each card is a draggable <button>.
 */
function buildCardPicker() {
  for (let suit = 0; suit < 4; suit++) {
    for (let rank = 0; rank < 13; rank++) {
      const cardValue = suit * 13 + rank;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'card-picker__card card-picker__card--' + SUIT_CLASSES[suit];
      btn.dataset.card = String(cardValue);
      btn.draggable = true;

      // Rank label
      const rankSpan = document.createElement('span');
      rankSpan.textContent = RANK_NAMES[rank];
      btn.appendChild(rankSpan);

      // Suit symbol
      const suitSpan = document.createElement('span');
      suitSpan.textContent = SUIT_SYMBOLS[suit];
      btn.appendChild(suitSpan);

      btn.setAttribute(
        'aria-label',
        `${RANK_NAMES[rank]}${SUIT_SYMBOLS[suit]} (${SUIT_NAMES[suit]})`
      );

      cardPickerEl.appendChild(btn);
    }
  }
}

/**
 * Update the picker grid to reflect which cards are selected (disabled).
 */
function renderPickerState() {
  const allSelected = new Set(holeCards.concat(boardCards));
  const buttons = cardPickerEl.querySelectorAll('.card-picker__card');

  for (const btn of buttons) {
    const cardValue = Number(btn.dataset.card);
    const isSelected = allSelected.has(cardValue);
    btn.disabled = isSelected;

    if (isSelected) {
      btn.classList.add('card-picker__card--selected');
      btn.draggable = false;
    } else {
      btn.classList.remove('card-picker__card--selected');
      btn.draggable = true;
    }
  }
}

// -- Control panel (opponents + pot/bet inputs + quick buttons) ---------------

/** @type {number[]} Quick-add/subtract amounts for pot and bet buttons */
const QUICK_AMOUNTS = [1, 10, 100, 1000];

/**
 * Build the control panel: opponent dropdown, pot input with quick buttons,
 * and bet input with quick buttons. Renders into .advisor-control-panel.
 */
function buildControlPanel() {
  // --- Opponent count group ---
  const oppGroup = document.createElement('div');
  oppGroup.className = 'control-panel__group';

  const oppLabel = document.createElement('label');
  oppLabel.className = 'control-panel__label';
  oppLabel.textContent = 'Opponents';
  oppLabel.setAttribute('for', 'opponent-count-select');
  oppGroup.appendChild(oppLabel);

  opponentSelectEl = document.createElement('select');
  opponentSelectEl.id = 'opponent-count-select';
  opponentSelectEl.className = 'opponent-select';
  for (let i = 1; i <= 9; i++) {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = String(i);
    if (i === 1) {
      opt.selected = true;
    }
    opponentSelectEl.appendChild(opt);
  }
  opponentSelectEl.addEventListener('change', handleOpponentCountChange);
  oppGroup.appendChild(opponentSelectEl);

  controlPanelEl.appendChild(oppGroup);

  // --- Pot size group ---
  const potGroup = buildInputGroup('Pot', 'advisor-pot-size-input', 'e.g. 100');
  potInput = potGroup.querySelector('input');
  controlPanelEl.appendChild(potGroup);

  // --- Bet to call group ---
  const betGroup = buildInputGroup('Bet', 'advisor-bet-to-call-input', 'e.g. 50');
  betInput = betGroup.querySelector('input');
  controlPanelEl.appendChild(betGroup);

  // Wire up input events -- recompute recommendation on change
  potInput.addEventListener('input', onPotBetChanged);
  betInput.addEventListener('input', onPotBetChanged);

  // Event delegation for quick buttons (add, subtract, reset)
  controlPanelEl.addEventListener('click', handleQuickButtonClick);
}

/**
 * Build an input group with label, number input, quick-add row,
 * quick-subtract row, and reset button.
 *
 * @param {string} labelText - Short label ("Pot" or "Bet")
 * @param {string} inputId - HTML id for the input element
 * @param {string} placeholder - Placeholder text for the input
 * @returns {HTMLElement} The group container element
 */
function buildInputGroup(labelText, inputId, placeholder) {
  const group = document.createElement('div');
  group.className = 'control-panel__group';

  const label = document.createElement('label');
  label.className = 'control-panel__label';
  label.textContent = labelText;
  label.setAttribute('for', inputId);
  group.appendChild(label);

  const input = document.createElement('input');
  input.type = 'number';
  input.id = inputId;
  input.className = 'control-panel__input';
  input.min = '0';
  input.step = 'any';
  input.placeholder = placeholder;
  group.appendChild(input);

  // Quick-add buttons row
  const addRow = document.createElement('div');
  addRow.className = 'control-panel__quick-btns';
  for (const amount of QUICK_AMOUNTS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'quick-btn quick-btn--add';
    btn.textContent = '+' + amount;
    btn.dataset.action = 'add';
    btn.dataset.amount = String(amount);
    btn.dataset.target = inputId;
    btn.setAttribute('aria-label', 'Add ' + amount + ' to ' + labelText.toLowerCase());
    addRow.appendChild(btn);
  }
  group.appendChild(addRow);

  // Quick-subtract buttons row
  const subRow = document.createElement('div');
  subRow.className = 'control-panel__quick-btns';
  for (const amount of QUICK_AMOUNTS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'quick-btn quick-btn--subtract';
    btn.textContent = '\u2212' + amount;
    btn.dataset.action = 'subtract';
    btn.dataset.amount = String(amount);
    btn.dataset.target = inputId;
    btn.setAttribute('aria-label', 'Subtract ' + amount + ' from ' + labelText.toLowerCase());
    subRow.appendChild(btn);
  }
  group.appendChild(subRow);

  // Reset button
  const resetBtn = document.createElement('button');
  resetBtn.type = 'button';
  resetBtn.className = 'reset-btn';
  resetBtn.textContent = 'Reset';
  resetBtn.dataset.action = 'reset';
  resetBtn.dataset.target = inputId;
  resetBtn.setAttribute('aria-label', 'Reset ' + labelText.toLowerCase() + ' to empty');
  group.appendChild(resetBtn);

  return group;
}

/**
 * Handle click events on quick-add, quick-subtract, and reset buttons
 * via event delegation on the control panel.
 *
 * @param {MouseEvent} event
 */
function handleQuickButtonClick(event) {
  const btn = /** @type {HTMLElement} */ (event.target).closest('[data-action]');
  if (!btn) return;

  const action = btn.dataset.action;
  const targetId = btn.dataset.target;
  const targetInput = document.getElementById(targetId);
  if (!targetInput) return;

  if (action === 'reset') {
    targetInput.value = '';
    onPotBetChanged();
    return;
  }

  const amount = parseFloat(btn.dataset.amount);
  if (!Number.isFinite(amount)) return;

  const currentVal = parseFloat(targetInput.value);
  const base = Number.isFinite(currentVal) ? currentVal : 0;

  if (action === 'add') {
    targetInput.value = String(base + amount);
  } else if (action === 'subtract') {
    const result = base - amount;
    targetInput.value = String(Math.max(0, result));
  }

  onPotBetChanged();
}

// -- Event handling ----------------------------------------------------------

/**
 * Attach all event listeners: picker clicks, slot clicks, drag-and-drop,
 * and the Clear All button.
 */
function attachEventListeners() {
  // Card picker clicks (delegation)
  cardPickerEl.addEventListener('click', handleCardPickerClick);

  // Slot clicks (remove card) -- delegation on each slot container
  holeSlotsEl.addEventListener('click', handleSlotClick);
  flopSlotsEl.addEventListener('click', handleSlotClick);
  turnSlotsEl.addEventListener('click', handleSlotClick);
  riverSlotsEl.addEventListener('click', handleSlotClick);

  // Clear All button
  const clearBtn = container.querySelector('.clear-button');
  if (clearBtn) {
    clearBtn.addEventListener('click', handleClearAll);
  }

  // Drag-and-drop on picker cards
  cardPickerEl.addEventListener('dragstart', handleDragStart);
  cardPickerEl.addEventListener('dragend', handleDragEnd);

  // Drop targets: all slot containers
  for (const slotContainer of [holeSlotsEl, flopSlotsEl, turnSlotsEl, riverSlotsEl]) {
    slotContainer.addEventListener('dragover', handleDragOver);
    slotContainer.addEventListener('dragleave', handleDragLeave);
    slotContainer.addEventListener('drop', handleDrop);
  }
}

/**
 * Handle click on a card in the picker grid. Fills the next empty slot
 * in order: hole1, hole2, flop1-3, turn, river.
 *
 * @param {MouseEvent} event
 */
function handleCardPickerClick(event) {
  const btn = /** @type {HTMLElement} */ (event.target).closest('.card-picker__card');
  if (!btn || btn.disabled) return;

  const cardValue = Number(btn.dataset.card);
  placeCardInNextEmptySlot(cardValue);
}

/**
 * Handle click on a filled card slot to remove that card.
 *
 * @param {MouseEvent} event
 */
function handleSlotClick(event) {
  const slot = /** @type {HTMLElement} */ (event.target).closest('.card-slot--filled');
  if (!slot) return;

  const slotType = slot.dataset.slotType;
  const slotIndex = Number(slot.dataset.slotIndex);

  removeCardFromSlot(slotType, slotIndex);
}

/**
 * Clear all selections, cancel worker, and reset all displays.
 * Also resets the module-level position to 'all' and invokes
 * the registered onClearAll callback (used by app.js for position reset).
 */
function handleClearAll() {
  cancelWorker();
  holeCards = [];
  boardCards = [];
  latestEquity = null;
  latestDrawResult = null;
  latestEquityBreakdown = null;
  winIfHitResults = null;
  equityInProgress = false;
  winIfHitPending = false;
  currentGeneration++;

  // Reset position to default
  currentPosition = 'blinds';

  // Reset opponent count to default
  opponentCount = 1;
  if (opponentSelectEl) {
    opponentSelectEl.value = '1';
  }

  // Reset pot and bet inputs
  if (potInput) potInput.value = '';
  if (betInput) betInput.value = '';

  renderSlots();
  renderPickerState();
  clearElement(drawsAreaEl);
  clearElement(equityAreaEl);
  clearElement(recommendationAreaEl);
  showEquityPrompt('Select 2 hole cards to see equity.');

}

/**
 * Handle opponent count dropdown change.
 * Updates module state and triggers recalculation.
 */
function handleOpponentCountChange() {
  opponentCount = parseInt(opponentSelectEl.value, 10);
  if (!Number.isFinite(opponentCount) || opponentCount < 1) {
    opponentCount = 1;
  }
  onSelectionChanged();
}

// -- Drag-and-drop handlers --------------------------------------------------

/**
 * Handle dragstart on a picker card.
 * @param {DragEvent} event
 */
function handleDragStart(event) {
  const btn = /** @type {HTMLElement} */ (event.target).closest('.card-picker__card');
  if (!btn || btn.disabled) {
    event.preventDefault();
    return;
  }

  const cardValue = btn.dataset.card;
  event.dataTransfer.setData('text/plain', cardValue);
  event.dataTransfer.effectAllowed = 'move';
  btn.classList.add('card-picker__card--dragging');
}

/**
 * Handle dragend -- clean up drag styling.
 * @param {DragEvent} event
 */
function handleDragEnd(event) {
  const btn = /** @type {HTMLElement} */ (event.target).closest('.card-picker__card');
  if (btn) {
    btn.classList.remove('card-picker__card--dragging');
  }
  // Clean up any remaining drag-over classes on slots
  const allSlots = container.querySelectorAll('.card-slot');
  for (const slot of allSlots) {
    slot.classList.remove('card-slot--drag-over');
  }
}

/**
 * Handle dragover on a slot container -- allow drop.
 * @param {DragEvent} event
 */
function handleDragOver(event) {
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';

  const slot = /** @type {HTMLElement} */ (event.target).closest('.card-slot');
  if (slot) {
    slot.classList.add('card-slot--drag-over');
  }
}

/**
 * Handle dragleave on a slot -- remove highlight.
 * @param {DragEvent} event
 */
function handleDragLeave(event) {
  const slot = /** @type {HTMLElement} */ (event.target).closest('.card-slot');
  if (slot) {
    slot.classList.remove('card-slot--drag-over');
  }
}

/**
 * Handle drop on a slot -- place the card in that specific slot.
 * If the slot is already occupied, swap the old card back to the picker.
 *
 * @param {DragEvent} event
 */
function handleDrop(event) {
  event.preventDefault();

  const slot = /** @type {HTMLElement} */ (event.target).closest('.card-slot');
  if (!slot) return;

  slot.classList.remove('card-slot--drag-over');

  const cardValueStr = event.dataTransfer.getData('text/plain');
  const cardValue = Number(cardValueStr);
  if (Number.isNaN(cardValue) || cardValue < 0 || cardValue > 51) return;

  // Already placed? Should not happen since disabled cards are not draggable
  const allSelected = new Set(holeCards.concat(boardCards));
  if (allSelected.has(cardValue)) return;

  const slotType = slot.dataset.slotType;
  const slotIndex = Number(slot.dataset.slotIndex);

  placeCardInSpecificSlot(cardValue, slotType, slotIndex);
}

// -- Card placement logic ----------------------------------------------------

/**
 * Place a card into the next empty slot in sequence order.
 *
 * @param {number} cardValue - Card integer 0-51
 */
function placeCardInNextEmptySlot(cardValue) {
  // Find the first empty slot in order
  for (const def of SLOT_DEFS) {
    const cards = def.type === 'hole' ? holeCards : boardCards;
    if (def.index >= cards.length) {
      // This slot is empty -- fill it
      if (def.type === 'hole') {
        holeCards.push(cardValue);
      } else {
        // Board cards must be filled sequentially
        boardCards.push(cardValue);
      }
      afterCardChange();
      return;
    }
  }
  // All 7 slots full, ignore
}

/**
 * Place a card into a specific slot by type and index.
 * If the slot is already occupied, the old card is swapped out.
 *
 * @param {number} cardValue - Card integer 0-51
 * @param {string} slotType - 'hole' or 'board'
 * @param {number} slotIndex - Index within the type
 */
function placeCardInSpecificSlot(cardValue, slotType, slotIndex) {
  const cards = slotType === 'hole' ? holeCards : boardCards;

  if (slotIndex < cards.length) {
    // Slot is occupied -- swap: old card goes back to picker
    cards[slotIndex] = cardValue;
  } else if (slotIndex === cards.length) {
    // Slot is the next empty one -- just push
    cards.push(cardValue);
  } else {
    // Slot is beyond the next empty (gap). Reject the drop --
    // preceding slots must be filled first.
    return;
  }

  afterCardChange();
}

/**
 * Remove a card from a specific slot.
 *
 * @param {string} slotType - 'hole' or 'board'
 * @param {number} slotIndex - Index within the type
 */
function removeCardFromSlot(slotType, slotIndex) {
  const cards = slotType === 'hole' ? holeCards : boardCards;

  if (slotIndex >= 0 && slotIndex < cards.length) {
    cards.splice(slotIndex, 1);
    afterCardChange();
  }
}

/**
 * Common handler after any card selection change.
 * Re-renders slots/picker and triggers detection + equity + recommendation.
 */
function afterCardChange() {
  renderSlots();
  renderPickerState();
  onSelectionChanged();
}

// -- Selection change handler ------------------------------------------------

/**
 * Called after any card add/remove. Triggers outs detection, equity
 * calculation, preflop recommendation, and recommendation table rendering.
 */
function onSelectionChanged() {
  // Invalidate stale async results
  currentGeneration++;
  winIfHitResults = null;
  winIfHitPending = false;
  latestEquity = null;
  latestEquityBreakdown = null;

  // (1) Outs detection: needs 2 hole + 3+ board
  updateDrawsDetection();

  // (2) Equity calculation: needs 2+ hole cards
  updateEquity();

  // (3) Preflop recommendation: needs 2 hole cards + non-"all" position
  renderPreflopRecommendation();

  // (4) Render the unified table with current state
  renderRecommendationTable();
}

// -- Draws/outs detection ----------------------------------------------------

/**
 * Run outs detection if conditions are met and store result.
 */
function updateDrawsDetection() {
  if (holeCards.length < 2 || boardCards.length < 3) {
    latestDrawResult = null;
    return;
  }

  latestDrawResult = detectDraws(holeCards, boardCards);
}

// -- Equity calculation ------------------------------------------------------

/**
 * Start or cancel an equity calculation based on current card selection.
 */
function updateEquity() {
  cancelWorker();

  if (holeCards.length < 2) {
    latestEquity = null;
    latestEquityBreakdown = null;
    equityInProgress = false;
    showEquityPrompt('Select 2 hole cards to see equity.');
    return;
  }

  // Board must be 0, 3, 4, or 5 cards for the worker
  const boardLen = boardCards.length;
  if (boardLen === 1 || boardLen === 2) {
    showEquityPrompt(
      `Select ${3 - boardLen} more board card${3 - boardLen > 1 ? 's' : ''} (flop requires 3).`
    );
    latestEquity = null;
    latestEquityBreakdown = null;
    equityInProgress = false;
    return;
  }

  // Valid selection -- start simulation
  startSimulation();
}

/**
 * Terminate the current worker if one is running.
 */
function cancelWorker() {
  if (worker !== null) {
    worker.terminate();
    worker = null;
  }
}

/**
 * Start a new Monte Carlo simulation in a Web Worker.
 */
function startSimulation() {
  cancelWorker();
  equityInProgress = true;

  const gen = currentGeneration;

  showEquityProgress(0, 10000);

  try {
    worker = new Worker('js/worker-equity.js');
  } catch (err) {
    showEquityPrompt('Unable to start calculation. Your browser may not support Web Workers.');
    equityInProgress = false;
    return;
  }

  const thisWorker = worker;
  worker.onmessage = function (e) {
    // Discard messages from terminated or superseded workers
    if (thisWorker !== worker) {
      return;
    }
    const msg = e.data;

    if (msg.type === 'progress') {
      // Only show progress bar for equity phase (not win-if-hit)
      if (!winIfHitPending) {
        showEquityProgress(msg.data.completed, msg.data.total);
      }
    } else if (msg.type === 'result') {
      // Discard stale results from a previous generation
      if (gen !== currentGeneration) {
        return;
      }

      const { wins, ties, losses, total } = msg.data;
      if (total > 0) {
        latestEquity = ((wins + ties * 0.5) / total) * 100;
        latestEquityBreakdown = { wins, ties, losses, total };
      } else {
        latestEquity = null;
        latestEquityBreakdown = null;
      }
      equityInProgress = false;

      // Clear the equity area progress bar
      clearElement(equityAreaEl);

      // Render table with equity data
      renderRecommendationTable();

      // Phase 2: start win-if-hit if draws exist
      if (latestDrawResult && latestDrawResult.draws.length > 0 && boardCards.length < 5) {
        winIfHitPending = true;
        // NOTE: depends on js/worker-equity.js by dev1 -- start-win-if-hit support
        worker.postMessage({
          type: 'start-win-if-hit',
          data: {
            holeCards: holeCards.slice(),
            boardCards: boardCards.slice(),
            draws: latestDrawResult.draws.map(function (d) { return { outs: d.outs }; }),
            opponentCount: opponentCount,
            iterationsPerDraw: 2500,
            generation: gen,
          },
        });
      } else {
        // No phase 2 needed -- clean up worker
        if (worker !== null) {
          worker.terminate();
          worker = null;
        }
      }
    } else if (msg.type === 'result-win-if-hit') {
      // Discard stale results from a previous generation
      if (gen !== currentGeneration) {
        return;
      }

      winIfHitResults = msg.data.results;
      winIfHitPending = false;

      // Render table with win-if-hit data filled in
      renderRecommendationTable();

      // Clean up after both phases complete
      if (worker !== null) {
        worker.terminate();
        worker = null;
      }
    }
  };

  worker.onerror = function (event) {
    // Discard errors from terminated or superseded workers
    if (gen !== currentGeneration || thisWorker !== worker) {
      return;
    }
    console.error('worker-equity error:', event.message, event.filename, event.lineno);
    showEquityPrompt('Calculation error. Please try again.');
    equityInProgress = false;
    winIfHitPending = false;
    if (worker !== null) {
      worker.terminate();
      worker = null;
    }
  };

  worker.postMessage({
    type: 'start',
    data: {
      holeCards: holeCards.slice(),
      boardCards: boardCards.slice(),
      iterations: 10000,
      opponentCount: opponentCount,
    },
  });
}

// -- Equity display helpers --------------------------------------------------

/**
 * Show a text prompt in the equity area.
 * @param {string} text
 */
function showEquityPrompt(text) {
  clearElement(equityAreaEl);

  const p = document.createElement('p');
  p.className = 'odds-results__prompt';
  p.textContent = text;
  equityAreaEl.appendChild(p);
}

/**
 * Show progress bar during equity calculation.
 * @param {number} completed
 * @param {number} total
 */
function showEquityProgress(completed, total) {
  let progressEl = equityAreaEl.querySelector('.odds-progress');
  let statusEl = equityAreaEl.querySelector('.odds-results__prompt');

  if (!progressEl) {
    clearElement(equityAreaEl);

    const wrapper = document.createElement('div');
    wrapper.className = 'odds-results';

    const status = document.createElement('p');
    status.className = 'odds-results__prompt';
    status.textContent = 'Calculating...';
    wrapper.appendChild(status);
    statusEl = status;

    const progress = document.createElement('div');
    progress.className = 'odds-progress';
    const bar = document.createElement('div');
    bar.className = 'odds-progress__bar';
    progress.appendChild(bar);
    wrapper.appendChild(progress);
    progressEl = progress;

    equityAreaEl.appendChild(wrapper);
  }

  const pct = total > 0 ? (completed / total) * 100 : 0;
  const bar = progressEl.querySelector('.odds-progress__bar');
  if (bar) {
    /** @type {HTMLElement} */ (bar).style.width = pct + '%';
  }

  if (statusEl) {
    statusEl.textContent = `Calculating... ${Math.round(pct)}%`;
  }
}

// -- Pot odds and recommendation table ---------------------------------------

/**
 * Called when pot or bet inputs change.
 */
function onPotBetChanged() {
  renderRecommendationTable();
}

/**
 * Validate a numeric input value.
 *
 * @param {string} rawValue
 * @param {string} fieldName
 * @returns {{ valid: boolean, value: number, error: string }}
 */
function validateNumericInput(rawValue, fieldName) {
  const trimmed = rawValue.trim();

  if (trimmed === '') {
    return { valid: false, value: 0, error: '' };
  }

  const num = Number(trimmed);

  if (!Number.isFinite(num)) {
    return { valid: false, value: 0, error: `${fieldName} must be a valid number.` };
  }

  if (num < 0) {
    return { valid: false, value: 0, error: `${fieldName} cannot be negative.` };
  }

  return { valid: true, value: num, error: '' };
}

/**
 * Computes the GCD of two positive integers (Euclidean algorithm).
 * @param {number} a
 * @param {number} b
 * @returns {number}
 */
function gcd(a, b) {
  while (b !== 0) {
    const temp = b;
    b = a % b;
    a = temp;
  }
  return a;
}

/**
 * Simplifies a ratio to lowest integer terms, handling decimals.
 * @param {number} numerator
 * @param {number} denominator
 * @returns {{ num: number, den: number }}
 */
function simplifyRatio(numerator, denominator) {
  if (denominator === 0) {
    return { num: numerator, den: 0 };
  }

  const numStr = String(numerator);
  const denStr = String(denominator);
  const numDecimals = numStr.includes('.') ? numStr.split('.')[1].length : 0;
  const denDecimals = denStr.includes('.') ? denStr.split('.')[1].length : 0;
  const maxDecimals = Math.min(Math.max(numDecimals, denDecimals), 4);
  const scale = Math.pow(10, maxDecimals);

  const scaledNum = Math.round(numerator * scale);
  const scaledDen = Math.round(denominator * scale);

  const divisor = gcd(scaledNum, scaledDen);
  return {
    num: scaledNum / divisor,
    den: scaledDen / divisor,
  };
}

/**
 * Return a color class based on probability percentage.
 * >50%: green, 20-50%: yellow, <20%: red.
 *
 * @param {number} pct - Percentage value 0-100
 * @returns {string} CSS class name
 */
function probColorClass(pct) {
  if (pct > 50) return 'prob-green';
  if (pct >= 20) return 'prob-yellow';
  return 'prob-red';
}

/**
 * Compute a verdict by comparing a probability against pot odds.
 * RAISE if probability > potOdds + 10, CALL if > potOdds, else FOLD.
 *
 * @param {number} probability - Percentage value
 * @param {number} potOddsPercent - Pot odds percentage
 * @returns {{ text: string, cssClass: string }}
 */
function computeVerdict(probability, potOddsPercent) {
  if (probability > potOddsPercent + 10) {
    return { text: 'RAISE', cssClass: 'verdict-raise' };
  } else if (probability > potOddsPercent) {
    return { text: 'CALL', cssClass: 'verdict-call' };
  }
  return { text: 'FOLD', cssClass: 'verdict-fold' };
}

/**
 * Compute a verdict based on raw equity alone (no pot odds).
 * Used when pot/bet are not entered yet.
 *
 * @param {number} equity - Equity percentage 0-100
 * @returns {{ text: string, cssClass: string }}
 */
function computeVerdictFromEquity(equity) {
  if (equity > 50) {
    return { text: 'RAISE', cssClass: 'verdict-raise' };
  } else if (equity >= 33) {
    return { text: 'CALL', cssClass: 'verdict-call' };
  }
  return { text: 'FOLD', cssClass: 'verdict-fold' };
}

/**
 * Parse pot odds from the input fields.
 *
 * @returns {{ valid: boolean, potOddsPercent: number, pot: number, bet: number, error: string, empty: boolean }}
 */
function parsePotOdds() {
  if (!potInput || !betInput) {
    return { valid: false, potOddsPercent: 0, pot: 0, bet: 0, error: '', empty: true };
  }

  const potVal = potInput.value;
  const betVal = betInput.value;

  if (potVal.trim() === '' || betVal.trim() === '') {
    return { valid: false, potOddsPercent: 0, pot: 0, bet: 0, error: '', empty: true };
  }

  const potValidation = validateNumericInput(potVal, 'Pot size');
  if (!potValidation.valid) {
    return { valid: false, potOddsPercent: 0, pot: 0, bet: 0, error: potValidation.error, empty: false };
  }

  const betValidation = validateNumericInput(betVal, 'Bet to call');
  if (!betValidation.valid) {
    return { valid: false, potOddsPercent: 0, pot: 0, bet: 0, error: betValidation.error, empty: false };
  }

  const pot = potValidation.value;
  const bet = betValidation.value;

  if (bet === 0) {
    return { valid: false, potOddsPercent: 0, pot, bet: 0, error: '', empty: false };
  }

  const totalPot = pot + bet;
  const potOddsPercent = (bet / totalPot) * 100;

  return { valid: true, potOddsPercent, pot, bet, error: '', empty: false };
}

/**
 * Render the unified recommendation table from current state.
 * Primary target: advisor-recommendation-area.
 * Does NOT clear advisor-draws-area -- renderPreflopRecommendation owns it.
 * Does NOT clear advisor-equity-area -- it hosts the progress bar during
 * async equity calculation and is cleared by updateEquity result and handleClearAll.
 */
function renderRecommendationTable() {
  clearElement(recommendationAreaEl);

  // Guard: need at least 2 hole cards + 3 board cards for post-flop analysis
  if (holeCards.length < 2 || boardCards.length < 3) {
    return;
  }

  if (!latestDrawResult) {
    return;
  }

  const potOdds = parsePotOdds();

  // Build the rec-table container
  const table = document.createElement('div');
  table.className = 'rec-table';

  // No preflop row when board is dealt (flop+) — post-flop analysis takes over

  // --- Made hand row ---
  const madeRow = buildMadeHandRow(potOdds);
  table.appendChild(madeRow);

  // --- Improvement rows (only when board < 5 cards) ---
  if (boardCards.length < 5 && latestDrawResult.draws.length > 0) {
    for (let i = 0; i < latestDrawResult.draws.length; i++) {
      const draw = latestDrawResult.draws[i];
      const impRow = buildImprovementRow(draw, i, potOdds);
      table.appendChild(impRow);
    }

    // --- Total outs row ---
    const totalRow = buildTotalOutsRow(potOdds);
    table.appendChild(totalRow);
  }

  // Show pot odds info and validation messages after the table
  if (potOdds.error) {
    const errP = document.createElement('p');
    errP.className = 'validation-message';
    errP.textContent = potOdds.error;
    recommendationAreaEl.appendChild(table);
    recommendationAreaEl.appendChild(errP);
    return;
  }

  if (!potOdds.empty && potOdds.bet === 0 && !potOdds.valid) {
    const infoP = document.createElement('p');
    infoP.className = 'pot-odds-info';
    infoP.textContent = 'No bet to call -- you can check for free';
    recommendationAreaEl.appendChild(table);
    recommendationAreaEl.appendChild(infoP);
    return;
  }

  recommendationAreaEl.appendChild(table);
}

/**
 * Build the made hand row for the recommendation table.
 *
 * @param {{ valid: boolean, potOddsPercent: number, pot: number, bet: number, error: string, empty: boolean }} potOdds
 * @returns {HTMLElement}
 */
function buildMadeHandRow(potOdds) {
  const row = document.createElement('div');
  row.className = 'rec-table__row rec-table__row--made-hand';

  // Hand name cell
  const nameCell = document.createElement('div');
  nameCell.className = 'rec-table__cell rec-table__cell--name';
  nameCell.textContent = latestDrawResult.madeHand
    ? latestDrawResult.madeHand.name
    : 'No made hand';
  row.appendChild(nameCell);

  // Equity cell
  const equityCell = document.createElement('div');
  equityCell.className = 'rec-table__cell rec-table__cell--equity';

  if (latestEquity !== null) {
    equityCell.textContent = latestEquity.toFixed(1) + '%';
    equityCell.classList.add(probColorClass(latestEquity));
  } else {
    equityCell.textContent = 'Calculating...';
  }
  row.appendChild(equityCell);

  // Opponent count annotation
  const oppCell = document.createElement('div');
  oppCell.className = 'rec-table__cell rec-table__cell--opp';
  oppCell.textContent = 'vs ' + opponentCount + ' opponent' + (opponentCount !== 1 ? 's' : '');
  row.appendChild(oppCell);

  // Pot odds + verdict cell
  const verdictCell = document.createElement('div');
  verdictCell.className = 'rec-table__cell rec-table__cell--verdict';

  if (potOdds.valid) {
    // Pot odds entered — show pot odds info + verdict based on pot odds comparison
    const potOddsInfo = document.createElement('span');
    potOddsInfo.className = 'rec-table__pot-odds';
    const ratio = ((potOdds.pot + potOdds.bet) / potOdds.bet).toFixed(1);
    potOddsInfo.textContent = 'Pot odds: ' + potOdds.potOddsPercent.toFixed(1) + '% (' + ratio + ':1)';
    verdictCell.appendChild(potOddsInfo);

    if (latestEquity !== null) {
      const verdict = computeVerdict(latestEquity, potOdds.potOddsPercent);
      const badge = document.createElement('span');
      badge.className = 'verdict-badge ' + verdict.cssClass;
      badge.textContent = verdict.text;
      verdictCell.appendChild(badge);
    }
  } else if (latestEquity !== null) {
    // No pot odds — show verdict based on raw equity thresholds with hint
    const hint = document.createElement('span');
    hint.className = 'rec-table__pot-odds';
    hint.textContent = 'Enter pot & bet for precise odds';
    verdictCell.appendChild(hint);

    const verdict = computeVerdictFromEquity(latestEquity);
    const badge = document.createElement('span');
    badge.className = 'verdict-badge ' + verdict.cssClass;
    badge.textContent = verdict.text;
    verdictCell.appendChild(badge);
  }
  row.appendChild(verdictCell);

  // Win/tie/loss expandable detail
  const detailContainer = document.createElement('div');
  detailContainer.className = 'rec-table__detail';

  if (latestEquityBreakdown !== null) {
    const { wins, ties, losses, total } = latestEquityBreakdown;
    const winPct = ((wins / total) * 100).toFixed(1);
    const tiePct = ((ties / total) * 100).toFixed(1);
    const lossPct = ((losses / total) * 100).toFixed(1);

    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'info-toggle rec-table__detail-toggle';
    toggleBtn.setAttribute('aria-expanded', 'false');
    toggleBtn.textContent = 'Win/Tie/Loss details';

    const contentDiv = document.createElement('div');
    contentDiv.className = 'rec-table__detail-content';
    contentDiv.style.display = 'none';

    const detailText = document.createElement('span');
    detailText.className = 'rec-table__detail-text';
    detailText.textContent = `Win: ${winPct}%  Tie: ${tiePct}%  Loss: ${lossPct}%`;
    contentDiv.appendChild(detailText);

    toggleBtn.addEventListener('click', function () {
      const expanded = toggleBtn.getAttribute('aria-expanded') === 'true';
      toggleBtn.setAttribute('aria-expanded', String(!expanded));
      contentDiv.style.display = expanded ? 'none' : 'block';
    });

    detailContainer.appendChild(toggleBtn);
    detailContainer.appendChild(contentDiv);
  }

  row.appendChild(detailContainer);

  return row;
}

/**
 * Build an improvement row for a single draw.
 *
 * @param {{ name: string, outs: number[], description: string, probability: { nextCard: number, byRiver: number } }} draw
 * @param {number} drawIndex - Index into latestDrawResult.draws
 * @param {{ valid: boolean, potOddsPercent: number }} potOdds
 * @returns {HTMLElement}
 */
function buildImprovementRow(draw, drawIndex, potOdds) {
  const row = document.createElement('div');
  row.className = 'rec-table__row rec-table__row--improvement';

  // Draw name cell
  const nameCell = document.createElement('div');
  nameCell.className = 'rec-table__cell rec-table__cell--name';
  nameCell.textContent = draw.name;
  row.appendChild(nameCell);

  // Outs count cell
  const outsCell = document.createElement('div');
  outsCell.className = 'rec-table__cell rec-table__cell--outs';
  outsCell.textContent = draw.outs.length + ' outs';
  row.appendChild(outsCell);

  // Hit chance cell -- most prominent, color-coded
  const hitCell = document.createElement('div');
  hitCell.className = 'rec-table__cell rec-table__cell--hit';
  const hitPct = getDrawHitPct(draw);
  hitCell.textContent = 'Hit: ' + hitPct.toFixed(1) + '%';
  hitCell.classList.add(probColorClass(hitPct));
  row.appendChild(hitCell);

  // Win-if-hit cell
  const wihCell = document.createElement('div');
  wihCell.className = 'rec-table__cell rec-table__cell--wih';

  const wihPct = getWinIfHitPct(drawIndex);
  if (wihPct !== null) {
    wihCell.textContent = 'WiH: ' + wihPct.toFixed(1) + '%';
  } else {
    wihCell.textContent = 'WiH: Calculating...';
  }
  row.appendChild(wihCell);

  // Adjusted probability cell -- color-coded
  const adjCell = document.createElement('div');
  adjCell.className = 'rec-table__cell rec-table__cell--adj';

  if (wihPct !== null) {
    const adjPct = (hitPct * wihPct) / 100;
    adjCell.textContent = 'Adj: ' + adjPct.toFixed(1) + '%';
  } else {
    adjCell.textContent = 'Adj: Calculating...';
  }
  row.appendChild(adjCell);

  return row;
}

/**
 * Build the total outs summary row.
 *
 * @param {{ valid: boolean, potOddsPercent: number }} potOdds
 * @returns {HTMLElement}
 */
function buildTotalOutsRow(potOdds) {
  const row = document.createElement('div');
  row.className = 'rec-table__row rec-table__row--total';

  // Label cell
  const nameCell = document.createElement('div');
  nameCell.className = 'rec-table__cell rec-table__cell--name';
  nameCell.textContent = 'Total outs';
  row.appendChild(nameCell);

  // De-duplicated outs count
  const outsCell = document.createElement('div');
  outsCell.className = 'rec-table__cell rec-table__cell--outs';
  outsCell.textContent = latestDrawResult.totalOuts.length + ' outs';
  row.appendChild(outsCell);

  // Combined hit chance -- color-coded
  const hitCell = document.createElement('div');
  hitCell.className = 'rec-table__cell rec-table__cell--hit';
  const combinedHitPct = getCombinedHitPct();
  hitCell.textContent = 'Hit: ' + combinedHitPct.toFixed(1) + '%';
  hitCell.classList.add(probColorClass(combinedHitPct));
  row.appendChild(hitCell);

  // Weighted average win-if-hit
  const wihCell = document.createElement('div');
  wihCell.className = 'rec-table__cell rec-table__cell--wih';

  const weightedWih = getWeightedAverageWinIfHit();
  if (weightedWih !== null) {
    wihCell.textContent = 'WiH: ' + weightedWih.toFixed(1) + '%';
  } else {
    wihCell.textContent = 'WiH: Calculating...';
  }
  row.appendChild(wihCell);

  // Combined adjusted probability
  const adjCell = document.createElement('div');
  adjCell.className = 'rec-table__cell rec-table__cell--adj';

  if (weightedWih !== null) {
    const combinedAdj = (combinedHitPct * weightedWih) / 100;
    adjCell.textContent = 'Adj: ' + combinedAdj.toFixed(1) + '%';
  } else {
    adjCell.textContent = 'Adj: Calculating...';
  }
  row.appendChild(adjCell);

  return row;
}

// -- Helper functions for draw calculations ----------------------------------

/**
 * Get the hit percentage for a specific draw based on board state.
 * Flop: uses byRiver. Turn: uses nextCard.
 *
 * @param {{ probability: { nextCard: number, byRiver: number } }} draw
 * @returns {number} Percentage 0-100
 */
function getDrawHitPct(draw) {
  if (boardCards.length === 3) {
    return draw.probability.byRiver * 100;
  }
  return draw.probability.nextCard * 100;
}

/**
 * Get the win-if-hit percentage for a specific draw from winIfHitResults.
 * Returns null if results are not yet available.
 *
 * @param {number} drawIndex
 * @returns {number | null} Percentage 0-100, or null
 */
function getWinIfHitPct(drawIndex) {
  if (!winIfHitResults) return null;

  const result = winIfHitResults.find(function (r) { return r.drawIndex === drawIndex; });
  if (!result || result.total === 0) return null;

  // Consistent with main equity: wins + 0.5 * ties
  const ties = result.ties || 0;
  return ((result.wins + 0.5 * ties) / result.total) * 100;
}

/**
 * Get the combined hit chance for total de-duplicated outs.
 *
 * @returns {number} Percentage 0-100
 */
function getCombinedHitPct() {
  if (boardCards.length === 3) {
    return latestDrawResult.probabilities.byRiver * 100;
  }
  return latestDrawResult.probabilities.nextCard * 100;
}

/**
 * Compute the weighted average win-if-hit across all draws.
 * Weight by each draw's outs count.
 * Returns null if any draw's win-if-hit is not yet available.
 *
 * @returns {number | null} Percentage 0-100, or null
 */
function getWeightedAverageWinIfHit() {
  if (!winIfHitResults || !latestDrawResult) return null;

  let totalWeight = 0;
  let weightedSum = 0;

  for (let i = 0; i < latestDrawResult.draws.length; i++) {
    const draw = latestDrawResult.draws[i];
    const wihPct = getWinIfHitPct(i);
    if (wihPct === null) return null;

    const weight = draw.outs.length;
    totalWeight += weight;
    weightedSum += weight * wihPct;
  }

  if (totalWeight === 0) return null;
  return weightedSum / totalWeight;
}

// -- Preflop hand abbreviation -----------------------------------------------

/**
 * Convert two card integers (0-51) to preflop abbreviation format.
 * Higher rank is always listed first. Pairs have no suffix,
 * suited hands get 's', offsuit hands get 'o'.
 *
 * @param {number} card1 - Card integer 0-51
 * @param {number} card2 - Card integer 0-51
 * @returns {string} E.g. "AKo", "JJ", "T9s"
 */
export function cardsToHandAbbrev(card1, card2) {
  const rank1 = cardRank(card1);
  const rank2 = cardRank(card2);
  const suit1 = cardSuit(card1);
  const suit2 = cardSuit(card2);

  // Higher rank first
  const highRank = Math.max(rank1, rank2);
  const lowRank = Math.min(rank1, rank2);

  const highChar = RANK_NAMES[highRank];
  const lowChar = RANK_NAMES[lowRank];

  if (highRank === lowRank) {
    // Pocket pair: no suffix
    return highChar + lowChar;
  }

  if (suit1 === suit2) {
    return highChar + lowChar + 's';
  }

  return highChar + lowChar + 'o';
}

// -- Position change handling ------------------------------------------------

/**
 * Called by app.js when the position selector changes.
 * Stores the new position and updates the preflop recommendation display.
 * Also re-renders the rec-table so the embedded preflop row updates.
 *
 * @param {string} position - One of "all", "early", "middle", "late", "blinds"
 */
export function onPositionChanged(position) {
  currentPosition = position;
  renderPreflopRecommendation();
  renderRecommendationTable();
}

// -- Preflop recommendation rendering ----------------------------------------

/**
 * Render the preflop recommendation into drawsAreaEl.
 * Shows a standalone preflop row when exactly 2 hole cards are selected,
 * position is not 'all', and board cards < 3 (pre-flop stage).
 * When board >= 3, the preflop recommendation is shown as the first row
 * of the rec-table instead (via buildPreflopRecRow in renderRecommendationTable).
 * Callers that also need the rec-table updated should call
 * renderRecommendationTable separately.
 */
function renderPreflopRecommendation() {
  clearElement(drawsAreaEl);

  // When board >= 3, the preflop row is embedded in the rec-table instead
  if (boardCards.length >= 3) {
    return;
  }

  // Standalone preflop display: only when 2 hole cards, no full board yet
  if (holeCards.length !== 2) {
    return;
  }

  const abbrev = cardsToHandAbbrev(holeCards[0], holeCards[1]);
  const strength = getHandStrength(abbrev, currentPosition);
  const positionLabel = POSITION_DISPLAY_NAMES[currentPosition] || currentPosition;

  const row = document.createElement('div');
  row.className = 'rec-table__row rec-table__row--preflop';

  // Left side: hand abbreviation and position context
  const nameCell = document.createElement('div');
  nameCell.className = 'rec-table__cell rec-table__cell--name';
  nameCell.textContent = abbrev + ' from ' + positionLabel;
  row.appendChild(nameCell);

  // Right side: verdict badge (RAISE/CALL/FOLD style)
  const verdictCell = document.createElement('div');
  verdictCell.className = 'rec-table__cell rec-table__cell--verdict';

  const badge = document.createElement('span');
  if (strength === 'premium' || strength === 'strong') {
    badge.className = 'verdict-badge verdict-raise';
    badge.textContent = 'RAISE';
  } else if (strength === 'playable') {
    badge.className = 'verdict-badge verdict-call';
    badge.textContent = 'CALL';
  } else if (strength === 'marginal') {
    badge.className = 'verdict-badge verdict-call';
    badge.textContent = 'CALL';
  } else {
    badge.className = 'verdict-badge verdict-fold';
    badge.textContent = 'FOLD';
  }
  verdictCell.appendChild(badge);
  row.appendChild(verdictCell);

  // Wrap in .rec-table so the row gets the enclosing border/background styling
  const table = document.createElement('div');
  table.className = 'rec-table';
  table.appendChild(row);
  drawsAreaEl.appendChild(table);
}

// -- Clear All callback hook -------------------------------------------------

/**
 * Register a callback to be invoked when Clear All is clicked.
 * Used by app.js to reset position state.
 *
 * @param {Function} callback
 */
// -- Preflop popup -----------------------------------------------------------

/** @type {HTMLButtonElement[]|null} Grid cells inside the popup (for position updates) */
let popupGridCells = null;

/** @type {Function|null} Escape key handler reference for cleanup */
let popupEscapeHandler = null;

/** @type {Function|null} Focus trap handler reference for cleanup */
let popupFocusTrapHandler = null;

/**
 * Open the preflop popup modal. Builds the popup content, renders
 * the 13x13 grid using preflop-chart.js exports, and sets up
 * focus trapping and close handlers.
 *
 * @param {string} position - Current position to display the grid for
 */
export function openPreflopPopup(position) {
  const overlay = document.querySelector('.preflop-popup-overlay');
  if (!overlay) {
    console.error('postflop-advisor: .preflop-popup-overlay not found.');
    return;
  }

  // Guard against double-open: close existing popup first to avoid leaking listeners
  if (overlay.style.display === 'flex') {
    closePreflopPopup();
  }

  // Clear any previous popup content
  while (overlay.firstChild) {
    overlay.removeChild(overlay.firstChild);
  }

  // Build popup container
  const popup = document.createElement('div');
  popup.className = 'preflop-popup';

  // -- Header with title and close button --
  const header = document.createElement('div');
  header.className = 'preflop-popup__header';

  const title = document.createElement('h2');
  title.className = 'preflop-popup__title';
  title.textContent = 'Preflop Starting Hands';
  header.appendChild(title);

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'preflop-popup__close';
  closeBtn.setAttribute('aria-label', 'Close preflop chart');
  closeBtn.textContent = '\u2715'; // Unicode multiplication sign (X)
  closeBtn.addEventListener('click', closePreflopPopup);
  header.appendChild(closeBtn);

  popup.appendChild(header);

  // -- Position filter buttons inside popup --
  const popupFilters = document.createElement('div');
  popupFilters.className = 'position-filters position-filters--popup';
  popupFilters.setAttribute('role', 'group');
  popupFilters.setAttribute('aria-label', 'Position filter');

  const positions = [
    { value: 'blinds', label: 'Blinds (SB/BB)' },
    { value: 'early', label: 'UTG (Early)' },
    { value: 'middle', label: 'Middle' },
    { value: 'late', label: 'Cutoff/BTN' },
  ];

  for (const pos of positions) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'position-button';
    btn.dataset.position = pos.value;
    btn.textContent = pos.label;
    if (pos.value === position) {
      btn.classList.add('position-button--active');
    }
    btn.addEventListener('click', function () {
      // Update active state
      const allBtns = popupFilters.querySelectorAll('.position-button');
      for (const b of allBtns) {
        b.classList.remove('position-button--active');
      }
      btn.classList.add('position-button--active');

      // Re-render grid for new position
      updateCellsForPosition(popupGridCells, pos.value);
    });
    popupFilters.appendChild(btn);
  }
  popup.appendChild(popupFilters);

  // -- Legend --
  const legend = buildPopupLegend();
  popup.appendChild(legend);

  // -- Position descriptions (collapsible) --
  const posDescriptions = buildPopupPositionDescriptions();
  popup.appendChild(posDescriptions);

  // -- Grid container --
  const gridContainer = document.createElement('div');
  gridContainer.className = 'preflop-grid';
  gridContainer.setAttribute('role', 'grid');
  gridContainer.setAttribute('aria-label', 'Preflop starting hand chart');
  popup.appendChild(gridContainer);

  // -- Hand detail display --
  const detailEl = document.createElement('div');
  detailEl.className = 'hand-detail';

  const detailText = document.createElement('p');
  detailText.className = 'hand-detail__text';
  detailText.textContent = 'Tap a cell to see hand details.';
  detailEl.appendChild(detailText);
  popup.appendChild(detailEl);

  overlay.appendChild(popup);

  // Render the grid using preflop-chart.js exports
  popupGridCells = renderGrid(gridContainer, position);
  updateCellsForPosition(popupGridCells, position);
  attachGridClickHandler(gridContainer, detailEl, popupGridCells);

  // Show the overlay
  overlay.style.display = 'flex';

  // Prevent body scroll while popup is open
  document.body.style.overflow = 'hidden';

  // -- Escape key handler --
  popupEscapeHandler = function (event) {
    if (/** @type {KeyboardEvent} */ (event).key === 'Escape') {
      closePreflopPopup();
    }
  };
  document.addEventListener('keydown', /** @type {EventListener} */ (popupEscapeHandler));

  // -- Backdrop click handler (click directly on overlay, not popup) --
  overlay.addEventListener('click', handlePopupBackdropClick);

  // -- Focus trap --
  popupFocusTrapHandler = function (event) {
    const ke = /** @type {KeyboardEvent} */ (event);
    if (ke.key !== 'Tab') return;

    const focusableEls = popup.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    if (focusableEls.length === 0) return;

    const firstEl = /** @type {HTMLElement} */ (focusableEls[0]);
    const lastEl = /** @type {HTMLElement} */ (focusableEls[focusableEls.length - 1]);

    if (ke.shiftKey) {
      // Shift+Tab: if focus is on first element, wrap to last
      if (document.activeElement === firstEl) {
        ke.preventDefault();
        lastEl.focus();
      }
    } else {
      // Tab: if focus is on last element, wrap to first
      if (document.activeElement === lastEl) {
        ke.preventDefault();
        firstEl.focus();
      }
    }
  };
  document.addEventListener('keydown', /** @type {EventListener} */ (popupFocusTrapHandler));

  // Focus the close button on open
  closeBtn.focus();
}

/**
 * Handle clicks on the overlay backdrop to close the popup.
 * Only closes if the click target is the overlay itself, not the popup content.
 *
 * @param {MouseEvent} event
 */
function handlePopupBackdropClick(event) {
  const overlay = document.querySelector('.preflop-popup-overlay');
  if (event.target === overlay) {
    closePreflopPopup();
  }
}

/**
 * Close the preflop popup and clean up event listeners.
 */
export function closePreflopPopup() {
  const overlay = document.querySelector('.preflop-popup-overlay');
  if (!overlay) return;

  overlay.style.display = 'none';
  document.body.style.overflow = '';

  // Remove event listeners
  if (popupEscapeHandler) {
    document.removeEventListener('keydown', /** @type {EventListener} */ (popupEscapeHandler));
    popupEscapeHandler = null;
  }

  if (popupFocusTrapHandler) {
    document.removeEventListener('keydown', /** @type {EventListener} */ (popupFocusTrapHandler));
    popupFocusTrapHandler = null;
  }

  overlay.removeEventListener('click', handlePopupBackdropClick);

  // Clear popup grid cell references
  popupGridCells = null;

  // Return focus to the "Preflop Table" button
  const preflopBtn = document.querySelector('.preflop-table-btn');
  if (preflopBtn) {
    /** @type {HTMLElement} */ (preflopBtn).focus();
  }
}

/**
 * Build the legend element for the popup.
 * Shows colored swatches for each strength category.
 *
 * @returns {HTMLElement}
 */
function buildPopupLegend() {
  const legend = document.createElement('div');
  legend.className = 'chart-legend';

  const categories = ['premium', 'strong', 'playable', 'marginal', 'fold'];
  for (const cat of categories) {
    const item = document.createElement('span');
    item.className = 'legend-item legend-item--' + cat;

    const swatch = document.createElement('span');
    swatch.className = 'legend-swatch';
    item.appendChild(swatch);

    const label = document.createElement('span');
    label.textContent = STRENGTH_LABELS[cat];
    item.appendChild(label);

    legend.appendChild(item);
  }

  return legend;
}

/**
 * Build the position descriptions collapsible section for the popup.
 *
 * @returns {HTMLElement}
 */
function buildPopupPositionDescriptions() {
  const wrapper = document.createElement('div');
  wrapper.className = 'position-descriptions';

  const toggleBtn = document.createElement('button');
  toggleBtn.type = 'button';
  toggleBtn.className = 'info-toggle';
  toggleBtn.setAttribute('aria-expanded', 'false');
  toggleBtn.setAttribute('aria-controls', 'popup-position-desc-content');
  toggleBtn.textContent = 'What do these positions mean?';
  wrapper.appendChild(toggleBtn);

  const content = document.createElement('div');
  content.id = 'popup-position-desc-content';
  content.className = 'info-content';
  content.style.display = 'none';

  const dl = document.createElement('dl');
  dl.className = 'position-description-list';

  const positions = [
    { term: 'UTG (Early)', desc: 'Under the Gun. First to act pre-flop. Play only premium hands.' },
    { term: 'Middle', desc: 'Middle position. Slightly wider range than UTG.' },
    { term: 'Cutoff/BTN', desc: 'Cutoff and Button. Best positions -- widest opening range.' },
    { term: 'Blinds (SB/BB)', desc: 'Small Blind / Big Blind. Already invested, defend selectively.' },
  ];

  for (const pos of positions) {
    const dt = document.createElement('dt');
    dt.textContent = pos.term;
    dl.appendChild(dt);

    const dd = document.createElement('dd');
    dd.textContent = pos.desc;
    dl.appendChild(dd);
  }

  content.appendChild(dl);
  wrapper.appendChild(content);

  // Direct click listener -- the popup is outside .main-content so
  // app.js's delegated handler on .main-content will not reach this button.
  toggleBtn.addEventListener('click', function () {
    const expanded = toggleBtn.getAttribute('aria-expanded') === 'true';
    toggleBtn.setAttribute('aria-expanded', String(!expanded));
    content.style.display = expanded ? 'none' : 'block';
  });

  return wrapper;
}

// -- Utility -----------------------------------------------------------------

/**
 * Remove all child nodes from an element.
 * @param {HTMLElement} el
 */
function clearElement(el) {
  while (el.firstChild) {
    el.removeChild(el.firstChild);
  }
}
