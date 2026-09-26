const SUITS = ["♠", "♥", "♦", "♣"];
const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];

const PLAYER_COUNT = 5;
const HAND_SIZE = 8;

// ONLINE MULTIPLAYER (rules are unchanged)
let isOnlineGame = false;
let myPlayerIndex = 0;
let onlineRoomCode = "";
let onlineSocket = null;
let onlineHost = false;
let suppressNetworkSync = false;
let onlineForceFullState = false;
function getLocalPlayerIndex(){ return isOnlineGame ? myPlayerIndex : 0; }
function isMyTurn(){ return currentPlayer === getLocalPlayerIndex(); }


let players = [];
let deck = [];
let discardPile = [];

let indicator = null;
let indicatorAvailable = false;
let indicatorTaken = false;
let roundStartingPlayer = 0;
let universalRank = null;

let currentPlayer = 0;
let selectedCards = [];

let hasDrawn = false;
let hasDiscarded = false;

let turnMode = null;
let turnActionMade = false;
let turnMeldMade = false;

let firstTurnCompleted = [
    false,
    false,
    false,
    false,
    false
];

/*
   FIRST-TURN MELD RULE

   During first turn, meld cards remain inside
   the normal hand.

   They are NOT hidden and NOT removed.

   After all 5 players complete their first turn,
   the meld is revealed when that player's own
   next turn starts.
*/
let meldsRevealed = [
    false,
    false,
    false,
    false,
    false
];

/*
   License rule
*/
let licensed = [
    false,
    false,
    false,
    false,
    false
];

/*
   Game Over rule
*/
let gameOver = false;
let gameWinner = -1;
let gameStarted = false;
let lastRanking = [];

// 10-game match scoreboard
const MAX_GAMES = 10;
let roundScores = [];

// Only two draw-pile rebuilds (suffols) are allowed per game.
const MAX_SUFFOLS = 2;
let suffolCount = 0;

/* =========================================================
   SAVE / RESUME
========================================================= */

const SAVE_KEY = "53CardGameSave_v1";

function saveGame() {
    if (isOnlineGame) return;
    if (!gameStarted) return;

    const state = {
        players,
        deck,
        discardPile,
        indicator,
        indicatorAvailable,
        indicatorTaken,
        roundStartingPlayer,
        universalRank,
        currentPlayer,
        selectedCards,
        hasDrawn,
        hasDiscarded,
        turnMode,
        turnActionMade,
        turnMeldMade,
        firstTurnCompleted,
        meldsRevealed,
        licensed,
        gameOver,
        gameWinner,
        lastRanking,
        roundScores,
        suffolCount,
        message: $("message") ? $("message").textContent : ""
    };

    try {
        localStorage.setItem(SAVE_KEY, JSON.stringify(state));
    } catch (error) {
        console.warn("Could not save game:", error);
    }
}

function hasSavedGame() {
    try {
        return !!localStorage.getItem(SAVE_KEY);
    } catch (error) {
        return false;
    }
}

function loadGame() {
    try {
        const raw = localStorage.getItem(SAVE_KEY);

        if (!raw) return false;

        const state = JSON.parse(raw);

        if (
            !state ||
            !Array.isArray(state.players) ||
            state.players.length !== PLAYER_COUNT ||
            !Array.isArray(state.deck) ||
            !Array.isArray(state.discardPile)
        ) {
            return false;
        }

        players = state.players;
        deck = state.deck;
        discardPile = state.discardPile;

        indicator = state.indicator || null;
        indicatorAvailable = !!state.indicatorAvailable;
        indicatorTaken = !!state.indicatorTaken;
        const savedRoundScores = Array.isArray(state.roundScores)
            ? state.roundScores
            : [];
        roundStartingPlayer = Number.isInteger(state.roundStartingPlayer)
            ? state.roundStartingPlayer
            : [0, 4, 3, 2, 1][savedRoundScores.length % PLAYER_COUNT];
        universalRank = state.universalRank || null;

        currentPlayer = Number.isInteger(state.currentPlayer)
            ? state.currentPlayer
            : 0;

        selectedCards = Array.isArray(state.selectedCards)
            ? state.selectedCards
            : [];

        hasDrawn = !!state.hasDrawn;
        hasDiscarded = !!state.hasDiscarded;

        turnMode = state.turnMode || null;
        turnActionMade = !!state.turnActionMade;
        turnMeldMade = !!state.turnMeldMade;

        firstTurnCompleted = Array.isArray(state.firstTurnCompleted)
            ? state.firstTurnCompleted
            : [false, false, false, false, false];

        meldsRevealed = Array.isArray(state.meldsRevealed)
            ? state.meldsRevealed
            : [false, false, false, false, false];

        licensed = Array.isArray(state.licensed)
            ? state.licensed
            : [false, false, false, false, false];

        gameOver = !!state.gameOver;
        gameWinner = Number.isInteger(state.gameWinner)
            ? state.gameWinner
            : -1;

        lastRanking = Array.isArray(state.lastRanking)
            ? state.lastRanking
            : [];

        roundScores = Array.isArray(state.roundScores)
            ? state.roundScores
            : [];

        suffolCount = Number.isInteger(state.suffolCount)
            ? Math.max(0, Math.min(MAX_SUFFOLS, state.suffolCount))
            : 0;

        gameStarted = true;

        render();

        if (state.message) {
            setMessage(state.message);
        }

        if (gameOver && lastRanking.length > 0) {
            showRoundScoreboard(lastRanking);
        } else if (!isOnlineGame && currentPlayer !== 0) {
            setTimeout(aiTurn, 500);
        }

        return true;
    } catch (error) {
        console.warn("Could not resume saved game:", error);
        return false;
    }
}

function clearSavedGame() {
    try {
        localStorage.removeItem(SAVE_KEY);
    } catch (error) {
        console.warn("Could not clear saved game:", error);
    }
}



/* =========================================================
   BASIC HELPERS
========================================================= */

function $(id) {
    return document.getElementById(id);
}

function resetTurnState() {
    hasDrawn = false;
    hasDiscarded = false;
    selectedCards = [];
    turnMode = null;
    turnActionMade = false;
    turnMeldMade = false;
}

function createDeck() {
    const cards = [];

    SUITS.forEach(suit => {
        RANKS.forEach(rank => {
            cards.push({
                suit: suit,
                rank: rank,
                id: `${rank}${suit}_${Math.random()}`
            });
        });
    });

    cards.push({
        suit: null,
        rank: "JOKER",
        id: `JOKER_${Math.random()}`
    });

    return cards;
}

function cardText(card) {
    if (!card) return "-";

    if (card.rank === "JOKER") {
        return "🃏";
    }

    return `${card.rank}${card.suit}`;
}


function setCardVisual(cardButton, card) {
    if (card && card.rank === "JOKER") {
        const jokerImage = document.createElement("img");
        jokerImage.src = "data:image/jpeg;base64,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";
        jokerImage.alt = "Joker";
        jokerImage.draggable = false;
        jokerImage.style.width = "100%";
        jokerImage.style.height = "100%";
        jokerImage.style.display = "block";
        jokerImage.style.objectFit = "cover";
        jokerImage.style.borderRadius = "5px";
        jokerImage.style.pointerEvents = "none";
        cardButton.appendChild(jokerImage);
        return;
    }

    cardButton.textContent = cardText(card);
}

function cardClass(card) {
    if (!card) return "card";

    if (card.rank === "JOKER") {
        return "card joker";
    }

    if (
        card.suit === "♥" ||
        card.suit === "♦"
    ) {
        return "card red";
    }

    return "card black";
}

function shuffle(array) {
    for (
        let i = array.length - 1;
        i > 0;
        i--
    ) {
        const j =
            Math.floor(
                Math.random() * (i + 1)
            );

        [
            array[i],
            array[j]
        ] = [
            array[j],
            array[i]
        ];
    }

    return array;
}


/* =========================================================
   10-GAME SCOREBOARD
========================================================= */

function checkGameOver() {
    if (gameOver) {
        return true;
    }

    for (
        let i = 0;
        i < PLAYER_COUNT;
        i++
    ) {
        if (
            players[i].hand.length === 0
        ) {
            finishGame(i);
            return true;
        }
    }

    return false;
}

function finishGame(
    winnerIndex
) {
    if (gameOver) {
        return;
    }

    gameOver = true;
    gameWinner = winnerIndex;

    resetTurnState();

    /*
       This is the end of ONE GAME/ROUND only.
       The match continues until 10 games are completed.

       Score rule:
       - Player who finishes all cards = 0
       - Every other player = number of cards remaining
    */
    const scores = [];

    for (
        let i = 0;
        i < PLAYER_COUNT;
        i++
    ) {
        scores.push(
            i === winnerIndex
                ? 0
                : players[i].hand.length
        );
    }

    roundScores.push(scores);

    const remainingPlayers = [];

    for (
        let i = 0;
        i < PLAYER_COUNT;
        i++
    ) {
        remainingPlayers.push({
            index: i,
            cards: scores[i]
        });
    }

    remainingPlayers.sort(
        (a, b) => {
            if (a.cards !== b.cards) {
                return a.cards - b.cards;
            }

            return a.index - b.index;
        }
    );

    const ranking = remainingPlayers.map(
        (player, index) => ({
            index: player.index,
            cards: player.cards,
            position: index + 1
        })
    );

    lastRanking = ranking;

    render();

    showRoundScoreboard(ranking);

    setMessage(
        `${players[winnerIndex].name} finished all cards. Game ${roundScores.length} score recorded.`
    );
}

function finishGameByDrawExhaustion() {
    if (gameOver) {
        return;
    }

    gameOver = true;
    gameWinner = -1;

    resetTurnState();

    // No player finished, so every player scores the cards currently left in hand.
    const scores = players.map(player => player.hand.length);

    roundScores.push(scores);

    const remainingPlayers = [];

    for (let i = 0; i < PLAYER_COUNT; i++) {
        remainingPlayers.push({
            index: i,
            cards: scores[i]
        });
    }

    remainingPlayers.sort((a, b) => {
        if (a.cards !== b.cards) {
            return a.cards - b.cards;
        }
        return a.index - b.index;
    });

    const ranking = remainingPlayers.map((player, index) => ({
        index: player.index,
        cards: player.cards,
        position: index + 1
    }));

    lastRanking = ranking;

    render();
    showRoundScoreboard(ranking);

    setMessage(
        `Game ${roundScores.length} ended after 2 suffols. No player finished. Scores recorded.`
    );
}

function getTotalScores() {
    const totals = Array(PLAYER_COUNT).fill(0);

    roundScores.forEach(
        scores => {
            for (
                let i = 0;
                i < PLAYER_COUNT;
                i++
            ) {
                totals[i] += Number(scores[i]) || 0;
            }
        }
    );

    return totals;
}

