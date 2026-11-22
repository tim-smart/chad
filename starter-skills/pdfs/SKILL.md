---
name: pdfs
description: Read before inspecting, extracting text or images from, splitting, merging, rotating, decrypting, compressing, extracting attachments from, or rendering pages of a PDF.
---

# Working with PDFs

The image includes poppler's tools for reading and extracting from PDFs (`pdfinfo`, `pdftotext`, `pdftoppm`, `pdfimages`, `pdffonts`, `pdfdetach`, `pdfunite`, `pdfseparate`, `pdftocairo`), plus `qpdf` for lossless restructuring and encryption. ImageMagick's `magick` can combine images into a PDF. To create a new PDF from text, read the `documents` skill.

Always write to a new file and keep the original.

## Reading

```sh
# Page count, page size, title, producer, and encryption status
pdfinfo input.pdf
# Extract text while preserving columns and table layout
pdftotext -layout input.pdf output.txt
# Extract pages 3 to 5 to stdout
pdftotext -layout -f 3 -l 5 input.pdf -
# List fonts and whether they're embedded
pdffonts input.pdf
```

If `pdftotext` returns no text, the PDF is a scan. There is no OCR installed, so render the pages as images and read them yourself, or tell the owner.

## Rendering pages as images

```sh
# All pages as PNGs at 150 dpi (page-1.png, page-2.png, ...)
pdftoppm -png -r 150 input.pdf page
# Page 2 only as a single JPEG named cover.jpg
pdftoppm -jpeg -r 150 -f 2 -l 2 -singlefile input.pdf cover
# Page 1 as SVG
pdftocairo -svg -f 1 -l 1 input.pdf page-1.svg
```

Render and inspect pages directly when visual layout matters, such as forms, charts, or tables that `pdftotext` scrambles.

## Embedded images and attachments

```sh
# Extract embedded images in their original formats (img-000.jpg, ...)
pdfimages -all input.pdf img
# List embedded images with page numbers and sizes first
pdfimages -list input.pdf
# List and extract attached files
pdfdetach -list input.pdf
pdfdetach -saveall -o attachments input.pdf
```

## Splitting, merging, and reordering

```sh
# Merge PDFs in order
qpdf --empty --pages a.pdf b.pdf c.pdf -- merged.pdf
# Keep pages 1-3 and 7 in that order
qpdf input.pdf --pages . 1-3,7 -- output.pdf
# Drop the first page, or extract just the last page
qpdf input.pdf --pages . 2-z -- rest.pdf
qpdf input.pdf --pages . z -- last.pdf
# Reverse page order
qpdf input.pdf --pages . z-1 -- reversed.pdf
# Split into one file per page (page-01.pdf, ...)
qpdf input.pdf --split-pages page-%d.pdf
# Interleave odd and even pages (for example, a two-sided scan)
qpdf --empty --collate --pages front.pdf back.pdf z-1 -- both.pdf
```

`pdfunite a.pdf b.pdf merged.pdf` also merges PDFs, and `pdfseparate -f 2 -l 4 input.pdf page-%d.pdf` splits a page range.

## Rotating

```sh
# Rotate every page 90 degrees clockwise
qpdf input.pdf --rotate=+90 -- output.pdf
# Rotate only pages 2 and 4 by 180 degrees
qpdf input.pdf --rotate=+180:2,4 -- output.pdf
```

## Passwords and encryption

Treat a PDF password as a secret. Ask the owner to store it with `requestSecret` (see the `credentials` skill) and pass it through `chad secret run`, never as a literal.

```sh
# Decrypt using the password from stdin
chad secret run --stdin PDF_PASSWORD -- qpdf --password-file=- --decrypt input.pdf output.pdf
# Encrypt with AES-256
chad secret run --env PASS=PDF_PASSWORD -- sh -c 'qpdf --encrypt --user-password="$PASS" --owner-password="$PASS" --bits=256 -- input.pdf output.pdf'
# Verify PDF structure
qpdf --check input.pdf
```

## Compressing

```sh
# Lossless: recompress streams and pack object streams
qpdf --recompress-flate --compression-level=9 --object-streams=generate input.pdf output.pdf
# Linearize for fast web viewing (first page loads while the rest downloads)
qpdf --linearize input.pdf output.pdf
```

If a PDF is huge because of scanned pages, lossless compression won't shrink it much. Render the pages with `pdftoppm -jpeg -r 120` and reassemble them with `magick` below.

## Images to PDF

```sh
# One page per image, in order
magick page-*.jpg output.pdf
# Fit and center each image on A4 at 150 dpi
magick page-*.jpg -resize 1240x1754 -gravity center -background white -extent 1240x1754 -units PixelsPerInch -density 150 output.pdf
```

## Checking the output

Run `pdfinfo` on the output file. If you reordered or modified pages, render a page or two with `pdftoppm` and check them visually. Send the file with `sendFile`.
