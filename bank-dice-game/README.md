# 🎲 Bank Dice Game

A Progressive Web App (PWA) implementation of the classic Bank dice game. Install it on your Android phone and play with friends!

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
- `index.html` - Main HTML structure
- `style.css` - Mobile-first responsive styling
- `app.js` - Game logic and state management
- `manifest.json` - PWA manifest for installation
- `sw.js` - Service Worker for offline support
- `icons/` - App icons for various sizes
