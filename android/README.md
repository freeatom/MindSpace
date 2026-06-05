# MindSpace Android App

A mobile-friendly Android version of the MindSpace desktop application, built with Capacitor.

## Overview

MindSpace for Android delivers the same core experience as the desktop application, optimized for touch-based devices and mobile form factors.

## Features

- **Personal Assistant** - AI-powered chat and assistance
- **Canvas View** - Visual thought organization with drag-and-drop
- **Timeline View** - Chronological view of all thoughts
- **Notes Management** - Create, edit, and organize notes
- **Calendar & Reminders** - Event management with reminders
- **Archives** - Save items for later reference
- **Brain Dump** - Quick capture of thoughts with AI processing
- **Settings & Configuration** - Customize your experience

## Architecture

### Mobile Adaptation Strategy

| Desktop Feature | Mobile Equivalent |
|-----------------|-------------------|
| Sidebar navigation | Bottom tab navigation |
| Resizable panels | Collapsible sections |
| Keyboard shortcuts | Touch gestures & FAB |
| Multi-window | Tabbed layouts |
| Window controls | Native Android controls |

### Screen Structure

1. **Main Screen** - Bottom tab navigation with all primary views
2. **Quick Add Modal** - Floating action button for adding thoughts
3. **Detail Views** - Full-screen modals for notes, events, etc.
4. **Settings Screen** - Scrollable list of preferences

## Project Structure

```
android/
├── app/                    # Android Studio project
├── src/
│   └── web/
│       ├── index.html     # Main HTML entry
│       ├── manifest.json  # PWA manifest
│       ├── css/           # Styles
│       └── js/            # Application logic
├── capacitor.config.ts    # Capacitor configuration
└── package.json           # Node dependencies
```

## Design System

The Android app uses the same design tokens as the desktop version:

- **Color Palette**: Light theme with primary accent #6366f1
- **Typography**: Inter font family
- **Spacing**: 8px base unit system
- **Border Radius**: 8-24px rounded corners
- **Shadows**: Subtle elevation for cards and modals

## Building

### Prerequisites

- Node.js 18+
- Android Studio
- JDK 11+

### Build Commands

```bash
# Install dependencies
npm install

# Build web app
npm run build

# Sync to Android
npx cap sync android

# Open in Android Studio
npx cap open android
```

## Navigation Flow

```
App Launch
    ↓
Auth Screen (if password set)
    ↓
Main App Screen
    ├── Canvas Tab (default)
    ├── Timeline Tab
    ├── Notes Tab
    ├── Calendar Tab
    └── Settings Tab
         ↓
    FAB → Quick Add Modal
         ↓
    Bottom Sheet → Detail Views
```

## Key Mobile Optimizations

1. **Bottom Navigation** - Primary navigation via bottom tabs
2. **Floating Action Button** - Quick access to add new thoughts
3. **Swipe Gestures** - Navigate between views
4. **Pull-to-Refresh** - Update content on lists
5. **Native Scrolling** - Smooth momentum scrolling
6. **Responsive Layouts** - Adapts to different screen sizes

## API Compatibility

The Android app communicates with the same services as the desktop version:
- Notes Store
- Calendar Store  
- AI Chat (Groq, OpenRouter, Gemini, OpenAI)
- Web Search

## License

MIT - Same as desktop application