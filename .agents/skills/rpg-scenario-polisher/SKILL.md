---
name: rpg-scenario-polisher
description: Use this skill when writing, reviewing, expanding, or implementing Japanese JRPG scenario text, NPC dialogue, event scripts, ruins, books, foreshadowing, character voice, or story flags for PRISMA ABYSS. Do not use for unrelated code-only refactors.
---

# RPG Scenario Polisher for PRISMA ABYSS

## Purpose

Make PRISMA ABYSS feel like an authored large-scale JRPG, not generic AI fantasy text.

This skill is used for:

- main story scenes
- NPC dialogue
- town dialogue
- dungeon events
- ruins, books, inscriptions, legends
- party banter
- conditional dialogue based on flags, story step, and party state
- foreshadowing and misdirection
- converting Markdown scenario drafts into `story.js`
- reviewing existing implemented dialogue without blindly canonizing or rewriting it

## Mandatory process

Before writing or editing:

1. Read the current scenario source files in `docs/scenario/` if they exist.
2. Read the relevant files under `docs/story-bible/`.
3. Check `story.js`, `story_logic.js`, `map.js`, and `maps_logic.js` for event structure.
4. Identify current story point, party state, known facts, hidden facts, and flags.
5. Draft or revise Markdown first unless the user explicitly asks for direct implementation.
6. If existing dialogue is suspicious, use the review queue instead of immediate replacement.

## Legacy dialogue handling

Existing implemented dialogue is **legacy implemented source text**.

It has weight because it exists in the game, but it is not automatically final canon.
It may contain old ideas, implementation shortcuts, AI-like exposition, spoilers, long lines, or voice drift.

Therefore:

- Do not delete or replace it automatically.
- Do not bless it as final canon automatically.
- Do not hide its problems.
- Do not silently rewrite it in `story.js`.
- Do not merge a rewritten line into the master script as canon without approval.

When a concern is found, create or update an entry in `docs/scenario/07_DIALOGUE_REVIEW_QUEUE.md`.

Each entry must include:

- review ID
- status
- target file
- script key or event ID
- story timing
- speaker
- current text
- concern
- why it matters
- option A: keep current
- option B: light revision
- option C: larger rewrite
- Codex recommendation
- implementation impact
- user decision field

Status values:

- `pending`: user has not decided
- `approved_keep`: keep current as approved canon
- `approved_light`: use light revision
- `approved_rewrite`: use larger rewrite
- `rejected`: do not use the proposal
- `later`: revisit later
- `implemented`: approved change has been reflected into runtime files

Only `approved_*` entries may be implemented.

## Dialogue hard rules

- Do not apply a fixed character-count limit to dialogue.
- Judge each displayed line by on-screen readability, natural breathing, information density, and character voice.
- Split long thoughts only when the split improves rhythm or comprehension, not to satisfy a numeric threshold.
- Consecutive lines by the same speaker are allowed.
- Never let all characters share the same sentence rhythm.
- Never use NPCs only to deliver hints.
- Never explain the full truth through a book, ruin, or villager.
- Never reveal hidden truth before the correct story point.
- Rumors and wrong guesses are allowed when grounded in the speaker's life.
- Character bias is useful. Authorial convenience is not.

## Character voice method

For every named character in a scene, define before writing:

- first person
- second person
- sentence endings
- default emotional temperature
- what they avoid saying
- what they say when angry
- what they say when afraid
- one concrete habit or gesture
- what they misunderstand at this point
- what fact they must not know yet

Do not merely list these traits in the final scene. Use them to shape the lines.

## NPC method

For each town or settlement, create NPCs from local life:

- work
- family
- fear
- routine
- superstition
- food
- trade
- tools
- gossip
- weather
- local phrase
- private worry

Only some NPCs should give useful hints.
At least half of ordinary town NPC dialogue should make the world feel lived in rather than directly advancing the plot.

## Ruins, books, and inscriptions

Ruins, inscriptions, and books should be incomplete.

Use:

- missing characters
- cracked stone
- soot
- water damage
- copied mistakes
- mistranslation
- priestly censorship
- contradictory editions
- local children misreading old words
- scholars arguing over one phrase

They may suggest truth, but should not fully explain it.

## Foreshadowing

Foreshadowing must be logged in `docs/scenario/03_FORESHADOWING_LEDGER.md`.

For each clue, record:

- clue text
- location
- speaker or object
- visible meaning now
- hidden meaning later
- reveal timing
- risk of being too obvious
- whether it is a true clue, false clue, or emotional misread

Use fewer, sharper clues.
Do not stuff every scene with lore.

## Misdirection

Misdirection should come from character emotion and partial knowledge.

Allowed examples:

- Xiao blaming Demon Castle because of Shanny.
- Villagers fearing Demon King Zenon because history taught them to.
- Kingdom soldiers believing sacrifice is salvation.
- Priests using “light” language to hide coercion.
- Demon Castle residents speaking harshly while keeping promises.

Do not lie in neutral narrator text unless the narrator is explicitly unreliable.

## Markdown scenario output format

Use this structure for each scene or area:

- Area
- Story timing
- Required flags
- Party assumptions
- Known facts
- Hidden facts not to reveal
- Scene purpose
- Current implemented lines, if any
- Draft dialogue script
- Conditional variants
- NPC life dialogue
- Foreshadowing notes
- Existing dialogue review entries required
- Implementation notes

## Review checklist

Before finalizing, score the scene from 1 to 5:

- Character voice separation
- Lived-in world detail
- Spoiler discipline
- Subtle foreshadowing
- Lack of exposition dump
- On-screen readability and dialogue rhythm
- Emotional specificity
- Implementation readiness
- Approval status clarity

If any score is 2 or below, revise before implementation.
