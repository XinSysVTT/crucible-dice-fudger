/**
 * Dice Fudger
 * Adds a GM-only "Fudge Roll" chat-message context option that lets the GM edit the individual
 * die results of an already-evaluated Roll stored on a ChatMessage, before that message is
 * revealed to the rest of the table.
 *
 * This does NOT re-roll anything and does NOT create a duplicate message. It edits the real
 * Roll data in place and saves it back to the message. Because Foundry (and Crucible) render
 * chat cards live from message.rolls on every render rather than from a frozen snapshot, the
 * corrected numbers simply appear the next time the card is rendered - including the moment you
 * use core Foundry's own "Reveal Message" option.
 *
 * Verified against the Crucible v0.10.1 system source (not just assumed):
 *  - StandardCheck.isSuccess/isCriticalSuccess/isFailure/isCriticalFailure all read `this.total`
 *    live on every access, so skill/save checks (and group checks, which reuse the same getters
 *    per-participant and recompute their aggregate from those getters on every render) pick up
 *    an edited total automatically - no extra step needed beyond fixing `roll._total`.
 *  - AttackRoll is the one case that does NOT work that way: its Hit/Miss/Dodge/etc. label and
 *    its damage total are cached on `roll.data.result` / `roll.data.damage` at the moment the
 *    attack was first resolved, not recomputed from `this.total` on render. Crucible's own code
 *    (module/hooks/talent.mjs, used by its "Loaded Dice" reroll talent) handles this by calling
 *    `roll.resolveDamage(actor, target)` again after mutating dice - so this module does the same
 *    thing for attack rolls, and only falls back to a bare total recompute for everything else.
 *  - For the bare recompute, Crucible's own code also revealed the right tool: Foundry's Roll
 *    class exposes `roll._evaluateTotal()`, its real internal totaling method (Crucible calls it
 *    directly in that same talent hook). That's used here instead of a hand-rolled +/- walker,
 *    so multiplication, parentheses, keep/drop, etc. in other systems' formulas are handled
 *    correctly too. A manual +/- fallback is kept only for the unlikely case of a Foundry version
 *    where that private method doesn't exist.
 */

const MODULE_ID = "dice-fudger";
let _pendingGroupCheckOutcome = null;
let _pendingGroupCheckParticipantCount = null;
let _riggedParticipantIndex = 0;
const _pendingGroupCheckMessages = new Map();

let _pendingSingleRollOutcome = null;
let _singleRollRiggingInstalled = false;

const OUTCOME_LABELS = {
  criticalSuccess: "Critical Success",
  success: "Success",
  failure: "Failure",
  criticalFailure: "Critical Failure"
};

/**
 * Install a permanent (idempotent) patch on Roll.prototype.evaluate that is a no-op unless a
 * single-roll fudge is currently armed via DiceFudger.armNextRoll(). Unlike _installRollRigging
 * (which wraps/unwraps evaluate for the duration of a single GroupCheck.configure() call), this
 * patch stays installed indefinitely - it just does nothing until _pendingSingleRollOutcome is
 * set, then consumes (clears) that state the moment it successfully intercepts a roll that looks
 * like a Crucible check (has a dc), regardless of whether the edit succeeded, so a bad roll never
 * leaves the module stuck silently rigging every future roll.
 */
function _installSingleRollRigging() {
  if (_singleRollRiggingInstalled) return;
  _singleRollRiggingInstalled = true;
  const originalEvaluate = Roll.prototype.evaluate;
  Roll.prototype.evaluate = async function(...args) {
    const result = await originalEvaluate.apply(this, args);
    if (!_pendingSingleRollOutcome) return result;
    try {
      const data = this.data ?? this.options?.data;
      const looksLikeCrucibleCheck = data && ("dc" in data || "dc" in (data.data ?? {}));
      if (!looksLikeCrucibleCheck) return result;
      const outcome = _pendingSingleRollOutcome;
      const targetTotal = _chooseGroupOutcomeTotal(this, outcome);
      if (targetTotal === null) return result;
      const currentTotal = _evaluateRollTotal(this);
      if (currentTotal !== targetTotal) {
        const edited = _assignDiceValuesToMatchTotal(this, targetTotal);
        if (!edited && this._total !== targetTotal) this._total = targetTotal;
        if (edited || typeof this.resolveDamage === "function") await _reresolveRoll(this);
      }
      console.debug("dice-fudger | rigged next single roll", {outcome, targetTotal, currentTotal});
    } catch (err) {
      console.warn("dice-fudger | failed to rig next single roll:", err);
    } finally {
      // Consume the arming after the first qualifying roll is *attempted*, success or not - a
      // roll that doesn't have `dc` (e.g. a damage roll) is skipped above without reaching here,
      // so this only fires (and disarms) on the actual check roll we were waiting for.
      _pendingSingleRollOutcome = null;
      _updateArmedIndicator();
    }
    return result;
  };
}

