# TwinMind Live Suggestions Assignment

A lightweight three-column web app built to match the provided TwinMind reference UI and satisfy the assignment spec as closely as possible in a simple, reviewable codebase.

## What it does

- Captures live microphone audio in the browser
- Flushes transcript chunks roughly every 30 seconds while recording
- Sends each chunk to Groq `whisper-large-v3` for transcription
- Generates exactly 3 fresh live suggestions from recent transcript context using Groq `openai/gpt-oss-120b`
- Keeps older suggestion batches visible underneath the latest batch
- Opens a detailed answer in the chat panel when a suggestion is clicked
- Allows free-form user questions in the same session chat
- Exports transcript, suggestion batches, chat history, prompts, settings, and latency metadata
- Saves the Groq API key and prompt/settings locally in the browser with `localStorage`

## Stack

- Vanilla HTML, CSS, and JavaScript
- Browser `MediaRecorder` for microphone capture
- Groq APIs
  - `whisper-large-v3` for transcription
  - `openai/gpt-oss-120b` for suggestions and chat answers
- Small Node static server for local running

## Run locally

```bash
npm install
npm start
```

Open `http://localhost:3000` in Chrome or Edge.

## How to use

1. Click `Settings`.
2. Paste your Groq API key from `https://console.groq.com/keys`.
3. Save settings.
4. Click the mic button and allow microphone access.
5. Speak for around 30 seconds.
6. Watch the transcript appear on the left and the 3 live suggestions appear in the middle.
7. Click any suggestion to generate a detailed answer on the right.
8. Export the session at the end.

## Prompt strategy

- Live suggestions use a short transcript window to stay timely and reduce noise.
- The live-suggestion prompt explicitly asks for a context-aware mix across question, talking point, answer, fact check, and clarification.
- Suggestions are forced into a structured JSON response and trimmed to exactly 3 cards.
- Clicked suggestions use a larger transcript window for more detailed and context-rich answers.
- Direct chat is transcript-first, then falls back to cautious general knowledge when necessary.

## Tradeoffs

- The Groq API key is stored client-side in browser `localStorage` for assignment simplicity and ease of testing. For production, this should move behind a backend proxy.
- Session data is kept in memory only and intentionally resets on page reload, matching the assignment’s “session-only” requirement.
- Latency metrics are simple client-side measurements, useful for demoing responsiveness but not a full observability layer.

## Files

- `index.html`: app structure and modal/templates
- `styles.css`: reference-inspired dark UI styling
- `app.js`: mic capture, Groq calls, prompt handling, export, persistence, timers
- `server.js`: local static server
- `vercel.json`: simple deployment config for Vercel

## Deploy

### Vercel

1. Push this project to GitHub.
2. Import the repo into Vercel.
3. Framework preset: `Other`
4. Build command: leave empty
5. Output directory: `.`
6. Deploy

### Alternative static hosts

Because this is a small browser app plus a Node static server, it can also be adapted for Render, Railway, or Netlify. If deploying to a purely static host, serve the files at repo root and ensure the browser can reach the Groq API directly.

## Notes

- Best tested in Chrome or Edge because of `MediaRecorder` support.
- Real-world prompt tuning still matters a lot for this assignment. The included prompts are a strong starting point, but the best submission will come from testing them in actual meeting-like conversations.
