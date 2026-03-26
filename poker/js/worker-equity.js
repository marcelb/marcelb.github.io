/**
 * worker-equity.js -- Web Worker for Monte Carlo equity simulation.
 *
 * Self-contained: duplicates the minimal card encoding and hand evaluation
 * logic from poker-core.js because Web Workers cannot reliably import
 * ES modules in all target browsers.
 *
 * Message protocol (structured messages):
 *   Incoming:
 *     { type: 'start', data: { holeCards: number[], boardCards: number[], iterations: number, opponentCount?: number } }
 *     { type: 'start-win-if-hit', data: { holeCards: number[], boardCards: number[], draws: Array<{ outs: number[] }>, opponentCount?: number, iterationsPerDraw?: number, generation?: number } }
 *     { type: 'cancel' }
 *   Outgoing:
 *     { type: 'progress', data: { completed: number, total: number } }
 *     { type: 'result', data: { wins: number, ties: number, losses: number, total: number } }
 *     { type: 'result-win-if-hit', data: { results: Array<{ drawIndex: number, wins: number, total: number }>, generation: number } }
 *
 * Card encoding (same as poker-core.js):
 *   Integer 0-51. rank = card % 13, suit = (card / 13) | 0
 *   Rank: 0=2, 1=3, ..., 8=T, 9=J, 10=Q, 11=K, 12=A
 *   Suit: 0=clubs, 1=diamonds, 2=hearts, 3=spades
 *
 * Performance target: 10,000 iterations in under 2 seconds on a mid-range phone.
 */

// ── State ────────────────────────────────────────────────────────────

let cancelled = false;

// ── Fisher-Yates shuffle (partial) ───────────────────────────────────
//
// For the Monte Carlo loop we only need to draw a few cards from the
// remaining deck, so we do a partial Fisher-Yates: shuffle from the
// end but stop once we have drawn enough cards. This avoids shuffling
// the entire deck when we only need 7-9 cards.

/**
 * Partially shuffle the deck in-place and return it. After calling this,
 * the last `count` elements of the array are a uniformly random sample.
 *
 * @param {Int8Array} deck - The deck to shuffle (modified in place)
 * @param {number} count - How many cards to draw from the end
 * @returns {Int8Array} Same array reference
 */
function partialShuffle(deck, count) {
  const len = deck.length;
  for (let i = len - 1; i >= len - count; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    const temp = deck[i];
    deck[i] = deck[j];
    deck[j] = temp;
  }
  return deck;
}

// ── 5-card hand evaluator ────────────────────────────────────────────
//
// Duplicated from poker-core.js evaluate5. Returns a comparable integer
// score where higher is better. Score encoding:
//   bits 24-27: hand rank (1-9)
//   bits 20-23: primary rank
//   bits 16-19: secondary rank
//   bits 12-15: kicker 1
//   bits 8-11:  kicker 2
//   bits 4-7:   kicker 3

/**
 * Evaluate exactly 5 cards and return a numeric score.
 * @param {number} c0
 * @param {number} c1
 * @param {number} c2
 * @param {number} c3
 * @param {number} c4
 * @returns {number}
 */
