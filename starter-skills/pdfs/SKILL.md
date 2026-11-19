---
name: pdfs
description: Read before you read, search, split, merge, rotate, compress, encrypt, decrypt or render a PDF, take its images or attachments out, or turn its pages into images.
---

# Working with PDFs

The image has poppler's commands, which read a PDF (`pdfinfo`, `pdftotext`, `pdftoppm`, `pdfimages`, `pdffonts`, `pdfdetach`, `pdfunite`, `pdfseparate`, `pdftocairo`), and `qpdf`, which rewrites one without changing its pages. ImageMagick's `magick` turns images into a PDF. To write a new PDF from text, read the `documents` skill.

Write the result to a new file and keep the original.

## Reading

```sh
# Pages, page size, title, producer and whether it is encrypted
pdfinfo input.pdf
# The text, keeping the layout of columns and tables
pdftotext -layout input.pdf output.txt
# Pages 3 to 5 only, to standard output
pdftotext -layout -f 3 -l 5 input.pdf -
# The fonts, and whether each is embedded
pdffonts input.pdf
```

A PDF that gives no text from `pdftotext` is a scan. There is no OCR in the image. Render the pages as images and read them yourself, or tell the owner.

## Pages as images

```sh
# Each page as a PNG at 150 dpi: page-1.png, page-2.png and so on
pdftoppm -png -r 150 input.pdf page
# Only page 2, as one JPEG named cover.jpg
pdftoppm -jpeg -r 150 -f 2 -l 2 -singlefile input.pdf cover
# A page as SVG
pdftocairo -svg -f 1 -l 1 input.pdf page-1.svg
```

Render a page and look at it when its layout matters, such as a form, a chart or a table that `pdftotext` mangles.

## What it embeds

```sh
# The images, in their own formats, as img-000.jpg and so on
pdfimages -all input.pdf img
# List the images first, with their pages and sizes
pdfimages -list input.pdf
# The attached files
pdfdetach -list input.pdf
pdfdetach -saveall -o attachments input.pdf
```

## Splitting, merging and reordering

```sh
# Merge in order
qpdf --empty --pages a.pdf b.pdf c.pdf -- merged.pdf
# Pages 1 to 3 and 7, in that order
qpdf input.pdf --pages . 1-3,7 -- output.pdf
# Every page but the first, and the last page alone
qpdf input.pdf --pages . 2-z -- rest.pdf
qpdf input.pdf --pages . z -- last.pdf
# Reverse the pages
qpdf input.pdf --pages . z-1 -- reversed.pdf
# Split into one file per page: page-01.pdf and so on
qpdf input.pdf --split-pages page-%d.pdf
# Odd pages of one and even of another, such as a two-sided scan
qpdf --empty --collate --pages front.pdf back.pdf z-1 -- both.pdf
```

`pdfunite a.pdf b.pdf merged.pdf` merges too, and `pdfseparate -f 2 -l 4 input.pdf page-%d.pdf` splits a range.

## Rotating

```sh
# Turn every page a quarter turn clockwise
qpdf input.pdf --rotate=+90 -- output.pdf
# Only pages 2 and 4
qpdf input.pdf --rotate=+180:2,4 -- output.pdf
```

## Passwords and encryption

A PDF's password is a secret. Ask the owner to save it with `requestSecret`, as the `credentials` skill says, and pass it to `qpdf` from `chad secret run`, never as a literal.

```sh
# Remove the password, reading it on standard input
chad secret run --stdin PDF_PASSWORD -- qpdf --password-file=- --decrypt input.pdf output.pdf
# Encrypt with AES-256
chad secret run --env PASS=PDF_PASSWORD -- sh -c 'qpdf --encrypt --user-password="$PASS" --owner-password="$PASS" --bits=256 -- input.pdf output.pdf'
# Check a file is well-formed
qpdf --check input.pdf
```

## Smaller files

```sh
# Lossless: compress streams and pack objects
qpdf --recompress-flate --compression-level=9 --object-streams=generate input.pdf output.pdf
# Linearize, which lets a browser show the first page while the rest downloads
qpdf --linearize input.pdf output.pdf
```

A PDF that is large because of its scans gets smaller only by making the images smaller: render the pages with `pdftoppm -jpeg -r 120` and put them back together as below.

## Images to a PDF

```sh
# One page per image, in order
magick page-*.jpg output.pdf
# A4 pages at 150 dpi, each image fitted and centred
magick page-*.jpg -resize 1240x1754 -gravity center -background white -extent 1240x1754 -units PixelsPerInch -density 150 output.pdf
```

## Checking the result

Run `pdfinfo` on what you wrote, and for an edit that moved pages, render a page or two with `pdftoppm` and look. Send the file with `sendFile`.
