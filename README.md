# Simple PDF Editor

A free, lightweight PDF editor that runs entirely in your browser. Your files are never uploaded.

**Live site:** https://prasodium.github.io/pdf-editor/

## Features
- **Edit existing text** – click any text and retype it. The original embedded font and colour are reused, so the replacement matches.
- Add text, draw, highlight, whiteout, boxes, and images
- Rotate, delete, duplicate, and reorder pages; add blank pages
- Merge PDFs or images (drag and drop or "Add PDF"); download a single page with ⇩
- Undo / redo

## Font matching
PDFs usually embed only the letters they use from each font. When you edit text:

1. Letters the PDF's font contains are drawn with that exact font, one by one.
2. If some letters are missing, the editor saves, tells you which ones, and offers **Choose font file**. Pick the same font (`.ttf` or `.otf`, for example Georgia Bold) and it saves again with that exact font.
3. Without the font file, missing letters use the closest standard font (Helvetica, Times or Courier, with bold and italic matched).

Fonts that are not embedded (such as plain Helvetica-Bold) are always matched exactly.

## Run locally
No build step. Serve the folder with any static server, e.g. `python3 -m http.server`, and open http://localhost:8000.

## Built with
[pdf.js](https://github.com/mozilla/pdf.js) (rendering), [pdf-lib](https://github.com/Hopding/pdf-lib) and [fontkit](https://github.com/foliojs/fontkit) (saving). Vendored in `vendor/`.

MIT License
