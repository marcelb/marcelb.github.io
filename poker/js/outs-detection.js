/**
 * outs-detection.js -- Pure-logic module for analyzing poker hands.
 *
 * Detects draws (flush draw, OESD, gutshot, overcards, set draw,
 * pair draw, trips draw), identifies the current made hand, computes
 * outs as actual card integers, and calculates probabilities.
 * Zero DOM dependencies.
 *
 * @module outs-detection
 */

import {
  cardRank,
  cardSuit,
  evaluate5,
  evaluate7,
  handRankFromScore,
  RANK_FULL_NAMES,
  HAND_RANK_NAMES,
} from './poker-core.js';

// ── Internal helpers ────────────────────────────────────────────────

/**
 * Build a set of all 52 card integers that are NOT in the visible cards.
 * @param {number[]} visibleCards - Combined hole + board cards
 * @returns {Set<number>}
 */
function unseenCardSet(visibleCards) {
  const visible = new Set(visibleCards);
  const unseen = new Set();
  for (let i = 0; i < 52; i++) {
    if (!visible.has(i)) {
      unseen.add(i);
    }
  }
  return unseen;
}

/**
 * Extract the primary rank (bits 20-23) from a hand score.
 * @param {number} score
 * @returns {number}
 */
function primaryRankFromScore(score) {
  return (score >>> 20) & 0xF;
}

/**
 * Extract the secondary rank (bits 16-19) from a hand score.
 * @param {number} score
 * @returns {number}
 */
function secondaryRankFromScore(score) {
  return (score >>> 16) & 0xF;
}

/**
 * Returns the plural form of a rank name.
 * Handles the irregular case: "Six" -> "Sixes".
 * All other rank names pluralize correctly with a simple "s" suffix.
 * @param {string} rankName
 * @returns {string}
 */
function pluralRankName(rankName) {
  if (rankName === 'Six') return 'Sixes';
  return rankName + 's';
}

// ── Made hand detection ─────────────────────────────────────────────

/**
 * Evaluates the best made hand from hole cards + board and returns
 * a descriptive name and numeric rank.
 *
 * @param {number[]} holeCards - Array of 0-2 card integers
 * @param {number[]} boardCards - Array of 0-5 card integers
 * @returns {{ name: string, rank: number } | null}
 */
function detectMadeHand(holeCards, boardCards) {
  const allCards = [...holeCards, ...boardCards];
  const total = allCards.length;

  if (total < 5) {
    return null;
  }

  let score;
  if (total === 5) {
    score = evaluate5(allCards[0], allCards[1], allCards[2], allCards[3], allCards[4]);
  } else if (total === 6) {
    // Best 5 of 6: try all C(6,5) = 6 combos
    score = 0;
    for (let skip = 0; skip < 6; skip++) {
      const hand = [];
      for (let i = 0; i < 6; i++) {
        if (i !== skip) hand.push(allCards[i]);
      }
      const s = evaluate5(hand[0], hand[1], hand[2], hand[3], hand[4]);
      if (s > score) score = s;
    }
  } else if (total === 7) {
    score = evaluate7(allCards);
  } else {
    return null;
  }

  const handRank = handRankFromScore(score);
  const name = formatMadeHandName(score, handRank);

  return { name, rank: handRank };
}

/**
 * Formats a descriptive name for a made hand, e.g. "Pair of Kings",
 * "Two Pair, Aces and Sevens", "Straight, King high".
 *
 * @param {number} score - Hand evaluation score
 * @param {number} handRank - Hand rank category 1-9
 * @returns {string}
 */
function formatMadeHandName(score, handRank) {
  const primary = primaryRankFromScore(score);
  const secondary = secondaryRankFromScore(score);

  switch (handRank) {
    case 9: // Straight Flush
      if (primary === 12) return 'Royal Flush';
      return `Straight Flush, ${RANK_FULL_NAMES[primary]} high`;

    case 8: // Four of a Kind
      return `Four of a Kind, ${pluralRankName(RANK_FULL_NAMES[primary])}`;

    case 7: // Full House
      return `Full House, ${pluralRankName(RANK_FULL_NAMES[primary])} full of ${pluralRankName(RANK_FULL_NAMES[secondary])}`;

    case 6: // Flush
      return `Flush, ${RANK_FULL_NAMES[primary]} high`;

    case 5: // Straight
      return `Straight, ${RANK_FULL_NAMES[primary]} high`;

    case 4: // Three of a Kind
      return `Three of a Kind, ${pluralRankName(RANK_FULL_NAMES[primary])}`;

    case 3: // Two Pair
      return `Two Pair, ${pluralRankName(RANK_FULL_NAMES[primary])} and ${pluralRankName(RANK_FULL_NAMES[secondary])}`;

    case 2: // One Pair
      return `Pair of ${pluralRankName(RANK_FULL_NAMES[primary])}`;

    case 1: // High Card
      return `High Card, ${RANK_FULL_NAMES[primary]}`;

    default:
      return HAND_RANK_NAMES[handRank] || 'Unknown';
  }
}

