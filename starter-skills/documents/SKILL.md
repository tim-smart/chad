---
name: documents
description: Read before creating a PDF, Word document, or web page, or converting between Markdown, Word (.docx), OpenDocument, HTML, EPUB, LaTeX, and plain text.
---

# Writing and converting documents

The image includes `pandoc` for converting between document formats and `typst` for typesetting PDFs. `pandoc` generates PDFs through `typst` when given `--pdf-engine=typst`. There is no LaTeX, LibreOffice, or Word. To inspect or edit an existing PDF, read the `pdfs` skill.

## Converting formats

`pandoc` infers formats from file extensions. Pass `-f` (from) and `-t` (to) when the extension doesn't make the format clear.

```sh
# Word to Markdown, saving embedded images under media/
pandoc input.docx --extract-media=media -o output.md
# Markdown to Word
pandoc input.md -o output.docx
# HTML to GitHub-Flavored Markdown
pandoc -f html -t gfm input.html -o output.md
# Markdown to a single self-contained HTML file (embedded images and styles)
pandoc input.md --standalone --embed-resources --metadata title='Title' -o output.html
# Markdown to EPUB
pandoc input.md --metadata title='Title' -o output.epub
# Word to plain text
pandoc input.docx -t plain -o output.txt
```

`pandoc` can also read spreadsheets (`.xlsx`, as one table per sheet) and slide decks (`.pptx`), and write a `.pptx` from Markdown (one slide per `##` heading). Run `pandoc --list-input-formats` and `pandoc --list-output-formats` for the full list.

```sh
# Spreadsheet sheets as Markdown tables
pandoc input.xlsx -t gfm -o output.md
# Slide deck from Markdown
pandoc slides.md -o slides.pptx
```

To match the styling of an existing Word document, pass it with `--reference-doc`. `pandoc` copies its styles without its content:

```sh
pandoc input.md --reference-doc=theirs.docx -o output.docx
```

## PDF from Markdown

```sh
pandoc input.md --pdf-engine=typst -o output.pdf
# A4, tighter margins, an installed font, and a table of contents
pandoc input.md --pdf-engine=typst -V papersize=a4 -V margin.x=2cm -V margin.y=2cm -V mainfont='Liberation Serif' --toc -o output.pdf
```

## PDF with typst

Use `typst` directly when layout matters more than prose (invoices, letters, CVs, fixed-column tables, posters). Write a `.typ` file and compile it:

```typst
#set page(paper: "a4", margin: 2cm)
#set text(font: "Liberation Sans", size: 11pt)

= Invoice 42

#table(
  columns: (1fr, auto, auto),
  [*Item*], [*Hours*], [*Amount*],
  [Design], [10], [\$1,000],
)
```

```sh
typst compile doc.typ doc.pdf
# Pass values from a script (read in the file as sys.inputs.name)
typst compile --input name=Ada doc.typ doc.pdf
# Render PNG previews (one per page) to check the layout
typst compile --format png --ppi 100 doc.typ 'preview-{p}.png'
# List available fonts
typst fonts
```

`typst` reports errors with file, line, and column numbers. `#import "@preview/<package>:<version>"` downloads packages from the Typst registry on first use and caches them under `~/.cache`.

## Checking the output

Before sending a PDF, render its first page with `pdftoppm -png -r 80 -f 1 -l 1 -singlefile output.pdf preview` and inspect it. Send the finished file with `sendFile`.
