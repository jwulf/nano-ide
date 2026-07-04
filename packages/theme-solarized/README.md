# @nanobpm/nano-ide-theme-solarized

Solarized theme pack for the Nano RAD console — Ethan Schoonover's
sixteen-colour precision palette (https://ethanschoonover.com/solarized), as
two themes:

- **Solarized Dark** — base03/base02 surfaces, blue accent.
- **Solarized Light** — base3/base2 surfaces, the same accents.

Install from the console's **Extensions** marketplace (or
`npm install` it into `<workspace>/extensions/`), then pick the theme under
**Config → Appearance** or apply it straight from the Extensions view.

A theme pack is pure data: the `nano-ide.ext.json` manifest maps the console's
design-token vocabulary (`app`, `panel`, `accent`, …) to CSS colours. No code
runs, no toolchain is required, and no trust approval is needed.
