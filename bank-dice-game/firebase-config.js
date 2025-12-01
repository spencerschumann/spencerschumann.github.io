// Firebase Configuration for Bank Dice Game Multiplayer
// Using Firebase Realtime Database for signaling

// Firebase SDK (loaded via CDN in HTML)
// This configuration is for the signaling server

const firebaseConfig = {
    // These are public configuration values - safe to commit
    // The database rules in Firebase console control access
    apiKey: "AIzaSyBg_JVQKmSxCxVJVKJHzQMWxKG9qVBXZ7Y",
    authDomain: "bank-dice-game-multi.firebaseapp.com",
    databaseURL: "https://bank-dice-game-multi-default-rtdb.firebaseio.com",
    projectId: "bank-dice-game-multi",
    storageBucket: "bank-dice-game-multi.appspot.com",
    messagingSenderId: "123456789",
    appId: "1:123456789:web:abcdef123456"
};

// Room code generator - creates 4 character alphanumeric codes
function generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Avoiding confusing chars like 0, O, I, 1
    let code = '';
    for (let i = 0; i < 4; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
}

// Export configuration
if (typeof window !== 'undefined') {
    window.firebaseConfig = firebaseConfig;
    window.generateRoomCode = generateRoomCode;
}
