# Visual Loop (eyes)

## Capture

Capture the real terminal UI with whatever screenshot route the project already has (a snapshot script, a terminal recorder, or a manual screenshot saved as PNG). Do not install tools for this guidance. Read the PNGs with the image-capable read tool.

- Capture at the sizes that matter: wide (180x50), just below the main breakpoint (about 140 columns), and narrow (80x24).
- Never type prompts into a captured shell that inherits the user's permission mode.
- Remove any scratch directories the capture route created when done.
- If no capture route exists, say so and report observations from code as unverified instead of implying a visual inspection happened.

## Loop

1. Capture "before" at the sizes that matter; name files by size and step.
2. Write the critique or brief before editing.
3. Edit, re-capture, read both PNGs, and compare against the brief point by point.
4. Stop after 3 rounds or when no P0-P2 remains; report what is left.
5. Pair visual checks with the repo's focused render tests (render counts, overflow, breakpoints).

## Mockups first

For redesigns, draw directions with any mockup tool before code. Constrain artboards to the terminal: a fixed monospace grid in `ch` units at the real column count, theme colors only, no font sizes or radii, glyphs from the DESIGN.md family. Then match the implementation screenshot to the chosen artboard.