function showRoundScoreboard(
    ranking
) {
    const oldPanel =
        $("gameOverPanel");

    if (oldPanel) {
        oldPanel.remove();
    }

    const panel =
        document.createElement("div");

    panel.id = "gameOverPanel";
    panel.style.position = "fixed";
    panel.style.left = "50%";
    panel.style.top = "50%";
    panel.style.transform = "translate(-50%, -50%)";
    panel.style.width = "min(96vw, 720px)";
    panel.style.maxHeight = "92vh";
    panel.style.overflowY = "auto";
    panel.style.background = "#ffffff";
    panel.style.color = "#111111";
    panel.style.borderRadius = "18px";
    panel.style.padding = "22px";
    panel.style.boxSizing = "border-box";
    panel.style.zIndex = "99999";
    panel.style.boxShadow = "0 15px 50px rgba(0,0,0,0.45)";
    panel.style.textAlign = "center";

    const completed = roundScores.length;
    const isFinal = completed >= MAX_GAMES;

    const title = document.createElement("div");
    title.textContent = isFinal
        ? "🏆 10 GAMES COMPLETE"
        : `📋 GAME ${completed} COMPLETE`;
    title.style.fontSize = "27px";
    title.style.fontWeight = "800";
    title.style.marginBottom = "7px";

    const winner = document.createElement("div");
    winner.textContent = isFinal
        ? "Final scoreboard"
        : gameWinner >= 0 && players[gameWinner]
            ? `${players[gameWinner].name} finished all cards`
            : "No player finished — draw pile exhausted after 2 suffols";
    winner.style.fontSize = "18px";
    winner.style.fontWeight = "700";
    winner.style.marginBottom = "16px";

    /*
       IMPORTANT:
       For Games 1-9, show ONLY the score from the game that just ended.
       All previous game scores remain safely stored in roundScores and are
       shown only after Game 10 is complete.
    */
    const wrapper = document.createElement("div");
    wrapper.style.width = "100%";
    wrapper.style.overflowX = "auto";

    const table = document.createElement("table");
    table.style.width = "100%";
    table.style.minWidth = "430px";
    table.style.borderCollapse = "collapse";
    table.style.fontSize = "15px";

    if (!isFinal) {
        const thead = document.createElement("thead");
        const headRow = document.createElement("tr");

        ["PLAYER", `GAME ${completed} SCORE`].forEach(text => {
            const th = document.createElement("th");
            th.textContent = text;
            th.style.padding = "10px 8px";
            th.style.borderBottom = "2px solid #222";
            th.style.textAlign = "center";
            headRow.appendChild(th);
        });

        thead.appendChild(headRow);
        table.appendChild(thead);

        const tbody = document.createElement("tbody");
        const currentScores = roundScores[completed - 1] || [];

        for (let i = 0; i < PLAYER_COUNT; i++) {
            const row = document.createElement("tr");

            const playerCell = document.createElement("td");
            playerCell.textContent =
                i === 0 ? "You" : `Player ${i + 1}`;
            playerCell.style.padding = "10px 8px";
            playerCell.style.borderBottom = "1px solid #ddd";
            playerCell.style.fontWeight = "700";
            row.appendChild(playerCell);

            const score = Number(currentScores[i] || 0);
            const scoreCell = document.createElement("td");
            scoreCell.textContent = String(score);
            scoreCell.style.padding = "10px 8px";
            scoreCell.style.borderBottom = "1px solid #ddd";
            scoreCell.style.fontWeight = score === 0 ? "900" : "700";
            scoreCell.style.textAlign = "center";
            row.appendChild(scoreCell);

            tbody.appendChild(row);
        }

        table.appendChild(tbody);
    } else {
        /* After Game 10, show every game's score plus the final totals. */
        const thead = document.createElement("thead");
        const headRow = document.createElement("tr");

        const gameHead = document.createElement("th");
        gameHead.textContent = "GAME";
        gameHead.style.padding = "9px 5px";
        gameHead.style.borderBottom = "2px solid #222";
        headRow.appendChild(gameHead);

        for (let i = 0; i < PLAYER_COUNT; i++) {
            const th = document.createElement("th");
            th.textContent = i === 0 ? "You" : `Player ${i + 1}`;
            th.style.padding = "9px 5px";
            th.style.borderBottom = "2px solid #222";
            th.style.whiteSpace = "nowrap";
            headRow.appendChild(th);
        }

        thead.appendChild(headRow);
        table.appendChild(thead);

        const tbody = document.createElement("tbody");

        roundScores.forEach((scores, gameIndex) => {
            const row = document.createElement("tr");

            const gameCell = document.createElement("td");
            gameCell.textContent = `Game ${gameIndex + 1}`;
            gameCell.style.fontWeight = "700";
            gameCell.style.padding = "8px 5px";
            gameCell.style.borderBottom = "1px solid #ddd";
            row.appendChild(gameCell);

            scores.forEach(score => {
                const cell = document.createElement("td");
                cell.textContent = String(score);
                cell.style.padding = "8px 5px";
                cell.style.borderBottom = "1px solid #ddd";
                cell.style.fontWeight = score === 0 ? "800" : "600";
                row.appendChild(cell);
            });

            tbody.appendChild(row);
        });

        const totals = getTotalScores();
        const totalRow = document.createElement("tr");
        totalRow.style.background = "#f1f1f1";

        const totalLabel = document.createElement("td");
        totalLabel.textContent = "TOTAL";
        totalLabel.style.padding = "10px 5px";
        totalLabel.style.fontWeight = "900";
        totalRow.appendChild(totalLabel);

        totals.forEach(total => {
            const cell = document.createElement("td");
            cell.textContent = String(total);
            cell.style.padding = "10px 5px";
            cell.style.fontWeight = "900";
            totalRow.appendChild(cell);
        });

        tbody.appendChild(totalRow);
        table.appendChild(tbody);
    }

    wrapper.appendChild(table);

    const note = document.createElement("div");
    note.textContent = isFinal
        ? "All 10 game scores are saved above. TOTAL is the sum of all 10 games."
        : "Only this game's score is shown. Previous game scores are saved safely and will be shown after Game 10.";
    note.style.marginTop = "13px";
    note.style.fontSize = "13px";
    note.style.color = "#555";

    panel.appendChild(title);
    panel.appendChild(winner);
    panel.appendChild(wrapper);
    panel.appendChild(note);

    if (isFinal) {
        const totals = getTotalScores();
        const minScore = Math.min(...totals);
        const winners = [];

        for (let i = 0; i < PLAYER_COUNT; i++) {
            if (totals[i] === minScore) {
                winners.push(
                    i === 0 ? "You" : `Player ${i + 1}`
                );
            }
        }

        const finalWinner = document.createElement("div");
        finalWinner.textContent =
            winners.length === 1
                ? `🏆 Winner: ${winners[0]} — ${minScore} points`
                : `🏆 Tie: ${winners.join(" & ")} — ${minScore} points`;
        finalWinner.style.marginTop = "18px";
        finalWinner.style.padding = "12px";
        finalWinner.style.borderRadius = "10px";
        finalWinner.style.background = "#fff3b0";
        finalWinner.style.fontSize = "19px";
        finalWinner.style.fontWeight = "900";
        panel.appendChild(finalWinner);

        const closeBtn = document.createElement("button");
        closeBtn.textContent = "CLOSE";
        closeBtn.style.marginTop = "16px";
        closeBtn.style.padding = "11px 25px";
        closeBtn.style.border = "none";
        closeBtn.style.borderRadius = "10px";
        closeBtn.style.background = "#222";
        closeBtn.style.color = "#fff";
        closeBtn.style.fontSize = "15px";
        closeBtn.style.fontWeight = "700";
        closeBtn.style.cursor = "pointer";
        closeBtn.onclick = () => panel.remove();
        panel.appendChild(closeBtn);
    } else {
        const nextBtn = document.createElement("button");
        nextBtn.textContent = `NEXT GAME (${completed + 1}/10)`;
        nextBtn.style.marginTop = "16px";
        nextBtn.style.padding = "12px 25px";
        nextBtn.style.border = "none";
        nextBtn.style.borderRadius = "10px";
        nextBtn.style.background = "#222";
        nextBtn.style.color = "#fff";
        nextBtn.style.fontSize = "15px";
        nextBtn.style.fontWeight = "800";
        nextBtn.style.cursor = "pointer";
        nextBtn.onclick = () => {
            panel.remove();
            newGame(false);
        };
        panel.appendChild(nextBtn);
    }

    document.body.appendChild(panel);
}

function allFirstTurnsCompleted() {
    return firstTurnCompleted.every(
        value => value === true
    );
}


/*
   Remove a player's hidden first-turn
   meld cards from their normal hand.

   The actual card objects are matched by ID,
   so the original cards are preserved.
*/
function removeRevealedMeldCards(
    playerIndex
) {
    const player =
        players[playerIndex];

    if (!player) {
        return;
    }

    if (
        player.melds.length === 0
    ) {
        return;
    }

    const meldCardIds =
        new Set();

    player.melds.forEach(
        meld => {
            meld.forEach(
                card => {
                    if (card && card.id) {
                        meldCardIds.add(
                            card.id
                        );
                    }
                }
            );
        }
    );

    if (
        meldCardIds.size === 0
    ) {
        return;
    }

    player.hand =
        player.hand.filter(
            card =>
                !meldCardIds.has(
                    card.id
                )
        );
}


/*
   Reveal meld ONLY when:

   1. All 5 players completed first turn.
   2. It is that player's own turn.

   Before this happens, their meld cards
   remain visible in their normal hand.
*/
function updateMeldVisibility() {
    if (
        !allFirstTurnsCompleted()
    ) {
        return;
    }

    if (
        !meldsRevealed[currentPlayer]
    ) {
        meldsRevealed[currentPlayer] =
            true;

        removeRevealedMeldCards(
            currentPlayer
        );

        /*
           A player may have completed all
           their hidden meld cards.
           Check after they are revealed.
        */
        checkGameOver();
    }
}


/* =========================================================
   NEW GAME
========================================================= */

function newGame(resetMatch = true) {
    if (isOnlineGame && onlineHost) onlineForceFullState = true;
    gameStarted = true;

    if (resetMatch) {
        roundScores = [];
    }

    /*
       CLOCKWISE STARTER ROTATION

       Game 1: You
       Game 2: Player 5
       Game 3: Player 4
       Game 4: Player 3
       Game 5: Player 2
       Game 6: You
       Game 7: Player 5
       Game 8: Player 4
       Game 9: Player 3
       Game 10: Player 2

       This follows the clockwise direction around the table
       while giving every player exactly 2 starting games.
    */
    const clockwiseOrder = [0, 4, 3, 2, 1];
    const startingPlayer =
        clockwiseOrder[roundScores.length % PLAYER_COUNT];

    roundStartingPlayer = startingPlayer;

    lastRanking = [];

    const oldPanel =
        $("gameOverPanel");

    if (oldPanel) {
        oldPanel.remove();
    }

    players = [];

    for (
        let i = 0;
        i < PLAYER_COUNT;
        i++
    ) {
        players.push({
            name: `Player ${i + 1}`,
            hand: [],
            melds: []
        });
    }

    deck = shuffle(
        createDeck()
    );

    discardPile = [];

    indicator = null;
    indicatorAvailable = false;
    indicatorTaken = false;
    universalRank = null;

    currentPlayer = startingPlayer;

    firstTurnCompleted = [
        false,
        false,
        false,
        false,
        false
    ];

    meldsRevealed = [
        false,
        false,
        false,
        false,
        false
    ];

    licensed = [
        false,
        false,
        false,
        false,
        false
    ];

    gameOver = false;
    gameWinner = -1;
    suffolCount = 0;

    resetTurnState();


    /* Deal 8 cards to each player */

    for (
        let r = 0;
        r < HAND_SIZE;
        r++
    ) {
        for (
            let p = 0;
            p < PLAYER_COUNT;
            p++
        ) {
            players[p].hand.push(
                deck.pop()
            );
        }
    }


    /* Indicator card */

    indicator =
        deck.pop();

    indicatorAvailable =
        true;


    /* Universal Joker */

    if (
        indicator.rank === "JOKER"
    ) {
        universalRank = "A";
    } else {
        const index =
            RANKS.indexOf(
                indicator.rank
            );

        universalRank =
            RANKS[
                (index + 1) %
                RANKS.length
            ];
    }


    render();

    if (startingPlayer === 0) {
        setMessage(
            "Your first turn: you MUST take the indicator, draw, or take the discard."
        );
    } else {
        setMessage(
            `${players[startingPlayer].name}'s first turn.`
        );

        if (!isOnlineGame) {
            setTimeout(
                aiTurn,
                900
            );
        }
    }

    if (isOnlineGame) broadcastOnlineState();
}


/* =========================================================
   MAIN RENDER
========================================================= */

function render() {
    createCompleteButton();

    if ($("indicator")) {
        $("indicator").textContent =
            indicator
                ? cardText(indicator)
                : "-";
    }

    if ($("universalJoker")) {
        $("universalJoker").textContent =
            universalRank || "-";
    }

    if ($("drawCount")) {
        $("drawCount").textContent =
            deck.length;
    }

    if ($("discardCount")) {
        $("discardCount").textContent =
            discardPile.length;
    }

    renderTableIndicator();
    renderDiscardCards();
    renderPlayers();
    renderHand();
    renderMelds();

    updateButtons();
    updateCompleteButton();
    saveGame();
    if (isOnlineGame && !suppressNetworkSync) broadcastOnlineState();
}


/* =========================================================
   INDICATOR
========================================================= */

function renderTableIndicator() {
    const box =
        $("tableIndicator");

    if (!box) return;

    box.innerHTML = "";

    if (
        !indicator ||
        !indicatorAvailable
    ) {
        box.style.display =
            "none";

        return;
    }

    box.style.display =
        "block";

    const card =
        document.createElement(
            "button"
        );

    card.className =
        cardClass(indicator);

    card.textContent =
        cardText(indicator);

    if (
        isMyTurn() &&
        roundStartingPlayer === 0 &&
        !indicatorTaken &&
        !firstTurnCompleted[getLocalPlayerIndex()] &&
        turnMode === null
    ) {
        card.title =
            "Take Indicator Card";

        card.onclick =
            takeIndicator;
    } else {
        card.disabled =
            true;

        card.title =
            "Indicator Card";
    }

    box.appendChild(card);
}

function takeIndicator() {
    if (gameOver) return;
    if (!isMyTurn()) return;
    if (roundStartingPlayer !== 0) return;

    if (
        firstTurnCompleted[getLocalPlayerIndex()]
    ) {
        return;
    }

    if (
        !indicatorAvailable ||
        !indicator
    ) {
        return;
    }

    if (
        turnMode !== null
    ) {
        setMessage(
            "You already started your turn."
        );

        return;
    }

    players[getLocalPlayerIndex()].hand.push(
        indicator
    );

    indicatorTaken =
        true;

    indicatorAvailable =
        false;

    hasDrawn =
        true;

    hasDiscarded =
        false;

    turnMode =
        "draw";

    turnActionMade =
        true;

    turnMeldMade =
        false;

    setMessage(
        "You took the indicator. Select one card and DISCARD."
    );

    render();
}