// ── Draw detection ──────────────────────────────────────────────────

/**
 * Detects flush draws (exactly 4 cards of one suit, needing 1 more).
 *
 * @param {number[]} allCards - All visible cards (hole + board)
 * @param {Set<number>} unseen - Set of unseen card integers
 * @returns {Array<{ name: string, outs: number[], description: string }>}
 */
function detectFlushDraws(allCards, unseen) {
  const draws = [];
  const suitCounts = [0, 0, 0, 0];

  for (const card of allCards) {
    suitCounts[cardSuit(card)]++;
  }

  for (let suit = 0; suit < 4; suit++) {
    if (suitCounts[suit] === 4) {
      const outs = [];
      for (const card of unseen) {
        if (cardSuit(card) === suit) {
          outs.push(card);
        }
      }
      if (outs.length > 0) {
        draws.push({
          name: 'Flush draw',
          outs,
          description: `4 cards of one suit, ${outs.length} remaining to complete the flush`,
        });
      }
    }
  }

  return draws;
}

/**
 * Detects straight draws (OESD and gutshot) from the combined hand.
 *
 * Checks all 10 possible 5-rank straight windows (including the wheel).
 * For each window where exactly 4 of 5 required ranks are present:
 *   - If the 4 present ranks are consecutive: OESD (open-ended straight draw)
 *   - If the 4 present ranks have an internal gap: gutshot
 *
 * OESD draws from adjacent windows sharing the same 4 consecutive ranks
 * are combined into a single draw entry with all completing cards as outs.
 *
 * @param {number[]} allCards - All visible cards (hole + board)
 * @param {Set<number>} unseen - Set of unseen card integers
 * @returns {Array<{ name: string, outs: number[], description: string }>}
 */
function detectStraightDraws(allCards, unseen) {
  const draws = [];
  const rankSet = new Set();
  for (const card of allCards) {
    rankSet.add(cardRank(card));
  }

  // All 10 possible 5-rank straight windows
  const windows = [];
  for (let low = 0; low <= 8; low++) {
    const w = [];
    for (let i = 0; i < 5; i++) {
      w.push(low + i);
    }
    windows.push(w);
  }
  // Wheel: A-2-3-4-5 => ranks [12, 0, 1, 2, 3]
  windows.push([12, 0, 1, 2, 3]);

  // Track missing ranks already reported to avoid duplicate draw entries
  const reportedMissingRanks = new Set();

  for (const window of windows) {
    const present = [];
    const missing = [];

    for (const rank of window) {
      if (rankSet.has(rank)) {
        present.push(rank);
      } else {
        missing.push(rank);
      }
    }

    if (present.length !== 4 || missing.length !== 1) {
      continue;
    }

    const missingRank = missing[0];

    if (reportedMissingRanks.has(missingRank)) {
      continue;
    }

    // Collect outs: unseen cards of the missing rank
    const outs = [];
    for (const card of unseen) {
      if (cardRank(card) === missingRank) {
        outs.push(card);
      }
    }

    if (outs.length === 0) {
      continue;
    }

    reportedMissingRanks.add(missingRank);

    // Determine OESD vs gutshot based on whether the 4 present ranks
    // are consecutive. OESD = 4 in a row; gutshot = gap in the middle.
    const sortedPresent = [...present].sort((a, b) => a - b);
    const isWheel = (window[0] === 12);

    let fourAreConsecutive;
    if (isWheel) {
      fourAreConsecutive = areFourConsecutiveWithWrap(sortedPresent);
    } else {
      fourAreConsecutive = (sortedPresent[3] - sortedPresent[0] === 3);
    }

    if (fourAreConsecutive) {
      // 4 consecutive ranks -- OESD. Tag with group key so adjacent
      // windows producing the same 4 ranks get their outs merged.
      const groupKey = sortedPresent.join(',');
      draws.push({
        name: 'Open-ended straight draw',
        outs,
        description: `4 consecutive ranks, need ${RANK_FULL_NAMES[missingRank]} to complete`,
        _oesdGroup: groupKey,
        _isOesd: true,
      });
    } else {
      // Internal gap -- gutshot
      draws.push({
        name: 'Gutshot straight draw',
        outs,
        description: `Need ${RANK_FULL_NAMES[missingRank]} to complete the straight`,
      });
    }
  }

  // Combine OESD draws that share the same 4 consecutive ranks.
  // Two windows may each contribute one missing rank for the same group.
  const oesdGroups = new Map();
  const nonOesdDraws = [];

  for (const draw of draws) {
    if (draw._isOesd) {
      const key = draw._oesdGroup;
      if (!oesdGroups.has(key)) {
        oesdGroups.set(key, { outs: [], ranks: [] });
      }
      const group = oesdGroups.get(key);
      group.outs.push(...draw.outs);
      if (draw.outs.length > 0) {
        group.ranks.push(cardRank(draw.outs[0]));
      }
    } else {
      nonOesdDraws.push(draw);
    }
  }

  const result = [];

  for (const [, group] of oesdGroups) {
    const rankNames = group.ranks.map(r => RANK_FULL_NAMES[r]).join(' or ');

    if (group.ranks.length === 1) {
      // Only one missing rank -- one-sided draw (e.g. A-K-Q-J or A-2-3-4).
      // Reclassify as gutshot since it is completable on one end only.
      result.push({
        name: 'Gutshot straight draw',
        outs: group.outs,
        description: `Need ${rankNames} to complete the straight`,
      });
    } else {
      result.push({
        name: 'Open-ended straight draw',
        outs: group.outs,
        description: `4 consecutive ranks, need ${rankNames} to complete`,
      });
    }
  }

  result.push(...nonOesdDraws);

  return result;
}

