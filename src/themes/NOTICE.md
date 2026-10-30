# Bundled theme attribution

The Ghostty theme files in `ghostty/` are unmodified copies from
iTerm2-Color-Schemes (<https://github.com/mbadolato/iTerm2-Color-Schemes>),
directory `ghostty/`, revision `c379d7a31af861838a017468b03120c8970eaa00`, taken
as herdr-gpui bundles them (its `assets/themes/` at commit `7a8e5acb`, credited
there in `crates/herdr-gpui/THEMES-NOTICE.md`), so a theme name means the same
colors in both apps. `catalog.ts` bundles them with `import.meta.glob`. The
collection is MIT-licensed; the copyright for each individual theme belongs to
its author.

The hand-written palettes in `catalog.ts` (`Nord`, `Dracula`, `Catppuccin Mocha`,
`Catppuccin Latte`) are herdr-gpui's built-ins, ported from its
`src/config/theme.rs`, as are the Ghostty parser in `ghostty.ts`, the chrome
derivation in `chrome.ts` and the contrast nudge in `contrast.ts`.

```text
MIT License

Copyright (c) 2011 to Present Mark Badolato

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
