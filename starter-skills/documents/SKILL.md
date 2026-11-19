---
name: documents
description: Read before you write a document for the owner as a PDF, a Word file or a web page, or convert between Markdown, Word (.docx), OpenDocument, HTML, EPUB, LaTeX and plain text.
---

# Writing and converting documents

The image has `pandoc`, which converts between document formats, and `typst`, which typesets a PDF. pandoc makes a PDF through typst with `--pdf-engine=typst`. There is no LaTeX, LibreOffice or Word. To read or change an existing PDF, read the `pdfs` skill.

## Converting

pandoc reads the format from the input's extension and writes the one of `-o`. `-f` and `-t` name them when the extension does not.

```sh
# Word to Markdown, with its images saved under media/
pandoc input.docx --extract-media=media -o output.md
# Markdown to Word
pandoc input.md -o output.docx
# A web page to Markdown
pandoc -f html -t gfm input.html -o output.md
# Markdown to one HTML file with its images and styles inside it
pandoc input.md --standalone --embed-resources --metadata title='Title' -o output.html
# Markdown to EPUB
pandoc input.md --metadata title='Title' -o output.epub
# Word to plain text
pandoc input.docx -t plain -o output.txt
```

pandoc also reads a spreadsheet (.xlsx), as one table per sheet, and a slide deck (.pptx), and it writes a slide deck from Markdown, one slide per `##` heading. `pandoc --list-input-formats` and `pandoc --list-output-formats` give the rest.

```sh
# The sheets of a spreadsheet as Markdown tables
pandoc input.xlsx -t gfm -o output.md
# A slide deck from Markdown
pandoc slides.md -o slides.pptx
```

To match a Word file the owner already has, pass it as the reference document. pandoc takes its styles and none of its text.

```sh
pandoc input.md --reference-doc=theirs.docx -o output.docx
```

## A PDF from Markdown

```sh
pandoc input.md --pdf-engine=typst -o output.pdf
# A4, smaller margins, a font that is in the image, and a table of contents
pandoc input.md --pdf-engine=typst -V papersize=a4 -V margin.x=2cm -V margin.y=2cm -V mainfont='Liberation Serif' --toc -o output.pdf
```

## A PDF with typst

Write typst when the layout matters more than the text: an invoice, a letter, a CV, a table with fixed columns or a poster. Write `doc.typ` and compile it.

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
# Pass values in from a script, read in the file as sys.inputs.name
typst compile --input name=Ada doc.typ doc.pdf
# PNG previews, one per page, to look at the layout
typst compile --format png --ppi 100 doc.typ 'preview-{p}.png'
# The fonts typst can use
typst fonts
```

typst reports an error with its file, line and column. Fix it and compile again. `#import "@preview/<package>:<version>"` downloads a package from typst's registry on first use and caches it under `~/.cache`.

## Checking the result

Render the first page of a PDF with `pdftoppm -png -r 80 -f 1 -l 1 -singlefile output.pdf preview` and look at it before you send it. Send the file with `sendFile`.