/**
 * Check if 4 sorted ranks form a consecutive sequence considering
 * the wheel wrap (Ace = 12 wrapping to Two = 0).
 *
 * @param {number[]} sortedRanks - 4 ranks sorted ascending
 * @returns {boolean}
 */
function areFourConsecutiveWithWrap(sortedRanks) {
  // Normal consecutive: max - min === 3
  if (sortedRanks[3] - sortedRanks[0] === 3) {
    return true;
  }

  // Wheel wrap: A-2-3-4 => sorted [0, 1, 2, 12]
  if (sortedRanks[0] === 0 && sortedRanks[3] === 12 &&
      sortedRanks[1] === 1 && sortedRanks[2] === 2) {
    return true;
  }

  return false;
}

/**
 * Detects overcard draws (both hole cards strictly above all board cards,
 * and neither has paired with the board).
 *
 * @param {number[]} holeCards - The player's hole cards
 * @param {number[]} boardCards - The community cards
 * @param {Set<number>} unseen - Set of unseen card integers
 * @returns {Array<{ name: string, outs: number[], description: string }>}
 */
function detectOvercardDraws(holeCards, boardCards, unseen) {
  if (holeCards.length !== 2 || boardCards.length < 3) {
    return [];
  }

  const holeRank0 = cardRank(holeCards[0]);
  const holeRank1 = cardRank(holeCards[1]);

  // Pocket pair: set-draw detector handles this, not overcards
  if (holeRank0 === holeRank1) {
    return [];
  }

  let maxBoardRank = -1;
  const boardRanks = [];
  for (const card of boardCards) {
    const r = cardRank(card);
    boardRanks.push(r);
    if (r > maxBoardRank) maxBoardRank = r;
  }

  // Both hole cards must be strictly higher than ALL board cards
  if (holeRank0 <= maxBoardRank || holeRank1 <= maxBoardRank) {
    return [];
  }

  // Neither hole card should have paired with the board
  for (const br of boardRanks) {
    if (br === holeRank0 || br === holeRank1) {
      return [];
    }
  }

  // Outs: remaining cards matching either hole card rank
  const outs = [];
  for (const card of unseen) {
    const r = cardRank(card);
    if (r === holeRank0 || r === holeRank1) {
      outs.push(card);
    }
  }

  if (outs.length === 0) {
    return [];
  }

  return [{
    name: 'Two overcards',
    outs,
    description: `Both hole cards (${RANK_FULL_NAMES[holeRank0]}, ${RANK_FULL_NAMES[holeRank1]}) above all board cards`,
  }];
}