/**
 * Show (or remove) a small fixed on-screen indicator while a single-roll fudge is armed, so the
 * GM always has a visible reminder of what's queued and a one-click way to cancel it.
 */
function _updateArmedIndicator() {
  let el = document.getElementById("dice-fudger-armed-indicator");
  if (!_pendingSingleRollOutcome) {
    el?.remove();
    return;
  }
  if (!el) {
    el = document.createElement("div");
    el.id = "dice-fudger-armed-indicator";
    el.className = "dice-fudger-armed-indicator";
    el.addEventListener("click", () => {
      _pendingSingleRollOutcome = null;
      _updateArmedIndicator();
      ui.notifications.info("Dice Fudger: next-roll fudge cancelled.");
    });
    document.body.appendChild(el);
  }
  el.textContent = `🎲 Next roll forced: ${OUTCOME_LABELS[_pendingSingleRollOutcome] ?? _pendingSingleRollOutcome} (click to cancel)`;
}

/**
 * Decide the individual outcome bracket each participant roll in a group check should be forced
 * into so that Crucible's own aggregate formula (module/dice/group-check.mjs #computeAggregate)
 * lands on the GM's requested group-level outcome.
 *
 * Crucible scores each participant (+2 critical success, +1 success, 0 failure, -1 critical
 * failure) and classifies the total against `total` (participant count) and `required`
 * (floor(total/2)+1):
 *   critical success: score >= total
 *   success:          required <= score < total
 *   failure:          0 < score < required
 *   critical failure: score <= 0
 *
 * For criticalSuccess/criticalFailure, every participant landing in that same bracket already
 * produces the matching aggregate (those brackets sit at the extremes), so uniform assignment
 * works fine. For success/failure, uniformly forcing every participant into the SAME plain
 * bracket is exactly what causes the group card to read Critical Success/Critical Failure
 * instead: if all N participants plainly succeed, score == N == total, which trips the critical
 * success branch; if all plainly fail, score == 0, which trips critical failure. Giving
 * (total - 1) participants the requested bracket and exactly one the opposite plain bracket
 * lands the score solidly inside the requested non-critical range for total >= 3 (success) or
 * total >= 2 (failure).
 *
 * Below those sizes, a plain success/failure aggregate is mathematically unreachable under
 * Crucible's own formula regardless of what any module does (there's no integer score that
 * satisfies the inequality) - e.g. a single-participant check can only ever show as critical
 * either way. In that case this falls back to uniform assignment; the card will still read as
 * critical, which is the closest achievable result.
 * @param {string} outcome  "criticalSuccess"|"success"|"failure"|"criticalFailure"
 * @param {number} count    Number of participant rolls in this group check
 * @returns {string[]}      Per-participant outcome brackets, same length as count
 */
function _computeParticipantOutcomes(outcome, count) {
  if (!Number.isFinite(count) || count < 1) return [];
  if (outcome === "success" && count >= 3) {
    return Array(count).fill(outcome).map((o, i) => i === 0 ? "failure" : o);
  }
  if (outcome === "failure" && count >= 2) {
    return Array(count).fill(outcome).map((o, i) => i === 0 ? "success" : o);
  }
  return Array(count).fill(outcome);
}

/**
 * Temporarily patches Roll.prototype.evaluate so that any Crucible check roll (identified by
 * having a `dc` on its roll data - the same signature StandardCheck/GroupCheck participant rolls
 * carry) which evaluates while this is installed gets its dice corrected to land in the requested
 * outcome bracket immediately after it resolves, before Crucible does anything else with it (in
 * particular, before it builds any chat message). Returns a function that restores the original
 * evaluate method; always call it (in a finally block) once the check this was installed for is
 * done configuring, so unrelated rolls elsewhere aren't affected.
 */
function _installRollRigging(outcome) {
  const originalEvaluate = Roll.prototype.evaluate;
  Roll.prototype.evaluate = async function(...args) {
    const result = await originalEvaluate.apply(this, args);
    try {
      const data = this.data ?? this.options?.data;
      const looksLikeCrucibleCheck = data && ("dc" in data || "dc" in (data.data ?? {}));
      if (!looksLikeCrucibleCheck) return result;
      const participantOutcomes = _computeParticipantOutcomes(outcome, _pendingGroupCheckParticipantCount ?? 1);
      const participantIndex = _riggedParticipantIndex++;
      const rollOutcome = participantOutcomes[participantIndex] ?? outcome;
      const targetTotal = _chooseGroupOutcomeTotal(this, rollOutcome);
      if (targetTotal === null) return result;
      const currentTotal = _evaluateRollTotal(this);
      if (currentTotal === targetTotal) return result;
      const edited = _assignDiceValuesToMatchTotal(this, targetTotal);
      if (!edited && this._total !== targetTotal) this._total = targetTotal;
      if (edited || typeof this.resolveDamage === "function") await _reresolveRoll(this);
      console.debug("dice-fudger | rigged roll pre-message", {outcome, rollOutcome, participantIndex, targetTotal, currentTotal});
    } catch (err) {
      console.warn("dice-fudger | failed to rig roll during evaluate:", err);
    }
    return result;
  };
  return function restore() {
    Roll.prototype.evaluate = originalEvaluate;
  };
}

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "hideFromActiveModules", {
    name: "Hide from Active Modules",
    hint: "If enabled, this module will be hidden from the active modules list for non-GM users.",
    scope: "world",
    config: true,
    type: Boolean,
    default: false
  });
});

