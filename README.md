# Sophia — AI Voice Companion

A personal real-time AI voice companion powered natively by **Google Gemini Multimodal Live API** (`models/gemini-3.8-live`), with real-time GPS location tracking, turn-by-turn routing, interactive Google Maps display, and web inspection.

## Features

- **Google Gemini Live Voice**: Direct bidirectional real-time audio streaming powered by `models/gemini-3.8-live` and the realistic `Kore` female voice at steady 1x conversational speed.
- **Persistent Long-Term Memory**: Deep conversational context retention across turns.
- **Turn-by-Turn Navigation & Maps**: Real-time GPS location tracking and interactive Google Maps route deck.
- **Zero Third-Party Gateway Dependencies**: 100% native Google Gemini WebSockets (`generativelanguage.googleapis.com`).

## Deployment on Render

1. **Build Command**:
   ```bash
   npm install && npm run build
   ```
2. **Start Command**:
   ```bash
   node .output/server/index.mjs
   ```
3. **Environment Variables**:
   - `GEMINI_API_KEY`: Your Google AI Studio API key (`AQ...`)
   - `GEMINI_VOICE`: `Kore` (default smooth natural female voice)
   - `GEMINI_MODEL`: `models/gemini-3.8-live`