/* =========================================================
   DRAW PILE
========================================================= */

function prepareDrawPile() {
    if (deck.length > 0) {
        return true;
    }

    // Only two draw-pile rebuilds are allowed in one game/round.
    if (suffolCount >= MAX_SUFFOLS) {
        finishGameByDrawExhaustion();
        return false;
    }

    const cardsToShuffle = [
        ...discardPile
    ];

    if (indicatorAvailable && indicator) {
        cardsToShuffle.push(indicator);
        indicatorAvailable = false;
        indicatorTaken = true;
        indicator = null;
    }

    if (cardsToShuffle.length === 0) {
        finishGameByDrawExhaustion();
        return false;
    }

    deck = shuffle(cardsToShuffle);
    discardPile = [];
    suffolCount++;

    return true;
}

function drawCard() {
    if (gameOver) return;
    if (!isMyTurn()) return;

    if (
        turnMode === "meld"
    ) {
        setMessage(
            "You started a meld turn. You cannot draw now."
        );

        return;
    }

    if (hasDrawn) {
        setMessage(
            "You already drew a card."
        );

        return;
    }

    prepareDrawPile();

    if (
        deck.length === 0
    ) {
        setMessage(
            "No cards available."
        );

        return;
    }

    const card =
        deck.pop();

    players[getLocalPlayerIndex()].hand.push(
        card
    );

    hasDrawn =
        true;

    hasDiscarded =
        false;

    turnMode =
        "draw";

    turnActionMade =
        true;

    turnMeldMade =
        false;

    setMessage(
        "Card drawn. Select one card and DISCARD."
    );

    render();
}


/* =========================================================
   TAKE TOP DISCARD
========================================================= */

function takeDiscard() {
    if (gameOver) return;
    if (!isMyTurn()) return;

    if (
        turnMode === "meld"
    ) {
        setMessage(
            "You started a meld turn. You cannot take a discard."
        );

        return;
    }

    if (hasDrawn) {
        setMessage(
            "You already drew a card."
        );

        return;
    }

    if (
        discardPile.length === 0
    ) {
        setMessage(
            "No discard card available."
        );

        return;
    }

    const card =
        discardPile.pop();

    players[getLocalPlayerIndex()].hand.push(
        card
    );

    hasDrawn =
        true;

    hasDiscarded =
        false;

    turnMode =
        "draw";

    turnActionMade =
        true;

    turnMeldMade =
        false;

    setMessage(
        "You took the discard. Select one card and DISCARD."
    );

    render();
}


/* =========================================================
   DISCARD DISPLAY
========================================================= */

function renderDiscardCards() {
    const discardBox = $("discardTop");

    if (!discardBox) return;

    discardBox.innerHTML = "";

    /*
       DISCARD FAN
       Keep the original curved/overlapping look:
       - cards overlap horizontally
       - the cards form a shallow arc
       - every previous card keeps a readable edge
       - newest card stays on top/clickable
    */
    discardBox.style.position = "relative";
    discardBox.style.display = "block";
    discardBox.style.overflow = "visible";
    discardBox.style.whiteSpace = "normal";
    discardBox.style.flexWrap = "nowrap";
    discardBox.style.maxWidth = "none";

    if (discardPile.length === 0) {
        discardBox.style.width = "60px";
        discardBox.style.height = "72px";

        const empty = document.createElement("span");
        empty.textContent = "-";
        empty.className = "discard-empty";
        discardBox.appendChild(empty);
        return;
    }

    const count = discardPile.length;
    const cardWidth = 54;
    const cardHeight = 72;

    // Strong enough overlap to look like the original fan,
    // while still leaving every previous card readable.
    const step = count <= 4 ? 30 : count <= 7 ? 27 : 25;
    const fanWidth = cardWidth + (count - 1) * step;
    const fanHeight = 92;

    discardBox.style.width = `${fanWidth}px`;
    discardBox.style.height = `${fanHeight}px`;
    discardBox.style.marginLeft = `${-Math.round(fanWidth / 2)}px`;
    discardBox.style.left = "50%";

    // Rotation and vertical lift create the curved/fan shape.
    const rotations = [-18, -14, -10, -7, -4, -2, 0, 3, 7, 11, 15, 18];

    discardPile.forEach((card, index) => {
        const cardButton = document.createElement("button");

        cardButton.className = `${cardClass(card)} small`;

        const isTop = index === count - 1;

        if (isTop) {
            cardButton.classList.add("top-discard");

            if (
                isMyTurn() &&
                turnMode !== "meld" &&
                !hasDrawn &&
                !gameOver
            ) {
                cardButton.disabled = false;
                cardButton.title = "Take this discard card";
                cardButton.onclick = takeDiscard;
            } else {
                cardButton.disabled = true;
                cardButton.title = "Top discard card";
            }
        } else {
            cardButton.disabled = true;
            cardButton.title = "Discarded card";
        }

        setCardVisual(cardButton, card);

        // Absolute positioning is important here: flex wrapping must never
        // destroy the curved overlap when the discard pile gets longer.
        const x = index * step;
        const middle = (count - 1) / 2;
        const distance = Math.abs(index - middle) / Math.max(middle, 1);
        const y = Math.round(25 * distance * distance);
        const rotation = rotations[
            Math.round((index / Math.max(count - 1, 1)) * (rotations.length - 1))
        ];

        cardButton.style.position = "absolute";
        cardButton.style.left = `${x}px`;
        cardButton.style.top = `${y}px`;
        cardButton.style.margin = "0";
        cardButton.style.zIndex = String(index + 1);
        cardButton.style.transformOrigin = "50% 85%";
        cardButton.style.transform = `rotate(${rotation}deg)`;
        cardButton.style.flex = "none";

        discardBox.appendChild(cardButton);
    });
}


/* =========================================================
   PLAYER HAND
========================================================= */

function renderHand() {
    const handBox = $("hand");
    if (!handBox) return;

    handBox.innerHTML = "";

    /*
       ALL cards remain visible in the hand during the first turn.
       Long-press (2 seconds) + drag lets you arrange your cards
       manually from left to right or right to left.
    */
    players[getLocalPlayerIndex()].hand.forEach((card, index) => {
        const cardButton = document.createElement("button");

        cardButton.className = cardClass(card);
        cardButton.type = "button";
        cardButton.style.touchAction = "none";
        cardButton.style.userSelect = "none";
        cardButton.dataset.cardId = card.id;

        if (selectedCards.includes(index)) {
            cardButton.classList.add("selected");
        }

        setCardVisual(cardButton, card);
        cardButton.onclick = () => {
            if (cardButton.dataset.longPressed === "true") {
                cardButton.dataset.longPressed = "false";
                return;
            }

            /*
               Always find the card by its stable ID at click time.
               The hand can be reordered/re-rendered, so using the
               old render-time index could select a different card.
            */
            const currentIndex = players[getLocalPlayerIndex()].hand.findIndex(
                currentCard =>
                    currentCard.id === cardButton.dataset.cardId
            );

            if (currentIndex >= 0) {
                toggleCardSelection(currentIndex);
            }
        };

        enableHandCardReordering(cardButton);
        handBox.appendChild(cardButton);
    });
}

/* =========================================================
   MANUAL HAND CARD REORDER
   Hold a card for 2 seconds, then drag it to any position.
   The game rules are unchanged; this only changes hand order.
========================================================= */
let handDragState = null;
let handLongPressTimer = null;

function clearHandLongPressTimer() {
    if (handLongPressTimer) {
        clearTimeout(handLongPressTimer);
        handLongPressTimer = null;
    }
}

function enableHandCardReordering(cardButton) {
    const handBox = $("hand");
    if (!handBox) return;

    cardButton.draggable = false;
    cardButton.style.touchAction = "none";
    cardButton.style.userSelect = "none";

    cardButton.addEventListener("pointerdown", (event) => {
        if (gameOver) return;
        if (event.pointerType === "mouse" && event.button !== 0) return;
        if (handDragState) return;

        clearHandLongPressTimer();
        cardButton.dataset.longPressed = "false";

        const pointerId = event.pointerId;
        const startX = event.clientX;
        const startY = event.clientY;

        const cardId = cardButton.dataset.cardId;

        handLongPressTimer = setTimeout(() => {
            handLongPressTimer = null;

            if (gameOver) return;

            /*
               The AI can re-render the hand while the player is holding
               a card. Find the card again by its stable ID so a render
               during the 1-second hold does not cancel the rearrange.
            */
            const currentButton = [...handBox.children].find(
                element => element.dataset.cardId === cardId
            );

            if (!currentButton) return;

            handDragState = {
                button: currentButton,
                pointerId,
                cardId,
                startX,
                startY,
                offsetX: event.clientX - currentButton.getBoundingClientRect().left,
                offsetY: event.clientY - currentButton.getBoundingClientRect().top,
                preview: null
            };

            currentButton.dataset.longPressed = "true";
            currentButton.classList.add("hand-dragging");
            currentButton.style.opacity = "0.65";
            currentButton.style.transform = "scale(1.08) translateY(-10px)";
            currentButton.style.zIndex = "10000";
            currentButton.style.position = "relative";

            const preview = currentButton.cloneNode(true);
            preview.classList.add("hand-drag-preview");
            preview.style.position = "fixed";
            preview.style.left = `${event.clientX - handDragState.offsetX}px`;
            preview.style.top = `${event.clientY - handDragState.offsetY}px`;
            preview.style.margin = "0";
            preview.style.pointerEvents = "none";
            preview.style.opacity = "0.9";
            preview.style.transform = "scale(1.08)";
            preview.style.zIndex = "100000";
            document.body.appendChild(preview);
            handDragState.preview = preview;
            currentButton.style.opacity = "0.25";

            document.body.style.userSelect = "none";
            document.body.style.touchAction = "none";
        }, 1000);
    });
}

// Use document-level pointer events so dragging continues even when the
// pointer/finger leaves the original card. This is important on touch screens.
document.addEventListener("pointermove", (event) => {
    if (!handDragState) return;
    if (event.pointerId !== handDragState.pointerId) return;

    event.preventDefault();
    updateMeldDropTarget(event.clientX, event.clientY);
    moveHandCardToPointer(event.clientX, event.clientY);
}, { passive: false });

document.addEventListener("pointerup", (event) => {
    if (handDragState && event.pointerId === handDragState.pointerId) {
        event.preventDefault();
        const droppedOnMeld = tryDropDraggedCardOnMeld(event.clientX, event.clientY);
        if (!droppedOnMeld) {
            finishHandCardReorder();
        }
        cleanupHandDrag();
    } else {
        clearHandLongPressTimer();
    }
}, { passive: false });

document.addEventListener("pointercancel", (event) => {
    if (handDragState && event.pointerId === handDragState.pointerId) {
        finishHandCardReorder();
        cleanupHandDrag();
    } else {
        clearHandLongPressTimer();
    }
});

function cleanupHandDrag() {
    clearHandLongPressTimer();

    if (handDragState) {
        const handBox = $("hand");
        const cardButton =
            handDragState.button && handDragState.button.isConnected
                ? handDragState.button
                : handBox
                    ? [...handBox.children].find(
                        element => element.dataset.cardId === handDragState.cardId
                    )
                    : null;

        if (handDragState.meldTarget) {
            handDragState.meldTarget.classList.remove("meld-drop-target");
        }

        /* Always remove the floating drag preview, including after a
           successful meld drop where the original hand card has already
           been removed from the hand. */
        if (handDragState.preview) {
            handDragState.preview.remove();
            handDragState.preview = null;
        }

        if (!cardButton) {
            handDragState = null;
            document.body.style.userSelect = "";
            document.body.style.touchAction = "";
            return;
        }
        cardButton.dataset.longPressed = "true";
        cardButton.classList.remove("hand-dragging");
        cardButton.style.opacity = "";
        cardButton.style.transform = "";
        cardButton.style.zIndex = "";
        cardButton.style.position = "";
    }

    handDragState = null;
    document.body.style.userSelect = "";
    document.body.style.touchAction = "";
}

