// Bank Dice Game - Main Application Logic

class BankGame {
    constructor() {
        this.players = [];
        this.totalRounds = 20;
        this.currentRound = 1;
        this.rollCount = 0;
        this.bankTotal = 0;
        this.currentPlayerIndex = 0;
        this.playersWhoCanRoll = [];
        this.playersWhoBanked = [];
        this.gameStarted = false;
        this.lastRoundEndPlayerIndex = 0; // Track who ended the last round
        this.history = []; // For undo functionality

        this.initEventListeners();
        this.loadFromStorage();
    }

    initEventListeners() {
        // Setup screen
        document.getElementById('add-player-btn').addEventListener('click', () => this.addPlayer());
        document.getElementById('player-name-input').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') this.addPlayer();
        });
        document.getElementById('start-game-btn').addEventListener('click', () => this.startGame());

        // Round selection
        document.querySelectorAll('.round-btn').forEach(btn => {
            btn.addEventListener('click', (e) => this.selectRounds(e.target));
        });

        // Game screen - dice buttons
        document.querySelectorAll('.dice-btn').forEach(btn => {
            btn.addEventListener('click', (e) => this.handleDiceRoll(parseInt(e.target.dataset.value)));
        });

        // Doubles button
        document.getElementById('doubles-btn').addEventListener('click', () => this.handleDoubles());

        // Bank button
        document.getElementById('bank-btn').addEventListener('click', () => this.showBankModal());

        // Bank modal
        document.getElementById('cancel-bank-btn').addEventListener('click', () => this.hideBankModal());

        // Round end modal
        document.getElementById('next-round-btn').addEventListener('click', () => this.startNextRound());

        // Game over modal
        document.getElementById('play-again-btn').addEventListener('click', () => this.resetGame());

        // New game button
        document.getElementById('new-game-btn').addEventListener('click', () => this.confirmNewGame());

        // Undo button
        document.getElementById('undo-btn').addEventListener('click', () => this.undo());
    }

    // Player Management
    addPlayer() {
        const input = document.getElementById('player-name-input');
        const name = input.value.trim();

        if (name && this.players.length < 20) {
            if (!this.players.some(p => p.name.toLowerCase() === name.toLowerCase())) {
                this.players.push({
                    name: name,
                    score: 0
                });
                this.updatePlayerList();
                input.value = '';
                input.focus();
                this.saveToStorage();
            } else {
                alert('Player already exists!');
            }
        }
    }

    removePlayer(index) {
        this.players.splice(index, 1);
        this.updatePlayerList();
        this.saveToStorage();
    }

    updatePlayerList() {
        const list = document.getElementById('player-list');
        list.innerHTML = this.players.map((player, index) => `
            <li>
                <span>${player.name}</span>
                <button class="remove-btn" onclick="game.removePlayer(${index})">×</button>
            </li>
        `).join('');

        document.getElementById('start-game-btn').disabled = this.players.length < 2;
    }

    selectRounds(btn) {
        document.querySelectorAll('.round-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.totalRounds = parseInt(btn.dataset.rounds);
    }

    // Game Flow
    startGame() {
        if (this.players.length < 2) return;

        this.gameStarted = true;
        this.currentRound = 1;
        this.resetRound();

        // Reset all player scores
        this.players.forEach(p => p.score = 0);

        document.getElementById('setup-screen').classList.remove('active');
        document.getElementById('game-screen').classList.add('active');
        document.getElementById('total-rounds').textContent = this.totalRounds;

        this.updateGameUI();
        this.saveToStorage();
    }

    resetRound() {
        this.rollCount = 0;
        this.bankTotal = 0;
        this.playersWhoCanRoll = [...Array(this.players.length).keys()];
        this.playersWhoBanked = [];
        this.history = []; // Clear history for new round
        
        // Start with the player after the one who ended the last round
        // For the first round, lastRoundEndPlayerIndex is 0, so we start at 0
        // For subsequent rounds, start with the player after the last one
        if (this.currentRound === 1) {
            this.currentPlayerIndex = 0;
        } else {
            this.currentPlayerIndex = (this.lastRoundEndPlayerIndex + 1) % this.players.length;
        }
    }

    handleDiceRoll(value) {
        if (!this.gameStarted) return;

        // Save state for undo before making changes
        this.saveStateForUndo();

        this.rollCount++;

        if (value === 7) {
            this.handleSeven();
        } else {
            this.bankTotal += value;
            this.advanceToNextPlayer();
            this.updateGameUI();
        }

        this.saveToStorage();
    }

    handleSeven() {
        // First 3 rolls: 7 is worth 70 points
        if (this.rollCount <= 3) {
            this.bankTotal += 70;
            this.advanceToNextPlayer();
            this.updateGameUI();
        } else {
            // After first 3 rolls: 7 ends the round
            this.endRound('A 7 was rolled!');
        }
    }

    handleDoubles() {
        // Save state for undo before making changes
        this.saveStateForUndo();

        this.rollCount++;

        // All doubles double the cumulative score
        this.bankTotal *= 2;

        this.advanceToNextPlayer();
        this.updateGameUI();
        this.saveToStorage();
    }

    advanceToNextPlayer() {
        if (this.playersWhoCanRoll.length === 0) return;

        // Move to next player who can still roll
        let nextIndex = (this.currentPlayerIndex + 1) % this.playersWhoCanRoll.length;
        this.currentPlayerIndex = nextIndex;
    }

    // Undo functionality
    saveStateForUndo() {
        const state = {
            rollCount: this.rollCount,
            bankTotal: this.bankTotal,
            currentPlayerIndex: this.currentPlayerIndex,
            playersWhoCanRoll: [...this.playersWhoCanRoll],
            playersWhoBanked: [...this.playersWhoBanked],
            players: this.players.map(p => ({ ...p }))
        };
        this.history.push(state);
        
        // Limit history to prevent memory issues
        if (this.history.length > 50) {
            this.history.shift();
        }
    }

    undo() {
        if (this.history.length === 0) return;

        const previousState = this.history.pop();
        this.rollCount = previousState.rollCount;
        this.bankTotal = previousState.bankTotal;
        this.currentPlayerIndex = previousState.currentPlayerIndex;
        this.playersWhoCanRoll = previousState.playersWhoCanRoll;
        this.playersWhoBanked = previousState.playersWhoBanked;
        this.players = previousState.players;

        this.updateGameUI();
        this.saveToStorage();
    }

    // Banking
    showBankModal() {
        const modal = document.getElementById('bank-modal');
        const list = document.getElementById('bank-player-list');

        // Show all players who haven't banked this round
        list.innerHTML = this.players.map((player, index) => {
            const hasBanked = this.playersWhoBanked.includes(index);
            return `
                <button class="bank-player-btn" 
                        onclick="game.playerBank(${index})" 
                        ${hasBanked ? 'disabled' : ''}>
                    ${player.name} ${hasBanked ? '(Already Banked)' : ''}
                </button>
            `;
        }).join('');

        modal.classList.add('active');
    }

    hideBankModal() {
        document.getElementById('bank-modal').classList.remove('active');
    }

    playerBank(playerIndex) {
        if (this.playersWhoBanked.includes(playerIndex)) return;

        // Save state for undo before making changes
        this.saveStateForUndo();

        // Add bank total to player's score
        this.players[playerIndex].score += this.bankTotal;
        this.playersWhoBanked.push(playerIndex);

        // Remove from players who can roll
        const rollIndex = this.playersWhoCanRoll.indexOf(playerIndex);
        if (rollIndex > -1) {
            this.playersWhoCanRoll.splice(rollIndex, 1);

            // Adjust current player index if needed
            if (this.playersWhoCanRoll.length > 0) {
                if (rollIndex <= this.currentPlayerIndex) {
                    this.currentPlayerIndex = Math.max(0, this.currentPlayerIndex - 1);
                }
                this.currentPlayerIndex = this.currentPlayerIndex % this.playersWhoCanRoll.length;
            }
        }

        this.hideBankModal();
        this.updateGameUI();
        this.saveToStorage();

        // Check if all players have banked
        if (this.playersWhoBanked.length === this.players.length) {
            this.endRound('All players have banked!');
        }
    }

    endRound(reason) {
        // Remember who was current when round ended (for next round's starting player)
        if (this.playersWhoCanRoll.length > 0) {
            this.lastRoundEndPlayerIndex = this.playersWhoCanRoll[this.currentPlayerIndex];
        }

        const modal = document.getElementById('round-end-modal');
        const title = document.getElementById('round-end-title');
        const message = document.getElementById('round-end-message');
        const scoresDiv = document.getElementById('round-scores');

        title.textContent = `Round ${this.currentRound} Over!`;
        message.textContent = reason;

        // Show round scores
        const sortedPlayers = [...this.players].sort((a, b) => b.score - a.score);
        scoresDiv.innerHTML = sortedPlayers.map(player => `
            <div class="score-item">
                <span>${player.name}</span>
                <span>${player.score} pts</span>
            </div>
        `).join('');

        modal.classList.add('active');
    }

    startNextRound() {
        document.getElementById('round-end-modal').classList.remove('active');

        this.currentRound++;

        if (this.currentRound > this.totalRounds) {
            this.endGame();
        } else {
            this.resetRound();
            this.updateGameUI();
        }

        this.saveToStorage();
    }

    endGame() {
        const modal = document.getElementById('game-over-modal');
        const scoresDiv = document.getElementById('final-scores');

        // Sort players by score
        const sortedPlayers = [...this.players]
            .map((p, i) => ({ ...p, originalIndex: i }))
            .sort((a, b) => b.score - a.score);

        const winner = sortedPlayers[0];

        scoresDiv.innerHTML = `
            <div class="winner">🎉 ${winner.name} Wins! 🎉</div>
            ${sortedPlayers.map((player, index) => `
                <div class="score-item ${index === 0 ? 'first' : ''}">
                    <span><span class="rank">#${index + 1}</span> ${player.name}</span>
                    <span>${player.score} pts</span>
                </div>
            `).join('')}
        `;

        modal.classList.add('active');
        this.gameStarted = false;
        this.clearStorage();
    }

    confirmNewGame() {
        if (confirm('Are you sure you want to start a new game? Current progress will be lost.')) {
            this.resetGame();
        }
    }

    resetGame() {
        // Hide all modals
        document.querySelectorAll('.modal').forEach(m => m.classList.remove('active'));

        // Reset game state
        this.gameStarted = false;
        this.currentRound = 1;
        this.lastRoundEndPlayerIndex = 0;
        this.history = [];
        this.resetRound();

        // Reset player scores but keep players
        this.players.forEach(p => p.score = 0);

        // Switch screens
        document.getElementById('game-screen').classList.remove('active');
        document.getElementById('setup-screen').classList.add('active');

        this.updatePlayerList();
        this.clearStorage();
    }

    updateGameUI() {
        // Update round info
        document.getElementById('current-round').textContent = this.currentRound;
        document.getElementById('roll-count').textContent = this.rollCount + 1;

        // Update bank total
        document.getElementById('bank-total').textContent = this.bankTotal;

        // Update 7 button styling - only show as dangerous after 3rd roll
        const sevenBtn = document.querySelector('.dice-btn[data-value="7"]');
        if (this.rollCount >= 3) {
            sevenBtn.classList.add('dice-seven-danger');
        } else {
            sevenBtn.classList.remove('dice-seven-danger');
        }

        // Update current player turn
        const turnInfo = document.getElementById('current-player-turn');
        if (this.playersWhoCanRoll.length > 0) {
            const currentPlayerId = this.playersWhoCanRoll[this.currentPlayerIndex];
            turnInfo.textContent = `${this.players[currentPlayerId].name}'s turn`;
        } else {
            turnInfo.textContent = '';
        }

        // Update players list (sorted by score, highest first)
        const list = document.getElementById('players-game-list');
        const playersWithIndex = this.players.map((player, index) => ({ player, originalIndex: index }));
        playersWithIndex.sort((a, b) => b.player.score - a.player.score);
        
        list.innerHTML = playersWithIndex.map(({ player, originalIndex }) => {
            const isCurrent = this.playersWhoCanRoll.length > 0 && 
                              this.playersWhoCanRoll[this.currentPlayerIndex] === originalIndex;
            const hasBanked = this.playersWhoBanked.includes(originalIndex);

            return `
                <div class="player-card ${isCurrent ? 'current' : ''} ${hasBanked ? 'banked' : ''}">
                    <div class="name">${player.name}</div>
                    <div class="score">${player.score}</div>
                    ${hasBanked ? '<div class="banked-label">BANKED</div>' : ''}
                </div>
            `;
        }).join('');

        // Update undo button state
        const undoBtn = document.getElementById('undo-btn');
        undoBtn.disabled = this.history.length === 0;
    }

    // Local Storage
    saveToStorage() {
        const state = {
            players: this.players,
            totalRounds: this.totalRounds,
            currentRound: this.currentRound,
            rollCount: this.rollCount,
            bankTotal: this.bankTotal,
            currentPlayerIndex: this.currentPlayerIndex,
            playersWhoCanRoll: this.playersWhoCanRoll,
            playersWhoBanked: this.playersWhoBanked,
            gameStarted: this.gameStarted,
            lastRoundEndPlayerIndex: this.lastRoundEndPlayerIndex,
            history: this.history
        };
        localStorage.setItem('bankGame', JSON.stringify(state));
    }

    loadFromStorage() {
        const saved = localStorage.getItem('bankGame');
        if (saved) {
            try {
                const state = JSON.parse(saved);
                this.players = state.players || [];
                this.totalRounds = state.totalRounds || 20;
                this.currentRound = state.currentRound || 1;
                this.rollCount = state.rollCount || 0;
                this.bankTotal = state.bankTotal || 0;
                this.currentPlayerIndex = state.currentPlayerIndex || 0;
                this.playersWhoCanRoll = state.playersWhoCanRoll || [];
                this.playersWhoBanked = state.playersWhoBanked || [];
                this.gameStarted = state.gameStarted || false;
                this.lastRoundEndPlayerIndex = state.lastRoundEndPlayerIndex || 0;
                this.history = state.history || [];

                if (this.gameStarted) {
                    document.getElementById('setup-screen').classList.remove('active');
                    document.getElementById('game-screen').classList.add('active');
                    document.getElementById('total-rounds').textContent = this.totalRounds;
                    this.updateGameUI();
                } else {
                    this.updatePlayerList();
                    // Set round button
                    document.querySelectorAll('.round-btn').forEach(btn => {
                        btn.classList.toggle('active', parseInt(btn.dataset.rounds) === this.totalRounds);
                    });
                }
            } catch (e) {
                console.error('Failed to load game state:', e);
                this.clearStorage();
            }
        }
    }

    clearStorage() {
        localStorage.removeItem('bankGame');
    }
}

// Initialize game
const game = new BankGame();

// Register Service Worker
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js')
            .then(registration => {
                console.log('ServiceWorker registered:', registration.scope);
            })
            .catch(error => {
                console.log('ServiceWorker registration failed:', error);
            });
    });
}