Hooks.once("ready", () => {
  if (game.user?.isGM) return;
  if (game.settings.get(MODULE_ID, "hideFromActiveModules")) {
    document.body.classList.add("dice-fudger-hide-active-module");
  }
});

Hooks.once("ready", async () => {
  if (!game.user?.isGM) return;
  const flagPath = `flags.${MODULE_ID}.isFudgeNextRollMacro`;
  const existing = game.macros.find(m => foundry.utils.getProperty(m, flagPath));
  if (existing) return;
  try {
    await Macro.create({
      name: "Fudge Next Roll",
      type: "script",
      img: "icons/svg/d20-black.svg",
      command: "DiceFudger.promptArmNextRoll();",
      // Explicit, rather than relying on the schema default: only the GM (and other GM accounts,
      // which always bypass ownership checks) can see or run this in the Macro Directory.
      ownership: {default: CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE},
      flags: {[MODULE_ID]: {isFudgeNextRollMacro: true}}
    });
    console.log("dice-fudger | created \"Fudge Next Roll\" macro in the Macro Directory - drag it onto your hotbar.");
  } catch (err) {
    console.warn("dice-fudger | failed to auto-create the Fudge Next Roll macro:", err);
  }
});

Hooks.once("ready", () => {
  const GroupCheck = _getGroupCheckClass();
  if (!GroupCheck || typeof GroupCheck.configure !== "function" || GroupCheck.configure._diceFudgerPatched) return;

  const originalConfigure = GroupCheck.configure;
  GroupCheck.configure = async function(options = {}) {
    const outcome = await DiceFudger.promptPreRollOutcome();
    if (!outcome) return originalConfigure.call(this, options);

    _pendingGroupCheckOutcome = outcome;
    console.debug("dice-fudger | pre-roll outcome armed:", outcome);

    // Rig dice as each participant's Roll evaluates, BEFORE Crucible ever builds the chat
    // message. This way Crucible renders the group-check card itself, from its own real
    // (already-correct) roll data, the normal way -- we never touch its private rendering
    // internals, so nothing needs correcting after the fact and players never see a "wrong"
    // result flash before a later fix.
    const restoreRigging = _installRollRigging(outcome);
    try {
      return await originalConfigure.call(this, options);
    } finally {
      restoreRigging();
      // createChatMessage/updateChatMessage below remain as a fallback in case some roll in
      // this check didn't go through Roll.prototype.evaluate (e.g. a pre-evaluated Roll was
      // reused) and so the rigging above missed it.
    }
  };
  GroupCheck.configure._diceFudgerPatched = true;

  // Capture the participant count as soon as it's known (requestSubmit receives
  // requestedActors before any query is dispatched or any roll is evaluated), so the pre-roll
  // rigging installed above can distribute outcomes across participants instead of forcing every
  // single one into the same bracket. See _computeParticipantOutcomes for why that distinction
  // matters for plain success/failure.
  if (typeof GroupCheck.prototype?.requestSubmit === "function" && !GroupCheck.prototype.requestSubmit._diceFudgerPatched) {
    const originalRequestSubmit = GroupCheck.prototype.requestSubmit;
    GroupCheck.prototype.requestSubmit = async function(options = {}) {
      if (_pendingGroupCheckOutcome) {
        const requested = options?.requestedActors;
        const count = requested?.size ?? requested?.length ?? (requested ? Array.from(requested).length : null);
        _pendingGroupCheckParticipantCount = Number.isFinite(count) ? count : null;
        _riggedParticipantIndex = 0;
        console.debug("dice-fudger | group check participant count captured", {count: _pendingGroupCheckParticipantCount});
      }
      return originalRequestSubmit.call(this, options);
    };
    GroupCheck.prototype.requestSubmit._diceFudgerPatched = true;
  }
});

Hooks.on("createChatMessage", async (message) => {
  if (!game.user.isGM) return;
  const outcome = _pendingGroupCheckOutcome;
  if (!outcome) return;
  console.debug("dice-fudger | createChatMessage saw pending outcome", {
    outcome, messageId: message.id, isGroupCheck: _isGroupCheckMessage(message), rollCount: message.rolls?.length
  });
  if (!_isGroupCheckMessage(message)) return;
  _pendingGroupCheckOutcome = null;

  // Some Crucible versions post the group-check message already fully resolved (rolls present
  // on creation), others post an empty placeholder and fill in `rolls` on a later update. Handle
  // both: if the rolls are already here, force the outcome now instead of queuing it to wait for
  // an update event that may never come.
  if (message.rolls?.length) {
    const success = await DiceFudger.forceGroupOutcome(message, outcome, {silent: true});
    if (success) return;
  }
  _pendingGroupCheckMessages.set(message.id, outcome);
});

