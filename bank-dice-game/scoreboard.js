// Bank Dice Game - Scoreboard/Host Logic

class ScoreboardGame {
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
        this.lastRoundEndPlayerIndex = 0;
        this.history = [];
        this.connectedPlayers = new Map();
        
        // Multiplayer
        this.multiplayer = new MultiplayerManager();
        this.roomCode = null;

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
        document.querySelectorAll('.dice-btn-small[data-value]').forEach(btn => {
            btn.addEventListener('click', (e) => this.handleDiceRoll(parseInt(e.target.dataset.value)));
        });

        // Doubles button
        document.getElementById('doubles-btn').addEventListener('click', () => this.handleDoubles());

        // Bank button
        document.getElementById('bank-btn').addEventListener('click', () => this.showBankModal());

        // Bank modal
        document.getElementById('cancel-bank-btn').addEventListener('click', () => this.hideBankModal());
        document.getElementById('confirm-bank-btn').addEventListener('click', () => this.confirmBank());

        // Round end modal
        document.getElementById('next-round-btn').addEventListener('click', () => this.startNextRound());
        document.getElementById('modal-undo-btn').addEventListener('click', () => this.undoFromModal());

        // Game over modal
        document.getElementById('play-again-btn').addEventListener('click', () => this.resetGame());

        // New game button
        document.getElementById('new-game-btn').addEventListener('click', () => this.confirmNewGame());

        // Undo button
        document.getElementById('undo-btn').addEventListener('click', () => this.undo());

