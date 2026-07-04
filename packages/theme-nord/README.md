# @nanobpm/nano-ide-theme-nord

Nord theme pack for the Nano RAD console — an arctic, north-bluish colour
palette (https://www.nordtheme.com), as two themes:

- **Nord Dark** — Polar Night surfaces with Frost accents.
- **Nord Light** — Snow Storm surfaces with the same Frost accents.

Install from the console's **Extensions** marketplace (or
`npm install` it into `<workspace>/extensions/`), then pick the theme under
**Config → Appearance** or apply it straight from the Extensions view.

A theme pack is pure data: the `nano-ide.ext.json` manifest maps the console's
design-token vocabulary (`app`, `panel`, `accent`, …) to CSS colours. No code
runs, no toolchain is required, and no trust approval is needed.