function moveHandCardToPointer(pointerX, pointerY) {
    if (!handDragState) return;

    const handBox = $("hand");
    if (!handBox) return;

    /* Re-acquire the same card if the hand was re-rendered during AI play. */
    let dragged = handDragState.button;
    if (!dragged || !dragged.isConnected) {
        dragged = [...handBox.children].find(
            element => element.dataset.cardId === handDragState.cardId
        );
        if (!dragged) return;
        handDragState.button = dragged;
        dragged.dataset.longPressed = "true";
        dragged.classList.add("hand-dragging");
        dragged.style.opacity = "0.65";
        dragged.style.transform = "scale(1.08) translateY(-10px)";
        dragged.style.zIndex = "10000";
        dragged.style.position = "relative";
    }

    if (handDragState.preview) {
        handDragState.preview.style.left = `${pointerX - handDragState.offsetX}px`;
        handDragState.preview.style.top = `${pointerY - handDragState.offsetY}px`;
    }

    const cards = [...handBox.children].filter(el => el !== dragged);
    if (!cards.length) return;

    /*
       Support BOTH horizontal and vertical movement.
       The hand can wrap onto multiple rows, so use the actual
       screen position of each card instead of only pointerX.
    */
    let target = null;
    let bestDistance = Infinity;

    for (const card of cards) {
        const rect = card.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        const distance = Math.hypot(
            pointerX - centerX,
            pointerY - centerY
        );

        if (distance < bestDistance) {
            bestDistance = distance;
            target = card;
        }
    }

    if (!target) return;

    const targetRect = target.getBoundingClientRect();

    /*
       Decide before/after using the closest card's full 2D position.
       This means moving above/below a card changes its position in the
       hand instead of only moving left/right.
    */
    const targetCenterX = targetRect.left + targetRect.width / 2;
    const targetCenterY = targetRect.top + targetRect.height / 2;

    let putBefore;

    if (Math.abs(pointerY - targetCenterY) > targetRect.height * 0.35) {
        putBefore = pointerY < targetCenterY;
    } else {
        putBefore = pointerX < targetCenterX;
    }

    if (putBefore) {
        if (dragged.nextSibling !== target) {
            handBox.insertBefore(dragged, target);
        }
    } else {
        if (target.nextSibling !== dragged) {
            handBox.insertBefore(dragged, target.nextSibling);
        }
    }
}

function getMeldDropTarget(pointerX, pointerY) {
    /*
       Find the ACTUAL meld under the pointer.  The dragged card has a
       floating preview with pointer-events disabled, so the table/meld
       remains clickable underneath it.
    */
    const elements = document.elementsFromPoint
        ? document.elementsFromPoint(pointerX, pointerY)
        : [];

    for (const element of elements) {
        let node = element;

        while (node && node !== document.body) {
            if (
                node.classList &&
                node.classList.contains("meld-row") &&
                node.dataset.meldPlayer !== undefined &&
                node.dataset.meldIndex !== undefined
            ) {
                return node;
            }

            node = node.parentElement;
        }
    }

    /*
       If the pointer is on the edge/space immediately beside a meld,
       use the closest visible meld row.  This makes dropping on a meld
       reliable without changing which meld is selected when the pointer
       is clearly over another meld.
    */
    const meldRows = [...document.querySelectorAll(".meld-row")];
    let closest = null;
    let closestDistance = Infinity;

    for (const row of meldRows) {
        if (row.dataset.meldPlayer === undefined ||
            row.dataset.meldIndex === undefined) {
            continue;
        }

        const rect = row.getBoundingClientRect();
        const dx =
            pointerX < rect.left
                ? rect.left - pointerX
                : pointerX > rect.right
                    ? pointerX - rect.right
                    : 0;
        const dy =
            pointerY < rect.top
                ? rect.top - pointerY
                : pointerY > rect.bottom
                    ? pointerY - rect.bottom
                    : 0;
        const distance = Math.hypot(dx, dy);

        if (distance < closestDistance) {
            closestDistance = distance;
            closest = row;
        }
    }

    return closestDistance <= 70 ? closest : null;
}

function updateMeldDropTarget(pointerX, pointerY) {
    if (!handDragState) return;

    const target = getMeldDropTarget(pointerX, pointerY);

    if (handDragState.meldTarget &&
        handDragState.meldTarget !== target) {
        handDragState.meldTarget.classList.remove("meld-drop-target");
    }

    handDragState.meldTarget = target;

    if (target) {
        target.classList.add("meld-drop-target");
    }
}

function extendSpecificMeldWithCard(meld, card) {
    if (!meld) return null;

    if (meld.meldType === "set") {
        if (!canExtendSetWithCards(meld, [card])) {
            return null;
        }

        meld.push(card);
        return { success: true, meld, type: "set" };
    }

    if (meld.meldType === "sequence") {
        const result = canExtendSequenceWithCards(meld, [card]);
        if (!result) return null;

        const info = getStoredSequenceInfo(meld);
        if (!info) return null;

        if (result.side === "prefix") {
            meld.unshift(...result.cards);
            meld.sequenceCardPositions = [
                ...result.positions,
                ...info.cardPositions
            ];
            meld.sequenceJokerPositions = [...info.jokerPositions];
            result.cards.forEach((item, index) => {
                if (isJoker(item)) {
                    meld.sequenceJokerPositions.push(result.positions[index]);
                }
            });
            meld.sequenceStart = result.positions[0];
        } else {
            meld.push(...result.cards);
            meld.sequenceCardPositions = [
                ...info.cardPositions,
                ...result.positions
            ];
            meld.sequenceJokerPositions = [...info.jokerPositions];
            result.cards.forEach((item, index) => {
                if (isJoker(item)) {
                    meld.sequenceJokerPositions.push(result.positions[index]);
                }
            });
            meld.sequenceEnd = result.positions[result.positions.length - 1];
        }

        return { success: true, meld, type: "sequence" };
    }

    return null;
}

function tryDropDraggedCardOnMeld(pointerX, pointerY) {
    if (!handDragState) return false;
    if (gameOver) return false;
    if (!isMyTurn()) return false;
    if (turnMode === "draw") return false;
    if (!licensed[getLocalPlayerIndex()]) return false;

    const target = getMeldDropTarget(pointerX, pointerY);
    if (!target) return false;

    const playerIndex = Number(target.dataset.meldPlayer);
    const meldIndex = Number(target.dataset.meldIndex);

    if (!Number.isInteger(playerIndex) || !Number.isInteger(meldIndex)) {
        return false;
    }

    const targetPlayer = players[playerIndex];
    const targetMeld = targetPlayer && targetPlayer.melds[meldIndex];
    if (!targetMeld) return false;

    const oldHand = players[getLocalPlayerIndex()].hand.slice();
    const cardId = handDragState.cardId;
    const cardIndex = oldHand.findIndex(card => String(card.id) === String(cardId));

    if (cardIndex < 0) return false;

    const card = oldHand[cardIndex];

    /* The card being physically dragged is the card being played. */
    const result = extendSpecificMeldWithCard(targetMeld, card);

    if (!result) {
        setMessage("That card cannot be added to this meld.");
        return true;
    }

    players[getLocalPlayerIndex()].hand.splice(cardIndex, 1);

    selectedCards = selectedCards
        .map(index => oldHand[index])
        .filter(Boolean)
        .filter(selectedCard => selectedCard.id !== card.id)
        .map(selectedCard =>
            players[getLocalPlayerIndex()].hand.findIndex(item => item.id === selectedCard.id)
        )
        .filter(index => index >= 0);

    turnMode = "meld";
    turnActionMade = true;
    turnMeldMade = true;

    if (checkGameOver()) {
        return true;
    }

    setMessage(
        `${cardText(card)} added to the selected ${result.type} meld.`
    );

    render();
    return true;
}

function finishHandCardReorder() {
    const handBox = $("hand");
    if (!handBox || !players[0] || !handDragState) return;

    const oldHand = players[getLocalPlayerIndex()].hand.slice();
    const selectedIds = selectedCards
        .map(index => oldHand[index])
        .filter(Boolean)
        .map(card => card.id);

    const cardById = new Map(oldHand.map(card => [card.id, card]));
    const newHand = [...handBox.children]
        .map(element => cardById.get(element.dataset.cardId))
        .filter(Boolean);

    if (newHand.length !== oldHand.length) return;

    players[getLocalPlayerIndex()].hand = newHand;

    selectedCards = selectedIds
        .map(id => players[getLocalPlayerIndex()].hand.findIndex(card => card.id === id))
        .filter(index => index >= 0);

    saveGame();
    updateButtons();
    updateCompleteButton();
}

function toggleCardSelection(
    index
) {
    if (gameOver) return;

    const existing =
        selectedCards.indexOf(
            index
        );

    if (existing >= 0) {
        selectedCards.splice(
            existing,
            1
        );
    } else {
        selectedCards.push(
            index
        );
    }

    renderHand();

    updateButtons();
    updateCompleteButton();
}


/* =========================================================
   OTHER PLAYERS
========================================================= */

function renderPlayers() {
    /*
       The local player always sits in the bottom seat (#player1).
       In online games, rotate the other players around that seat so
       card backs, names, melds, and turn indicators all refer to the
       same actual player. Offline play keeps the original layout.
    */
    const localIndex = getLocalPlayerIndex();

    for (let seatOffset = 0; seatOffset < PLAYER_COUNT; seatOffset++) {
        const playerIndex =
            (localIndex + seatOffset) % PLAYER_COUNT;
        const player = players[playerIndex];
        const playerBox = $(`player${seatOffset + 1}`);

        if (!player || !playerBox) continue;

        // Record which real player occupies this visual seat. Meld rendering
        // uses this same mapping so each player's meld stays in their own box.
        playerBox.dataset.playerIndex = String(playerIndex);

        // Keep the local player in the bottom seat and label others by name.
        const heading = playerBox.querySelector("h2");
        if (heading) {
            const labelNode = Array.from(heading.childNodes).find(
                node => node.nodeType === Node.TEXT_NODE
            );
            if (labelNode) {
                labelNode.textContent =
                    seatOffset === 0 ? "You " : `${player.name} `;
            }
        }

        const status = playerBox.querySelector(".status");
        if (status) {
            status.textContent =
                seatOffset === 0
                    ? (isMyTurn() ? "● YOUR TURN" : "")
                    : (currentPlayer === playerIndex ? "● TURN" : "");
        }

        // The local player's face-up hand is rendered separately in #hand.
        if (seatOffset === 0) continue;

        const cardsBox = $(`p${seatOffset + 1}Cards`);
        if (!cardsBox) continue;

        cardsBox.innerHTML = "";
        player.hand.forEach(() => {
            const back = document.createElement("div");
            back.className = "back-card";
            cardsBox.appendChild(back);
        });
    }
}


/* =========================================================
   JOKER
========================================================= */

function isJoker(card) {
    if (!card) return false;

    return (
        card.rank === "JOKER" ||
        card.rank === universalRank
    );
}


/* =========================================================
   RANK POSITION HELPERS
========================================================= */

function rankAtPosition(
    position
) {
    if (
        position === 0 ||
        position === 13
    ) {
        return "A";
    }

    return RANKS[position];
}

function getCardPositions(
    card
) {
    if (
        !card ||
        isJoker(card)
    ) {
        return [];
    }

    if (
        card.rank === "A"
    ) {
        return [0, 13];
    }

    const pos =
        RANKS.indexOf(
            card.rank
        );

    if (pos < 0) {
        return [];
    }

    return [pos];
}


/* =========================================================
   INITIAL SEQUENCE ANALYSIS
========================================================= */

function getSequenceInfo(
    cards
) {
    if (
        !cards ||
        cards.length < 3
    ) {
        return null;
    }

    const normalCards = cards.filter(card => !isJoker(card));
    const jokerCards = cards.filter(card => isJoker(card));

    if (normalCards.length === 0) {
        return null;
    }

    const suit = normalCards[0].suit;

    if (!normalCards.every(card => card.suit === suit)) {
        return null;
    }

    const length = cards.length;

    if (length > 13) {
        return null;
    }

    /*
       IMPORTANT:
       The player's actual card order is part of the meld display.
       Find a sequence position for THAT exact order instead of
       sorting/rearranging the cards.

       Examples:
         4, 5, JOKER  -> positions 4, 5, 6
         7, 8, JOKER  -> positions 7, 8, 9
         JOKER, 7, 8  -> positions 6, 7, 8

       The joker fills the exact position occupied by the joker in
       the player's arrangement. This also makes later prefix/suffix
       extensions use the correct represented rank.
    */
    for (let start = 0; start <= 14 - length; start++) {
        const end = start + length - 1;
        if (start === 0 && end === 13) continue;

        const assignedPositions = [];
        const jokerPositions = [];
        let valid = true;

        for (let i = 0; i < cards.length; i++) {
            const card = cards[i];
            const position = start + i;

            if (isJoker(card)) {
                jokerPositions.push(position);
                assignedPositions.push(position);
                continue;
            }

            if (card.suit !== suit) {
                valid = false;
                break;
            }

            const expectedRank = rankAtPosition(position);
            if (card.rank !== expectedRank) {
                valid = false;
                break;
            }

            assignedPositions.push(position);
        }

        if (!valid) continue;

        return {
            start,
            end,
            suit,
            positions: [...assignedPositions],
            jokerPositions,
            length,
            orderedCards: [...cards],
            orderedPositions: [...assignedPositions]
        };
    }

    return null;
}

/* =========================================================
   VALID MELD
========================================================= */