function evaluate5(c0, c1, c2, c3, c4) {
  const r0 = c0 % 13;
  const r1 = c1 % 13;
  const r2 = c2 % 13;
  const r3 = c3 % 13;
  const r4 = c4 % 13;

  const s0 = (c0 / 13) | 0;
  const s1 = (c1 / 13) | 0;
  const s2 = (c2 / 13) | 0;
  const s3 = (c3 / 13) | 0;
  const s4 = (c4 / 13) | 0;

  // Sort ranks descending (5-element insertion sort -- fast for tiny arrays)
  const ranks = [r0, r1, r2, r3, r4];
  for (let i = 1; i < 5; i++) {
    const key = ranks[i];
    let j = i - 1;
    while (j >= 0 && ranks[j] < key) {
      ranks[j + 1] = ranks[j];
      j--;
    }
    ranks[j + 1] = key;
  }

  // Check flush
  const isFlush = s0 === s1 && s1 === s2 && s2 === s3 && s3 === s4;

  // Check straight
  let isStraight = false;
  let straightHigh = 0;

  if (ranks[0] - ranks[4] === 4 &&
      ranks[0] !== ranks[1] && ranks[1] !== ranks[2] &&
      ranks[2] !== ranks[3] && ranks[3] !== ranks[4]) {
    isStraight = true;
    straightHigh = ranks[0];
  }

  // Ace-low straight (wheel): A-5-4-3-2 => sorted = [12, 3, 2, 1, 0]
  if (!isStraight &&
      ranks[0] === 12 && ranks[1] === 3 && ranks[2] === 2 &&
      ranks[3] === 1 && ranks[4] === 0) {
    isStraight = true;
    straightHigh = 3;
  }

  // Straight flush
  if (isFlush && isStraight) {
    return (9 << 24) | (straightHigh << 20);
  }

  // Count rank occurrences using a small array
  const counts = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  counts[ranks[0]]++;
  counts[ranks[1]]++;
  counts[ranks[2]]++;
  counts[ranks[3]]++;
  counts[ranks[4]]++;

  // Classify ranks by count
  let quads = -1;
  let trips = -1;
  const pairs = [];
  const kickers = [];

  // Track which ranks we have already classified
  let classified0 = false;
  let classified1 = false;
  let classified2 = false;
  let classified3 = false;
  let classified4 = false;

  for (let i = 0; i < 5; i++) {
    if (i === 0 && classified0) continue;
    if (i === 1 && classified1) continue;
    if (i === 2 && classified2) continue;
    if (i === 3 && classified3) continue;
    if (i === 4 && classified4) continue;

    const r = ranks[i];
    const c = counts[r];

    // Mark all subsequent entries of the same rank as classified
    for (let k = i + 1; k < 5; k++) {
      if (ranks[k] === r) {
        if (k === 0) classified0 = true;
        if (k === 1) classified1 = true;
        if (k === 2) classified2 = true;
        if (k === 3) classified3 = true;
        if (k === 4) classified4 = true;
      }
    }

    if (c === 4) quads = r;
    else if (c === 3) trips = r;
    else if (c === 2) pairs.push(r);
    else kickers.push(r);
  }

  // Ensure pairs are in descending order
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

  // Flush
  if (isFlush) {
    return (6 << 24) | (ranks[0] << 20) | (ranks[1] << 16) |
           (ranks[2] << 12) | (ranks[3] << 8) | (ranks[4] << 4);
  }

  // Straight
  if (isStraight) {
    return (5 << 24) | (straightHigh << 20);
  }

  // Three of a kind
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

// ── 7-card hand evaluator ────────────────────────────────────────────

/**
 * Evaluate the best 5-card hand from exactly 7 cards.
 * Enumerates all C(7,5) = 21 combinations by excluding 2 cards.
 *
 * @param {number} c0
 * @param {number} c1
 * @param {number} c2
 * @param {number} c3
 * @param {number} c4
 * @param {number} c5
 * @param {number} c6
 * @returns {number} Best hand score
 */
function evaluate7(c0, c1, c2, c3, c4, c5, c6) {
  const cards = [c0, c1, c2, c3, c4, c5, c6];
  let best = 0;

  // Enumerate all 21 combinations by choosing 2 cards to exclude
  for (let i = 0; i < 7; i++) {
    for (let j = i + 1; j < 7; j++) {
      // Collect the 5 cards that are NOT excluded
      let idx = 0;
      let h0 = 0, h1 = 0, h2 = 0, h3 = 0, h4 = 0;
      for (let k = 0; k < 7; k++) {
        if (k !== i && k !== j) {
          if (idx === 0) h0 = cards[k];
          else if (idx === 1) h1 = cards[k];
          else if (idx === 2) h2 = cards[k];
          else if (idx === 3) h3 = cards[k];
          else h4 = cards[k];
          idx++;
        }
      }
      const score = evaluate5(h0, h1, h2, h3, h4);
      if (score > best) {
        best = score;
      }
    }
  }

  return best;
}

// ── Monte Carlo simulation ───────────────────────────────────────────

/**
 * Run the Monte Carlo equity simulation against N opponents.
 *
 * Player wins only if their score exceeds ALL opponents' scores.
 * Tie occurs only when the player ties the best opponent and beats
 * all others. Any opponent exceeding the player's score is a loss.
 *
 * @param {number[]} holeCards - Player's 2 hole cards
 * @param {number[]} boardCards - 0, 3, 4, or 5 community cards
 * @param {number} iterations - Number of random trials (default 10000)
 * @param {number} opponentCount - Number of opponents (1-9, default 1)
 */
function runSimulation(holeCards, boardCards, iterations, opponentCount) {
  const totalIterations = iterations || 10000;
  const progressInterval = 1000;
  const numOpponents = opponentCount || 1;

  // Build the remaining deck (excluding known cards)
  const excluded = new Set(holeCards.concat(boardCards));
  const remainingCount = 52 - excluded.size;
  const remaining = new Int8Array(remainingCount);
  let idx = 0;
  for (let i = 0; i < 52; i++) {
    if (!excluded.has(i)) {
      remaining[idx++] = i;
    }
  }

  // How many community cards still need to be dealt
  const boardNeeded = 5 - boardCards.length;
  // Each opponent gets 2 hole cards, plus boardNeeded community cards
  const drawCount = 2 * numOpponents + boardNeeded;

  // Prevent drawing more cards than available
  if (drawCount > remainingCount) {
    self.postMessage({
      type: 'result',
      data: { wins: 0, ties: 0, losses: 0, total: 0 }
    });
    return;
  }

  let wins = 0;
  let ties = 0;
  let losses = 0;

  for (let iter = 0; iter < totalIterations; iter++) {
    if (cancelled) {
      return;
    }

    partialShuffle(remaining, drawCount);

    const drawStart = remainingCount - drawCount;

    // Opponent hole cards occupy the first 2*numOpponents drawn slots
    // Board cards follow after opponent cards
    const boardDrawStart = drawStart + 2 * numOpponents;

    const h0 = holeCards[0];
    const h1 = holeCards[1];

    // Full board = existing board + newly dealt board cards
    let b0, b1, b2, b3, b4;
    if (boardCards.length === 5) {
      b0 = boardCards[0];
      b1 = boardCards[1];
      b2 = boardCards[2];
      b3 = boardCards[3];
      b4 = boardCards[4];
    } else if (boardCards.length === 4) {
      b0 = boardCards[0];
      b1 = boardCards[1];
      b2 = boardCards[2];
      b3 = boardCards[3];
      b4 = remaining[boardDrawStart];
    } else if (boardCards.length === 3) {
      b0 = boardCards[0];
      b1 = boardCards[1];
      b2 = boardCards[2];
      b3 = remaining[boardDrawStart];
      b4 = remaining[boardDrawStart + 1];
    } else {
      b0 = remaining[boardDrawStart];
      b1 = remaining[boardDrawStart + 1];
      b2 = remaining[boardDrawStart + 2];
      b3 = remaining[boardDrawStart + 3];
      b4 = remaining[boardDrawStart + 4];
    }

    const playerScore = evaluate7(h0, h1, b0, b1, b2, b3, b4);

    // Evaluate all opponents and determine outcome
    let bestOppScore = 0;
    let anyOppBetter = false;

    for (let opp = 0; opp < numOpponents; opp++) {
      const oppCardStart = drawStart + 2 * opp;
      const oppScore = evaluate7(
        remaining[oppCardStart], remaining[oppCardStart + 1],
        b0, b1, b2, b3, b4
      );
      if (oppScore > playerScore) {
        anyOppBetter = true;
        break;
      }
      if (oppScore > bestOppScore) {
        bestOppScore = oppScore;
      }
    }

    if (anyOppBetter) {
      losses++;
    } else if (playerScore > bestOppScore) {
      wins++;
    } else {
      // playerScore === bestOppScore: tie with the best opponent
      ties++;
    }

    if ((iter + 1) % progressInterval === 0) {
      self.postMessage({
        type: 'progress',
        data: { completed: iter + 1, total: totalIterations }
      });
    }
  }

  self.postMessage({
    type: 'result',
    data: {
      wins: wins,
      ties: ties,
      losses: losses,
      total: totalIterations
    }
  });
}

// ── Win-if-hit simulation ────────────────────────────────────────────
//
// For each draw, forces each of that draw's out cards onto the next
// empty board slot and simulates against N opponents. Aggregates
// wins/total per draw across all outs.

/**
 * Run win-if-hit Monte Carlo simulation for a batch of draws.
 *
 * For each draw, iterates over its outs. For each out card, forces it
 * onto the board (turn slot on flop, river slot on turn) and runs
 * iterationsPerDraw simulations to estimate how often the player wins
 * when that out hits.
 *
 * @param {number[]} holeCards - Player's 2 hole cards
 * @param {number[]} boardCards - 3 or 4 community cards (flop or turn)
 * @param {Array<{ outs: number[] }>} draws - Per-draw outs arrays
 * @param {number} numOpponents - Number of opponents (1-9)
 * @param {number} iterationsPerDraw - Iterations per draw type
 * @param {number} generation - Generation counter for stale-result detection
 */
function runWinIfHit(holeCards, boardCards, draws, numOpponents, iterationsPerDraw, generation) {
  const results = [];
  const knownCards = new Set(holeCards.concat(boardCards));

  // On flop (3 board cards): forced out is turn, need 1 random for river
  // On turn (4 board cards): forced out is river, need 0 more random cards
  const additionalBoardNeeded = boardCards.length === 3 ? 1 : 0;

  for (let drawIdx = 0; drawIdx < draws.length; drawIdx++) {
    // Check cancellation between draws for responsiveness
    if (cancelled) {
      return;
    }

    const draw = draws[drawIdx];
    const outs = draw.outs;

    if (!Array.isArray(outs) || outs.length === 0) {
      results.push({ drawIndex: drawIdx, wins: 0, total: 0 });
      continue;
    }

    let totalWins = 0;
    let totalTies = 0;
    let totalTrials = 0;

    // Distribute iterations evenly across outs so total per draw = iterationsPerDraw
    const itersPerOut = Math.max(1, Math.floor(iterationsPerDraw / outs.length));

    for (let outIdx = 0; outIdx < outs.length; outIdx++) {
      const forcedOut = outs[outIdx];

      // Build remaining deck excluding hole cards, board cards, and the forced out
      const excludedSet = new Set(knownCards);
      excludedSet.add(forcedOut);

      const remainingCount = 52 - excludedSet.size;
      const remaining = new Int8Array(remainingCount);
      let rIdx = 0;
      for (let c = 0; c < 52; c++) {
        if (!excludedSet.has(c)) {
          remaining[rIdx++] = c;
        }
      }

      // drawCount = opponent cards + any additional board cards
      const drawCount = 2 * numOpponents + additionalBoardNeeded;

      // Guard: cannot draw more cards than are in the remaining deck
      if (drawCount > remainingCount) {
        continue;
      }

      for (let iter = 0; iter < itersPerOut; iter++) {
        partialShuffle(remaining, drawCount);

        const drawStart = remainingCount - drawCount;
        const boardDrawStart = drawStart + 2 * numOpponents;

        // Construct the completed board with the forced out card
        let b0, b1, b2, b3, b4;
        if (boardCards.length === 3) {
          // Flop: board[0..2] + forcedOut as turn + 1 random as river
          b0 = boardCards[0];
          b1 = boardCards[1];
          b2 = boardCards[2];
          b3 = forcedOut;
          b4 = remaining[boardDrawStart];
        } else {
          // Turn: board[0..3] + forcedOut as river
          b0 = boardCards[0];
          b1 = boardCards[1];
          b2 = boardCards[2];
          b3 = boardCards[3];
          b4 = forcedOut;
        }

        const playerScore = evaluate7(
          holeCards[0], holeCards[1], b0, b1, b2, b3, b4
        );

        // Evaluate all opponents -- consistent with main equity: track wins and ties separately
        let anyOppBetter = false;
        let bestOppScore = -1;
        for (let opp = 0; opp < numOpponents; opp++) {
          const oppCardStart = drawStart + 2 * opp;
          const oppScore = evaluate7(
            remaining[oppCardStart], remaining[oppCardStart + 1],
            b0, b1, b2, b3, b4
          );
          if (oppScore > playerScore) {
            anyOppBetter = true;
            break;
          }
          if (oppScore > bestOppScore) {
            bestOppScore = oppScore;
          }
        }

        if (!anyOppBetter) {
          if (playerScore > bestOppScore) {
            totalWins++;
          } else {
            totalTies++;
          }
        }
        totalTrials++;
      }
    }

    // Equity-consistent: wins + 0.5 * ties
    results.push({ drawIndex: drawIdx, wins: totalWins, ties: totalTies, total: totalTrials });
  }

  self.postMessage({
    type: 'result-win-if-hit',
    data: { results: results, generation: generation }
  });
}

// ── Message handler ──────────────────────────────────────────────────

self.onmessage = function(e) {
  const msg = e.data;

  if (msg.type === 'cancel') {
    cancelled = true;
    return;
  }

  if (msg.type === 'start') {
    cancelled = false;
    const { holeCards, boardCards, iterations } = msg.data;

    // Validate inputs before running
    if (!Array.isArray(holeCards) || holeCards.length !== 2) {
      self.postMessage({
        type: 'result',
        data: { wins: 0, ties: 0, losses: 0, total: 0 }
      });
      return;
    }

    if (!Array.isArray(boardCards) ||
        (boardCards.length !== 0 && boardCards.length !== 3 &&
         boardCards.length !== 4 && boardCards.length !== 5)) {
      self.postMessage({
        type: 'result',
        data: { wins: 0, ties: 0, losses: 0, total: 0 }
      });
      return;
    }

    // Clamp opponentCount: must be integer 1-9, default 1
    let opponentCount = 1;
    if (typeof msg.data.opponentCount === 'number' &&
        Number.isFinite(msg.data.opponentCount)) {
      opponentCount = Math.max(1, Math.min(9, Math.floor(msg.data.opponentCount)));
    }

    runSimulation(holeCards, boardCards, iterations, opponentCount);
    return;
  }

  if (msg.type === 'start-win-if-hit') {
    cancelled = false;
    const { holeCards, boardCards, draws, generation } = msg.data;

    // Validate inputs
    if (!Array.isArray(holeCards) || holeCards.length !== 2) {
      self.postMessage({
        type: 'result-win-if-hit',
        data: { results: [], generation: generation || 0 }
      });
      return;
    }

    // Win-if-hit only makes sense on flop (3) or turn (4)
    if (!Array.isArray(boardCards) ||
        (boardCards.length !== 3 && boardCards.length !== 4)) {
      self.postMessage({
        type: 'result-win-if-hit',
        data: { results: [], generation: generation || 0 }
      });
      return;
    }

    if (!Array.isArray(draws) || draws.length === 0) {
      self.postMessage({
        type: 'result-win-if-hit',
        data: { results: [], generation: generation || 0 }
      });
      return;
    }

    // Clamp opponentCount: must be integer 1-9, default 1
    let opponentCount = 1;
    if (typeof msg.data.opponentCount === 'number' &&
        Number.isFinite(msg.data.opponentCount)) {
      opponentCount = Math.max(1, Math.min(9, Math.floor(msg.data.opponentCount)));
    }

    // Default iterationsPerDraw to 2500 if missing or invalid
    let iterationsPerDraw = 2500;
    if (typeof msg.data.iterationsPerDraw === 'number' &&
        Number.isFinite(msg.data.iterationsPerDraw) &&
        msg.data.iterationsPerDraw > 0) {
      iterationsPerDraw = Math.floor(msg.data.iterationsPerDraw);
    }

    runWinIfHit(
      holeCards, boardCards, draws, opponentCount,
      iterationsPerDraw, generation || 0
    );
  }
};
