# UI reconstruction map

Upstream baseline: tonyAmadeus/offAice at
`c6e2b59114763d83c93edeb2758a6cbe2ffbb952`.

| Original UI module | SwiftUI reconstruction | Functional status |
| --- | --- | --- |
| `src/renderer/App.tsx`, `styles.css` | `ContentView.swift`, `StudioDesign.swift`, `StudioDashboard.swift` | Navigation, dashboard, project list, secure-state indicator |
| `src/renderer/members.tsx`, `member-card.tsx` | `StudioAssets.swift`, `StudioDashboard.swift`, `MembersView.swift` | Original portraits (optional download), native cards and persona editing |
| `src/renderer/member-desk.tsx` | `ChatView.swift` | Read-only CLI chat with streaming and stop |
| `src/renderer/room.tsx`, `room-backdrop.tsx` | `RoomView.swift`, `StudioAssets.swift` | Shared sequential replies, optional time-of-day room art |
| `src/renderer/roundtable.tsx` | `RoundtableView.swift` | Two-agent independent comparison; not full peer-review/voting workflow |
| `src/renderer/project-room.tsx` | `ProjectsView.swift` | Project copy and manual writeback; not original multi-role project-flow UI |
| `src/renderer/settings.tsx` | `SettingsView.swift` | Native CLI paths, theme, localization, encrypted backup |
| `src/renderer/attention.tsx` | `StudioDashboard.swift` (`StudioAttentionView`) | Pending project reviews and failures only |

Art asset source: upstream `src/renderer/assets/members/`,
`src/renderer/assets/rooms/`, `build/airoom.png`.
Use `Scripts/fetch-original-assets.sh` to obtain pinned, SHA-verified copies locally.
The app never fetches art from the network at runtime.

Appearance preference is stored in UserDefaults (non-secret). Conversations,
projects, backup and language remain under the existing encrypted data store.

Security guarantees and limits remain as described in `SECURITY.md`.
