# Dice Fudger

Dice Fudger is a Foundry VTT module for the Crucible system that lets the GM edit or force the results of already-rolled, not-yet-revealed dice messages.

## What it does

- Adds a GM-only chat message context option called **Fudge Roll**.
- Allows editing the face value of individual dice in an evaluated roll before the message is revealed.
- Works with Foundry's built-in **Blind GM Roll** + **Reveal Message** workflow.
- Adds group-check outcome controls for Crucible group check messages.
- Includes a macro to force the next qualifying roll into a specific outcome.

## Compatibility

- Verified for Crucible system version 0.10.2, on Foundry VTT 14 (build 367).
- Declared compatibility with Foundry VTT 14.

## Changelog

### 0.0.9
- Changed: the GM-whispered "Dice Fudger" chat note now only appears when an armed fudge could NOT
  be applied (or was clamped/errored) - i.e. when the GM needs to know something. Successful
  auto-applications to player-made rolls are silent apart from the usual toast notification.

### 0.0.8
- Fixed: the foreign-roll detection posted nothing and never consumed an armed fudge, because it
  identified the message author via `message.user` - a field Foundry v13+ renamed to `author`
  (message.user no longer exists, so every incoming message looked like the GM's own and was
  skipped). This made the 0.0.6/0.0.7 "apply or explain" behavior for player-made rolls completely
  inert. Now reads `message.author` (with fallbacks for older Foundry versions), so an armed
  "Fudge Next Roll" fudge is correctly applied to - or explained for - rolls made by other users.
- The GM-whispered Dice Fudger notes no longer pass the removed `user` create-data key (the author
  field defaults to the creating user).

### 0.0.7
- Fixed: a "Fudge Next Roll" fudge never did anything for rolls made by players on their own
  clients. This is architectural - the roll interception only runs on the GM's client, and a
  player's roll is evaluated and posted by their own client before the GM ever sees it. Two changes
  address it:
  - New **Auto-Apply Armed Next-Roll Fudges to Player-Made Rolls** setting (on by default): when a
    qualifying roll arrives from another user while a fudge is armed, the fudge is applied
    automatically if it can still be done before the outcome matters - an unconfirmed action card
    (edited before you click Confirm) or a blind/whispered roll players can't see yet. Otherwise a
    private GM-whispered note explains why it wasn't possible and what your options are.
  - The module now posts a private GM-whispered chat note in every case (applied or not), so the
    armed fudge is never silently consumed without a trace. Debug logging
    (`dice-fudger | armed next-roll fudge saw a foreign chat message`) also lands in the console
    for every message seen while a fudge is armed, to make failures diagnosable.
- Attack rolls are now explicitly recognized as fudgeable (via their `resolveDamage` signature in
  addition to the `dc` check), so an armed fudge also covers attack rolls made on the GM's client.

### 0.0.6
- Added: when a macro-armed "Fudge Next Roll" fudge cannot be applied, the module now posts a
  private chat message whispered to every GM user (players never see it) explaining exactly why,
  instead of relying only on transient toast notifications. Covered reasons: the roll has no
  usable DC/threshold data; the dice physically can't reach the total the requested outcome needs
  (the closest achievable total is applied, and the note says what the roll now reads as); an
  unexpected error while editing the dice; and the qualifying roll having been made by another
  user on their own client, which the GM-side roll interception can never see - in that case the
  armed fudge is cleared, and for blind/whispered rolls the note points the GM at the manual
  "Fudge Roll" context-menu option as a still-silent fallback.

### 0.0.5
- Fixed: forcing/fudging a group check outcome updated the underlying roll data correctly but no
  longer visibly updated the group check chat card. Crucible 0.10.2 nests the actual group check
  flag data (`.actors`, `.aggregate`, etc.) one level deeper than before, under
  `flags.crucible[GroupCheck.FLAG_KEY]` rather than `flags.crucible` directly - the module was
  passing the wrong (too-shallow) object into Crucible's own card renderer, which failed silently.

## Installation

1. Copy the module folder into your Foundry `modules` directory.
2. In Foundry, enable the module in your world configuration.
3. If enabled, the module may create a macro named **Fudge Next Roll** in the Macro Directory for easy access.

## Usage

### Fudge an existing roll

1. As GM, find the hidden chat message containing a roll.
2. Open the chat message context menu.
3. Choose **Fudge Roll**.
4. Edit individual dice values and save.
5. Use Foundry's **Reveal Message** when ready.

### Force a group check outcome

1. As GM, use the **Force Group Outcome** option from the chat message context menu on a Crucible group check.
2. Choose one of:
   - Critical Success
   - Success
   - Failure
   - Critical Failure
3. The module updates the stored roll totals and re-renders the group check message.

### Forge the next roll

- Use the **Fudge Next Roll** macro to arm the next qualifying roll (skill check, save, attack roll, etc.) for a forced outcome.
- The module displays an on-screen indicator while the next roll is armed.
- Click the indicator to cancel the armed fudge.
- Rolls made on the GM's client (NPCs, group checks, rolls you make for players) are fudged directly as they happen. Rolls made by players on their own clients can't be intercepted at roll time - depending on the **Auto-Apply Armed Next-Roll Fudges** setting, the fudge is instead applied automatically to the player's message while it's still unconfirmed/hidden (toast notification only), or a private message whispered to the GM explains why it couldn't be applied and what your options are. Players never see these notes.

## Notes

- This module does not re-roll results; it directly edits the dice values stored in the existing roll.
- It preserves Crucible behavior by updating roll totals and re-resolving affected cached results when needed.
- When the **Hide from Active Modules** setting is enabled, the module removes its own entry from the Manage/View Modules list for non-GM users. Note that Foundry lets any player open a read-only version of that list (it's not GM-only), which is exactly why this setting exists - but it's a UI-level hide only: it doesn't prevent a technically inclined player from seeing the module is installed via the browser console (`game.modules`) or via network requests for its files. There is no way to make an active Foundry module fully invisible to connected clients.

- 

<a href="https://buymeacoffee.com/xinsys">
  <img
    src="https://github.com/user-attachments/assets/5c4ef9f4-f6a3-457e-a8d4-34399d545f11"
    alt="Buy Me a Coffee"
    width="90"
  />
</a>
