# Working in this repo

`README.md` has the code map and the environment variables. Read it first; don't
duplicate it here.

## Commits

End every commit message with:

```
Co-Authored-By: kamicut <marcfarra@gmail.com>
```

Keep any assistant co-author trailer below that one.

## Architecture constraints

- **There is no client runtime.** `views.tsx` components run once, on the server,
  and render to a string. No state, no hooks, no event handler props. Interactivity
  comes from htmx attributes, from small scripts in `public/`, or from a hydrated
  island if a subtree ever truly needs client state. Reach for a framework only
  after saying out loud why htmx can't do it.
- **The round page is a single-screen dashboard.** `--h` in `public/style.css` sizes
  the boards so two rows of four fit the viewport, minus a hand-tuned chrome
  allowance. Anything added above the grid eats board height, so adjust that
  allowance in the same change and say what you traded.
- **Lichess is rate-limited.** Fetches are cached and paced in `lichess.ts`. Don't
  add a fetch to a render path.

## Style

- Comments explain why a thing is the way it is, not what the line does. The
  existing ones are the reference.
- Prefer deleting code to adding a flag.

## Before pushing

Run `bun test`. For anything visual, look at the page at both desktop and phone
widths rather than assuming, since the two layouts diverge at the 900px breakpoint.
Lichess is unreachable from sandboxes, so stand the boards in when checking layout.