/**
 * Detects set draws (pocket pair that hasn't made a set/trips yet).
 *
 * @param {number[]} holeCards - The player's hole cards
 * @param {number[]} boardCards - The community cards
 * @param {Set<number>} unseen - Set of unseen card integers
 * @returns {Array<{ name: string, outs: number[], description: string }>}
 */
function detectSetDraws(holeCards, boardCards, unseen) {
  if (holeCards.length !== 2) {
    return [];
  }

  const r0 = cardRank(holeCards[0]);
  const r1 = cardRank(holeCards[1]);

  if (r0 !== r1) {
    return [];
  }

  const pairRank = r0;
  let countOfRank = 2;
  for (const card of boardCards) {
    if (cardRank(card) === pairRank) {
      countOfRank++;
    }
  }

  // Already have quads -- no further improvement possible
  if (countOfRank >= 4) {
    return [];
  }

  const outs = [];
  for (const card of unseen) {
    if (cardRank(card) === pairRank) {
      outs.push(card);
    }
  }

  if (outs.length === 0) {
    return [];
  }

  const rankName = RANK_FULL_NAMES[pairRank];
  if (countOfRank === 3) {
    // Already have a set -- drawing to quads
    return [{
      name: 'Quads draw',
      outs,
      description: `Set of ${pluralRankName(rankName)}, need the last one for four of a kind`,
    }];
  }

  return [{
    name: 'Set draw',
    outs,
    description: `Pocket ${pluralRankName(rankName)}, need one more on the board`,
  }];
}

/**
 * Detects pair draws: when an unpaired, non-pocket-pair hole card can
 * improve to a pair (or two pair if the player already has a pair).
 *
 * For each hole card whose rank does NOT match the other hole card's rank
 * AND does NOT match any board card rank, the remaining unseen cards of
 * that rank are outs.
 *
 * @param {number[]} holeCards - The player's hole cards
 * @param {number[]} boardCards - The community cards
 * @param {Set<number>} unseen - Set of unseen card integers
 * @param {{ name: string, rank: number } | null} madeHand - Current made hand
 * @returns {Array<{ name: string, outs: number[], description: string }>}
 */
function detectPairDraws(holeCards, boardCards, unseen, madeHand) {
  if (holeCards.length !== 2) {
    return [];
  }

  const r0 = cardRank(holeCards[0]);
  const r1 = cardRank(holeCards[1]);

  // Pocket pair: set draw handles this case
  if (r0 === r1) {
    return [];
  }

  const boardRankCounts = new Map();
  for (const card of boardCards) {
    const r = cardRank(card);
    boardRankCounts.set(r, (boardRankCounts.get(r) || 0) + 1);
  }

  // Determine improvement label based on current made hand rank
  let improvementLabel;
  if (madeHand === null || madeHand.rank < 2) {
    // No pair yet -- pairing a hole card makes a pair
    improvementLabel = 'a pair';
  } else if (madeHand.rank === 2) {
    // Already has one pair -- pairing the other hole card makes two pair
    improvementLabel = 'two pair';
  } else {
    // Already two pair (3) or better -- pairing an unpaired hole card makes a full house
    improvementLabel = 'a full house';
  }

  const draws = [];

  for (const holeRank of [r0, r1]) {
    // Skip if this hole card already matches a board card (already paired)
    if (boardRankCounts.has(holeRank)) {
      continue;
    }

    // Collect unseen cards of this rank
    const outs = [];
    for (const card of unseen) {
      if (cardRank(card) === holeRank) {
        outs.push(card);
      }
    }

    if (outs.length === 0) {
      continue;
    }

    const rankName = RANK_FULL_NAMES[holeRank];
    draws.push({
      name: `Pair draw (${pluralRankName(rankName)})`,
      outs,
      description: `Hit ${rankName} to make ${improvementLabel}`,
    });
  }

  return draws;
}

/**
 * Detects trips draws: when a hole card's rank matches exactly one board
 * card's rank (giving a pair), and the hole cards are NOT a pocket pair,
 * the remaining unseen cards of that rank are outs to trips.
 *
 * Must NOT fire when the rank appears 2+ times on the board (player
 * already has trips or better from that rank).
 *
 * @param {number[]} holeCards - The player's hole cards
 * @param {number[]} boardCards - The community cards
 * @param {Set<number>} unseen - Set of unseen card integers
 * @returns {Array<{ name: string, outs: number[], description: string }>}
 */
