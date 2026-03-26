/**
 * poker-core.js — Shared poker data and utility functions.
 *
 * Card encoding: integers 0-51.
 *   rank = card % 13   (0=2, 1=3, ..., 8=T, 9=J, 10=Q, 11=K, 12=A)
 *   suit = card / 13 | 0  (0=clubs, 1=diamonds, 2=hearts, 3=spades)
 *
 * This module is imported by both preflop-chart.js and odds-calculator.js,
 * so it must have zero DOM dependencies.
 */

// ── Card constants ──────────────────────────────────────────────────

/** @type {readonly string[]} Rank display characters, indexed by rank id 0-12 */
export const RANK_NAMES = Object.freeze([
  '2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'
]);

/** @type {readonly string[]} Full rank names for human-readable output */
export const RANK_FULL_NAMES = Object.freeze([
  'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
  'Ten', 'Jack', 'Queen', 'King', 'Ace'
]);

/** @type {readonly string[]} Suit display characters, indexed by suit id 0-3 */
export const SUIT_SYMBOLS = Object.freeze(['♣', '♦', '♥', '♠']);

/** @type {readonly string[]} Suit names, indexed by suit id 0-3 */
export const SUIT_NAMES = Object.freeze(['clubs', 'diamonds', 'hearts', 'spades']);

/** @type {readonly string[]} Single-char suit abbreviations for compact display */
export const SUIT_CHARS = Object.freeze(['c', 'd', 'h', 's']);

// ── Card encoding / decoding ────────────────────────────────────────

/**
 * Encode a rank (0-12) and suit (0-3) into a single card integer (0-51).
 * @param {number} rank - 0=2 through 12=Ace
 * @param {number} suit - 0=clubs, 1=diamonds, 2=hearts, 3=spades
 * @returns {number} Card integer 0-51
 */
export function encodeCard(rank, suit) {
  return suit * 13 + rank;
}

/**
 * Extract the rank (0-12) from a card integer.
 * @param {number} card - Integer 0-51
 * @returns {number} Rank 0-12
 */
export function cardRank(card) {
  return card % 13;
}

/**
 * Extract the suit (0-3) from a card integer.
 * @param {number} card - Integer 0-51
 * @returns {number} Suit 0-3
 */
export function cardSuit(card) {
  return (card / 13) | 0;
}

/**
 * Format a card integer as a short string like "As" (Ace of spades) or "Td" (Ten of diamonds).
 * @param {number} card - Integer 0-51
 * @returns {string}
 */
export function formatCardShort(card) {
  return RANK_NAMES[cardRank(card)] + SUIT_CHARS[cardSuit(card)];
}

/**
 * Format a card integer with the Unicode suit symbol, e.g. "A♠" or "T♦".
 * @param {number} card - Integer 0-51
 * @returns {string}
 */
export function formatCardSymbol(card) {
  return RANK_NAMES[cardRank(card)] + SUIT_SYMBOLS[cardSuit(card)];
}

/**
 * Format a card integer as a full human-readable string, e.g. "Ace of spades".
 * @param {number} card - Integer 0-51
 * @returns {string}
 */
export function formatCardFull(card) {
  return `${RANK_FULL_NAMES[cardRank(card)]} of ${SUIT_NAMES[cardSuit(card)]}`;
}

/**
 * Parse a two-character card string like "As" or "Td" back to a card integer.
 * Returns -1 if the string is invalid.
 * @param {string} str - Two-character card string (rank char + suit char)
 * @returns {number} Card integer 0-51, or -1 if invalid
 */
export function parseCard(str) {
  if (typeof str !== 'string' || str.length !== 2) return -1;
  const rankIndex = RANK_NAMES.indexOf(str[0].toUpperCase());
  const suitIndex = SUIT_CHARS.indexOf(str[1].toLowerCase());
  if (rankIndex === -1 || suitIndex === -1) return -1;
  return encodeCard(rankIndex, suitIndex);
}

// ── Preflop hand naming ─────────────────────────────────────────────

/**
 * Format a two-card starting hand as a canonical preflop string.
 * Pairs: "AA", "KK", etc.
 * Suited: "AKs", "QJs", etc. (higher rank first)
 * Offsuit: "AKo", "QJo", etc. (higher rank first)
 *
 * @param {number} card1 - First hole card (0-51)
 * @param {number} card2 - Second hole card (0-51)
 * @returns {string}
 */
export function formatStartingHand(card1, card2) {
  const r1 = cardRank(card1);
  const r2 = cardRank(card2);
  const s1 = cardSuit(card1);
  const s2 = cardSuit(card2);

  const highRank = Math.max(r1, r2);
  const lowRank = Math.min(r1, r2);

  if (r1 === r2) {
    return RANK_NAMES[r1] + RANK_NAMES[r2];
  }

  const suffix = (s1 === s2) ? 's' : 'o';
  return RANK_NAMES[highRank] + RANK_NAMES[lowRank] + suffix;
}