Hooks.on("updateChatMessage", async (message) => {
  if (!game.user.isGM) return;
  const outcome = _pendingGroupCheckMessages.get(message.id);
  if (!outcome) return;
  console.debug("dice-fudger | updateChatMessage saw queued outcome", {
    outcome, messageId: message.id, isGroupCheck: _isGroupCheckMessage(message), rollCount: message.rolls?.length
  });
  if (!_isGroupCheckMessage(message)) return;
  if (!message.rolls?.length) return;
  const success = await DiceFudger.forceGroupOutcome(message, outcome, {silent: true});
  if (success) _pendingGroupCheckMessages.delete(message.id);
});

Hooks.on("getChatMessageContextOptions", (message, options) => {
  if (!game.user.isGM) return;

  options.push({
    label: "Fudge Roll",
    icon: '<i class="fas fa-dice-d20"></i>',
    visible: (li) => {
      const msg = _resolveMessage(li);
      return !!msg && _getEditableDice(msg).length > 0;
    },
    onClick: (_event, li) => {
      const msg = _resolveMessage(li);
      if (msg) DiceFudger.open(msg);
    }
  });

  options.push({
    label: "Force Group Outcome",
    icon: '<i class="fas fa-dice-d20"></i>',
    visible: (li) => {
      const msg = _resolveMessage(li);
      return !!msg && _isGroupCheckMessage(msg);
    },
    onClick: async (_event, li) => {
      const msg = _resolveMessage(li);
      if (!msg) return;
      const outcome = await new Promise((resolve) => {
        new Dialog({
          title: "Force Group Outcome",
          content: "<p>Select the desired group outcome.</p>",
          buttons: {
            criticalSuccess: {
              label: "Critical Success",
              callback: () => resolve("criticalSuccess")
            },
            success: {
              label: "Success",
              callback: () => resolve("success")
            },
            failure: {
              label: "Failure",
              callback: () => resolve("failure")
            },
            criticalFailure: {
              label: "Critical Failure",
              callback: () => resolve("criticalFailure")
            }
          },
          default: "success",
          close: () => resolve(null)
        }).render(true);
      });
      if (outcome) await DiceFudger.forceGroupOutcome(msg, outcome);
    }
  });
});

Hooks.on("renderChatMessage", (app, html) => {
  if (!game.user.isGM) return;
  if (!_isGroupCheckMessage(app.message)) return;
  _buildGroupOutcomeButtons(html, app.message);
});

/**
 * Support both the raw-element (v13/v14) and jQuery (legacy) context-menu calling conventions.
 * @param {HTMLElement|object} li
 * @returns {ChatMessage|null}
 */
function _resolveMessage(li) {
  const id = li?.dataset?.messageId ?? li?.data?.("messageId") ?? li?.[0]?.dataset?.messageId;
  return id ? game.messages.get(id) : null;
}

/**
 * Collect every editable die across every Roll on a message.
 * @param {ChatMessage} message
 * @returns {{roll: Roll, rollIndex: number, term: object, termIndex: number, dieIndex: number,
 *            faces: number, value: number}[]}
 */
function _getEditableDice(message) {
  const entries = [];
  const rolls = message.rolls ?? [];
  rolls.forEach((roll, rollIndex) => {
    if (!roll?._evaluated) return;
    roll.terms.forEach((term, termIndex) => {
      if (!(term instanceof foundry.dice.terms.DiceTerm)) return;
      term.results.forEach((r, dieIndex) => {
        if (r.discarded) return; // don't offer to edit discarded (e.g. dropped-lowest) dice
        entries.push({
          roll, rollIndex, term, termIndex, dieIndex,
          faces: term.faces, value: r.result
        });
      });
    });
  });
  return entries;
}

function _getEditableDiceFromRoll(roll) {
  const entries = [];
  if (!roll?._evaluated) return entries;
  roll.terms.forEach((term, termIndex) => {
    if (!(term instanceof foundry.dice.terms.DiceTerm)) return;
    term.results.forEach((r, dieIndex) => {
      if (r.discarded) return;
      entries.push({roll, term, termIndex, dieIndex, faces: term.faces, value: r.result});
    });
  });
  return entries;
}

function _evaluateRollTotal(roll) {
  if (typeof roll._evaluateTotal === "function") return roll._evaluateTotal();
  if (typeof roll.total === "number") return roll.total;
  return _recomputeTotalFallback(roll);
}

