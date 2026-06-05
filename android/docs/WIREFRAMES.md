# MindSpace Android - Wireframes & UI Documentation

## Overview

This document provides detailed wireframes and UI specifications for the MindSpace Android application.

---

## Screen Structure

### 1. Auth Screen
- **Purpose**: Password protection for app access
- **Elements**:
  - Animated logo (floating effect)
  - Password input field
  - Toggle visibility button
  - Unlock button
  - Error message display
- **Behavior**: 
  - Shows only if password is set
  - Shake animation on wrong password
  - Haptic feedback on error

### 2. Main App Screen
- **Header Bar**: App title, search button, lock button
- **Priority Status Bar**: High/Medium/Low counts
- **Content Area**: Scrollable view content
- **FAB**: Floating action button (bottom-right)
- **Bottom Navigation**: 5 tabs (Canvas, Timeline, Notes, Calendar, Settings)

---

## View Wireframes

### Canvas View
```
┌─────────────────────────────┐
│ ◀ MindSpace         🔍 🔒  │ ← Header
├─────────────────────────────┤
│ 🔴 0  🟡 0  🟢 0           │ ← Priority Status
├─────────────────────────────┤
│ Canvas                      │ ← View Header
│ ┌─────────────────────────┐ │
│ │ 🔴 High Priority        │ │
│ │   [Thought Card]        │ │
│ │   [Thought Card]        │ │
│ └─────────────────────────┘ │
│ ┌─────────────────────────┐ │
│ │ 🟡 Medium Priority      │ │
│ │   [Thought Card]        │ │
│ └─────────────────────────┘ │
│ ┌─────────────────────────┐ │
│ │ 🟢 Low Priority         │ │
│ │   [Thought Card]        │ │
│ └─────────────────────────┘ │
│ ┌─────────────────────────┐ │
│ │ ▼ Finished (3)          │ │ ← Collapsible
│ │   [Finished Card]        │ │
│ └─────────────────────────┘ │
│                             │
│                    [+]      │ ← FAB
├─────────────────────────────┤
│ 🏠  📅  📝  📅  ⚙️          │ ← Bottom Nav
└─────────────────────────────┘
```

### Timeline View
```
┌─────────────────────────────┐
│ ◀ MindSpace         🔍 🔒  │
├─────────────────────────────┤
│ 🔴 0  🟡 0  🟢 0           │
├─────────────────────────────┤
│ Timeline                    │
│                             │
│ ●──────────────────────────│ ← Timeline line
│ ┌─────────────────────────┐ │
│ │ [Card content here]     │ │
│ │ 12:30 PM                │ │
│ └─────────────────────────┘ │
│                             │
│ ●──────────────────────────│
│ ┌─────────────────────────┐ │
│ │ [Card content here]     │ │
│ │ Yesterday               │ │
│ └─────────────────────────┘ │
│                             │
│                    [+]      │
├─────────────────────────────┤
│ 🏠  📅  📝  📅  ⚙️          │
└─────────────────────────────┘
```

### Notes View
```
┌─────────────────────────────┐
│ ◀ MindSpace         🔍 🔒  │
├─────────────────────────────┤
│ 🔴 0  🟡 0  🟢 0           │
├─────────────────────────────┤
│ Notes                       │
│ ┌─────────────────────────┐ │
│ │ 🔍 Search notes...       │ │
│ └─────────────────────────┘ │
│ ┌─────────────────────────┐ │
│ │ Meeting Notes            │ │
│ │ Preview of content...    │ │
│ │ 2 hours ago              │ │
│ └─────────────────────────┘ │
│ ┌─────────────────────────┐ │
│ │ Shopping List           │ │
│ │ Milk, eggs, bread...     │ │
│ │ Yesterday               │ │
│ └─────────────────────────┘ │
│                             │
│                    [+]      │
├─────────────────────────────┤
│ 🏠  📅  📝  📅  ⚙️          │
└─────────────────────────────┘
```

### Calendar View
```
┌─────────────────────────────┐
│ ◀ MindSpace         🔍 🔒  │
├─────────────────────────────┤
│ 🔴 0  🟡 0  🟢 0           │
├─────────────────────────────┤
│ Calendar              [+]   │
│ [Dashboard] [Month]          │
│ ┌───┬───┬───┐                │
│ │ 0 │ 5 │ 3 │ ← Stats       │
│ │Mo │Up │Do │               │
│ └───┴───┴───┘                │
│ ┌─────────────────────────┐ │
│ │ Today                   │ │
│ │ 09:00 Team Meeting      │ │
│ │ 14:00 Doctor Appt       │ │
│ └─────────────────────────┘ │
│ ┌─────────────────────────┐ │
│ │ Upcoming                │ │
│ │ Tomorrow 10:00 Review   │ │
│ │ Fri 15:00 Project       │ │
│ └─────────────────────────┘ │
│                             │
│                    [+]      │
├─────────────────────────────┤
│ 🏠  📅  📝  📅  ⚙️          │
└─────────────────────────────┘
```