/**
 * Format a two-card starting hand as a full human-readable string.
 * E.g. "Ace-King suited", "Queen-Jack offsuit", "Pocket Aces".
 *
 * @param {number} card1 - First hole card (0-51)
 * @param {number} card2 - Second hole card (0-51)
 * @returns {string}
 */
export function formatStartingHandFull(card1, card2) {
  const r1 = cardRank(card1);
  const r2 = cardRank(card2);
  const s1 = cardSuit(card1);
  const s2 = cardSuit(card2);

  const highRank = Math.max(r1, r2);
  const lowRank = Math.min(r1, r2);

  if (r1 === r2) {
    return `Pocket ${RANK_FULL_NAMES[r1]}s`;
  }

  const suitLabel = (s1 === s2) ? 'suited' : 'offsuit';
  return `${RANK_FULL_NAMES[highRank]}-${RANK_FULL_NAMES[lowRank]} ${suitLabel}`;
}

// ── Deck operations ─────────────────────────────────────────────────

/**
 * Create a fresh deck of 52 cards as an array of integers 0-51.
 * @returns {number[]}
 */
export function createDeck() {
  const deck = new Array(52);
  for (let i = 0; i < 52; i++) {
    deck[i] = i;
  }
  return deck;
}

/**
 * Fisher-Yates (Knuth) shuffle — in-place, unbiased.
 * Iterates from the last element down to index 1, swapping each element
 * with a random element at index 0..i (inclusive).
 *
 * @param {number[]} deck - Array of card integers to shuffle in-place
 * @returns {number[]} The same array, shuffled
 */
export function shuffleDeck(deck) {
  for (let i = deck.length - 1; i >= 1; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    const temp = deck[i];
    deck[i] = deck[j];
    deck[j] = temp;
  }
  return deck;
}

/**
 * Create a deck that excludes a set of known cards (e.g. hole cards + board).
 * Useful for Monte Carlo dealing of remaining unknowns.
 *
 * @param {number[]} excludedCards - Array of card integers to exclude
 * @returns {number[]} A new deck array with excluded cards removed
 */
export function createFilteredDeck(excludedCards) {
  const excluded = new Set(excludedCards);
  const deck = [];
  for (let i = 0; i < 52; i++) {
    if (!excluded.has(i)) {
      deck.push(i);
    }
  }
  return deck;
}

// ── Hand evaluation ─────────────────────────────────────────────────
//
// Hand ranks (higher is better):
//   9 = Straight Flush (includes Royal Flush)
//   8 = Four of a Kind
//   7 = Full House
//   6 = Flush
//   5 = Straight
//   4 = Three of a Kind
//   3 = Two Pair
//   2 = One Pair
//   1 = High Card
//
// The evaluator returns a comparable score: a 32-bit integer where the
// high bits encode the hand rank and the low bits encode the kicker
// values, so that simple numeric comparison determines the winner.
//
// Score layout (from MSB to LSB):
//   bits 24-27: hand rank (1-9)
//   bits 20-23: primary rank (e.g. pair rank, trips rank, high card of straight)
//   bits 16-19: secondary rank (e.g. second pair, full house pair rank)
//   bits 12-15: kicker 1
//   bits  8-11: kicker 2
//   bits  4-7:  kicker 3
//
// This scheme allows direct numeric comparison of any two hands.

/** @type {readonly string[]} Human-readable hand rank names, indexed 0-9 */
export const HAND_RANK_NAMES = Object.freeze([
  '',              // 0 unused
  'High Card',
  'One Pair',
  'Two Pair',
  'Three of a Kind',
  'Straight',
  'Flush',
  'Full House',
  'Four of a Kind',
  'Straight Flush'
]);

/**
 * Evaluate exactly 5 cards and return a numeric score for comparison.
 *
 * @param {number} c0 - Card integer 0-51
 * @param {number} c1 - Card integer 0-51
 * @param {number} c2 - Card integer 0-51
 * @param {number} c3 - Card integer 0-51
 * @param {number} c4 - Card integer 0-51
 * @returns {number} Comparable hand score (higher is better)
 */