function isValidMeld(
    cards
) {
    if (
        !cards ||
        cards.length < 3
    ) {
        return false;
    }

    const normalCards =
        cards.filter(
            card => !isJoker(card)
        );

    /* SET */

    if (
        normalCards.length > 0
    ) {
        const sameRank =
            normalCards.every(
                card =>
                    card.rank ===
                    normalCards[0].rank
            );

        const differentSuits =
            new Set(
                normalCards.map(
                    card => card.suit
                )
            ).size ===
            normalCards.length;

        if (
            sameRank &&
            differentSuits
        ) {
            if (
                normalCards.length <= 4
            ) {
                return true;
            }
        }
    }

    /* SEQUENCE */

    return (
        getSequenceInfo(
            cards
        ) !== null
    );
}


/* =========================================================
   STORE MELD INFO
========================================================= */

function storeMeldInfo(
    meld,
    forceNewSequence = false
) {
    if (
        !forceNewSequence &&
        meld.meldType === "sequence" &&
        Array.isArray(
            meld.sequenceCardPositions
        ) &&
        meld.sequenceCardPositions.length ===
            meld.length
    ) {
        return meld;
    }

    const info =
        getSequenceInfo(
            meld
        );

    if (info) {
        /*
           IMPORTANT: Keep the cards in exactly the order
           the player arranged/selected them.

           getSequenceInfo() is used only to validate the
           sequence and store its fixed rank positions.
           It must NOT reorder the actual meld array.

           Example: 7, 8, JOKER stays 7, 8, JOKER
           when the meld is revealed.
        */
        meld.meldType =
            "sequence";

        meld.sequenceStart =
            info.start;

        meld.sequenceEnd =
            info.end;

        meld.sequenceSuit =
            info.suit;

        meld.sequenceCardPositions =
            [
                ...info.orderedPositions
            ];

        meld.sequenceJokerPositions =
            [
                ...info.jokerPositions
            ];

        return meld;
    }

    /* SET */

    meld.meldType =
        "set";

    delete meld.sequenceStart;
    delete meld.sequenceEnd;
    delete meld.sequenceSuit;
    delete meld.sequenceCardPositions;
    delete meld.sequenceJokerPositions;

    return meld;
}


/* =========================================================
   STORED SEQUENCE INFO
========================================================= */

function getStoredSequenceInfo(
    meld
) {
    if (!meld) {
        return null;
    }

    if (
        meld.meldType === "sequence" &&
        typeof meld.sequenceStart ===
            "number" &&
        typeof meld.sequenceEnd ===
            "number" &&
        Array.isArray(
            meld.sequenceCardPositions
        ) &&
        meld.sequenceCardPositions.length ===
            meld.length
    ) {
        return {
            start:
                meld.sequenceStart,

            end:
                meld.sequenceEnd,

            suit:
                meld.sequenceSuit,

            cardPositions:
                [
                    ...meld.sequenceCardPositions
                ],

            jokerPositions:
                Array.isArray(
                    meld.sequenceJokerPositions
                )
                    ? [
                        ...meld.sequenceJokerPositions
                    ]
                    : []
        };
    }

    if (
        meld.meldType ===
        "sequence"
    ) {
        const info =
            getSequenceInfo(
                meld
            );

        if (!info) {
            return null;
        }

        /*
           Older saved melds may not have position metadata.
           Preserve their actual card order; use the sequence
           analysis only to recover the positions needed for
           future extensions.
        */
        meld.sequenceStart =
            info.start;

        meld.sequenceEnd =
            info.end;

        meld.sequenceSuit =
            info.suit;

        meld.sequenceCardPositions =
            [
                ...info.orderedPositions
            ];

        meld.sequenceJokerPositions =
            [
                ...info.jokerPositions
            ];

        return {
            start:
                info.start,

            end:
                info.end,

            suit:
                info.suit,

            cardPositions:
                [
                    ...info.orderedPositions
                ],

            jokerPositions:
                [
                    ...info.jokerPositions
                ]
        };
    }

    return null;
}


/* =========================================================
   SET EXTENSION
========================================================= */

function canExtendSetWithCards(
    meld,
    cards
) {
    if (
        !meld ||
        meld.length < 3 ||
        !cards ||
        cards.length === 0
    ) {
        return false;
    }

    const existingNormalCards =
        meld.filter(
            card => !isJoker(card)
        );

    if (
        existingNormalCards.length === 0
    ) {
        return false;
    }

    const rank =
        existingNormalCards[0].rank;

    const existingSuits =
        new Set(
            existingNormalCards.map(
                card => card.suit
            )
        );

    const addedSuits =
        new Set();

    for (
        const card of cards
    ) {
        if (
            !card ||
            isJoker(card)
        ) {
            return false;
        }

        if (
            card.rank !== rank
        ) {
            return false;
        }

        if (
            existingSuits.has(
                card.suit
            )
        ) {
            return false;
        }

        if (
            addedSuits.has(
                card.suit
            )
        ) {
            return false;
        }

        addedSuits.add(
            card.suit
        );
    }

    if (
        existingNormalCards.length +
        cards.length >
        4
    ) {
        return false;
    }

    const combined = [
        ...meld,
        ...cards
    ];

    return isValidMeld(
        combined
    );
}

function canExtendSet(
    meld,
    card
) {
    return canExtendSetWithCards(
        meld,
        [card]
    );
}


/* =========================================================
   FIXED POSITION SEQUENCE EXTENSION
========================================================= */

function cardMatchesSequencePosition(
    card,
    position,
    suit
) {
    if (!card) {
        return false;
    }

    if (
        isJoker(card)
    ) {
        return true;
    }

    if (
        card.suit !== suit
    ) {
        return false;
    }

    const expectedRank =
        rankAtPosition(
            position
        );

    return (
        card.rank ===
        expectedRank
    );
}

function findFixedSequenceExtension(
    meld,
    cards
) {
    if (!meld || meld.length < 3 || !cards || cards.length === 0) {
        return null;
    }

    const info = getStoredSequenceInfo(meld);
    if (!info) return null;

    /*
       New cards may extend either side of a sequence, including BOTH
       sides in the same play.

       Example:
         existing: 4, 5, JOKER (joker = 6)
         new cards: 3 and 7
         result:    3, 4, 5, JOKER, 7

       The existing meld itself is never reordered.
    */
    const permutations = getCardPermutations(cards);

    for (const orderedCards of permutations) {
        for (let prefixCount = 0; prefixCount <= orderedCards.length; prefixCount++) {
            const prefixCards = orderedCards.slice(0, prefixCount);
            const suffixCards = orderedCards.slice(prefixCount);

            const prefixStart = info.start - prefixCards.length;
            const suffixEnd = info.end + suffixCards.length;

            if (prefixStart < 0 || suffixEnd > 13) continue;

            const prefixPositions = [];
            for (let p = prefixStart; p < info.start; p++) {
                prefixPositions.push(p);
            }

            const suffixPositions = [];
            for (let p = info.end + 1; p <= suffixEnd; p++) {
                suffixPositions.push(p);
            }

            let valid = true;

            for (let i = 0; i < prefixCards.length; i++) {
                if (!cardMatchesSequencePosition(
                    prefixCards[i],
                    prefixPositions[i],
                    info.suit
                )) {
                    valid = false;
                    break;
                }
            }

            if (!valid) continue;

            for (let i = 0; i < suffixCards.length; i++) {
                if (!cardMatchesSequencePosition(
                    suffixCards[i],
                    suffixPositions[i],
                    info.suit
                )) {
                    valid = false;
                    break;
                }
            }

            if (!valid) continue;

            return {
                side: prefixCards.length > 0 && suffixCards.length > 0
                    ? "both"
                    : prefixCards.length > 0
                        ? "prefix"
                        : "suffix",
                cards: [...orderedCards],
                prefixCards: [...prefixCards],
                prefixPositions: [...prefixPositions],
                suffixCards: [...suffixCards],
                suffixPositions: [...suffixPositions],
                positions: [...prefixPositions, ...suffixPositions]
            };
        }
    }

    return null;
}

function canExtendSequence(
    meld,
    card
) {
    return (
        findFixedSequenceExtension(
            meld,
            [card]
        ) !== null
    );
}

function canExtendSequenceWithCards(
    meld,
    cards
) {
    return findFixedSequenceExtension(
        meld,
        cards
    );
}


/* =========================================================
   PERMUTATIONS
========================================================= */

function getCardPermutations(
    cards
) {
    if (
        !cards ||
        cards.length === 0
    ) {
        return [[]];
    }

    if (
        cards.length > 7
    ) {
        return [];
    }

    const result = [];

    function build(
        remaining,
        current
    ) {
        if (
            remaining.length === 0
        ) {
            result.push([
                ...current
            ]);

            return;
        }

        for (
            let i = 0;
            i < remaining.length;
            i++
        ) {
            const next =
                remaining[i];

            const rest = [
                ...remaining.slice(
                    0,
                    i
                ),
                ...remaining.slice(
                    i + 1
                )
            ];

            current.push(
                next
            );

            build(
                rest,
                current
            );

            current.pop();
        }
    }

    build(
        [...cards],
        []
    );

    return result;
}


/* =========================================================
   EXTEND EXISTING MELD
========================================================= */

function extendExistingMeld(
    cards
) {
    if (
        !Array.isArray(cards)
    ) {
        cards = [cards];
    }

    if (
        cards.length === 0
    ) {
        return null;
    }

    /* EXISTING SET */

    for (
        let p = 0;
        p < PLAYER_COUNT;
        p++
    ) {
        const player =
            players[p];

        for (
            let m = 0;
            m < player.melds.length;
            m++
        ) {
            const meld =
                player.melds[m];

            if (
                meld.meldType !==
                "set"
            ) {
                continue;
            }

            if (
                canExtendSetWithCards(
                    meld,
                    cards
                )
            ) {
                cards.forEach(
                    card => {
                        meld.push(
                            card
                        );
                    }
                );

                return {
                    success: true,
                    player: p,
                    meld: meld,
                    type: "set"
                };
            }
        }
    }

    /* EXISTING SEQUENCE */

    for (
        let p = 0;
        p < PLAYER_COUNT;
        p++
    ) {
        const player =
            players[p];

        for (
            let m = 0;
            m < player.melds.length;
            m++
        ) {
            const meld =
                player.melds[m];

            if (
                meld.meldType !==
                "sequence"
            ) {
                continue;
            }

            const result =
                canExtendSequenceWithCards(
                    meld,
                    cards
                );

            if (!result) {
                continue;
            }

            const info =
                getStoredSequenceInfo(
                    meld
                );

            if (!info) {
                continue;
            }

            if (result.side === "both") {
                meld.splice(
                    0,
                    0,
                    ...result.prefixCards
                );

                meld.push(
                    ...result.suffixCards
                );

                meld.sequenceStart = result.prefixPositions[0];
                meld.sequenceEnd = result.suffixPositions[result.suffixPositions.length - 1];
            } else if (result.side === "prefix") {
                meld.unshift(
                    ...result.prefixCards
                );

                meld.sequenceStart = result.prefixPositions[0];
                meld.sequenceEnd = info.end;
            } else {
                meld.push(
                    ...result.suffixCards
                );

                meld.sequenceStart = info.start;
                meld.sequenceEnd = result.suffixPositions[result.suffixPositions.length - 1];
            }

            /*
               Rebuild the position metadata WITHOUT changing the
               actual card order. Each card keeps the position it has
               in the displayed meld.
            */
            const rebuiltPositions = [];
            const rebuiltJokers = [];

            for (let i = 0; i < meld.length; i++) {
                let position;

                if (i < (result.prefixCards || []).length) {
                    position = result.prefixPositions[i];
                } else if (i < (result.prefixCards || []).length + info.cardPositions.length) {
                    position = info.cardPositions[
                        i - (result.prefixCards || []).length
                    ];
                } else {
                    position = result.suffixPositions[
                        i - (result.prefixCards || []).length - info.cardPositions.length
                    ];
                }

                rebuiltPositions.push(position);

                if (isJoker(meld[i])) {
                    rebuiltJokers.push(position);
                }
            }

            meld.sequenceCardPositions = rebuiltPositions;
            meld.sequenceJokerPositions = rebuiltJokers;


            return {
                success: true,
                player: p,
                meld: meld,
                type: "sequence"
            };
        }
    }

    return null;
}


/* =========================================================
   MAKE MELD
========================================================= */

