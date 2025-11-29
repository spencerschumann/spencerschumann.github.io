// Bank Dice Game - Roller/Player Logic

class RollerGame {
    constructor() {
        this.multiplayer = new MultiplayerManager();
        this.roomCode = null;
        this.playerName = null;
        this.gameState = null;
        this.myPlayerIndex = -1;

        this.initEventListeners();
    }

    initEventListeners() {
        // Join screen
        const roomInput = document.getElementById('room-code-input');
        const nameInput = document.getElementById('player-name-input');
        const joinBtn = document.getElementById('join-btn');

        roomInput.addEventListener('input', () => this.validateJoinForm());
        nameInput.addEventListener('input', () => this.validateJoinForm());
        roomInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') nameInput.focus();
        });
        nameInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter' && !joinBtn.disabled) this.joinRoom();
        });
        joinBtn.addEventListener('click', () => this.joinRoom());

        // Waiting screen
        document.getElementById('leave-btn').addEventListener('click', () => this.leaveRoom());

        // Roller screen - dice buttons
        document.querySelectorAll('.dice-btn-roller[data-value]').forEach(btn => {
            btn.addEventListener('click', (e) => this.submitRoll(parseInt(e.target.dataset.value)));
        });

        // Doubles button
        document.getElementById('doubles-btn').addEventListener('click', () => this.submitDoubles());

        // Bank button
        document.getElementById('bank-btn').addEventListener('click', () => this.requestBank());

        // Leave game button
        document.getElementById('leave-game-btn').addEventListener('click', () => this.leaveRoom());

        // Disconnected screen
        document.getElementById('rejoin-btn').addEventListener('click', () => this.showJoinScreen());
    }

    validateJoinForm() {
        const roomCode = document.getElementById('room-code-input').value.trim();
        const playerName = document.getElementById('player-name-input').value.trim();
        const joinBtn = document.getElementById('join-btn');

        joinBtn.disabled = !(roomCode.length === 4 && playerName.length > 0);
    }

    async joinRoom() {
        const roomCode = document.getElementById('room-code-input').value.trim().toUpperCase();
        const playerName = document.getElementById('player-name-input').value.trim();
        const errorDiv = document.getElementById('join-error');

        errorDiv.textContent = '';

        try {
            // Check if room exists first
            const exists = await this.multiplayer.checkRoomExists(roomCode);
            if (!exists) {
                errorDiv.textContent = 'Room not found. Check the code and try again.';
                return;
            }

            // Join the room
            await this.multiplayer.joinRoom(roomCode, playerName);
            
            this.roomCode = roomCode;
            this.playerName = playerName;

            // Set up state change listener
            this.multiplayer.onStateChange = (state) => this.handleStateChange(state);

            // Show waiting screen
            this.showWaitingScreen();

        } catch (error) {
            console.error('Failed to join room:', error);
            errorDiv.textContent = 'Failed to join room. Please try again.';
        }
    }

    handleStateChange(state) {
        this.gameState = state;
        
        // Find my player index
        if (this.playerName && state.players) {
            this.myPlayerIndex = state.players.findIndex(
                p => p.name.toLowerCase() === this.playerName.toLowerCase()
            );
        }

        if (state.gameStarted) {
            this.showRollerScreen();
            this.updateUI();
        } else {
            this.showWaitingScreen();
        }
    }

    updateUI() {
        if (!this.gameState) return;

        const state = this.gameState;

        // Update round info
        document.getElementById('current-round').textContent = state.currentRound || 1;
        document.getElementById('total-rounds').textContent = state.totalRounds || 20;
        document.getElementById('roll-count').textContent = (state.rollCount || 0) + 1;

        // Update bank total
        document.getElementById('bank-total').textContent = state.bankTotal || 0;

        // Update current turn
        const turnDisplay = document.getElementById('current-turn');
        if (state.playersWhoCanRoll && state.playersWhoCanRoll.length > 0) {
            const currentPlayerId = state.playersWhoCanRoll[state.currentPlayerIndex || 0];
            const currentPlayer = state.players[currentPlayerId];
            
            if (currentPlayer) {
                const isMyTurn = currentPlayer.name.toLowerCase() === this.playerName.toLowerCase();
                turnDisplay.textContent = isMyTurn ? "🎲 Your turn!" : `${currentPlayer.name}'s turn`;
                turnDisplay.parentElement.classList.toggle('my-turn', isMyTurn);
            }
        } else {
            turnDisplay.textContent = 'All players have banked';
            turnDisplay.parentElement.classList.remove('my-turn');
        }

        // Update 7 button styling
        const sevenBtn = document.querySelector('.dice-btn-roller[data-value="7"]');
        if (state.rollCount >= 3) {
            sevenBtn.classList.add('dice-seven-danger');
        } else {
            sevenBtn.classList.remove('dice-seven-danger');
        }

        // Update doubles button
        const doublesBtn = document.getElementById('doubles-btn');
        doublesBtn.disabled = state.rollCount < 3;

        // Update my score
        if (this.myPlayerIndex >= 0 && state.players[this.myPlayerIndex]) {
            document.getElementById('my-score-value').textContent = state.players[this.myPlayerIndex].score || 0;
        }
    }

    async submitRoll(value) {
        try {
            await this.multiplayer.submitRoll(value, false);
        } catch (error) {
            console.error('Failed to submit roll:', error);
        }
    }

    async submitDoubles() {
        try {
            await this.multiplayer.submitRoll(0, true);
        } catch (error) {
            console.error('Failed to submit doubles:', error);
        }
    }

    async requestBank() {
        try {
            await this.multiplayer.requestBank();
        } catch (error) {
            console.error('Failed to request bank:', error);
        }
    }

    leaveRoom() {
        this.multiplayer.disconnect();
        this.roomCode = null;
        this.playerName = null;
        this.gameState = null;
        this.myPlayerIndex = -1;
        this.showJoinScreen();
    }

    showJoinScreen() {
        this.hideAllScreens();
        document.getElementById('join-screen').classList.add('active');
        document.getElementById('room-code-input').value = '';
        document.getElementById('player-name-input').value = '';
        document.getElementById('join-error').textContent = '';
        document.getElementById('join-btn').disabled = true;
    }

    showWaitingScreen() {
        this.hideAllScreens();
        document.getElementById('waiting-screen').classList.add('active');
        document.getElementById('connected-room-code').textContent = this.roomCode;
    }

    showRollerScreen() {
        this.hideAllScreens();
        document.getElementById('roller-screen').classList.add('active');
    }

    showDisconnectedScreen() {
        this.hideAllScreens();
        document.getElementById('disconnected-screen').classList.add('active');
    }

    hideAllScreens() {
        document.querySelectorAll('.screen').forEach(screen => {
            screen.classList.remove('active');
        });
    }
}

// Initialize game
const game = new RollerGame();
