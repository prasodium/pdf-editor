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
Original fonts are embedded as subsets, so they only contain the letters used in the document. If your new text uses a letter the PDF's font does not contain, the editor falls back to the closest standard font (Helvetica, Times, or Courier, with bold/italic matched).

## Run locally
No build step. Serve the folder with any static server, e.g. `python3 -m http.server`, and open http://localhost:8000.

## Built with
[pdf.js](https://github.com/mozilla/pdf.js) (rendering), [pdf-lib](https://github.com/Hopding/pdf-lib) and [fontkit](https://github.com/foliojs/fontkit) (saving). Vendored in `vendor/`.

MIT License
