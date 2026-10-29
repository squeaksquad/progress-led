# progress-led

A Claude Code mod that draws an LED-style progress bar above the prompt.

- **Task list.** Follows the task list the desktop app keeps for a turn: `x/y tasks, z%` as a segmented
  LED bar, the step in progress, and the last completions stamped with your local time. Click the count
  to expand the full list.
- **Timed jobs.** Shell commands that say how long they run (`--seconds N`, `--duration N`, `soak N`,
  `sleep N`, `timeout N`) get a live bar of their own once they have run 3 s. Quick commands stay out of
  the way; more than three running jobs collapse to `+N more`.
- **A tool for Claude.** `progress` lets Claude put up a bar for any long job, by time (`seconds`) or by
  count (`done` / `total`), and mark it finished.

The desktop app draws the bar as SVG LEDs; the terminal draws it with `▮` / `▯`.

Needs a recent Claude Code (a build that loads hooks modules; 2.1.309 works).

## Install

At the prompt of a terminal session:

```
/plugin install progress-led --marketplace squeaksquad/progress-led
```

From a shell:

```bash
claude plugin install progress-led --marketplace squeaksquad/progress-led
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add
marketplace with `squeaksquad/progress-led`, then Add plugin.

## Develop

```bash
claude plugin validate .
claude plugin test .
```

## License

MIT
