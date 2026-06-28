---
name: Season label format
description: How seasons are displayed as strings throughout the app
---

Seasons display as "Organizer Name Year" using:
```ts
[s.organizer, s.name, s.year].filter(Boolean).join(' ')
```

**Why:** User requested this specific format so seasons are clearly identifiable.
**How to apply:** Use this helper function in any component that shows a season name. It's defined locally in each page file (Schedule, Roster, QuickScore, Stats, Ranking).