function _clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function _distributeSumAcrossDice(faces, targetSum) {
  const count = faces.length;
  const minSum = count;
  const maxSum = faces.reduce((sum, f) => sum + f, 0);
  targetSum = _clamp(targetSum, minSum, maxSum);

  const values = Array(count).fill(1);
  let remaining = targetSum - minSum;
  const order = Array.from({length: count}, (_, i) => i).sort(() => Math.random() - 0.5);
  for (const i of order) {
    const cap = faces[i] - 1;
    if (!cap) continue;
    const add = Math.floor(Math.random() * Math.min(cap, remaining + 1));
    values[i] += add;
    remaining -= add;
    if (!remaining) break;
  }
  for (let i = count - 1; i >= 0 && remaining > 0; i--) {
    const cap = faces[i] - values[i];
    const add = Math.min(cap, remaining);
    values[i] += add;
    remaining -= add;
  }
  return values;
}

function _buildGroupOutcomeButtons(html, message) {
  if (html.find(".dice-fudger-group-outcome-buttons").length) return;
  const buttonBar = $("<div class=\"dice-fudger-group-outcome-buttons flexrow\"></div>");
  const buttons = [
    {action: "criticalSuccess", label: "Force Group Critical Success"},
    {action: "success", label: "Force Group Success"},
    {action: "failure", label: "Force Group Failure"},
    {action: "criticalFailure", label: "Force Group Critical Failure"}
  ];
  for (const button of buttons) {
    buttonBar.append(
      $(`<button type="button" class="button">${button.label}</button>`).data("diceFudgerAction", button.action)
    );
  }
  buttonBar.on("click", "button", async (event) => {
    event.preventDefault();
    const action = $(event.currentTarget).data("diceFudgerAction");
    if (!action) return;
    await DiceFudger.forceGroupOutcome(message, action);
  });

  const content = html.find(".message-content").first();
  if (!content.length) return;
  content.addClass("dice-fudger-has-buttons");
  content.css({overflowY: "auto", maxHeight: "calc(100vh - 12rem)"});
  buttonBar.css({position: "sticky", bottom: 0, zIndex: 2, background: "rgba(0,0,0,0.95)", padding: "0.35rem 0"});
  content.append(buttonBar);
}

function _parseCheckMetadata(roll) {
  const data = roll.data ?? {};
  const nestedData = data.data ?? {};
  const dc = Number.isFinite(Number(data.dc))
    ? Number(data.dc)
    : Number.isFinite(Number(nestedData.dc))
      ? Number(nestedData.dc)
      : Number.isFinite(Number(roll.options?.dc))
        ? Number(roll.options.dc)
        : 15;
  const criticalSuccessThreshold = Number.isFinite(Number(data.criticalSuccessThreshold))
    ? Number(data.criticalSuccessThreshold)
    : Number.isFinite(Number(nestedData.criticalSuccessThreshold))
      ? Number(nestedData.criticalSuccessThreshold)
      : Number.isFinite(Number(data.critThreshold))
        ? Number(data.critThreshold)
        : Number.isFinite(Number(nestedData.critThreshold))
          ? Number(nestedData.critThreshold)
          : 6;
  const criticalFailureThreshold = Number.isFinite(Number(data.criticalFailureThreshold))
    ? Number(data.criticalFailureThreshold)
    : Number.isFinite(Number(nestedData.criticalFailureThreshold))
      ? Number(nestedData.criticalFailureThreshold)
      : Number.isFinite(Number(data.critFailureThreshold))
        ? Number(data.critFailureThreshold)
        : Number.isFinite(Number(nestedData.critFailureThreshold))
          ? Number(nestedData.critFailureThreshold)
          : 6; // Crucible's own default (standard-check.mjs `this.data.criticalFailureThreshold ?? 6`)
  return {dc, criticalSuccessThreshold, criticalFailureThreshold};
}

function _chooseGroupOutcomeTotal(roll, outcome) {
  const {dc, criticalSuccessThreshold, criticalFailureThreshold} = _parseCheckMetadata(roll);
  if (!Number.isFinite(dc) || !Number.isFinite(criticalSuccessThreshold) || !Number.isFinite(criticalFailureThreshold)) return null;
  const successMin = dc + 1;
  const criticalSuccessMin = dc + criticalSuccessThreshold;
  const successMax = Math.max(successMin, criticalSuccessMin - 1);
  const criticalSuccessMax = Math.max(criticalSuccessMin, criticalSuccessMin + 5);
  const failureMin = Math.max(-(2 ** 31), dc - (criticalFailureThreshold - 1));
  const failureMax = dc;
  const criticalFailureMax = Math.min(failureMax - 1, dc - criticalFailureThreshold - 1);
  const criticalFailureMin = Math.max(-(2 ** 31), criticalFailureMax - 5);

  switch (outcome) {
    case "criticalSuccess":
      return _randomInt(criticalSuccessMin, criticalSuccessMax);
    case "success":
      return _randomInt(successMin, successMax);
    case "failure":
      return _randomInt(failureMin, failureMax);
    case "criticalFailure":
      return _randomInt(criticalFailureMin, criticalFailureMax);
    default:
      return null;
  }
}