function makeMeld() {
    if (gameOver) return;
    if (!isMyTurn()) return;

    if (
        turnMode === "draw"
    ) {
        setMessage(
            "You drew a card. You cannot make a meld this turn."
        );

        return;
    }

    if (
        turnMode === null
    ) {
        turnMode = "meld";
    }

    const cards =
        selectedCards.map(
            index =>
                players[getLocalPlayerIndex()].hand[index]
        );


    /* =====================================================
       LICENSED PLAYER
    ===================================================== */

    if (
        licensed[getLocalPlayerIndex()] &&
        selectedCards.length >= 1
    ) {
        const result =
            extendExistingMeld(
                cards
            );

        if (result) {
            const indexes =
                [...selectedCards].sort(
                    (a, b) => b - a
                );

            indexes.forEach(
                index => {
                    players[getLocalPlayerIndex()].hand.splice(
                        index,
                        1
                    );
                }
            );

            selectedCards = [];

            turnMode =
                "meld";

            turnActionMade =
                true;

            turnMeldMade =
                true;

            if (
                checkGameOver()
            ) {
                return;
            }

            setMessage(
                `${cards.map(cardText).join(", ")} added to the existing ${result.type} meld.`
            );

            render();

            return;
        }
    }


    /* =====================================================
       NEW MELD
    ===================================================== */

    if (
        selectedCards.length < 3
    ) {
        if (
            !licensed[getLocalPlayerIndex()]
        ) {
            setMessage(
                "You need to show a 3 or more card meld first to get your license."
            );
        } else {
            setMessage(
                "Select 3 or more cards for a new meld, or select cards that extend an existing meld."
            );
        }

        return;
    }

    if (
        !isValidMeld(cards)
    ) {
        setMessage(
            "Invalid meld."
        );

        return;
    }


    /*
       Store the meld.

       IMPORTANT:

       If this is the player's FIRST TURN,
       DO NOT remove the cards from the hand.

       They remain visible with all other cards.
    */

    const newMeld =
        [...cards];

    storeMeldInfo(
        newMeld,
        true
    );

    players[0].melds.push(
        newMeld
    );


    if (
        newMeld.length >= 3
    ) {
        licensed[getLocalPlayerIndex()] =
            true;
    }


    /*
       Remove cards ONLY if the player's
       meld is already revealed.

       During first turn, cards stay in hand.
    */
    if (
        meldsRevealed[getLocalPlayerIndex()]
    ) {
        const indexes =
            [...selectedCards].sort(
                (a, b) => b - a
            );

        indexes.forEach(
            index => {
                players[getLocalPlayerIndex()].hand.splice(
                    index,
                    1
                );
            }
        );
    }


    selectedCards = [];

    turnMode =
        "meld";

    turnActionMade =
        true;

    turnMeldMade =
        true;


    /*
       IMPORTANT:

       Do NOT check game over here for a
       first-turn hidden meld because the
       cards are still in the player's hand.
    */
    if (
        meldsRevealed[getLocalPlayerIndex()] &&
        checkGameOver()
    ) {
        return;
    }


    if (
        licensed[getLocalPlayerIndex()]
    ) {
        if (
            firstTurnCompleted[getLocalPlayerIndex()]
        ) {
            setMessage(
                "Meld created. LICENSE obtained."
            );
        } else {
            setMessage(
                "Meld created. Your cards stay in your hand until melds are revealed. LICENSE obtained."
            );
        }
    } else {
        setMessage(
            "Meld created."
        );
    }

    render();
}


/* =========================================================
   DISCARD
========================================================= */

function discardSelected() {
    if (gameOver) return;
    if (!isMyTurn()) return;

    if (
        turnMode !== "draw"
    ) {
        setMessage(
            "Discard is only required after drawing."
        );

        return;
    }

    if (!hasDrawn) {
        setMessage(
            "Draw a card first."
        );

        return;
    }

    if (hasDiscarded) {
        setMessage(
            "You already discarded this turn."
        );

        return;
    }

    if (
        selectedCards.length !== 1
    ) {
        setMessage(
            "Select exactly one card to discard."
        );

        return;
    }

    const index =
        selectedCards[0];

    if (
        index < 0 ||
        index >=
            players[getLocalPlayerIndex()].hand.length
    ) {
        selectedCards = [];

        render();

        setMessage(
            "Please select a card again."
        );

        return;
    }

    const card =
        players[getLocalPlayerIndex()].hand.splice(
            index,
            1
        )[0];

    discardPile.push(
        card
    );

    selectedCards = [];

    hasDiscarded =
        true;

    turnActionMade =
        true;

    if (
        checkGameOver()
    ) {
        return;
    }

    setMessage(
        "Card discarded. Press COMPLETE to end your turn."
    );

    render();
}


/* =========================================================
   COMPLETE BUTTON
========================================================= */

function createCompleteButton() {
    let completeBtn =
        $("completeBtn");

    const table =
        document.querySelector(
            ".table"
        );

    if (!table) {
        return null;
    }

    if (completeBtn) {
        if (
            completeBtn.parentElement !==
            table
        ) {
            table.appendChild(
                completeBtn
            );
        }

        return completeBtn;
    }

    completeBtn =
        document.createElement(
            "button"
        );

    completeBtn.id =
        "completeBtn";

    completeBtn.textContent =
        "COMPLETE";

    completeBtn.className =
        "complete-btn";

    completeBtn.type =
        "button";

    completeBtn.addEventListener(
        "click",
        completeTurn
    );

    table.appendChild(
        completeBtn
    );

    return completeBtn;
}

function updateCompleteButton() {
    const completeBtn =
        $("completeBtn");

    if (!completeBtn) return;

    let enabled = false;

    if (
        isMyTurn() &&
        !gameOver
    ) {
        if (
            turnMode === "draw" &&
            hasDrawn &&
            hasDiscarded
        ) {
            enabled = true;
        }

        if (
            turnMode === "meld" &&
            turnMeldMade
        ) {
            enabled = true;
        }
    }

    completeBtn.disabled =
        !enabled;
}


/* =========================================================
   COMPLETE TURN
========================================================= */

function completeTurn() {
    if (gameOver) return;
    if (!isMyTurn()) return;

    /*
       FIRST TURN MUST ALWAYS HAVE
       A DRAW/TAKE ACTION.

       Creating a meld alone does NOT count
       as taking a card on the first turn.
    */

    if (
        !firstTurnCompleted[getLocalPlayerIndex()]
    ) {
        if (!hasDrawn) {
            setMessage(
                "First turn cannot be skipped. You must take the indicator, draw a card, or take the discard card."
            );

            return;
        }

        if (!hasDiscarded) {
            setMessage(
                "You must discard one card before completing your first turn."
            );

            return;
        }
    }


    if (
        turnMode === "draw"
    ) {
        if (!hasDrawn) {
            setMessage(
                "You must draw first."
            );

            return;
        }

        if (!hasDiscarded) {
            setMessage(
                "You must discard one card before COMPLETE."
            );

            return;
        }
    }


    if (
        turnMode === "meld"
    ) {
        /*
           A meld turn is allowed only after
           the player has already taken a card
           on the first turn.

           Therefore first-turn meld alone
           cannot complete the turn.
        */
        if (
            !firstTurnCompleted[getLocalPlayerIndex()]
        ) {
            if (!hasDrawn) {
                setMessage(
                    "You must take a card first. You cannot skip your first turn."
                );

                return;
            }

            if (!hasDiscarded) {
                setMessage(
                    "You must discard one card before COMPLETE."
                );

                return;
            }
        }

        if (!turnMeldMade) {
            setMessage(
                "Make at least one meld first."
            );

            return;
        }
    }


    if (
        !firstTurnCompleted[getLocalPlayerIndex()]
    ) {
        firstTurnCompleted[getLocalPlayerIndex()] =
            true;
    }


    resetTurnState();

    currentPlayer = (getLocalPlayerIndex() - 1 + PLAYER_COUNT) % PLAYER_COUNT;

    updateMeldVisibility();

    resetTurnState();

    render();

    setMessage(
        `${players[currentPlayer].name === "Player 1" ? "Your" : players[currentPlayer].name}'s turn.`
    );

    if (!isOnlineGame) {
        setTimeout(
            aiTurn,
            900
        );
    }
    if (isOnlineGame) broadcastOnlineState();
}


/* =========================================================
   AI TURN
========================================================= */

function aiTurn() {
    if (isOnlineGame) return;
    if (gameOver) return;
    if (currentPlayer === 0) return;

    updateMeldVisibility();

    if (gameOver) return;

    const aiIndex =
        currentPlayer;

    const player =
        players[aiIndex];

    resetTurnState();

    render();

    setMessage(
        `${player.name}'s turn.`
    );

    setTimeout(
        () => {
            playAITurn(
                aiIndex
            );
        },
        600
    );
}


/* =========================================================
   AI PLAY TURN
========================================================= */

function playAITurn(
    aiIndex
) {
    if (gameOver) return;

    if (
        currentPlayer !==
        aiIndex
    ) {
        return;
    }

    /*
       FIRST TURN:
       Only the player who started this game may take
       the indicator card. If that player does not need
       the indicator, the indicator stays on the table and
       the player draws normally. No other player may take it.
    */
    if (
        !firstTurnCompleted[aiIndex]
    ) {
        if (
            aiIndex === roundStartingPlayer &&
            indicatorAvailable &&
            indicator &&
            aiNeedsIndicatorCard(aiIndex)
        ) {
            aiTakeIndicator(aiIndex);
        } else {
            aiDrawTurn(aiIndex);
        }

        return;
    }


    const player =
        players[aiIndex];

    let extensionIndex = -1;

    if (
        licensed[aiIndex]
    ) {
        extensionIndex =
            findAIExtensionCard(
                aiIndex
            );
    }

    if (
        extensionIndex >= 0 &&
        Math.random() < 0.6
    ) {
        aiMeldTurn(
            aiIndex
        );

        setTimeout(
            () => {
                aiExtendMeld(
                    aiIndex,
                    extensionIndex
                );
            },
            500
        );

        return;
    }

    const possibleMeld =
        findAIMeld(
            player.hand
        );

    if (
        possibleMeld &&
        Math.random() < 0.5
    ) {
        aiMeldTurn(
            aiIndex
        );
    } else {
        aiDrawTurn(
            aiIndex
        );
    }
}


/* =========================================================
   AI FIRST-TURN INDICATOR
========================================================= */

function aiNeedsIndicatorCard(aiIndex) {
    if (
        aiIndex !== roundStartingPlayer ||
        !indicatorAvailable ||
        !indicator
    ) {
        return false;
    }

    const hand = players[aiIndex].hand;
    const testCards = [...hand, indicator];

    // Take the indicator only when it immediately helps form
    // at least one valid meld. Otherwise leave it on the table.
    for (let a = 0; a < testCards.length; a++) {
        for (let b = a + 1; b < testCards.length; b++) {
            for (let c = b + 1; c < testCards.length; c++) {
                if (
                    isValidMeld([
                        testCards[a],
                        testCards[b],
                        testCards[c]
                    ])
                ) {
                    if (
                        testCards[a].id === indicator.id ||
                        testCards[b].id === indicator.id ||
                        testCards[c].id === indicator.id
                    ) {
                        return true;
                    }
                }
            }
        }
    }

    return false;
}

function aiTakeIndicator(aiIndex) {
    if (gameOver) return;
    if (currentPlayer !== aiIndex) return;
    if (aiIndex !== roundStartingPlayer) return;
    if (firstTurnCompleted[aiIndex]) return;
    if (!indicatorAvailable || !indicator) {
        aiDrawTurn(aiIndex);
        return;
    }

    const player = players[aiIndex];

    player.hand.push(indicator);

    indicatorTaken = true;
    indicatorAvailable = false;

    hasDrawn = true;
    hasDiscarded = false;
    turnMode = "draw";
    turnActionMade = true;
    turnMeldMade = false;

    render();

    setMessage(
        `${player.name} took the indicator card.`
    );

    setTimeout(
        () => {
            aiDiscardCard(aiIndex);
        },
        600
    );
}


/* =========================================================
   AI DRAW
========================================================= */

function aiDrawTurn(
    aiIndex
) {
    if (gameOver) return;

    const player =
        players[aiIndex];

    turnMode =
        "draw";

    hasDrawn =
        false;

    hasDiscarded =
        false;

    turnActionMade =
        false;

    turnMeldMade =
        false;

    prepareDrawPile();

    if (
        deck.length === 0
    ) {
        finishAITurn(
            aiIndex
        );

        return;
    }

    player.hand.push(
        deck.pop()
    );

    hasDrawn =
        true;

    turnActionMade =
        true;

    render();

    setMessage(
        `${player.name} drew a card.`
    );

    setTimeout(
        () => {
            aiDiscardCard(
                aiIndex
            );
        },
        600
    );
}


/* =========================================================
   AI DISCARD
========================================================= */

function aiDiscardCard(
    aiIndex
) {
    if (gameOver) return;

    const player =
        players[aiIndex];

    if (
        currentPlayer !==
        aiIndex
    ) {
        return;
    }

    if (
        turnMode !== "draw" ||
        !hasDrawn ||
        hasDiscarded
    ) {
        return;
    }

    if (
        player.hand.length === 0
    ) {
        checkGameOver();
        return;
    }

    let discardIndex =
        findAIDiscardIndex(
            player.hand
        );

    if (
        discardIndex < 0 ||
        discardIndex >=
            player.hand.length
    ) {
        discardIndex =
            player.hand.length - 1;
    }

    const card =
        player.hand.splice(
            discardIndex,
            1
        )[0];

    discardPile.push(
        card
    );

    hasDiscarded =
        true;

    turnActionMade =
        true;

    if (
        checkGameOver()
    ) {
        return;
    }

    render();

    setMessage(
        `${player.name} discarded a card.`
    );

    setTimeout(
        () => {
            if (
                !gameOver &&
                hasDrawn &&
                hasDiscarded
            ) {
                finishAITurn(
                    aiIndex
                );
            }
        },
        700
    );
}


