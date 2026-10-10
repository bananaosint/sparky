---
name: ui-taste
description: Use for any user-facing UI work (pages, components, layouts, styling) to avoid the generic template look. Rules for type, space, color, copy and states, and a screenshot check before calling it done.
---

# UI taste

Follow these rules for anything a person will see. Where the project already has a design system, its tokens and components win; apply these rules inside it.

## Type
- One font family. At most 2 weights in a view.
- Sizes from a modular scale (for example 1.25). Body text 15–16 px.
- Line length 60–75 characters.
- `font-variant-numeric: tabular-nums` for figures that line up (tables, prices, counters).

## Space
- A 4/8 px scale only.
- More space between groups than within them, so grouping reads without borders.
- No evenly spaced grid of identical cards by default. Size things by importance.

## Color
- Neutrals plus one accent.
- Body text contrast at least 4.5:1.
- Dark mode from tokens, never inverted colors.

## No template look
- No gradient hero with three feature cards.
- No emoji bullets.
- No stock copy ("Get started", "Unlock the power of…"). Copy names the user's actual nouns.
- No glassmorphism unless asked.

## States
Design the empty, loading, error and long-content cases. Don't leave them as defaults.

## Check before done
Take screenshots at 375 px and 1440 px (the Playwright plugin can do it) and look at them. Fix overflow, cramped spacing and broken wrapping before calling the work done.
