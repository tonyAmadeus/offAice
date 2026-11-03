# Avatar/Portrait crop fix

- `StudioAvatar` no longer makes a tall 960×1720 portrait into a square, then applies a hard-coded downward offset.
- `PortraitCropLayout` scales the original artwork proportionately and puts the upstream face coordinate at the exact centre of the circular frame.
- Original `BUILTIN_ART` values from `src/renderer/members.tsx`: Claude `(x=0.5,y=0.123,zoom=3.6)` and Codex `(x=0.487,y=0.113,zoom=3.6)`.
- Applies to all callers of `StudioAvatar`: sidebar, member cards, chats, lounge, roundtable and quota page. Full-body `StudioPortrait` display is unchanged.
- Four Linux-capable layout regression tests verify the crop and protect against a return to distortion or hard-coded offsets.
- Test the real rendering on macOS: SwiftUI / AppKit are not available in this Linux build environment.