/* =========================================================
   AI MELD TURN
========================================================= */

function aiMeldTurn(
    aiIndex
) {
    if (gameOver) return;

    const player =
        players[aiIndex];

    turnMode =
        "meld";

    hasDrawn =
        false;

    hasDiscarded =
        false;

    turnActionMade =
        false;

    turnMeldMade =
        false;

    render();

    setMessage(
        `${player.name} started a meld turn.`
    );

    setTimeout(
        () => {
            makeAIMelds(
                aiIndex
            );
        },
        600
    );
}


/* =========================================================
   AI FIND EXTENSION
========================================================= */

function findAIExtensionCard(
    aiIndex
) {
    if (
        !licensed[aiIndex]
    ) {
        return -1;
    }

    const player =
        players[aiIndex];

    for (
        let i = 0;
        i < player.hand.length;
        i++
    ) {
        const card =
            player.hand[i];

        for (
            let p = 0;
            p < PLAYER_COUNT;
            p++
        ) {
            for (
                let m = 0;
                m < players[p].melds.length;
                m++
            ) {
                const meld =
                    players[p].melds[m];

                if (
                    meld.meldType ===
                    "set"
                ) {
                    if (
                        canExtendSet(
                            meld,
                            card
                        )
                    ) {
                        return i;
                    }
                }

                if (
                    meld.meldType ===
                    "sequence"
                ) {
                    if (
                        canExtendSequence(
                            meld,
                            card
                        )
                    ) {
                        return i;
                    }
                }
            }
        }
    }

    return -1;
}


/* =========================================================
   AI EXTEND MELD
========================================================= */

function aiExtendMeld(
    aiIndex,
    handIndex
) {
    if (gameOver) return;

    if (
        currentPlayer !==
        aiIndex
    ) {
        return;
    }

    if (
        !licensed[aiIndex]
    ) {
        makeAIMelds(
            aiIndex
        );

        return;
    }

    const player =
        players[aiIndex];

    if (
        handIndex < 0 ||
        handIndex >=
            player.hand.length
    ) {
        finishAITurn(
            aiIndex
        );

        return;
    }

    const card =
        player.hand[
            handIndex
        ];

    const result =
        extendExistingMeld(
            card
        );

    if (!result) {
        makeAIMelds(
            aiIndex
        );

        return;
    }

    player.hand.splice(
        handIndex,
        1
    );

    turnMeldMade =
        true;

    turnActionMade =
        true;

    if (
        checkGameOver()
    ) {
        return;
    }

    render();

    setMessage(
        `${player.name} added ${cardText(card)} to an existing meld.`
    );

    setTimeout(
        () => {
            finishAITurn(
                aiIndex
            );
        },
        800
    );
}


/* =========================================================
   AI MAKE MELDS
========================================================= */

function makeAIMelds(
    aiIndex
) {
    if (gameOver) return;

    const player =
        players[aiIndex];

    let madeAny = false;


    /*
       Licensed player can extend
       existing melds.
    */

    if (
        licensed[aiIndex]
    ) {
        for (
            let count = 0;
            count < 5;
            count++
        ) {
            const extension =
                findAIExtensionCard(
                    aiIndex
                );

            if (
                extension < 0
            ) {
                break;
            }

            const card =
                player.hand[
                    extension
                ];

            const result =
                extendExistingMeld(
                    card
                );

            if (!result) {
                break;
            }

            player.hand.splice(
                extension,
                1
            );

            madeAny =
                true;

            turnActionMade =
                true;

            turnMeldMade =
                true;

            if (
                checkGameOver()
            ) {
                return;
            }
        }
    }


    /*
       Create new melds.
    */

    for (
        let count = 0;
        count < 5;
        count++
    ) {
        const meld =
            findAIMeld(
                player.hand
            );

        if (!meld) {
            break;
        }

        const indexes =
            [...meld.indexes].sort(
                (a, b) => b - a
            );

        const cards =
            meld.cards;

        /*
           FIRST TURN:

           Keep the meld cards in the
           player's normal hand.

           Do NOT splice them out yet.
        */
        if (
            !firstTurnCompleted[aiIndex]
        ) {
            const newMeld =
                [...cards];

            storeMeldInfo(
                newMeld,
                true
            );

            player.melds.push(
                newMeld
            );

            if (
                newMeld.length >= 3
            ) {
                licensed[aiIndex] =
                    true;
            }

            madeAny =
                true;

            turnActionMade =
                true;

            turnMeldMade =
                true;

            /*
               Do not remove cards here.
            */

            break;
        }


        /*
           Normal/revealed turn:
           remove meld cards from hand.
        */

        indexes.forEach(
            index => {
                player.hand.splice(
                    index,
                    1
                );
            }
        );

        const newMeld =
            [...cards];

        storeMeldInfo(
            newMeld,
            true
        );

        player.melds.push(
            newMeld
        );

        if (
            newMeld.length >= 3
        ) {
            licensed[aiIndex] =
                true;
        }

        madeAny =
            true;

        turnActionMade =
            true;

        turnMeldMade =
            true;

        if (
            checkGameOver()
        ) {
            return;
        }
    }


    render();

    if (madeAny) {
        setMessage(
            `${player.name} made/extended meld(s).`
        );
    } else {
        setMessage(
            `${player.name} could not make a meld.`
        );
    }

    setTimeout(
        () => {
            if (!gameOver) {
                finishAITurn(
                    aiIndex
                );
            }
        },
        800
    );
}


/* =========================================================
   AI FIND MELD
========================================================= */

function findAIMeld(
    hand
) {
    /* SETS */

    for (
        let rankIndex = 0;
        rankIndex < RANKS.length;
        rankIndex++
    ) {
        const rank =
            RANKS[rankIndex];

        const indexes = [];

        for (
            let i = 0;
            i < hand.length;
            i++
        ) {
            const card =
                hand[i];

            if (
                card.rank === rank &&
                !isJoker(card)
            ) {
                indexes.push(i);
            }
        }

        if (
            indexes.length >= 3
        ) {
            const selected =
                indexes.slice(0, 4);

            const cards =
                selected.map(
                    i => hand[i]
                );

            if (
                isValidMeld(
                    cards
                )
            ) {
                return {
                    indexes:
                        selected,

                    cards:
                        cards
                };
            }
        }
    }


    /* SEQUENCES */

    for (
        let suitIndex = 0;
        suitIndex < SUITS.length;
        suitIndex++
    ) {
        const suit =
            SUITS[suitIndex];

        for (
            let start = 0;
            start <= 11;
            start++
        ) {
            const indexes = [];
            const neededRanks = [];

            for (
                let p = start;
                p <= start + 2;
                p++
            ) {
                if (p === 0) {
                    neededRanks.push(
                        "A"
                    );
                } else if (
                    p === 13
                ) {
                    neededRanks.push(
                        "A"
                    );
                } else {
                    neededRanks.push(
                        RANKS[p]
                    );
                }
            }

            let possible =
                true;

            neededRanks.forEach(
                rank => {
                    let found =
                        -1;

                    for (
                        let i = 0;
                        i < hand.length;
                        i++
                    ) {
                        if (
                            hand[i].rank ===
                                rank &&
                            hand[i].suit ===
                                suit &&
                            !isJoker(
                                hand[i]
                            )
                        ) {
                            found = i;
                            break;
                        }
                    }

                    if (
                        found === -1
                    ) {
                        possible =
                            false;
                    } else {
                        indexes.push(
                            found
                        );
                    }
                }
            );

            if (!possible) {
                const jokerIndex =
                    hand.findIndex(
                        card =>
                            isJoker(card)
                    );

                if (
                    jokerIndex >= 0
                ) {
                    const unique =
                        [
                            ...new Set(
                                indexes
                            )
                        ];

                    const selected = [
                        ...unique,
                        jokerIndex
                    ];

                    if (
                        selected.length === 3
                    ) {
                        const cards =
                            selected.map(
                                i => hand[i]
                            );

                        if (
                            isValidMeld(
                                cards
                            )
                        ) {
                            return {
                                indexes:
                                    selected,

                                cards:
                                    cards
                            };
                        }
                    }
                }
            } else {
                const cards =
                    indexes.map(
                        i => hand[i]
                    );

                if (
                    isValidMeld(
                        cards
                    )
                ) {
                    return {
                        indexes:
                            indexes,

                        cards:
                            cards
                    };
                }
            }
        }
    }


    /* J Q K A WITH JOKER */

    for (
        let suitIndex = 0;
        suitIndex < SUITS.length;
        suitIndex++
    ) {
        const suit =
            SUITS[suitIndex];

        const needed = [
            "J",
            "Q",
            "K",
            "A"
        ];

        const indexes = [];
        let missing = 0;

        needed.forEach(
            rank => {
                let found =
                    -1;

                for (
                    let i = 0;
                    i < hand.length;
                    i++
                ) {
                    if (
                        hand[i].rank ===
                            rank &&
                        hand[i].suit ===
                            suit &&
                        !isJoker(
                            hand[i]
                        )
                    ) {
                        found = i;
                        break;
                    }
                }

                if (
                    found >= 0
                ) {
                    indexes.push(
                        found
                    );
                } else {
                    missing++;
                }
            }
        );

        if (
            missing === 1
        ) {
            const jokerIndex =
                hand.findIndex(
                    card =>
                        isJoker(card)
                );

            if (
                jokerIndex >= 0
            ) {
                indexes.push(
                    jokerIndex
                );

                const cards =
                    indexes.map(
                        i => hand[i]
                    );

                if (
                    isValidMeld(
                        cards
                    )
                ) {
                    return {
                        indexes:
                            indexes,

                        cards:
                            cards
                    };
                }
            }
        }
    }

    return null;
}


/* =========================================================
   AI DISCARD
========================================================= */

function findAIDiscardIndex(
    hand
) {
    const candidates = [];

    for (
        let i = 0;
        i < hand.length;
        i++
    ) {
        const card =
            hand[i];

        if (
            card.rank ===
            "JOKER"
        ) {
            continue;
        }

        if (
            card.rank ===
            universalRank
        ) {
            continue;
        }

        candidates.push(i);
    }

    if (
        candidates.length === 0
    ) {
        return hand.length - 1;
    }

    return candidates[
        Math.floor(
            Math.random() *
            candidates.length
        )
    ];
}


/* =========================================================
   FINISH AI TURN
========================================================= */

function finishAITurn(
    aiIndex
) {
    if (gameOver) return;

    if (
        currentPlayer !==
        aiIndex
    ) {
        return;
    }

    if (
        players[aiIndex].hand.length === 0
    ) {
        checkGameOver();
        return;
    }


    /*
       FIRST TURN:

       AI must have drawn and discarded.
    */
    if (
        !firstTurnCompleted[aiIndex]
    ) {
        if (
            !hasDrawn ||
            !hasDiscarded
        ) {
            return;
        }
    }


    if (
        turnMode === "draw"
    ) {
        if (
            !hasDrawn ||
            !hasDiscarded
        ) {
            return;
        }
    } else if (
        turnMode === "meld"
    ) {
        /*
           First-turn meld is allowed only
           after the mandatory draw/discard.
        */
        if (
            !firstTurnCompleted[aiIndex] &&
            (
                !hasDrawn ||
                !hasDiscarded
            )
        ) {
            return;
        }

        if (
            !turnMeldMade
        ) {
            /*
               If no meld was made, complete
               the normal draw turn instead.
            */
            if (
                !hasDrawn
            ) {
                aiDrawTurn(
                    aiIndex
                );

                return;
            }
        }
    }


    if (
        !firstTurnCompleted[aiIndex]
    ) {
        firstTurnCompleted[aiIndex] =
            true;
    }


    resetTurnState();

    currentPlayer =
        (aiIndex - 1 + PLAYER_COUNT) %
        PLAYER_COUNT;

    updateMeldVisibility();

    if (gameOver) {
        return;
    }

    resetTurnState();

    render();

    if (
        isMyTurn()
    ) {
        setMessage(
            "Your turn."
        );
    } else {
        setMessage(
            `${players[currentPlayer].name}'s turn.`
        );

        setTimeout(
            aiTurn,
            900
        );
    }
}


/* =========================================================
   RENDER MELDS
========================================================= */

