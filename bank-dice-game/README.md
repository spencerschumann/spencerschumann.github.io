# 🎲 Bank Dice Game

A Progressive Web App (PWA) implementation of the classic Bank dice game. Install it on your Android phone and play with friends!

## Play Modes

### Solo Mode (Original)
One device handles all scoring. The BANKER (scorekeeper) taps dice values as players call them out.

### Multiplayer Mode (NEW!)
- **Scoreboard Mode** (Tablet): Set up a tablet as a dedicated scoreboard showing the bank, round number, turn, and all player scores. Creates a room code for others to join.
- **Roller Mode** (Phone): Connect your phone to a game room to submit dice rolls directly to the scoreboard.

## How to Play

### Object of the Game
Be the player who BANKs the most points by the end of 20 rounds!

### Getting Started
1. Open the app and add all players' names
2. Choose between 10, 15, or 20 rounds (most play 20)
3. Choose a Scorekeeper (BANKER) who will manage the app
4. Each player will need access to two dice for their turn

### Game Flow
1. Players sit around a table and take turns rolling two dice clockwise
2. Each player calls out what their dice add up to
3. The BANKER taps that number on the screen pad
4. The Bank total increases with each roll

### Important Dice Rules

**Rolling a 7:**
- First 3 rolls: A 7 is worth 70 points (advantage!)
- After roll 3: A 7 ends the round

**Rolling Doubles:**
- First 3 rolls: Doubles add face value only (e.g., two 5s = 10 points)
- After roll 3: Doubles DOUBLE the entire Bank total!

### Banking
- Any player can call out "BANK" at any time (even if it's not their turn)
- The BANKER taps the BANK button and selects the player
- That player's personal score increases by the current Bank total
- Once banked, a player sits out for the rest of the round
- Each player can only bank once per round

### Ending a Round
A round ends when:
- Someone rolls a 7 (after the first 3 rolls), OR
- All players have banked

### Winning
After all rounds are played, the player with the highest personal score wins!

## Multiplayer Setup

### Setting Up the Scoreboard (Tablet)
1. Open the app on a tablet
2. Tap "Scoreboard Mode"
3. Add all players and start the game
4. A 4-character room code will be displayed
5. Share this code with players

### Joining as a Roller (Phone)
1. Open the app on your phone
2. Tap "Join Game"
3. Enter the room code from the scoreboard
4. Enter your name
5. Once connected, you can submit dice rolls directly!

## Installation

### Android
1. Open the app in Chrome
2. Tap the menu (three dots)
3. Select "Add to Home screen"
4. The app will work offline!

### iOS
1. Open the app in Safari
2. Tap the share button
3. Select "Add to Home Screen"

## Development

This is a simple static web app with no build step required. Just open `index.html` in a browser or serve it with any static file server.

```bash
# Simple Python server
python -m http.server 8000

# Or with Node.js
npx serve
```

## Files
- `index.html` - Main HTML structure (solo mode)
- `scoreboard.html` - Scoreboard display for tablets
- `roller.html` - Roller interface for phones
- `style.css` - Mobile-first responsive styling
- `scoreboard.css` - Scoreboard-specific styles
- `roller.css` - Roller-specific styles
- `app.js` - Solo mode game logic
- `scoreboard.js` - Scoreboard game logic
- `roller.js` - Roller client logic
- `multiplayer.js` - Firebase real-time sync manager
- `firebase-config.js` - Firebase configuration
- `manifest.json` - PWA manifest for installation
- `sw.js` - Service Worker for offline support
- `icons/` - App icons for various sizes

## Technical Notes

### Multiplayer Architecture
The multiplayer feature uses Firebase Realtime Database for signaling:
- The scoreboard (host) creates a room and manages game state
- Rollers connect to the room and receive state updates
- Dice rolls are sent from rollers to the scoreboard
- Bank requests notify the host to process banking

This architecture keeps the scoreboard as the single source of truth while allowing multiple devices to participate.