function _randomInt(min, max) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  if (max < min) max = min;
  if (min === max) return min;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function _getGroupCheckClass() {
  return globalThis.GroupCheck
    ?? window?.GroupCheck
    ?? globalThis.crucible?.api?.dice?.GroupCheck
    ?? window?.crucible?.api?.dice?.GroupCheck
    ?? null;
}

async function _renderGroupCheckContent(message) {
  if (!message?.rolls?.length) return null;
  const GroupCheck = _getGroupCheckClass();
  if (!GroupCheck || typeof GroupCheck.renderGroupCheckCard !== "function") return null;
  const rawFlags = {
    ...(message.data?.flags ?? {}),
    ...(message.flags ?? {})
  };
  // Crucible's renderGroupCheckCard expects the *inner* crucible-namespaced flag data
  // (message.flags.crucible), not the raw Foundry flags wrapper `{crucible: {...}}` itself.
  // Try the unwrapped shape first since that's what Crucible's own code expects; fall back to
  // the raw wrapper in case a different Crucible version expects the outer object instead.
  const flagCandidates = [rawFlags.crucible, rawFlags].filter(Boolean);
  const rollObjects = message.rolls ?? [];
  const rollJson = rollObjects.map((roll) => typeof roll.toJSON === "function" ? roll.toJSON() : roll);
  for (const flags of flagCandidates) {
  for (const rolls of [rollObjects, rollJson]) {
    try {
      const result = GroupCheck.renderGroupCheckCard(flags, rolls);
      const content = result instanceof Promise ? await result : result;
      if (typeof content === "string") return content;
      if (content?.outerHTML) return content.outerHTML;
      if (content?.html && typeof content.html === "function") {
        const html = content.html();
        if (typeof html === "string") return html;
      }
      if (content instanceof DocumentFragment) {
        const wrapper = document.createElement("div");
        wrapper.appendChild(content.cloneNode(true));
        return wrapper.innerHTML;
      }
      if (Array.isArray(content) && content.length) {
        const wrapper = document.createElement("div");
        content.forEach((item) => {
          if (item?.outerHTML) wrapper.appendChild(item.cloneNode(true));
          else if (item?.html && typeof item.html === "function") {
            const temp = document.createElement("div");
            temp.innerHTML = item.html();
            wrapper.append(...Array.from(temp.children));
          }
        });
        return wrapper.innerHTML || null;
      }
      console.warn("dice-fudger | renderGroupCheckCard returned unknown content type:", content);
    } catch (err) {
      console.warn("dice-fudger | renderGroupCheckCard attempt failed:", err);
    }
  }
  }
  return null;
}

function _isGroupCheckMessage(message) {
  if (!message || !Array.isArray(message.rolls) || message.rolls.length <= 1) return false;
  const content = String(message.data?.content ?? message.content ?? "");
  if (/group[- ]check|groupcheck|group-check/i.test(content)) return true;
  const flags = message.data?.flags ?? message.flags ?? {};
  if (flags && typeof flags === "object") {
    const flagsText = JSON.stringify(flags);
    if (/group[- ]check|groupcheck|group-check/i.test(flagsText)) return true;
  }
  return false;
}

function _assignDiceValuesToMatchTotal(roll, targetTotal) {
  const entries = _getEditableDiceFromRoll(roll);
  if (!entries.length) return false;
  const currentTotal = _evaluateRollTotal(roll);
  const currentDiceTotal = entries.reduce((sum, e) => sum + Number(e.value), 0);
  const fixedTotal = currentTotal - currentDiceTotal;
  const targetDiceTotal = targetTotal - fixedTotal;
  const faces = entries.map((e) => e.faces);
  const values = _distributeSumAcrossDice(faces, targetDiceTotal);
  values.forEach((value, index) => {
    const entry = entries[index];
    entry.term.results[entry.dieIndex].result = value;
  });
  if (typeof roll._evaluateTotal === "function") {
    roll._total = roll._evaluateTotal();
  } else {
    _recomputeTotalFallback(roll);
  }
  if (roll.data && typeof roll.data === "object") {
    roll.data.total = roll._total;
    if ("result" in roll.data) roll.data.result = roll._total;
  }
  return true;
}

/**
 * Fallback total recompute for the rare case where a Foundry build doesn't expose the internal
 * `_evaluateTotal()` method. Walks terms left-to-right applying +/- OperatorTerms only.
 * @param {Roll} roll
 * @returns {number} the recomputed total
 */