export function evaluate5(c0, c1, c2, c3, c4) {
  // Extract ranks and suits
  const ranks = [c0 % 13, c1 % 13, c2 % 13, c3 % 13, c4 % 13];
  const suits = [(c0 / 13) | 0, (c1 / 13) | 0, (c2 / 13) | 0, (c3 / 13) | 0, (c4 / 13) | 0];

  // Sort ranks descending for kicker ordering
  ranks.sort((a, b) => b - a);

  // Check flush (all same suit)
  const isFlush = suits[0] === suits[1] && suits[1] === suits[2] &&
                  suits[2] === suits[3] && suits[3] === suits[4];

  // Check straight
  let isStraight = false;
  let straightHigh = 0;

  // Normal straight: consecutive ranks
  if (ranks[0] - ranks[4] === 4 &&
      ranks[0] !== ranks[1] && ranks[1] !== ranks[2] &&
      ranks[2] !== ranks[3] && ranks[3] !== ranks[4]) {
    isStraight = true;
    straightHigh = ranks[0];
  }

  // Ace-low straight (wheel): A-5-4-3-2 => ranks sorted = [12, 3, 2, 1, 0]
  if (!isStraight &&
      ranks[0] === 12 && ranks[1] === 3 && ranks[2] === 2 &&
      ranks[3] === 1 && ranks[4] === 0) {
    isStraight = true;
    // Ace is low in the wheel; the "high" card of the straight is the 5 (rank 3)
    straightHigh = 3;
  }

  // Straight flush
  if (isFlush && isStraight) {
    return (9 << 24) | (straightHigh << 20);
  }

  // Count rank occurrences
  const counts = new Array(13).fill(0);
  for (let i = 0; i < 5; i++) {
    counts[ranks[i]]++;
  }

  // Group ranks by their count for pattern matching
  let quads = -1;
  let trips = -1;
  let pairs = [];   // may have 0, 1, or 2 entries
  let kickers = []; // singles, descending (already sorted since ranks is sorted)

  // Walk ranks in descending order to preserve kicker ordering
  const seen = new Set();
  for (let i = 0; i < 5; i++) {
    const r = ranks[i];
    if (seen.has(r)) continue;
    seen.add(r);
    const c = counts[r];
    if (c === 4) quads = r;
    else if (c === 3) trips = r;
    else if (c === 2) pairs.push(r);
    else kickers.push(r);
  }

  // Pairs should be sorted descending (they already are since we walk sorted ranks)
  // But ensure correctness:
  if (pairs.length === 2 && pairs[0] < pairs[1]) {
    const tmp = pairs[0];
    pairs[0] = pairs[1];
    pairs[1] = tmp;
  }

  // Four of a kind
  if (quads !== -1) {
    return (8 << 24) | (quads << 20) | ((kickers[0] || 0) << 16);
  }

  // Full house
  if (trips !== -1 && pairs.length === 1) {
    return (7 << 24) | (trips << 20) | (pairs[0] << 16);
  }

  // Flush (not straight, handled above)
  if (isFlush) {
    return (6 << 24) | (ranks[0] << 20) | (ranks[1] << 16) |
           (ranks[2] << 12) | (ranks[3] << 8) | (ranks[4] << 4);
  }

  // Straight (not flush, handled above)
  if (isStraight) {
    return (5 << 24) | (straightHigh << 20);
  }

  // Three of a kind (no pair, otherwise it would be full house)
  if (trips !== -1) {
    return (4 << 24) | (trips << 20) | ((kickers[0] || 0) << 16) |
           ((kickers[1] || 0) << 12);
  }

  // Two pair
  if (pairs.length === 2) {
    return (3 << 24) | (pairs[0] << 20) | (pairs[1] << 16) |
           ((kickers[0] || 0) << 12);
  }

  // One pair
  if (pairs.length === 1) {
    return (2 << 24) | (pairs[0] << 20) |
           ((kickers[0] || 0) << 16) | ((kickers[1] || 0) << 12) |
           ((kickers[2] || 0) << 8);
  }

  // High card
  return (1 << 24) | (ranks[0] << 20) | (ranks[1] << 16) |
         (ranks[2] << 12) | (ranks[3] << 8) | (ranks[4] << 4);
}

/**
 * Evaluate the best 5-card hand from exactly 7 cards.
 * Tests all C(7,5) = 21 combinations and returns the highest score.
 *
 * @param {number[]} cards - Array of exactly 7 card integers (0-51)
 * @returns {number} The best 5-card hand score
 */
export function evaluate7(cards) {
  let best = 0;

  // Enumerate all 21 combinations of 5 from 7
  for (let i = 0; i < 7; i++) {
    for (let j = i + 1; j < 7; j++) {
      // i and j are the two cards to EXCLUDE
      // Collect the other 5
      const hand = [];
      for (let k = 0; k < 7; k++) {
        if (k !== i && k !== j) {
          hand.push(cards[k]);
        }
      }
      const score = evaluate5(hand[0], hand[1], hand[2], hand[3], hand[4]);
      if (score > best) {
        best = score;
      }
    }
  }

  return best;
}

/**
 * Extract the hand rank category (1-9) from a hand score.
 * @param {number} score - Hand score from evaluate5 or evaluate7
 * @returns {number} Hand rank 1-9
 */
export function handRankFromScore(score) {
  return (score >>> 24) & 0xF;
}

/**
 * Get the human-readable name for a hand score.
 * @param {number} score - Hand score from evaluate5 or evaluate7
 * @returns {string} E.g. "Flush", "Two Pair", "Straight Flush"
 */
export function handNameFromScore(score) {
  const rank = handRankFromScore(score);
  return HAND_RANK_NAMES[rank] || 'Unknown';
}