        // Drag and drop handlers
        this.draggedPlayerIndex = null;
    }

    // Multiplayer handlers
    setupMultiplayerHandlers() {
        // Handle rolls from connected players
        this.multiplayer.onRollReceived = (roll) => {
            this.addActivity(`${roll.playerName} rolled ${roll.isDoubles ? 'doubles' : roll.value}`, 'roll');
            if (roll.isDoubles) {
                this.handleDoubles();
            } else {
                this.handleDiceRoll(roll.value);
            }
        };

        // Handle bank requests from connected players
        this.multiplayer.onBankRequest = (request) => {
            this.addActivity(`${request.playerName} wants to bank!`, 'bank');
            // Could auto-open bank modal or just notify
        };

        // Handle player connections
        this.multiplayer.onPlayerJoined = (player) => {
            this.connectedPlayers.set(player.id, player);
            this.updateConnectedCount();
            this.addActivity(`${player.name} connected`, 'system');
        };

        this.multiplayer.onPlayerLeft = (player) => {
            this.connectedPlayers.delete(player.id);
            this.updateConnectedCount();
            this.addActivity(`${player.name} disconnected`, 'system');
        };
    }

    updateConnectedCount() {
        document.getElementById('connected-players').textContent = this.connectedPlayers.size;
    }

    addActivity(message, type = 'system') {
        const list = document.getElementById('activity-list');
        const item = document.createElement('div');
        item.className = `activity-item ${type}`;
        item.textContent = message;
        list.insertBefore(item, list.firstChild);
        
        // Keep only last 10 items
        while (list.children.length > 10) {
            list.removeChild(list.lastChild);
        }
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
            <li data-index="${index}">
                <span class="drag-handle" draggable="true">☰</span>
                <span>${player.name}</span>
                <button class="remove-btn" onclick="game.removePlayer(${index})">×</button>
            </li>
        `).join('');

        // Add drag event listeners
        const items = list.querySelectorAll('li');
        items.forEach(item => {
            const dragHandle = item.querySelector('.drag-handle');
            dragHandle.addEventListener('dragstart', (e) => this.handleDragStart(e));
            dragHandle.addEventListener('dragend', (e) => this.handleDragEnd(e));
            item.addEventListener('dragover', (e) => this.handleDragOver(e));
            item.addEventListener('drop', (e) => this.handleDrop(e));
        });

        document.getElementById('start-game-btn').disabled = this.players.length < 2;
    }

    handleDragStart(e) {
        this.draggedElement = e.target.closest('li');
        this.draggedPlayerIndex = parseInt(this.draggedElement.dataset.index);
        setTimeout(() => e.target.classList.add('dragging'), 0);
        e.dataTransfer.effectAllowed = 'move';
    }

    handleDragOver(e) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const afterElement = this.getDragAfterElement(e.clientY);
        const list = document.getElementById('player-list');
        if (afterElement == null) {
            list.appendChild(this.draggedElement);
        } else {
            list.insertBefore(this.draggedElement, afterElement);
        }
    }

    getDragAfterElement(y) {
        const list = document.getElementById('player-list');
        const draggableElements = [...list.querySelectorAll('li:not(.dragging)')];
        return draggableElements.reduce((closest, child) => {
            const box = child.getBoundingClientRect();
            const offset = y - box.top - box.height / 2;
            if (offset < 0 && offset > closest.offset) {
                return { offset: offset, element: child };
            }
            return closest;
        }, { offset: Number.NEGATIVE_INFINITY }).element;
    }

    handleDrop(e) {
        e.preventDefault();
        const list = document.getElementById('player-list');
        const items = list.querySelectorAll('li');
        const newOrder = [];
        items.forEach(item => {
            const index = parseInt(item.dataset.index);
            newOrder.push(this.players[index]);
        });
        this.players = newOrder;
        this.updatePlayerList();
        this.saveToStorage();
    }

    handleDragEnd(e) {
        e.target.classList.remove('dragging');
        this.draggedElement = null;
        this.draggedPlayerIndex = null;
    }

    selectRounds(btn) {
        document.querySelectorAll('.round-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.totalRounds = parseInt(btn.dataset.rounds);
    }

    // Game Flow
    async startGame() {
        if (this.players.length < 2) return;

        this.gameStarted = true;
        this.currentRound = 1;
        this.resetRound();
        this.players.forEach(p => p.score = 0);

        // Setup multiplayer
        this.setupMultiplayerHandlers();
        
        try {
            this.roomCode = await this.multiplayer.createRoom(this.getGameState());
            document.getElementById('room-code').textContent = this.roomCode;
            this.addActivity('Room created! Share the code with players.', 'system');
        } catch (error) {
            console.error('Failed to create room:', error);
            this.addActivity('Playing in offline mode', 'system');
        }

        document.getElementById('setup-screen').classList.remove('active');
        document.getElementById('game-screen').classList.add('active');
        document.getElementById('total-rounds').textContent = this.totalRounds;

        this.updateGameUI();
        this.saveToStorage();
    }

    getGameState() {
        return {
            players: this.players,
            totalRounds: this.totalRounds,
            currentRound: this.currentRound,
            rollCount: this.rollCount,
            bankTotal: this.bankTotal,
            currentPlayerIndex: this.currentPlayerIndex,
            playersWhoCanRoll: this.playersWhoCanRoll,
            playersWhoBanked: this.playersWhoBanked,
            gameStarted: this.gameStarted
        };
    }

    resetRound() {
        this.rollCount = 0;
        this.bankTotal = 0;
        this.playersWhoCanRoll = [...Array(this.players.length).keys()];
        this.playersWhoBanked = [];
        this.history = [];
        
        if (this.currentRound === 1) {
            this.currentPlayerIndex = 0;
        } else {
            const startingPlayerId = (this.lastRoundEndPlayerIndex + 1) % this.players.length;
            this.currentPlayerIndex = startingPlayerId;
        }
    }

    handleDiceRoll(value) {
        if (!this.gameStarted) return;

        this.saveStateForUndo();
        this.rollCount++;

        if (value === 7) {
            this.handleSeven();
        } else {
            this.bankTotal += value;
            this.advanceToNextPlayer();
            this.updateGameUI();
        }

        this.syncMultiplayer();
        this.saveToStorage();
    }

    handleSeven() {
        if (this.rollCount <= 3) {
            this.bankTotal += 70;
            this.advanceToNextPlayer();
            this.updateGameUI();
        } else {
            this.endRound('7 rolled - Round over!');
        }
    }

    handleDoubles() {
        this.saveStateForUndo();
        this.rollCount++;
        this.bankTotal *= 2;
        this.advanceToNextPlayer();
        this.updateGameUI();
        this.syncMultiplayer();
        this.saveToStorage();
    }

    advanceToNextPlayer() {
        if (this.playersWhoCanRoll.length === 0) return;
        this.currentPlayerIndex = (this.currentPlayerIndex + 1) % this.playersWhoCanRoll.length;
    }

    // Sync with connected players
    syncMultiplayer() {
        if (this.multiplayer && this.roomCode) {
            this.multiplayer.updateGameState(this.getGameState());
        }
    }

    // Undo functionality
    saveStateForUndo() {
        const bankTotal = Number(this.bankTotal);
        const state = {
            rollCount: this.rollCount,
            bankTotal: isNaN(bankTotal) ? 0 : bankTotal,
            currentPlayerIndex: this.currentPlayerIndex,
            playersWhoCanRoll: [...this.playersWhoCanRoll],
            playersWhoBanked: [...this.playersWhoBanked],
            players: this.players.map(p => ({ ...p }))
        };
        this.history.push(state);
        if (this.history.length > 50) {
            this.history.shift();
        }
    }

    undo() {
        if (this.history.length === 0) return;

        const previousState = this.history.pop();
        this.rollCount = previousState.rollCount;
        const restoredBankTotal = Number(previousState.bankTotal);
        this.bankTotal = isNaN(restoredBankTotal) ? 0 : restoredBankTotal;
        this.currentPlayerIndex = previousState.currentPlayerIndex;
        this.playersWhoCanRoll = previousState.playersWhoCanRoll;
        this.playersWhoBanked = previousState.playersWhoBanked;
        this.players = previousState.players;

        this.updateGameUI();
        this.syncMultiplayer();
        this.saveToStorage();
    }

    undoFromModal() {
        if (this.history.length === 0) return;
        document.getElementById('round-end-modal').classList.remove('active');
        this.undo();
    }

    // Banking
    showBankModal() {
        const modal = document.getElementById('bank-modal');
        const list = document.getElementById('bank-player-list');

        list.innerHTML = this.players.map((player, index) => {
            const hasBanked = this.playersWhoBanked.includes(index);
            return `
                <label class="bank-player-checkbox" ${hasBanked ? 'style="opacity: 0.5;"' : ''}>
                    <input type="checkbox" 
                           data-player-index="${index}" 
                           ${hasBanked ? 'disabled' : ''}>
                    <span>${player.name} ${hasBanked ? '(Already Banked)' : ''}</span>
                </label>
            `;
        }).join('');

        modal.classList.add('active');
    }

    hideBankModal() {
        document.getElementById('bank-modal').classList.remove('active');
    }

    confirmBank() {
        const checkboxes = document.querySelectorAll('#bank-player-list input[type="checkbox"]:checked');
        const playerIndices = Array.from(checkboxes).map(cb => parseInt(cb.dataset.playerIndex));

        if (playerIndices.length === 0) {
            this.hideBankModal();
            return;
        }

        this.saveStateForUndo();

        const sortedIndices = playerIndices.sort((a, b) => {
            return this.playersWhoCanRoll.indexOf(b) - this.playersWhoCanRoll.indexOf(a);
        });

        const currentPlayerId = this.playersWhoCanRoll[this.currentPlayerIndex];
        const currentPlayerBanking = playerIndices.includes(currentPlayerId);

        sortedIndices.forEach(playerIndex => {
            if (this.playersWhoBanked.includes(playerIndex)) return;

            this.players[playerIndex].score += this.bankTotal;
            this.playersWhoBanked.push(playerIndex);
            this.addActivity(`${this.players[playerIndex].name} banked ${this.bankTotal} points!`, 'bank');

            const rollIndex = this.playersWhoCanRoll.indexOf(playerIndex);
            if (rollIndex > -1) {
                this.playersWhoCanRoll.splice(rollIndex, 1);
                if (this.playersWhoCanRoll.length > 0 && rollIndex < this.currentPlayerIndex) {
                    this.currentPlayerIndex--;
                }
            }
        });

        if (currentPlayerBanking && this.playersWhoCanRoll.length > 0) {
            this.currentPlayerIndex = this.currentPlayerIndex % this.playersWhoCanRoll.length;
        } else if (this.playersWhoCanRoll.length > 0) {
            this.currentPlayerIndex = this.currentPlayerIndex % this.playersWhoCanRoll.length;
        }

        this.hideBankModal();
        this.updateGameUI();
        this.syncMultiplayer();
        this.saveToStorage();

        if (this.playersWhoBanked.length === this.players.length) {
            this.endRound('All players have banked!');
        }
    }

    endRound(reason) {
        if (this.playersWhoCanRoll.length > 0) {
            this.lastRoundEndPlayerIndex = this.playersWhoCanRoll[this.currentPlayerIndex];
        }

        const modal = document.getElementById('round-end-modal');
        const title = document.getElementById('round-end-title');
        const message = document.getElementById('round-end-message');
        const scoresDiv = document.getElementById('round-scores');
        const modalUndoBtn = document.getElementById('modal-undo-btn');

        title.textContent = `Round ${this.currentRound} Over!`;
        message.textContent = reason;
        modalUndoBtn.disabled = this.history.length === 0;

        const sortedPlayers = [...this.players].sort((a, b) => b.score - a.score);
        scoresDiv.innerHTML = sortedPlayers.map(player => `
            <div class="score-item">
                <span>${player.name}</span>
                <span>${player.score} pts</span>
            </div>
        `).join('');

        modal.classList.add('active');
        this.addActivity(reason, 'system');
    }

    startNextRound() {
        document.getElementById('round-end-modal').classList.remove('active');
        this.currentRound++;

        if (this.currentRound > this.totalRounds) {
            this.endGame();
        } else {
            this.resetRound();
            this.updateGameUI();
            this.addActivity(`Round ${this.currentRound} started!`, 'system');
        }

        this.syncMultiplayer();
        this.saveToStorage();
    }

    endGame() {
        const modal = document.getElementById('game-over-modal');
        const scoresDiv = document.getElementById('final-scores');

        const sortedPlayers = [...this.players]
            .map((p, i) => ({ ...p, originalIndex: i }))
            .sort((a, b) => b.score - a.score);

        const topScore = sortedPlayers[0].score;
        const winners = sortedPlayers.filter(p => p.score === topScore);
        const isTie = winners.length > 1;

        let place = 1;
        const playersWithPlace = [];
        for (let i = 0; i < sortedPlayers.length; i++) {
            if (i > 0 && sortedPlayers[i].score !== sortedPlayers[i - 1].score) {
                place = i + 1;
            }
            playersWithPlace.push({ ...sortedPlayers[i], place });
        }

        const winnerMessage = isTie 
            ? `🎉 We have a tie! 🎉<br>${winners.map(w => w.name).join(', ')}`
            : `🎉 ${winners[0].name} Wins! 🎉`;

        scoresDiv.innerHTML = `
            <div class="winner">${winnerMessage}</div>
            ${playersWithPlace.map((player) => `
                <div class="score-item ${player.place === 1 ? 'first' : ''}">
                    <span><span class="rank">#${player.place}</span> ${player.name}</span>
                    <span>${player.score} pts</span>
                </div>
            `).join('')}
        `;

        modal.classList.add('active');
        this.gameStarted = false;
        this.clearStorage();
        
        if (this.multiplayer) {
            this.multiplayer.disconnect();
        }
    }

    confirmNewGame() {
        if (confirm('Are you sure you want to start a new game? Current progress will be lost.')) {
            this.resetGame();
        }
    }

    resetGame() {
        document.querySelectorAll('.modal').forEach(m => m.classList.remove('active'));

        if (this.multiplayer) {
            this.multiplayer.disconnect();
        }

        this.gameStarted = false;
        this.currentRound = 1;
        this.lastRoundEndPlayerIndex = 0;
        this.history = [];
        this.connectedPlayers.clear();
        this.resetRound();

        this.players.forEach(p => p.score = 0);

        document.getElementById('game-screen').classList.remove('active');
        document.getElementById('setup-screen').classList.add('active');

        this.updatePlayerList();
        this.clearStorage();
    }

    updateGameUI() {
        document.getElementById('current-round').textContent = this.currentRound;
        document.getElementById('roll-count').textContent = '#' + (this.rollCount + 1);
        document.getElementById('bank-total').textContent = this.bankTotal;
        document.getElementById('bank-total-btn').textContent = this.bankTotal;

        // Update 7 button styling
        const sevenBtn = document.querySelector('.dice-btn-small[data-value="7"]');
        if (this.rollCount >= 3) {
            sevenBtn.classList.add('dice-seven-danger');
        } else {
            sevenBtn.classList.remove('dice-seven-danger');
        }

        // Update doubles button
        const doublesBtn = document.getElementById('doubles-btn');
        doublesBtn.disabled = this.rollCount < 3;

        // Update current player turn
        const turnInfo = document.getElementById('current-player-turn');
        if (this.playersWhoCanRoll.length > 0) {
            const currentPlayerId = this.playersWhoCanRoll[this.currentPlayerIndex];
            turnInfo.textContent = `${this.players[currentPlayerId].name}'s turn to roll`;
        } else {
            turnInfo.textContent = 'All players have banked';
        }

        // Update players grid
        const list = document.getElementById('players-game-list');
        const playersWithIndex = this.players.map((player, index) => ({ player, originalIndex: index }));
        playersWithIndex.sort((a, b) => b.player.score - a.player.score);
        
        let place = 1;
        for (let i = 0; i < playersWithIndex.length; i++) {
            if (i > 0 && playersWithIndex[i].player.score !== playersWithIndex[i - 1].player.score) {
                place = i + 1;
            }
            playersWithIndex[i].place = place;
        }
        
        list.innerHTML = playersWithIndex.map(({ player, originalIndex, place }) => {
            const isCurrent = this.playersWhoCanRoll.length > 0 && 
                              this.playersWhoCanRoll[this.currentPlayerIndex] === originalIndex;
            const hasBanked = this.playersWhoBanked.includes(originalIndex);
            const showPlace = player.score > 0;

            return `
                <div class="player-card-large ${isCurrent ? 'current' : ''} ${hasBanked ? 'banked' : ''}">
                    ${showPlace ? `<div class="place">#${place}</div>` : '<div class="place"></div>'}
                    <div class="name">${player.name}</div>
                    <div class="score">${player.score}</div>
                    ${hasBanked ? '<div class="banked-label">BANKED</div>' : ''}
                </div>
            `;
        }).join('');

        // Update undo button
        document.getElementById('undo-btn').disabled = this.history.length === 0;
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
            history: this.history,
            roomCode: this.roomCode
        };
        localStorage.setItem('bankScoreboard', JSON.stringify(state));
    }

    loadFromStorage() {
        const saved = localStorage.getItem('bankScoreboard');
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
                this.roomCode = state.roomCode || null;

                if (this.gameStarted && this.roomCode) {
                    // Don't auto-restore multiplayer sessions for now
                    this.gameStarted = false;
                    this.updatePlayerList();
                } else if (!this.gameStarted) {
                    this.updatePlayerList();
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
        localStorage.removeItem('bankScoreboard');
    }
}

// Initialize game
const game = new ScoreboardGame();