function detectTripsDraws(holeCards, boardCards, unseen) {
  if (holeCards.length !== 2) {
    return [];
  }

  const r0 = cardRank(holeCards[0]);
  const r1 = cardRank(holeCards[1]);

  // Pocket pair: set draw handles this case
  if (r0 === r1) {
    return [];
  }

  const boardRankCounts = new Map();
  for (const card of boardCards) {
    const r = cardRank(card);
    boardRankCounts.set(r, (boardRankCounts.get(r) || 0) + 1);
  }

  const draws = [];

  for (const holeRank of [r0, r1]) {
    const boardCount = boardRankCounts.get(holeRank) || 0;

    // Exactly one board card matches -- player has a pair, can improve to trips
    if (boardCount !== 1) {
      continue;
    }

    const outs = [];
    for (const card of unseen) {
      if (cardRank(card) === holeRank) {
        outs.push(card);
      }
    }

    if (outs.length === 0) {
      continue;
    }

    const rankName = RANK_FULL_NAMES[holeRank];
    draws.push({
      name: `Trips draw (${pluralRankName(rankName)})`,
      outs,
      description: `Pair of ${pluralRankName(rankName)}, need one more for three of a kind`,
    });
  }

  return draws;
}

/**
 * Detects full house draws:
 *
 * (a) Two pair → full house: when the made hand is two pair, any unseen
 *     card matching either paired rank makes a full house.
 * (b) Trips → full house: when the made hand is three of a kind, any
 *     unseen card that pairs a board card or hole card (other than the
 *     trips rank) makes a full house. Only counts ranks that appear in
 *     the player's 7-card hand (hole + board).
 *
 * @param {number[]} holeCards - The player's hole cards
 * @param {number[]} boardCards - The community cards
 * @param {Set<number>} unseen - Set of unseen card integers
 * @param {{ name: string, rank: number } | null} madeHand - Current made hand
 * @returns {Array<{ name: string, outs: number[], description: string }>}
 */
function detectFullHouseDraws(holeCards, boardCards, unseen, madeHand) {
  if (!madeHand) return [];

  const allCards = [...holeCards, ...boardCards];

  if (madeHand.rank === 3) {
    // Two pair → full house: need to hit one of the two paired ranks
    // Find which ranks are paired
    const rankCounts = new Map();
    for (const card of allCards) {
      const r = cardRank(card);
      rankCounts.set(r, (rankCounts.get(r) || 0) + 1);
    }

    const outs = [];
    const pairedRanks = [];
    for (const [rank, count] of rankCounts) {
      if (count === 2) {
        pairedRanks.push(rank);
        for (const card of unseen) {
          if (cardRank(card) === rank) {
            outs.push(card);
          }
        }
      }
    }

    if (outs.length === 0) return [];

    const rankNames = pairedRanks.map(r => RANK_FULL_NAMES[r]);
    return [{
      name: 'Full house draw',
      outs,
      description: `Two pair, need a ${rankNames.join(' or ')} for a full house`,
    }];
  }

  if (madeHand.rank === 4) {
    // Three of a kind → full house: need to pair any other rank present
    // in the hand (hole + board cards)
    const rankCounts = new Map();
    for (const card of allCards) {
      const r = cardRank(card);
      rankCounts.set(r, (rankCounts.get(r) || 0) + 1);
    }

    // Find the trips rank (count >= 3)
    let tripsRank = -1;
    for (const [rank, count] of rankCounts) {
      if (count >= 3) {
        tripsRank = rank;
        break;
      }
    }

    // Collect outs: unseen cards that pair any non-trips rank in the hand
    const outs = [];
    const helpingRanks = [];
    for (const [rank, count] of rankCounts) {
      if (rank === tripsRank) continue;
      if (count >= 2) continue; // already paired, would make a higher hand
      let found = false;
      for (const card of unseen) {
        if (cardRank(card) === rank) {
          outs.push(card);
          found = true;
        }
      }
      if (found) helpingRanks.push(rank);
    }

    if (outs.length === 0) return [];

    return [{
      name: 'Full house draw',
      outs,
      description: `Three of a kind, need to pair the board for a full house`,
    }];
  }

  return [];
}

// ── Probability calculations ────────────────────────────────────────

/**
 * Probability of hitting at least one out on the next card dealt.
 *
 * @param {number} outsCount - Number of outs
 * @param {number} unseenCount - Number of unseen cards
 * @returns {number} Probability as a decimal (0 to 1)
 */