function _recomputeTotalFallback(roll) {
  let total = 0;
  let sign = 1;
  for (const term of roll.terms) {
    if (term instanceof foundry.dice.terms.OperatorTerm) {
      sign = term.operator === "-" ? -1 : 1;
      continue;
    }
    const t = Number(term.total);
    total += sign * (Number.isFinite(t) ? t : 0);
    sign = 1;
  }
  roll._total = total;
  return total;
}

/**
 * Re-resolve a Roll after its underlying dice results have been edited, so every cached field
 * that depends on the dice (not just `roll.total`) is brought back in sync.
 *
 * - If the roll is (or behaves like) a Crucible AttackRoll - i.e. it exposes `resolveDamage()` -
 *   its hit/miss result and damage total were cached at initial resolution and won't update from
 *   a bare total fix. Re-run `resolveDamage(actor, target)` with no config so it reuses the
 *   damage configuration already stored on the roll, mirroring what Crucible's own "Loaded Dice"
 *   reroll talent does internally.
 * - Otherwise, just fix the cached total, preferring Foundry's own `_evaluateTotal()` (handles
 *   any formula, not just +/-) and falling back to a manual walk only if that method is absent.
 * @param {Roll} roll
 * @returns {Promise<void>}
 */
async function _reresolveRoll(roll) {
  if (typeof roll.resolveDamage === "function") {
    const actor = roll.actor ?? (roll.data?.actorId ? game.actors.get(roll.data.actorId) : null);
    const target = roll.data?.target ? fromUuidSync(roll.data.target) : null;
    if (actor && target) {
      try {
        roll.resolveDamage(actor, target);
        return;
      } catch (err) {
        console.warn("dice-fudger | resolveDamage() failed, falling back to a bare total recompute:", err);
      }
    } else {
      console.warn("dice-fudger | Attack roll has no resolvable actor/target - only the total was fixed. " +
        "The Hit/Miss badge and damage total on this card may not reflect the edit.");
    }
  }
  if (typeof roll._evaluateTotal === "function") roll._total = roll._evaluateTotal();
  else _recomputeTotalFallback(roll);
}

class DiceFudger {
  /**
   * Arm the next qualifying roll (any Roll with a `dc` in its data - skill checks, saves,
   * attack rolls, etc.) to be forced into the given outcome bracket, whenever it next happens.
   * Callable directly from a macro, e.g. `DiceFudger.armNextRoll("success")`.
   * @param {"criticalSuccess"|"success"|"failure"|"criticalFailure"} outcome
   */
  static armNextRoll(outcome) {
    if (!game.user?.isGM) {
      ui.notifications.warn("Only the GM can fudge rolls.");
      return;
    }
    if (!(outcome in OUTCOME_LABELS)) {
      ui.notifications.error(`dice-fudger | Unknown outcome "${outcome}". Use one of: ${Object.keys(OUTCOME_LABELS).join(", ")}.`);
      return;
    }
    _installSingleRollRigging();
    _pendingSingleRollOutcome = outcome;
    _updateArmedIndicator();
    ui.notifications.info(`Dice Fudger: next roll will be forced to ${OUTCOME_LABELS[outcome]}.`);
  }

  /**
   * Open a small dialog to pick the outcome for the next roll, or cancel an already-armed fudge.
   * This is what the auto-created "Fudge Next Roll" macro calls.
   * @returns {Promise<void>}
   */
  static async promptArmNextRoll() {
    if (!game.user?.isGM) {
      ui.notifications.warn("Only the GM can fudge rolls.");
      return;
    }
    const outcome = await new Promise((resolve) => {
      new Dialog({
        title: "Fudge Next Roll",
        content: "<p>Force the next qualifying roll (skill check, save, attack, etc.) to a specific outcome.</p>",
        buttons: {
          criticalSuccess: {label: "Critical Success", callback: () => resolve("criticalSuccess")},
          success: {label: "Success", callback: () => resolve("success")},
          failure: {label: "Failure", callback: () => resolve("failure")},
          criticalFailure: {label: "Critical Failure", callback: () => resolve("criticalFailure")},
          cancel: {label: "Cancel Armed Fudge", callback: () => resolve("__cancel__")}
        },
        default: "success",
        close: () => resolve(null)
      }).render(true);
    });
    if (outcome === "__cancel__") {
      _pendingSingleRollOutcome = null;
      _updateArmedIndicator();
      ui.notifications.info("Dice Fudger: next-roll fudge cancelled.");
      return;
    }
    if (outcome) DiceFudger.armNextRoll(outcome);
  }

  static async promptPreRollOutcome() {
    return new Promise((resolve) => {
      new Dialog({
        title: "Force Group Check Outcome",
        content: "<p>Apply a forced outcome to the next group check you configure?</p>",
        buttons: {
          criticalSuccess: {
            label: "Critical Success",
            callback: () => resolve("criticalSuccess")
          },
          success: {
            label: "Success",
            callback: () => resolve("success")
          },
          failure: {
            label: "Failure",
            callback: () => resolve("failure")
          },
          criticalFailure: {
            label: "Critical Failure",
            callback: () => resolve("criticalFailure")
          },
          none: {
            label: "None",
            callback: () => resolve(null)
          }
        },
        default: "none",
        close: () => resolve(null)
      }).render(true);
    });
  }