function renderMelds() {
    for (
        let i = 0;
        i < PLAYER_COUNT;
        i++
    ) {
        const player =
            players[i];

        /*
           Find the visual seat that renderPlayers assigned to this actual
           player. Do not calculate the seat separately here: using the same
           data-player-index mapping prevents melds from appearing in another
           player's section in online games.
        */
        const playerBox = document.querySelector(
            `.player[data-player-index="${i}"]`
        );

        if (!playerBox) {
            continue;
        }

        const meldBox =
            playerBox.querySelector(
                ".melds"
            );

        if (!meldBox) {
            continue;
        }

        meldBox.innerHTML = "";

        /*
           Hidden until all first turns are
           completed AND this player's own
           turn has started.
        */

        if (
            !meldsRevealed[i]
        ) {
            continue;
        }

        /*
           Existing sequence positions are
           NEVER recalculated here.
        */

        player.melds.forEach(
            meld => {
                const row =
                    document.createElement(
                        "div"
                    );

                row.className =
                    "meld-row";

                /*
                   Keep every meld sequence/set on ONE horizontal line.
                   The surrounding player box may be narrow, but the meld
                   itself must never wrap onto a second line.
                */
                row.style.display = "flex";
                row.style.flexWrap = "nowrap";
                row.style.whiteSpace = "nowrap";
                row.style.width = "max-content";
                row.style.alignItems = "center";
                row.style.overflow = "visible";

                meldBox.style.overflow = "visible";

                row.dataset.meldPlayer = String(i);
                row.dataset.meldIndex = String(player.melds.indexOf(meld));

                meld.forEach(
                    card => {
                        const cardDiv =
                            document.createElement(
                                "div"
                            );

                        cardDiv.className =
                            `${cardClass(card)} small`;

                        setCardVisual(cardDiv, card);
                        cardDiv.dataset.meldPlayer = String(i);
                        cardDiv.dataset.meldIndex = String(player.melds.indexOf(meld));
                        cardDiv.dataset.meldCardId = String(card.id);

                        row.appendChild(
                            cardDiv
                        );
                    }
                );

                meldBox.appendChild(
                    row
                );
            }
        );
    }
}


/* =========================================================
   SORT HAND
========================================================= */

function sortHand() {
    players[getLocalPlayerIndex()].hand.sort(
        (a, b) => {
            if (
                a.rank === "JOKER"
            ) {
                return 1;
            }

            if (
                b.rank === "JOKER"
            ) {
                return -1;
            }

            const suitA =
                SUITS.indexOf(
                    a.suit
                );

            const suitB =
                SUITS.indexOf(
                    b.suit
                );

            if (
                suitA !== suitB
            ) {
                return (
                    suitA - suitB
                );
            }

            return (
                RANKS.indexOf(
                    a.rank
                ) -
                RANKS.indexOf(
                    b.rank
                )
            );
        }
    );

    selectedCards = [];

    render();
}


/* =========================================================
   BUTTONS
========================================================= */

function updateButtons() {
    const drawBtn =
        $("drawBtn");

    const takeDiscardBtn =
        $("takeDiscardBtn");

    const discardBtn =
        $("discardBtn");

    const makeMeldBtn =
        $("makeMeldBtn");


    if (drawBtn) {
        drawBtn.disabled =
            !isMyTurn() ||
            turnMode === "meld" ||
            hasDrawn ||
            gameOver;
    }


    if (takeDiscardBtn) {
        takeDiscardBtn.disabled =
            !isMyTurn() ||
            turnMode === "meld" ||
            hasDrawn ||
            discardPile.length === 0 ||
            gameOver;
    }


    if (discardBtn) {
        discardBtn.disabled =
            !isMyTurn() ||
            turnMode !== "draw" ||
            !hasDrawn ||
            hasDiscarded ||
            selectedCards.length !== 1 ||
            gameOver;
    }


    if (makeMeldBtn) {
        makeMeldBtn.disabled =
            !isMyTurn() ||
            turnMode === "draw" ||
            selectedCards.length < 1 ||
            gameOver;
    }
}


/* =========================================================
   MESSAGE
========================================================= */

function setMessage(
    text
) {
    const message =
        $("message");

    if (message) {
        message.textContent =
            text;
    }

    saveGame();
}


/* =========================================================
   START GAME
========================================================= */


/* =========================================================
   ONLINE MULTIPLAYER
========================================================= */
function broadcastOnlineState(){
    if(!isOnlineGame || suppressNetworkSync || !onlineSocket || onlineSocket.readyState!==WebSocket.OPEN) return;
    const forceFull = onlineForceFullState && onlineHost;
    onlineSocket.send(JSON.stringify({type:"state",roomCode:onlineRoomCode,forceFull,state:{
        players,deck,discardPile,indicator,indicatorAvailable,indicatorTaken,roundStartingPlayer,universalRank,currentPlayer,
        selectedCards:[],hasDrawn,hasDiscarded,turnMode,turnActionMade,turnMeldMade,firstTurnCompleted,meldsRevealed,licensed,
        gameOver,gameWinner,gameStarted,lastRanking,roundScores,suffolCount,message:$('message')?$('message').textContent:""
    }}));
    onlineForceFullState = false;
}
function applyOnlineState(st){
    if(!st || !Array.isArray(st.players) || st.players.length!==PLAYER_COUNT) return;
    suppressNetworkSync=true;
    try{
        players=st.players; deck=st.deck||[]; discardPile=st.discardPile||[]; indicator=st.indicator||null;
        indicatorAvailable=!!st.indicatorAvailable; indicatorTaken=!!st.indicatorTaken; roundStartingPlayer=Number.isInteger(st.roundStartingPlayer)?st.roundStartingPlayer:0;
        universalRank=st.universalRank||null; currentPlayer=Number.isInteger(st.currentPlayer)?st.currentPlayer:0;
        hasDrawn=!!st.hasDrawn; hasDiscarded=!!st.hasDiscarded; turnMode=st.turnMode||null; turnActionMade=!!st.turnActionMade; turnMeldMade=!!st.turnMeldMade;
        firstTurnCompleted=Array.isArray(st.firstTurnCompleted)?st.firstTurnCompleted:[false,false,false,false,false];
        meldsRevealed=Array.isArray(st.meldsRevealed)?st.meldsRevealed:[false,false,false,false,false];
        licensed=Array.isArray(st.licensed)?st.licensed:[false,false,false,false,false]; gameOver=!!st.gameOver; gameWinner=Number.isInteger(st.gameWinner)?st.gameWinner:-1;
        gameStarted=!!st.gameStarted; lastRanking=Array.isArray(st.lastRanking)?st.lastRanking:[]; roundScores=Array.isArray(st.roundScores)?st.roundScores:[]; suffolCount=Number.isInteger(st.suffolCount)?st.suffolCount:0; selectedCards=[];
        render(); if(st.message) setMessage(st.message);
        if(gameOver && lastRanking.length) showRoundScoreboard(lastRanking);
    }finally{ suppressNetworkSync=false; }
}
function onlineStatus(t){const e=$("onlineStatus");if(e)e.textContent=t;}
function showOnlinePanel(){
    const card=document.querySelector("#mainMenu .menu-card"); if(!card || $("onlinePanel")) return;
    const p=document.createElement("div"); p.id="onlinePanel"; p.style.marginTop="18px";
    p.innerHTML='<div style="font-weight:800;margin-bottom:8px">ONLINE 5 PLAYER</div><button id="createOnlineBtn" class="menu-button menu-new-game" type="button">CREATE GAME</button><div style="display:flex;gap:8px;margin-top:12px"><input id="roomCodeInput" maxlength="6" placeholder="ROOM CODE" style="flex:1;padding:13px;border:1px solid #ccd2dc;border-radius:10px;text-align:center;text-transform:uppercase;font-weight:700"><button id="joinOnlineBtn" class="menu-button menu-resume" type="button" style="width:auto;margin:0;padding:0 18px">JOIN</button></div><div id="onlineStatus" style="min-height:22px;margin-top:12px;color:#687386;font-size:13px"></div>';
    card.appendChild(p); $("createOnlineBtn").onclick=()=>connectOnline("create"); $("joinOnlineBtn").onclick=()=>connectOnline("join",$("roomCodeInput").value.trim().toUpperCase());
}
function connectOnline(mode,room){
    if(onlineSocket && onlineSocket.readyState===WebSocket.OPEN) onlineSocket.close();
    isOnlineGame=true; onlineHost=mode==="create"; onlineStatus(mode==="create"?"Creating room...":"Joining room...");
    const proto=location.protocol==="https:"?"wss:":"ws:"; onlineSocket=new WebSocket(proto+"//"+location.host);
    onlineSocket.onopen=()=>onlineSocket.send(JSON.stringify({type:mode==="create"?"create_room":"join_room",roomCode:room||""}));
    onlineSocket.onmessage=e=>{let m;try{m=JSON.parse(e.data)}catch{return}
        if(m.type==="room_created"||m.type==="joined"){onlineRoomCode=m.roomCode;myPlayerIndex=m.playerIndex;onlineStatus(`Room ${onlineRoomCode} • You are Player ${myPlayerIndex+1}. Waiting for 5 players...`);return;}
        if(m.type==="room_status"){onlineStatus(`Room ${onlineRoomCode} • ${m.count}/5 players connected.`);return;}
        if(m.type==="room_full"&&onlineHost){onlineStatus(`Room ${onlineRoomCode} is full. Starting game...`);newGame(true);return;}
        if(m.type==="state"){applyOnlineState(m.state);const menu=$("mainMenu"),game=$("gameScreen");if(menu)menu.style.display="none";if(game)game.style.display="block";return;}
        if(m.type==="error") onlineStatus(m.message||"Online error.");
        if(m.type==="player_left") onlineStatus(`Player ${m.playerIndex+1} disconnected. Waiting for reconnection...`);
    };
    onlineSocket.onclose=()=>{if(isOnlineGame)onlineStatus("Connection closed.");}; onlineSocket.onerror=()=>onlineStatus("Could not connect to multiplayer server.");
}

document.addEventListener(
    "DOMContentLoaded",
    () => {
        const menuScreen =
            $("mainMenu");

        const gameScreen =
            $("gameScreen");

        const menuNewGameBtn =
            $("menuNewGameBtn");

        const menuResumeBtn =
            $("menuResumeBtn");

        const resumeStatus =
            $("resumeStatus");

        const newGameBtn =
            $("newGameBtn");

        const drawBtn =
            $("drawBtn");

        const takeDiscardBtn =
            $("takeDiscardBtn");

        const sortBtn =
            $("sortBtn");

        const makeMeldBtn =
            $("makeMeldBtn");

        const discardBtn =
            $("discardBtn");


        function showGameScreen() {
            if (menuScreen) {
                menuScreen.style.display =
                    "none";
            }

            if (gameScreen) {
                gameScreen.style.display =
                    "block";
            }
        }


        function showMenuScreen() {
            if (gameScreen) {
                gameScreen.style.display =
                    "none";
            }

            if (menuScreen) {
                menuScreen.style.display =
                    "flex";
            }
        }


        function updateResumeButton() {
            const saved =
                hasSavedGame();

            if (menuResumeBtn) {
                menuResumeBtn.disabled =
                    !saved;
            }

            if (resumeStatus) {
                resumeStatus.textContent =
                    saved
                        ? "A saved game is available."
                        : "No saved game available.";
            }
        }


        if (menuNewGameBtn) {
            menuNewGameBtn.addEventListener(
                "click",
                () => {
                    showGameScreen();
                    newGame();
                }
            );
        }


        if (menuResumeBtn) {
            menuResumeBtn.addEventListener(
                "click",
                () => {
                    if (!hasSavedGame()) {
                        updateResumeButton();
                        return;
                    }

                    if (!loadGame()) {
                        clearSavedGame();
                        showMenuScreen();
                        updateResumeButton();
                        return;
                    }

                    showGameScreen();

                    /*
                       loadGame() already renders the game.
                       If an AI turn was restored, it will continue
                       from the saved current player.
                    */
                }
            );
        }


        if (newGameBtn) {
            newGameBtn.addEventListener(
                "click",
                () => {
                    if (isOnlineGame && !onlineHost) {
                        setMessage("Only the room creator can start a new game.");
                        return;
                    }
                    newGame(isOnlineGame ? false : true);
                }
            );
        }


        if (drawBtn) {
            drawBtn.addEventListener(
                "click",
                drawCard
            );
        }


        if (takeDiscardBtn) {
            takeDiscardBtn.addEventListener(
                "click",
                takeDiscard
            );
        }


        if (sortBtn) {
            sortBtn.addEventListener(
                "click",
                sortHand
            );
        }


        if (makeMeldBtn) {
            makeMeldBtn.addEventListener(
                "click",
                makeMeld
            );
        }


        if (discardBtn) {
            discardBtn.addEventListener(
                "click",
                discardSelected
            );
        }


        createCompleteButton();

        /*
           The menu is the first screen.
           The game does NOT automatically start.
        */
        showMenuScreen();
        updateResumeButton();
        showOnlinePanel();
    }
);