function probabilityNextCard(outsCount, unseenCount) {
  if (unseenCount <= 0) return 0;
  return outsCount / unseenCount;
}

/**
 * Probability of hitting at least one out across two cards (turn + river),
 * using the complement method:
 *   P = 1 - ((unseen - outs) / unseen) * ((unseen - 1 - outs) / (unseen - 1))
 *
 * @param {number} outsCount - Number of outs
 * @param {number} unseenCount - Unseen cards when the first card is dealt
 * @returns {number} Probability as a decimal (0 to 1)
 */
function probabilityByRiver(outsCount, unseenCount) {
  if (unseenCount <= 1) return 0;
  const missFirst = (unseenCount - outsCount) / unseenCount;
  const missSecond = (unseenCount - 1 - outsCount) / (unseenCount - 1);
  return 1 - (missFirst * missSecond);
}

// ── Main entry point ────────────────────────────────────────────────

/**
 * Analyzes hole cards + board cards for draws, outs, made hand, and probabilities.
 *
 * @param {number[]} holeCards - Array of 0-2 card integers (player's hole cards)
 * @param {number[]} boardCards - Array of 0-5 card integers (community cards)
 * @returns {{
 *   madeHand: { name: string, rank: number } | null,
 *   draws: Array<{ name: string, outs: number[], description: string, probability: { nextCard: number, byRiver: number } }>,
 *   totalOuts: number[],
 *   probabilities: { nextCard: number, byRiver: number }
 * }}
 */
export function detectDraws(holeCards, boardCards) {
  const allCards = [...holeCards, ...boardCards];
  const unseen = unseenCardSet(allCards);
  const unseenCount = unseen.size;

  const madeHand = detectMadeHand(holeCards, boardCards);

  // Board with 5 cards (river) or fewer than 3: no draw detection
  if (boardCards.length >= 5 || boardCards.length < 3) {
    return {
      madeHand,
      draws: [],
      totalOuts: [],
      probabilities: { nextCard: 0, byRiver: 0 },
    };
  }

  // Need 2 hole cards for meaningful draw detection
  if (holeCards.length < 2) {
    return {
      madeHand,
      draws: [],
      totalOuts: [],
      probabilities: { nextCard: 0, byRiver: 0 },
    };
  }

  const draws = [];

  draws.push(...detectFlushDraws(allCards, unseen));
  draws.push(...detectStraightDraws(allCards, unseen));
  draws.push(...detectOvercardDraws(holeCards, boardCards, unseen));
  draws.push(...detectSetDraws(holeCards, boardCards, unseen));
  draws.push(...detectPairDraws(holeCards, boardCards, unseen, madeHand));
  draws.push(...detectTripsDraws(holeCards, boardCards, unseen));
  draws.push(...detectFullHouseDraws(holeCards, boardCards, unseen, madeHand));

  // Attach per-draw probability so each draw can be displayed independently
  for (const draw of draws) {
    const drawOutsCount = draw.outs.length;
    if (boardCards.length === 3) {
      draw.probability = {
        nextCard: probabilityNextCard(drawOutsCount, unseenCount),
        byRiver: probabilityByRiver(drawOutsCount, unseenCount),
      };
    } else if (boardCards.length === 4) {
      const nc = probabilityNextCard(drawOutsCount, unseenCount);
      draw.probability = {
        nextCard: nc,
        byRiver: nc,
      };
    } else {
      draw.probability = { nextCard: 0, byRiver: 0 };
    }
  }

  // De-duplicate total outs: set union of all individual draw outs arrays
  const outsSet = new Set();
  for (const draw of draws) {
    for (const card of draw.outs) {
      outsSet.add(card);
    }
  }
  const totalOuts = [...outsSet].sort((a, b) => a - b);

  // Calculate total probabilities based on board state
  const outsCount = totalOuts.length;
  let nextCard = 0;
  let byRiver = 0;

  if (boardCards.length === 3) {
    // Flop: 2 cards to come
    nextCard = probabilityNextCard(outsCount, unseenCount);
    byRiver = probabilityByRiver(outsCount, unseenCount);
  } else if (boardCards.length === 4) {
    // Turn: 1 card to come
    nextCard = probabilityNextCard(outsCount, unseenCount);
    byRiver = nextCard;
  }

  return {
    madeHand,
    draws,
    totalOuts,
    probabilities: { nextCard, byRiver },
  };
}