### Settings View
```
┌─────────────────────────────┐
│ ◀ MindSpace         🔍 🔒  │
├─────────────────────────────┤
│ 🔴 0  🟡 0  🟢 0           │
├─────────────────────────────┤
│ Settings                    │
│ ┌─────────────────────────┐ │
│ │ General                  │ │
│ │ Default Priority [Med ▼]│ │
│ └─────────────────────────┘ │
│ ┌─────────────────────────┐ │
│ │ AI Assistant             │ │
│ │ Provider [Groq ▼]        │ │
│ │ API Key [••••••••]       │ │
│ │ Model [optional]         │ │
│ │ [Save] [Test]            │ │
│ └─────────────────────────┘ │
│ ┌─────────────────────────┐ │
│ │ Appearance               │ │
│ │ Animations     [Toggle] │ │
│ └─────────────────────────┘ │
│ ┌─────────────────────────┐ │
│ │ Security                 │ │
│ │ Change Password [Change] │ │
│ └─────────────────────────┘ │
│                             │
│                    [+]      │
├─────────────────────────────┤
│ 🏠  📅  📝  📅  ⚙️          │
└─────────────────────────────┘
```

---

## Modal Wireframes

### Quick Add Modal
```
┌─────────────────────────────┐
│ What's on your mind?     ✕  │
├─────────────────────────────┤
│ ┌─────────────────────────┐ │
│ │ Type your thought...    │ │
│ │                         │ │
│ │                         │ │
│ └─────────────────────────┘ │
│                             │
│ Priority                    │
│ [H] [M] [L]                │
│                             │
│ Duration                    │
│ [♾️ Keep] [📅 Today]        │
│                             │
│ Tags                        │
│ [work] [urgent] [+ new]      │
│                             │
│ ┌─────────┐ ┌─────────────┐ │
│ │  Save   │ │ ✨ AI Auto  │ │
│ └─────────┘ └─────────────┘ │
└─────────────────────────────┘
```

### Note Modal
```
┌─────────────────────────────┐
│ New Note                 ✕  │
├─────────────────────────────┤
│ Note name                   │
│ ┌─────────────────────────┐ │
│ │                         │ │
│ └─────────────────────────┘ │
│                             │
│ Content                     │
│ ┌─────────────────────────┐ │
│ │                         │ │
│ │                         │ │
│ │                         │ │
│ │                         │ │
│ └─────────────────────────┘ │
│                             │
│              [Delete] [Save]│
└─────────────────────────────┘
```

### Calendar Event Modal
```
┌─────────────────────────────┐
│ New Event                ✕  │
├─────────────────────────────┤
│ Event Title                 │
│ ┌─────────────────────────┐ │
│ │                         │ │
│ └─────────────────────────┘ │
│                             │
│ ┌──────────┐ ┌────────────┐  │
│ │ Date    │ │ Time      │  │
│ │ [Today] │ │ [09:00]   │  │
│ └──────────┘ └────────────┘  │
│                             │
│ Description                 │
│ ┌─────────────────────────┐ │
│ │                         │ │
│ └─────────────────────────┘ │
│                             │
│ ┌──────────┐ ┌────────────┐  │
│ │Category ▼│ │Priority ▼ │  │
│ └──────────┘ └────────────┘  │
│                             │
│              [Delete] [Save]│
└─────────────────────────────┘
```

### Search Modal
```
┌─────────────────────────────┐
│ 🔍 Search...             ✕  │
├─────────────────────────────┤
│ ┌─────────────────────────┐ │
│ │ Search thoughts...      │ │
│ └─────────────────────────┘ │
│                             │
│ Thoughts                    │
│ ┌─────────────────────────┐ │
│ │ Buy groceries           │ │
│ └─────────────────────────┘ │
│ ┌─────────────────────────┐ │
│ │ Call mom                │ │
│ └─────────────────────────┘ │
│                             │
│ Notes                       │
│ ┌─────────────────────────┐ │
│ │ Meeting Notes           │ │
│ └─────────────────────────┘ │
│                             │
└─────────────────────────────┘
```

---

## Component Specifications

### Bottom Navigation
- Height: 64px + safe area
- 5 items evenly distributed
- Active state: Primary accent color
- Icon size: 24px
- Label size: 10px

