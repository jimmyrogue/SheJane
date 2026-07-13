# SheJane UI Design System

This is the source of truth for the SheJane (石间) Desktop visual system.

## Visual Thesis

SheJane is warm paper, ink, and negative space. The product name 石间 means the space between stones, so the UI should feel quiet, deliberate, and lightly editorial rather than SaaS-generic.

- Use warm paper and ink for roughly 95% of the interface.
- Use seal red only for the brand mark, current execution, destructive intent, or a small number of truly important counters.
- Use moss green only for online, complete, or successful states.
- Do not use colorful file/app icons, multicolor status lights, purple-blue gradients, bokeh/orbs, or decorative gradients.
- Express hierarchy with ink strength, spacing, and surface depth before adding color.

## Tokens

```css
:root {
  --sj-paper: #FAF9F6;
  --sj-paper-raised: #FFFFFF;
  --sj-paper-sunken: #F3F1EC;
  --sj-paper-wash: #EFEDE7;
  --sj-ink: #2B2A28;
  --sj-ink-soft: #6F6B63;
  --sj-ink-faint: #A8A39A;
  --sj-ink-ghost: #C9C5BC;
  --sj-line: #E8E5DE;
  --sj-line-strong: #D9D5CC;
  --sj-seal: #B3532F;
  --sj-moss: #5E7A6E;
}
```

Typography:

- Sans: `-apple-system`, `BlinkMacSystemFont`, `PingFang SC`, `Noto Sans SC`, `Source Han Sans SC`, `Helvetica Neue`, `sans-serif`.
- Serif: `Noto Serif SC`, `Songti SC`, `STSong`, `serif`; reserve for brand wordmarks.
- Mono: `SF Mono`, `JetBrains Mono`, `ui-monospace`, `monospace`; use for file glyphs, code, counters, and technical tokens.

Radius and depth:

- Radius scale: `6px`, `10px`, `14px`.
- Shadows stay barely visible: `0 1px 2px rgba(43,42,40,.04)` for common surfaces, `0 2px 8px rgba(43,42,40,.06)` for hover/elevated surfaces.
- Prefer subtle background steps over hard borders; use `--sj-line` only as a hairline.

## Brand Mark

Use the "圆相" mark: an unclosed ink circle with one seal-red stone at the gap.

- Renderer assets: `apps/desktop/src/shared/assets/logo.png` and `logo-lockup.png`. Both are PNG assets; there is no SVG source in the repository.
- Electron assets: `apps/desktop/electron/assets/app-icon.png`/`.icns` (dark squircle, off-white ring), `apps/desktop/electron/assets/app-tray*.png`.
- The tray icon is a black transparent mask because Electron sets it as a macOS template image.

## App Shell

The primary shell is a utility surface, not a landing page.

- The window background is `--sj-paper` edge to edge. Do not wrap the app in an outer card, border, or old-style framed shell.
- The left sidebar is a floating raised-paper island: about `192px` wide at the default desktop width, `12px` from the window edges, `14px` radius, a hairline border, and a barely visible shadow.
- The sidebar hierarchy is the logo, `新对话`, and the conversation list. Runtime features (`Skill`, `MCP`) and `设置` belong in the bottom footer, not the top navigation.
- The main chat area remains paper, not a white panel. The message row column is centered at about `700px`.
- User messages are small raised-paper bubbles with a hairline; assistant messages are plain rich text on paper.
- The composer is a bottom floating island: about `560px` wide, raised paper, `10px` radius, light hairline, and quiet icon tools below the editor line.
- The right preview is also a floating island: `12px` from the window edges, `14px` radius, raised paper, and default width around `360px`; users may resize it wider for documents.
- Status dots: seal red for active/running, moss for online/success, muted ochre only for warnings.

## Attachments And Artifacts

Attachments and generated artifacts use single-color type glyphs instead of colorful app icons.

- Spreadsheet: `表`
- Document/PDF: `文`
- Presentation: `演`
- Image: `图`
- Plain text: `Tt`
- Markdown: `M↓`
- Code: `{}`

Cards should be small raised-paper objects with a hairline, not colored badges. Clicking previewable files opens the right floating preview panel; non-previewable files keep the external/download action.
