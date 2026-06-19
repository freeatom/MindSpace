# MindSpace

**Your mind, extended. Your productivity, unhinged (in a good way).**

A local-first, privacy-obsessed desktop app that replaces your sticky notes, calendar, notebook, clipboard manager, voice assistant, and that one tab you keep open "just in case" — all in one place. Built with Electron. Runs on vibes and caffeine.

> *"I didn't want another note-taking app. I wanted a second brain that actually works."*


---

## What Is This?

MindSpace is a **spatial productivity OS** for Windows. Think of it as a canvas where your thoughts literally float around, an AI assistant that actually does stuff instead of just chatting, and a voice engine. All your data stays on YOUR machine. No cloud. No telemetry. No "we updated our privacy policy" emails.

---

## Features

### Spatial Canvas
Drag-and-drop thought cards on an infinite canvas. Priority-coded (high/medium/low), taggable, and auto-expiring. Because not every thought deserves to live forever.

### Spotlight (Alt+Space)
A system-wide command bar — capture thoughts, chat with AI, search the web with an embedded browser, and manage notes. Always one shortcut away, even when MindSpace is hidden.

### Intelligence Agent
An AI agent that doesn't just talk — it **acts**. Creates thoughts, schedules meetings, manages notes, searches the web, triggers workflows, and learns about you over time via a persistent knowledge graph. Powered by a ReAct + Verify loop so it actually confirms its own work.

**Supports:** OpenRouter, Groq, OpenAI, Gemini, Anthropic. Bring your own API key.

### Whispr (Push-to-Talk)
Hold Right Shift → speak → release. Your voice gets transcribed via Groq Whisper and either pasted into whatever you're focused on or routed as a voice command to the AI agent. Works system-wide, even outside MindSpace.

### Brain Dump
Paste a wall of text. AI auto-categorizes it into actionable thought cards and archive entries. For those moments when your brain has 47 things to say and zero organizational skills.

### Calendar & Scheduler
Full event management with reminders, recurring events, snooze, and auto-scheduling from voice commands. The agent can schedule meetings from clipboard text or voice. Calendar events auto-link to canvas thought cards.

### Notes
A dedicated notes editor that lives alongside everything else. Create, search, and manage persistent documents.

### Clipboard Autopilot
Monitors your clipboard in the background. Copy a Zoom link? Auto-schedules the meeting. Copy a URL? Summarizes it. Copy a task list? Extracts action items onto the canvas. It's creepy-helpful.

### Workflows
Reusable macro sequences triggered by keyword. Chain shell commands, URL opens, thought creation, tool launches, and delays. Automate the boring stuff.

### Tools Hub
Register external tools and scripts. Launch them from MindSpace with one click.

### Archives & Timeline
Finished thoughts don't die — they graduate to the archive. Full timeline view for looking back at what you actually accomplished (or pretending you did).

### Zero-Knowledge Encryption
AES-256-GCM encryption with PBKDF2 key derivation. Your thoughts are encrypted at rest. Not even MindSpace can read them without your password. Because privacy isn't a feature, it's a right.

---

## Tech Stack

| Layer | Tech |
|-------|------|
| Framework | Electron 33 |
| Database | NeDB (embedded, file-based) |
| Encryption | AES-256-GCM via Node.js crypto |
| Auth | bcrypt password hashing |
| AI | OpenRouter / Groq / OpenAI / Gemini / Anthropic |
| Speech-to-Text | Groq Whisper API |
| UI | Vanilla JS, CSS |

---

## Getting Started

### Prerequisites
- Node.js 18+
- Windows 10/11 (PTT uses Win32 APIs)

### Install & Run

```bash
git clone https://github.com/freeatom/mindspace.git
cd mindspace
npm install
npm start
```

### Build Installer

```bash
npm run dist
# Output: dist/MindSpace Setup 1.0.0.exe
```

### Configuration

1. Launch MindSpace
2. Go to **Settings** → **AI Assistant**
3. Add your API key (OpenRouter, Groq, OpenAI, etc.)
4. Optionally add a Groq key under **Speech-to-Text (Whispr)** for voice features
5. Set a password for zero-knowledge encryption (recommended)

---

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Alt+Space` | Toggle Spotlight |
| `Alt+\`` | Toggle Whispr (voice) |
| `Right Shift` (hold) | Push-to-Talk Whispr (voice) |
| `Escape` | Close current overlay |

---

## Philosophy

- **Local-first.** Your data never leaves your machine.
- **No frameworks.** Vanilla JS because we're not afraid of the DOM.
- **Privacy by default.** Encryption at rest. No analytics. No tracking.
- **Self-healing.** The app monitors and fixes itself hourly.

---

## License

MIT — do whatever you want, just don't blame me when you become too productive.

---