### Floating Action Button (FAB)
- Size: 56px diameter
- Position: 24px from right, 24px from bottom nav
- Shadow: 4px 16px rgba(99, 102, 241, 0.4)
- Animation: Slide up on load

### Cards
- Border radius: 16px
- Padding: 16px
- Shadow: 0 2px 8px rgba(0,0,0,0.03)
- Margin: 16px horizontal, 8px vertical

### Modals (Bottom Sheets)
- Border radius: 20px top corners
- Max width: 500px
- Padding: 24px
- Animation: Slide up from bottom

### Priority Indicators
- High: Red (#f87171) with red background tint
- Medium: Yellow (#fbbf24) with yellow background tint  
- Low: Green (#34d399) with green background tint

### Status Bar
- Fixed below header
- Shows count of active thoughts by priority
- Horizontal centered layout

---

## Navigation Flow

```
App Launch
    │
    ▼
┌─────────────────┐
│  Auth Screen    │ ← (if password set)
│  - Logo         │
│  - Password     │
└────────┬────────┘
         │ (unlock)
         ▼
┌─────────────────┐
│  Main App       │
│  - Header       │
│  - Status Bar   │
│  - Content      │
│  - FAB          │
│  - Bottom Nav   │
└────────┬────────┘
         │
    ┌────┴────┬──────┬───────┬──────┐
    ▼        ▼      ▼       ▼      ▼
┌──────┐ ┌────┐ ┌────┐ ┌─────┐ ┌─────┐
│Canvas│ │Time│ │Notes│ │Cal  │ │Set  │
│      │ │line│ │     │ │     │ │tings│
└──────┘ └────┘ └────┘ └─────┘ └─────┘

Quick Add Flow:
┌──────┐     ┌──────────────┐
│ FAB  │────▶│ Quick Add    │
│  +   │     │ Modal        │
└──────┘     │ - Text       │
             │ - Priority   │
             │ - Duration   │
             │ - Tags       │
             │ [Save]       │
             └──────────────┘
```

---

## Color Palette

| Name | Hex | Usage |
|------|-----|-------|
| Primary | #6366f1 | Buttons, active states, FAB |
| Primary Light | #e0e1fc | Backgrounds, highlights |
| Primary Hover | #5558e6 | Button hover states |
| Secondary | #8b5cf6 | AI features, gradients |
| Background | #f8f7f4 | App background |
| Surface | #ffffff | Cards, modals |
| Text Primary | #1e293b | Headings, content |
| Text Secondary | #475569 | Labels, descriptions |
| Text Muted | #94a3b8 | Placeholders, hints |
| High Priority | #f87171 | High priority indicator |
| Medium Priority | #fbbf24 | Medium priority indicator |
| Low Priority | #34d399 | Low priority indicator |

---

## Typography

| Element | Size | Weight | Line Height |
|---------|------|--------|-------------|
| App Title | 18px | 700 | 1.2 |
| View Title | 18px | 600 | 1.2 |
| Card Title | 14px | 600 | 1.4 |
| Body Text | 14px | 400 | 1.5 |
| Caption | 11px | 500 | 1.4 |
| Button | 14px | 600 | 1 |
| Label | 11px | 600 | 1 |

---

## Spacing System

| Token | Value | Usage |
|-------|-------|-------|
| xs | 4px | Minimal gaps |
| sm | 8px | Between related elements |
| md | 16px | Section padding |
| lg | 24px | Card margins |
| xl | 32px | Major sections |

---

## Animations

| Animation | Duration | Easing | Usage |
|-----------|----------|--------|-------|
| Fast | 150ms | cubic-bezier(0.16, 1, 0.3, 1) | Hover states |
| Base | 250ms | cubic-bezier(0.16, 1, 0.3, 1) | Transitions |
| Modal | 300ms | cubic-bezier(0.16, 1, 0.3, 1) | Bottom sheets |
| FAB | 400ms | cubic-bezier(0.16, 1, 0.3, 1) | Entrance |

---

## Touch Interactions

1. **Tap**: Primary interaction for selecting, opening
2. **Long Press**: Context menu (delete thought)
3. **Swipe Down**: Dismiss modal
4. **Pull to Refresh**: Update list content

---

## Responsive Breakpoints

| Breakpoint | Width | Layout |
|------------|-------|--------|
| Phone | < 600px | Single column, full width |
| Tablet Portrait | 600-900px | Single column, centered |
| Tablet Landscape | 900-1200px | Two column grid |
| Large Tablet | > 1200px | Three column grid |

---

## Accessibility

- Minimum touch target: 48x48px
- Color contrast: 4.5:1 minimum
- Focus indicators on all interactive elements
- Screen reader labels for icons
- Reduced motion support via `prefers-reduced-motion`