# monocode-hub UI slice (reference only)

Verbatim copy of the agent-chat UI from monocode-hub (a fork of upstream MonoCode, MIT, see `LICENSE` and
`NOTICE` in this folder), kept here as the source to port Hivra's launched-agent view from. Nothing in this folder
is built, linted, type-checked or scanned by Tailwind: `dashboard/tsconfig.json`, `dashboard/eslint.config.mjs` and
`dashboard/src/app/globals.css` exclude `reference/`.

Paths match the original repo (`src/...`). One comment in `src/shared/lib/paths.ts` was reworded to drop a
home-folder path; every other file is byte-for-byte. Copied from monocode-hub at `679e30d9a`.

It is a slice, not a runnable app. These files still import modules that were left out (Tauri IPC in
`platform/tauri/*`, the session store and harness adapters, the "Mono"/hub/orchestration features, git and file
tree features). Treat those imports as the seams to replace with Hivra's own data layer.

## Stack

monocode-hub is a Tauri 2 desktop app: React 19 + TypeScript in a Vite 7 webview, styled with Tailwind CSS v4
(CSS-first `@theme` tokens in `src/styles/index.css`, no `tailwind.config`). No component library: every control
is hand-built.

Packages these files use (ranges from monocode-hub's `package.json`):

| Package | Version | Used for |
| --- | --- | --- |
| react, react-dom | ^19.1.0 | everything |
| tailwindcss, @tailwindcss/vite | ^4 | all styling (utility classes + tokens in `index.css`) |
| @hugeicons/react | ^1.1.10 | icon component (`shared/ui/icons.tsx`) |
| @hugeicons/core-free-icons | ^4.3.0 | the icon glyphs, deep-imported one by one |
| streamdown | ^2.5.0 | streaming Markdown in assistant replies (`AgentMarkdown.tsx`) |
| @streamdown/code | ^1.1.1 | code-block highlighting for streamdown |
| @streamdown/mermaid | ^1.0.2 | Mermaid diagrams in replies |
| shiki | ^3.23.0 | syntax highlighting (`HighlightedCodeBlock.tsx`) |
| remend | ^1.3.0 | repairs half-streamed Markdown (`streamingMarkdown.ts`) |
| rehype-harden | ^1.1.8 | link/image allow-listing in rendered Markdown |
| frimousse, emojibase-data | ^0.4.0, ^17.0.0 | composer emoji picker |
| @tauri-apps/api (+ plugin-opener, plugin-dialog) | ^2.7.0 | desktop IPC; replace with Hivra API calls |
| typescript | ~5.8.3 | |

Fonts: none bundled. `--font-sans` is the system UI stack and `--font-mono` is `ui-monospace, SFMono-Regular, Menlo...`
(both in `src/styles/index.css` `@theme`). Theme: dark by default, `theme-light` class on `<html>` for light, hue,
saturation and darkness driven by CSS variables (`--theme-hue`, `--theme-saturation`, `--theme-dark-lightness`),
set before paint by the inline script in `index.html` and at runtime by `features/settings/model/appearance.ts`.

## How the layout composes

Top-level layout: **`src/app/App.tsx`** (the `App` component; its main `return` is near line 16454). The tree is:

```
App (workspace-background, full-height column)
├─ TitleBar                         app/shell/TitleBar.tsx (spans the window in the inset layout)
└─ row
   ├─ ProjectStrip / ProjectRail    left icon rail of projects (app/shell/ProjectRail.tsx, RailAction, RailTooltip)
   ├─ Sidebar                       session/thread list, nav, search, filters (app/shell/Sidebar.tsx)
   └─ main column (body-glass)
      └─ PaneTree                   split panes + tabs (features/workspace/ui/PaneTree.tsx, SurfaceTabs.tsx)
         └─ SessionPane             one chat (features/sessions/ui/SessionPane.tsx)
            ├─ AgentTranscript      messages, tool/action rows, thinking + live step line
            │   ├─ AgentMarkdown → HighlightedCodeBlock, wordFade (streaming fade-in)
            │   ├─ LiveActivity, QuestionForm, PlanPreview, TaskListPreview, ToolDiffPreview, SessionReview
            ├─ TranscriptFind, TranscriptJumpToBottom, MessageQueue
            └─ Composer             input, attachments, @/slash pickers, send/stop
                ├─ ModelPicker, AccessPicker, ContextMeter, McpServerPicker
                └─ AttachmentChip, FileMentionPicker, ComposerRunner
```

`App.tsx` has two layouts: the classic flat row and an "inset" layout (rail + sidebar in one host, the session
pane in a rounded `inset-card`). Both use the same components. `main.tsx` mounts `App` and imports `index.css`.

## Screenshots

Taken from monocode-hub's own browser harness with invented stub data (no real chats):

- `screenshots/1-chat-transcript.png`: full window. Project rail, sidebar, session list, transcript with a
  streamed Markdown reply (headings, lists, inline code, code block), composer with model picker.
- `screenshots/2-chat-question-and-code.png`: the same chat with the agent asking a multiple-choice question
  (`QuestionForm`) and the "Waiting for your answers" live line.
- `screenshots/3-composer-fixture.png`: the empty session (`SessionPane` fixture) with the full composer:
  folder/branch line, input, model and access pickers, send/stop.

## Files

Top level

- `LICENSE`: upstream MonoCode MIT license (keep with any ported code).
- `NOTICE`: upstream trademark/attribution notice.
- `index.html`: Vite entry; inline pre-paint theme script and base CSS variables.
- `src/main.tsx`: React root; mounts `App`, loads `index.css`, appearance and window bootstrapping.
- `src/styles/index.css`: the whole design system. Tailwind v4 `@theme` tokens (colors, fonts, radii, diff colors),
  light/dark palettes, glass/haze backgrounds, transcript, composer and sidebar styles.

App shell (`src/app/`)

- `App.tsx`: top-level layout and state wiring for the window (see tree above).
- `shell/TitleBar.tsx`: top bar; session title, status, tabs/Overview controls, panel toggles.
- `shell/Sidebar.tsx`: the sidebar; search, nav items, session/thread list with groups, status dots, filters.
- `shell/ProjectRail.tsx`: narrow left rail of project icons with badges.
- `shell/RailAction.tsx`: one rail button (icon + label + badge).
- `shell/RailTooltip.tsx`: instant tooltips for rail controls.
- `shell/SettingsRail.tsx`: rail body while settings are open.
- `shell/WindowControls.tsx`: minimise/maximise/close buttons for non-macOS windows.
- `shell/GlassBackdrop.tsx`: frosted-glass backdrop layer.
- `shell/ClosingTab.tsx`: animated tab being closed.
- `shell/useProjectMenu.tsx`: project/group context menu hook.
- `shell/useProjectSwipe.ts`: trackpad swipe between projects.
- `shell/gitLabel.ts`: "repo/branch" label on session cards.
- `shell/windowTitle.ts`: OS window title text.

Workspace (`src/features/workspace/ui/`)

- `PaneTree.tsx`: split-pane layout that hosts `SessionPane`s; sash resize.
- `SurfaceTabs.tsx`: tab strip over a pane.

Chat pane (`src/features/sessions/ui/`)

- `SessionPane.tsx`: one chat: transcript + composer + find/queue overlays.
- `AgentTranscript.tsx`: the transcript; user/assistant turns, tool-call rows (folding work trail), thinking,
  working state, message actions (copy, edit, retry), delegated runs.
- `AgentMarkdown.tsx`: streamed Markdown renderer for replies (streamdown), links, images, tables.
- `HighlightedCodeBlock.tsx`: Shiki-highlighted code block with header and copy button.
- `wordFade.tsx`: smooth word fade-in for streamed text.
- `streamingMarkdown.ts`: repairs half-finished Markdown blocks while streaming.
- `hardBreaks.ts`: keeps single newlines as line breaks.
- `LiveActivity.tsx`: live step line under a working reply ("Reading app.tsx · 14s").
- `MonoWorkTicker.tsx`: one-line rolling status ticker.
- `TerminalSpinner.tsx`: small text spinner for running steps.
- `ToolDiffPreview.tsx`: file chip that expands to show a tool's edit diff.
- `useToolDetail.ts`: loads tool output that was left out of the live transcript.
- `QuestionForm.tsx`: agent's multiple-choice clarifying question card.
- `PlanPreview.tsx`, `PlanStepsBurst.tsx`: plan card and its step animation.
- `TaskListPreview.tsx`: todo-list card from an agent's task tool.
- `GoalRow.tsx`: a goal / finish-line row with check progress.
- `SessionReview.tsx`: end-of-turn result card (changes, review).
- `HandoffMiniCard.tsx`: card for a hand-off to another session.
- `LiveAgentsPreview.tsx`: card listing sub-agents currently running.
- `GeneratedImage.tsx`, `DocumentImage.tsx`, `documentImageSources.ts`, `LocalMedia.tsx`: images/media in replies.
- `UserLinkPreview.tsx`: link previews in user messages.
- `HistoryTurn.tsx`, `TranscriptPool.tsx`, `transcriptVisibility.ts`, `useMeasuredHistory.ts`: keep long or
  hidden transcripts mounted cheaply and measure older turns.
- `useReplyReflowAnchor.ts`: keeps the reader's place while a reply reflows.
- `TranscriptFind.tsx`: in-transcript search bar.
- `TranscriptJumpToBottom.tsx`: "jump to latest" button.
- `TranscriptSelectionMenu.tsx`: menu on selected transcript text (quote, copy).
- `PromptOutline.tsx`: outline of the user's prompts for quick jumps.
- `MessageQueue.tsx`: queued messages waiting to send while the agent works.
- `EmptySession.tsx`, `SessionsEmpty.tsx`, `DiscussionEmpty.tsx`: empty states.
- `Composer.tsx`: the composer; textarea, attachments, slash/@ commands, model/access pickers, send/stop.
- `ComposerRunner.tsx`: small mascot animation on the composer edge while a turn runs.
- `useComposerDockMotion.ts`: composer dock animation after the first send.
- `useComposerSkills.ts`: skill suggestions in the composer.
- `modeCommands.tsx`: slash-command modes and their colours.
- `ModelPicker.tsx` + `ModelPicker.css`: model and effort picker popover.
- `modelSource.ts`: where the model picker gets its list.
- `CustomModels.tsx`: "other models" section of the picker (add your own key).
- `AccessPicker.tsx`: permission / access-mode picker.
- `ContextMeter.tsx`: context-window ring meter.
- `McpServerPicker.tsx`: MCP server toggle picker.
- `AttachmentChip.tsx`: attachment chip in the composer and in sent messages.
- `FileMentionPicker.tsx`: `@file` mention picker.
- `HarnessIcon.tsx`: provider/agent icons.
- `SessionCardPreview.tsx`: hover preview of a session in the sidebar.
- `SessionFiltersMenu.tsx`: sidebar session filter menu.
- `SessionFolderPicker.tsx`: move a session into a folder.
- `sessionReminderPresets.ts`: reminder presets for a session.

Chat hooks (`src/features/sessions/hooks/`)

- `useBottomChatMotion.ts`: stick-to-bottom scrolling with a spring while replies stream.
- `useFileDrop.ts`: drag-and-drop files onto the pane to attach.
- `useTranscriptAnchor.ts`, `useTranscriptLayout.ts`: transcript layout preferences.
- `useTranscriptSelection.ts`: paragraph-aware text selection.

Chat view models (`src/features/sessions/model/`), the data shapes the UI renders

- `session.ts`: session, turn and transcript `Block` types.
- `transcriptActivity.ts`: groups tool calls into the folding work trail and step labels.
- `liveActivity.ts`: plain-words "what the agent is doing now".
- `transcriptTurnCache.ts`: reuses unchanged history between renders.
- `transcriptHighlights.ts`: find-in-transcript highlighting.
- `attachments.ts`: attachment types and helpers.
- `models.ts`: model catalogue, effort levels and labels.
- `contextUsage.ts`: context-window usage maths.
- `plan.ts`, `taskList.ts`, `userQuestion.ts`: plan, todo-list and question payloads.

Settings and platform

- `src/features/settings/model/appearance.ts`: theme, transcript layout and background preferences.
- `src/features/settings/ui/GradientBlurBackground.tsx`: blurred image background behind the chat.
- `src/features/quick-composer/ui/QuickModelSelector.css`: shared model-selector styles.
- `src/platform/tauri/useTrafficLightsVisible.ts`: room for macOS window buttons.

Shared UI (`src/shared/`)

- `ui/icons.tsx`: the icon set (Hugeicons, deep-imported).
- `ui/Popover.tsx` + `lib/popover.ts`: anchored popover and its placement maths.
- `ui/ConfirmDelete.tsx`: delete confirmation dialog.
- `ui/RevealHeight.tsx`: animated height reveal/collapse.
- `ui/Shimmer.tsx`: shimmering "working" text.
- `ui/TabLabel.tsx`: tab label that fades only when clipped.
- `hooks/useAnimatedReorder.ts`, `hooks/useSortable.ts`, `lib/drag.ts`: drag-to-reorder lists.
- `hooks/useDragResize.ts`: drag to resize a pane.
- `hooks/useLockOverscroll.ts`: stops scroll chaining.
- `hooks/useColorScheme.ts`: subscribe to light/dark changes.
- `lib/colorUtils.ts`: HSL helpers for the theme.
- `lib/layers.ts`: one z-index scale.
- `lib/layoutTransition.ts`: marks pane slides in progress.
- `lib/listWindow.ts`: first-paint size for progressive lists.
- `lib/numbers.ts`, `lib/keyboard.ts`, `lib/paths.ts`: formatting, key and path helpers.
- `lib/draftRestore.ts`: restores composer text after a paste.
- `lib/plainCommand.ts`: shows a shell command as plain words in a step row.
- `text/*.ts` (`allClear`, `askMarkers`, `countLine`, `engineLabelLine`, `noEmDash`, `noReply`, `toolRuleTalk`):
  small text clean-ups applied to agent replies before display.
