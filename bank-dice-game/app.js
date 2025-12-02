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
        this.startingPlayerIndex = 0; // Track who starts each new game
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
        document.querySelectorAll('.dice-btn[data-value]').forEach(btn => {
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
        document.getElementById('game-over-undo-btn').addEventListener('click', () => this.undoFromGameOver());

        // New game button
        document.getElementById('new-game-btn').addEventListener('click', () => this.confirmNewGame());

        // Undo button
        document.getElementById('undo-btn').addEventListener('click', () => this.undo());

        // Drag and drop handlers
        this.draggedPlayerIndex = null;
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

        // Add drag and drop event listeners only to drag handles
        const items = list.querySelectorAll('li');
        items.forEach(item => {
            const dragHandle = item.querySelector('.drag-handle');
            
            // Mouse events on drag handle
            dragHandle.addEventListener('dragstart', (e) => this.handleDragStart(e));
            dragHandle.addEventListener('dragend', (e) => this.handleDragEnd(e));
            
            // Touch events on drag handle only
            dragHandle.addEventListener('touchstart', (e) => this.handleTouchStart(e), { passive: false });
            dragHandle.addEventListener('touchmove', (e) => this.handleTouchMove(e), { passive: false });
            dragHandle.addEventListener('touchend', (e) => this.handleTouchEnd(e), { passive: false });
            
            // Dragover and drop on list items
            item.addEventListener('dragover', (e) => this.handleDragOver(e));
            item.addEventListener('drop', (e) => this.handleDrop(e));
        });

        document.getElementById('start-game-btn').disabled = this.players.length < 2;
        
        // Update starting player dropdown
        const select = document.getElementById('starting-player-select');
        const currentValue = this.startingPlayerIndex;
        select.innerHTML = this.players.map((player, index) => 
                `<option value="${index}" ${index === currentValue ? 'selected' : ''}>${player.name}</option>`
            ).join('');
        
        // If current starting player is invalid, reset to first player
        if (this.startingPlayerIndex >= this.players.length || this.startingPlayerIndex < 0) {
            this.startingPlayerIndex = 0;
            if (this.players.length > 0) {
                select.value = this.startingPlayerIndex;
                this.saveToStorage();
            }
        }
    }

    handleDragStart(e) {
        this.draggedElement = e.target.closest('li');
        this.draggedPlayerIndex = parseInt(this.draggedElement.dataset.index);
        
        setTimeout(() => {
            e.target.classList.add('dragging');
        }, 0);
        
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/html', e.target.innerHTML);
    }

    handleDragOver(e) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        
        const afterElement = this.getDragAfterElement(e.clientY);
        const draggable = this.draggedElement;
        const list = document.getElementById('player-list');
        
        // Store current positions before moving
        const items = [...list.querySelectorAll('li:not(.dragging)')];
        const positions = items.map(item => ({
            element: item,
            rect: item.getBoundingClientRect()
        }));
        
        // Move the element
        if (afterElement == null) {
            list.appendChild(draggable);
        } else {
            list.insertBefore(draggable, afterElement);
        }
        
        // Animate the repositioned elements
        positions.forEach(({ element, rect }) => {
            const newRect = element.getBoundingClientRect();
            const deltaY = rect.top - newRect.top;
            
            if (deltaY !== 0) {
                // Set initial position
                element.style.transform = `translateY(${deltaY}px)`;
                element.style.transition = 'none';
                
                // Force reflow
                element.offsetHeight;
                
                // Animate to final position
                element.style.transition = 'transform 0.2s ease';
                element.style.transform = 'translateY(0)';
            }
        });
    }

    getDragAfterElement(y) {
        const list = document.getElementById('player-list');
        const draggableElements = [...list.querySelectorAll('li:not(.dragging)')];
        
        return draggableElements.reduce((closest, child) => {
            const box = child.getBoundingClientRect();
            const offset = y - box.top - box.height / 2;
            
            if (offset < 0 && offset > closest.offset) {
                return { offset: offset, element: child };
            } else {
                return closest;
            }
        }, { offset: Number.NEGATIVE_INFINITY }).element;
    }

    handleDrop(e) {
        e.preventDefault();
        e.stopPropagation();
        
        // Get the new order from the DOM
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
        
        return false;
    }

    handleDragEnd(e) {
        e.target.classList.remove('dragging');
        this.draggedElement = null;
        this.draggedPlayerIndex = null;
    }

    // Touch event handlers for mobile
    handleTouchStart(e) {
        const item = e.target.closest('li');
        if (!item) return;
        
        this.draggedElement = item;
        this.draggedPlayerIndex = parseInt(item.dataset.index);
        this.touchStartY = e.touches[0].clientY;
        
        setTimeout(() => {
            item.classList.add('dragging');
        }, 0);
    }

    handleTouchMove(e) {
        if (!this.draggedElement) return;
        e.preventDefault();
        
        const touch = e.touches[0];
        const afterElement = this.getDragAfterElement(touch.clientY);
        const list = document.getElementById('player-list');
        
        // Store current positions before moving
        const items = [...list.querySelectorAll('li:not(.dragging)')];
        const positions = items.map(item => ({
            element: item,
            rect: item.getBoundingClientRect()
        }));
        
        // Move the element
        if (afterElement == null) {
            list.appendChild(this.draggedElement);
        } else {
            list.insertBefore(this.draggedElement, afterElement);
        }
        
        // Animate the repositioned elements
        positions.forEach(({ element, rect }) => {
            const newRect = element.getBoundingClientRect();
            const deltaY = rect.top - newRect.top;
            
            if (deltaY !== 0) {
                // Set initial position
                element.style.transform = `translateY(${deltaY}px)`;
                element.style.transition = 'none';
                
                // Force reflow
                element.offsetHeight;
                
                // Animate to final position
                element.style.transition = 'transform 0.2s ease';
                element.style.transform = 'translateY(0)';
            }
        });
    }

    handleTouchEnd(e) {
        if (!this.draggedElement) return;
        e.preventDefault();
        
        this.draggedElement.classList.remove('dragging');
        
        // Get the new order from the DOM
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
        
        this.draggedElement = null;
        this.draggedPlayerIndex = null;
    }

    selectRounds(btn) {
        document.querySelectorAll('.round-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.totalRounds = parseInt(btn.dataset.rounds);
        this.saveToStorage();
    }

    // Game Flow
    startGame() {
        if (this.players.length < 2) return;

        this.gameStarted = true;
        this.currentRound = 1;
        this.lastRoundEndPlayerIndex = this.startingPlayerIndex;
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
        // lastRoundEndPlayerIndex is an index into the players array
        // At round start, playersWhoCanRoll contains all player indices [0, 1, 2, ...]
        // so we can use the player index directly as the index into playersWhoCanRoll
        if (this.currentRound === 1) {
            // First round starts with the chosen starting player
            this.currentPlayerIndex = this.startingPlayerIndex;
        } else {
            // Calculate which player should start (next after the one who ended the round)
            const startingPlayerId = (this.lastRoundEndPlayerIndex + 1) % this.players.length;
            // Since playersWhoCanRoll = [0, 1, 2, ...] at round start, 
            // the player's ID equals their index in playersWhoCanRoll
            this.currentPlayerIndex = startingPlayerId;
        }
    }

    handleDiceRoll(value) {
        if (!this.gameStarted) return;

        // Save state for undo before making changes
        this.saveStateForUndo();

        // Track who is rolling (for determining next round's starting player)
        this.lastRoundEndPlayerIndex = this.playersWhoCanRoll[this.currentPlayerIndex];

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
            this.endRound('');
        }
    }

    handleDoubles() {
        // Save state for undo before making changes
        this.saveStateForUndo();

        // Track who is rolling (for determining next round's starting player)
        this.lastRoundEndPlayerIndex = this.playersWhoCanRoll[this.currentPlayerIndex];

        this.rollCount++;

        // All doubles double the cumulative score
        this.bankTotal *= 2;
        console.log('Doubles rolled! Bank total doubled to', this.bankTotal);

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
        // Ensure bankTotal is a valid number
        const bankTotal = Number(this.bankTotal);
        const state = {
            rollCount: this.rollCount,
            bankTotal: isNaN(bankTotal) ? 0 : bankTotal,
            currentPlayerIndex: this.currentPlayerIndex,
            playersWhoCanRoll: [...this.playersWhoCanRoll],
            playersWhoBanked: [...this.playersWhoBanked],
            players: this.players.map(p => ({ ...p })),
            lastRoundEndPlayerIndex: this.lastRoundEndPlayerIndex
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
        const restoredBankTotal = Number(previousState.bankTotal);
        this.bankTotal = isNaN(restoredBankTotal) ? 0 : restoredBankTotal;
        this.currentPlayerIndex = previousState.currentPlayerIndex;
        this.playersWhoCanRoll = previousState.playersWhoCanRoll;
        this.playersWhoBanked = previousState.playersWhoBanked;
        this.players = previousState.players;
        this.lastRoundEndPlayerIndex = previousState.lastRoundEndPlayerIndex;

        this.updateGameUI();
        this.saveToStorage();
    }

    undoFromModal() {
        if (this.history.length === 0) return;

        // Close the modal first
        document.getElementById('round-end-modal').classList.remove('active');
        
        // Perform the undo
        this.undo();
    }

    undoFromGameOver() {
        if (this.history.length === 0) return;

        // Close the modal first
        document.getElementById('game-over-modal').classList.remove('active');
        
        // Restore game state
        this.gameStarted = true;
        this.currentRound--; // Go back to the last round
        
        // Perform the undo
        this.undo();
    }

    // Banking
    showBankModal() {
        const modal = document.getElementById('bank-modal');
        const list = document.getElementById('bank-player-list');

        // Show all players who haven't banked this round
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
        // Get all checked checkboxes
        const checkboxes = document.querySelectorAll('#bank-player-list input[type="checkbox"]:checked');
        const playerIndices = Array.from(checkboxes).map(cb => parseInt(cb.dataset.playerIndex));

        if (playerIndices.length === 0) {
            this.hideBankModal();
            return;
        }

        // Save state for undo before making changes
        this.saveStateForUndo();

        // Sort player indices to remove them in reverse order to maintain correct indexing
        const sortedIndices = playerIndices.sort((a, b) => {
            return this.playersWhoCanRoll.indexOf(b) - this.playersWhoCanRoll.indexOf(a);
        });

        // Track if current player is banking
        const currentPlayerId = this.playersWhoCanRoll[this.currentPlayerIndex];
        const currentPlayerBanking = playerIndices.includes(currentPlayerId);

        // Process all selected players
        sortedIndices.forEach(playerIndex => {
            if (this.playersWhoBanked.includes(playerIndex)) return;

            // Add bank total to player's score
            this.players[playerIndex].score += this.bankTotal;
            this.playersWhoBanked.push(playerIndex);

            // Remove from players who can roll
            const rollIndex = this.playersWhoCanRoll.indexOf(playerIndex);
            if (rollIndex > -1) {
                this.playersWhoCanRoll.splice(rollIndex, 1);

                // Adjust current player index
                if (this.playersWhoCanRoll.length > 0) {
                    // If we removed someone before the current player, shift index back
                    if (rollIndex < this.currentPlayerIndex) {
                        this.currentPlayerIndex--;
                    }
                }
            }
        });

        // If the current player banked, advance to the next player
        if (currentPlayerBanking && this.playersWhoCanRoll.length > 0) {
            // currentPlayerIndex now points to the next player (because current was removed)
            // Just make sure it's within bounds
            this.currentPlayerIndex = this.currentPlayerIndex % this.playersWhoCanRoll.length;
        } else if (this.playersWhoCanRoll.length > 0) {
            // Make sure index is within bounds
            this.currentPlayerIndex = this.currentPlayerIndex % this.playersWhoCanRoll.length;
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
        // lastRoundEndPlayerIndex is already set by the last dice roll
        // No need to set it here

        // Check if this is the last round - if so, skip round end modal and go straight to game over
        if (this.currentRound >= this.totalRounds) {
            this.currentRound++;
            this.endGame();
            return;
        }

        const modal = document.getElementById('round-end-modal');
        const title = document.getElementById('round-end-title');
        const message = document.getElementById('round-end-message');
        const scoresDiv = document.getElementById('round-scores');
        const modalUndoBtn = document.getElementById('modal-undo-btn');

        title.textContent = `Round ${this.currentRound} Over!`;
        message.textContent = reason;

        // Enable/disable undo button based on history
        modalUndoBtn.disabled = this.history.length === 0;

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

        // Check for ties at first place
        const topScore = sortedPlayers[0].score;
        const winners = sortedPlayers.filter(p => p.score === topScore);
        const isTie = winners.length > 1;

        // Calculate places with tie handling for display
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

        // Enable/disable undo button based on history
        const undoBtn = document.getElementById('game-over-undo-btn');
        undoBtn.disabled = this.history.length === 0;

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
        
        // Rotate starting player to next person for new game
        this.startingPlayerIndex = (this.startingPlayerIndex + 1) % this.players.length;
        this.resetRound();

        // Reset player scores but keep players
        this.players.forEach(p => p.score = 0);

        // Switch screens
        document.getElementById('game-screen').classList.remove('active');
        document.getElementById('setup-screen').classList.add('active');

        this.updatePlayerList();
        this.saveToStorage();
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

        // Update doubles button - only enabled after 3rd roll
        const doublesBtn = document.getElementById('doubles-btn');
        doublesBtn.disabled = this.rollCount < 3;

        // Disable 2 and 12 buttons after 3rd roll (doubles only)
        const twoBtn = document.querySelector('.dice-btn[data-value="2"]');
        const twelveBtn = document.querySelector('.dice-btn[data-value="12"]');
        if (this.rollCount >= 3) {
            twoBtn.disabled = true;
            twelveBtn.disabled = true;
        } else {
            twoBtn.disabled = false;
            twelveBtn.disabled = false;
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
        
        // Calculate places with tie handling
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
                <div class="player-card ${isCurrent ? 'current' : ''} ${hasBanked ? 'banked' : ''}">
                    ${showPlace ? `<div class="place">#${place}</div>` : '<div class="place"></div>'}
                    <div class="name">${player.name}</div>
                    ${hasBanked ? '<div class="banked-label">BANKED</div>' : ''}
                    <div class="score">${player.score}</div>
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
            startingPlayerIndex: this.startingPlayerIndex,
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
                this.startingPlayerIndex = state.startingPlayerIndex !== undefined ? state.startingPlayerIndex : 0;
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
