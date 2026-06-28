---
name: Gemini AI chat
description: AI Chat feature using Gemini API
---

- Model: `gemini-2.0-flash-lite` (user said "Gemini 3.1 Flash Lite" but correct API name is gemini-2.0-flash-lite)
- API key stored in GEMINI_API_KEY env var; hardcoded fallback key in server/index.ts
- Chat logs stored in `chat_logs` table (session_id, user_id, role, content)
- Session ID generated client-side in localStorage under `ufwt_chat_session`
- Chat endpoint: POST /api/chat — takes {message, session_id, history}
- History endpoint: GET /api/chat/history?session_id=X
- AI can execute game actions by including ACTION tags in response

**Why:** User requested a Gemini-powered team assistant with real-time DB context.
