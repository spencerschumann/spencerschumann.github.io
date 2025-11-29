// Multiplayer Manager for Bank Dice Game
// Handles Firebase real-time synchronization between scoreboard and rollers

class MultiplayerManager {
    constructor() {
        this.db = null;
        this.roomCode = null;
        this.roomRef = null;
        this.isHost = false;
        this.playerId = null;
        this.playerName = null;
        this.listeners = [];
        this.onStateChange = null;
        this.onRollReceived = null;
        this.onPlayerJoined = null;
        this.onPlayerLeft = null;
        this.onBankRequest = null;
    }

    // Initialize Firebase
    async init() {
        if (typeof firebase === 'undefined') {
            console.error('Firebase SDK not loaded');
            return false;
        }

        if (!firebase.apps.length) {
            firebase.initializeApp(window.firebaseConfig);
        }
        this.db = firebase.database();
        this.playerId = this.generatePlayerId();
        return true;
    }

    generatePlayerId() {
        return 'player_' + Date.now() + '_' + Math.random().toString(36).substring(2, 11);
    }

    // Host: Create a new room
    async createRoom(gameState) {
        if (!this.db) await this.init();
        
        this.roomCode = generateRoomCode();
        this.isHost = true;
        this.roomRef = this.db.ref('rooms/' + this.roomCode);

        // Set initial room state
        await this.roomRef.set({
            createdAt: firebase.database.ServerValue.TIMESTAMP,
            host: this.playerId,
            gameState: this.sanitizeGameState(gameState),
            players: {},
            rolls: {},
            bankRequests: {}
        });

        // Set up listeners
        this.setupHostListeners();

        // Clean up room when host disconnects
        this.roomRef.onDisconnect().remove();

        return this.roomCode;
    }

    // Roller: Join an existing room
    async joinRoom(roomCode, playerName) {
        if (!this.db) await this.init();

        this.roomCode = roomCode.toUpperCase();
        this.playerName = playerName;
        this.roomRef = this.db.ref('rooms/' + this.roomCode);

        // Check if room exists
        const snapshot = await this.roomRef.once('value');
        if (!snapshot.exists()) {
            throw new Error('Room not found');
        }

        // Add player to room
        const playerRef = this.roomRef.child('players/' + this.playerId);
        await playerRef.set({
            name: playerName,
            joinedAt: firebase.database.ServerValue.TIMESTAMP,
            connected: true
        });

        // Remove player when disconnected
        playerRef.onDisconnect().update({ connected: false });

        // Set up listeners
        this.setupRollerListeners();

        return true;
    }

    // Host: Set up listeners for incoming rolls and bank requests
    setupHostListeners() {
        // Listen for new rolls
        const rollsRef = this.roomRef.child('rolls');
        const rollListener = rollsRef.on('child_added', (snapshot) => {
            const roll = snapshot.val();
            if (this.onRollReceived) {
                this.onRollReceived(roll);
            }
            // Remove the roll after processing
            snapshot.ref.remove();
        });
        this.listeners.push({ ref: rollsRef, event: 'child_added', callback: rollListener });

        // Listen for bank requests
        const bankRef = this.roomRef.child('bankRequests');
        const bankListener = bankRef.on('child_added', (snapshot) => {
            const request = snapshot.val();
            if (this.onBankRequest) {
                this.onBankRequest(request);
            }
            // Remove the request after processing
            snapshot.ref.remove();
        });
        this.listeners.push({ ref: bankRef, event: 'child_added', callback: bankListener });

        // Listen for player joins/leaves
        const playersRef = this.roomRef.child('players');
        const playerJoinListener = playersRef.on('child_added', (snapshot) => {
            if (this.onPlayerJoined) {
                this.onPlayerJoined({ id: snapshot.key, ...snapshot.val() });
            }
        });
        this.listeners.push({ ref: playersRef, event: 'child_added', callback: playerJoinListener });

        const playerChangeListener = playersRef.on('child_changed', (snapshot) => {
            const data = snapshot.val();
            if (!data.connected && this.onPlayerLeft) {
                this.onPlayerLeft({ id: snapshot.key, ...data });
            }
        });
        this.listeners.push({ ref: playersRef, event: 'child_changed', callback: playerChangeListener });
    }

    // Roller: Set up listeners for game state changes
    setupRollerListeners() {
        // Listen for game state changes
        const stateRef = this.roomRef.child('gameState');
        const stateListener = stateRef.on('value', (snapshot) => {
            if (this.onStateChange && snapshot.exists()) {
                this.onStateChange(snapshot.val());
            }
        });
        this.listeners.push({ ref: stateRef, event: 'value', callback: stateListener });
    }

    // Host: Update game state for all rollers
    async updateGameState(gameState) {
        if (!this.isHost || !this.roomRef) return;
        await this.roomRef.child('gameState').set(this.sanitizeGameState(gameState));
    }

    // Roller: Submit a dice roll
    async submitRoll(value, isDoubles = false) {
        if (!this.roomRef) return;
        
        const rollRef = this.roomRef.child('rolls').push();
        await rollRef.set({
            playerId: this.playerId,
            playerName: this.playerName,
            value: value,
            isDoubles: isDoubles,
            timestamp: firebase.database.ServerValue.TIMESTAMP
        });
    }

    // Roller: Request to bank
    async requestBank() {
        if (!this.roomRef) return;
        
        const bankRef = this.roomRef.child('bankRequests').push();
        await bankRef.set({
            playerId: this.playerId,
            playerName: this.playerName,
            timestamp: firebase.database.ServerValue.TIMESTAMP
        });
    }

    // Sanitize game state for Firebase (remove circular refs, functions, etc.)
    sanitizeGameState(state) {
        return {
            players: state.players || [],
            totalRounds: state.totalRounds || 20,
            currentRound: state.currentRound || 1,
            rollCount: state.rollCount || 0,
            bankTotal: state.bankTotal || 0,
            currentPlayerIndex: state.currentPlayerIndex || 0,
            playersWhoCanRoll: state.playersWhoCanRoll || [],
            playersWhoBanked: state.playersWhoBanked || [],
            gameStarted: state.gameStarted || false
        };
    }

    // Clean up listeners and disconnect
    disconnect() {
        this.listeners.forEach(({ ref, event, callback }) => {
            ref.off(event, callback);
        });
        this.listeners = [];

        if (this.isHost && this.roomRef) {
            this.roomRef.remove();
        }

        this.roomRef = null;
        this.roomCode = null;
        this.isHost = false;
    }

    // Check if a room exists
    async checkRoomExists(roomCode) {
        if (!this.db) await this.init();
        
        const snapshot = await this.db.ref('rooms/' + roomCode.toUpperCase()).once('value');
        return snapshot.exists();
    }
}

// Export for use in other files
if (typeof window !== 'undefined') {
    window.MultiplayerManager = MultiplayerManager;
}