  /**
   * Open the fudge dialog for a chat message.
   * @param {ChatMessage} message
   */
  static async open(message) {
    const dice = _getEditableDice(message);
    if (!dice.length) {
      ui.notifications.warn("This message has no editable dice.");
      return;
    }

    const {NumberField} = foundry.data.fields;
    const content = document.createElement("div");
    content.innerHTML = `<p style="margin-bottom:0.5em;">
      Edit any die below, then Save. Nothing is re-rolled - you're directly setting the face
      value. The message stays hidden until you use Foundry's own "Reveal Message" option.
    </p>`;

    dice.forEach((d, i) => {
      const field = new NumberField({
        label: `Roll ${d.rollIndex + 1} - die d${d.faces} (currently ${d.value})`,
        min: 1, max: d.faces, step: 1, integer: true, required: true
      });
      field.name = `die${i}`;
      content.append(field.toFormGroup({classes: ["slim"]}, {value: d.value, autofocus: i === 0}));
    });

    let formData;
    try {
      formData = await foundry.applications.api.DialogV2.input({
        window: {title: `Fudge Roll - ${message.speaker?.alias ?? "Chat Message"}`},
        content,
        ok: {label: "Save"}
      });
    } catch (err) {
      return; // cancelled
    }
    if (!formData) return;

    const touchedRolls = new Set();
    dice.forEach((d, i) => {
      const raw = formData[`die${i}`];
      const value = _clamp(Math.round(Number(raw)), 1, d.faces);
      if (value === d.value) return;
      d.term.results[d.dieIndex].result = value;
      touchedRolls.add(d.roll);
    });

    if (!touchedRolls.size) return; // nothing changed

    for (const roll of touchedRolls) await _reresolveRoll(roll);

    await message.update({rolls: message.rolls.map((roll) => typeof roll.toJSON === "function" ? roll.toJSON() : roll)}, {diff: false});
    ui.notifications.info("Roll fudged. Use Foundry's \"Reveal Message\" option when you're ready to show it.");
  }

  static async forceGroupOutcome(message, outcome, {silent = false} = {}) {
    console.debug("dice-fudger | forceGroupOutcome called", {messageId: message.id, outcome, rollCount: message.rolls?.length});
    const rolls = message.rolls ?? [];
    if (!rolls.length) {
      if (!silent) ui.notifications.warn("No participant rolls found for this message.");
      return false;
    }

    if (((outcome === "success") && (rolls.length < 3)) || ((outcome === "failure") && (rolls.length < 2))) {
      console.warn(`dice-fudger | a plain "${outcome}" aggregate isn't reachable with only ${rolls.length} participant(s) under Crucible's own aggregate formula - the group card will read as critical instead, which is the closest achievable result.`);
    }
    const participantOutcomes = _computeParticipantOutcomes(outcome, rolls.length);
    const changedRolls = new Set();
    const rollsNeedingReresolve = new Set();
    rolls.forEach((roll, i) => {
      const rollOutcome = participantOutcomes[i] ?? outcome;
      const targetTotal = _chooseGroupOutcomeTotal(roll, rollOutcome);
      if (targetTotal === null) return;
      const currentTotal = _evaluateRollTotal(roll);
      console.debug("dice-fudger | group outcome", {outcome, rollOutcome, targetTotal, currentTotal, roll});
      if (currentTotal === targetTotal) return;
      const edited = _assignDiceValuesToMatchTotal(roll, targetTotal);
      if (!edited && roll._total !== targetTotal) {
        roll._total = targetTotal;
      }
      changedRolls.add(roll);
      if (edited || typeof roll.resolveDamage === "function") {
        rollsNeedingReresolve.add(roll);
      }
    });

    if (!changedRolls.size) {
      if (!silent) ui.notifications.info("Group outcome was already at the requested result.");
      return true;
    }

    for (const roll of rollsNeedingReresolve) {
      await _reresolveRoll(roll);
    }

    const updateData = {
      rolls: message.rolls.map((roll) => typeof roll.toJSON === "function" ? roll.toJSON() : roll)
    };
    let content = null;
    try {
      content = await _renderGroupCheckContent(message);
    } catch (err) {
      console.warn("dice-fudger | failed to render group check content, updating rolls only:", err);
    }
    if (typeof content === "string") updateData.content = content;
    await message.update(updateData, {diff: false});

    const label = {
      criticalSuccess: "Critical Success",
      success: "Success",
      failure: "Failure",
      criticalFailure: "Critical Failure"
    }[outcome] ?? "Outcome";
    ui.notifications.info(`Forced group outcome: ${label}.`);
  }
}

globalThis.DiceFudger = DiceFudger;
