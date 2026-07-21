---

<div align="center">

<h3>☕ Support the Project</h3>

<p>If you want to support this project, you can do so here.</p>

<p><sub>Every coffee helps keep the project maintained and motivates future updates!</sub></p>

<a href="https://buymeacoffee.com/xinsys">
  <img
    src="https://github.com/user-attachments/assets/5c4ef9f4-f6a3-457e-a8d4-34399d545f11"
    alt="Buy Me a Coffee"
    width="180"
  />
</a>

</div>

---

# Dice Fudger

Dice Fudger is a Foundry VTT module for the Crucible system that lets the GM edit or force the results of already-rolled, not-yet-revealed dice messages.

## What it does

- Adds a GM-only chat message context option called **Fudge Roll**.
- Allows editing the face value of individual dice in an evaluated roll before the message is revealed.
- Works with Foundry's built-in **Blind GM Roll** + **Reveal Message** workflow.
- Adds group-check outcome controls for Crucible group check messages.
- Includes a macro to force the next qualifying roll into a specific outcome.

## Compatibility

- Verified for Foundry-compatible Crucible system version 0.10.1.
- Declared compatibility with Foundry VTT 14.

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

## Notes

- This module does not re-roll results; it directly edits the dice values stored in the existing roll.
- It preserves Crucible behavior by updating roll totals and re-resolving affected cached results when needed.
- The module hides itself from non-GM users when the **Hide from Active Modules** setting is enabled.