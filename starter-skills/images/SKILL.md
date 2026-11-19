---
name: images
description: Read before you convert, resize, crop, compress, combine, inspect or otherwise edit an image, a screenshot, a photo, an SVG or a GIF, or make a thumbnail, a contact sheet or a favicon.
---

# Working with images

The image chad runs in has ImageMagick 7 (`magick`), `rsvg-convert` for SVG, and `pngquant`, `jpegoptim` and `gifsicle` to make files smaller. ImageMagick reads PNG, JPEG, GIF, WebP, TIFF, BMP, HEIC and AVIF. The fonts are Liberation Sans, Serif and Mono.

Write the result to a new file and keep the original. Use `magick`, never `convert`, which is the ImageMagick 6 name and prints a warning.

## Look before you change

```sh
# Format, size, colour space and file size
magick identify input.jpg
# One value, for a script
magick identify -format '%w %h\n' input.jpg
# Everything, the EXIF data included
magick identify -verbose input.jpg
# What a file really is, whatever its extension
file input.bin
```

## Common edits

```sh
# Convert by the extension of the output
magick input.heic output.jpg
# Fit inside 1600x1600, never enlarge, keep the aspect ratio
magick input.jpg -resize '1600x1600>' output.jpg
# Exactly 800 wide, height by aspect ratio
magick input.jpg -resize 800x output.jpg
# A square thumbnail: fill 256x256 then cut the middle
magick input.jpg -resize 256x256^ -gravity center -extent 256x256 thumb.jpg
# Crop 800x600 starting at x=100, y=50, and drop the old canvas offset
magick input.png -crop 800x600+100+50 +repage output.png
# Apply the camera's rotation and drop metadata such as GPS before sharing
magick input.jpg -auto-orient -strip output.jpg
# Rotate, flip, flop
magick input.png -rotate 90 output.png
# Grayscale
magick input.png -colorspace Gray output.png
# Trim a uniform border, then pad 20px of white back
magick input.png -trim +repage -bordercolor white -border 20 output.png
# A transparent background colour made opaque
magick input.png -background white -alpha remove -alpha off output.jpg
# JPEG quality
magick input.png -quality 82 output.jpg
```

Quote a geometry that has `>`, `<`, `^` or `!`, or the shell reads it.

## Text, labels and watermarks

```sh
# A caption below the image
magick input.png -gravity south -background white -splice 0x60 -font Liberation-Sans -pointsize 32 -annotate +0+12 'Caption' output.png
# A semi-transparent watermark in the corner
magick input.jpg -gravity southeast -fill 'rgba(255,255,255,0.6)' -font Liberation-Sans -pointsize 36 -annotate +20+20 'example.com' output.jpg
```

`magick -list font` names the fonts there are.

## Several images

```sh
# Side by side, then stacked
magick a.png b.png +append row.png
magick a.png b.png -append column.png
# A contact sheet of every JPEG, four across, with file names
magick montage -label '%f' -font Liberation-Sans *.jpg -tile 4x -geometry 300x300+8+8 sheet.jpg
# An animated GIF from frames, 50 hundredths of a second each, looping
magick -delay 50 -loop 0 frame-*.png animation.gif
# The frames of a GIF, one PNG each
magick animation.gif -coalesce frame-%03d.png
# Many files at once, into another directory
mkdir -p small && magick mogrify -path small -resize '1200x1200>' *.jpg
```

`mogrify` without `-path` overwrites its inputs. Always give it `-path`.

## Differences

```sh
# How many pixels differ; the difference image marks them in red
magick compare -metric AE a.png b.png diff.png
```

`compare` prints the count on standard error and exits 1 when the images differ, which is not a failure.

## SVG

```sh
# SVG to PNG at a width, height by aspect ratio
rsvg-convert -w 1024 input.svg -o output.png
# SVG to PDF
rsvg-convert -f pdf input.svg -o output.pdf
# A favicon with several sizes in one file
rsvg-convert -w 256 logo.svg -o logo.png && magick logo.png -define icon:auto-resize=256,64,48,32,16 favicon.ico
```

`rsvg-convert` draws an SVG better than ImageMagick does, so use it for every SVG.

## Making files smaller

```sh
# PNG: lossy palette, usually 60 to 80 percent smaller. Writes output.png
pngquant --quality 65-85 --strip --output output.png input.png
# JPEG: lossless, in place, so copy first
cp input.jpg output.jpg && jpegoptim --strip-all output.jpg
# JPEG: at most quality 80
cp input.jpg output.jpg && jpegoptim --max=80 --strip-all output.jpg
# GIF
gifsicle -O3 --lossy=80 input.gif -o output.gif
# WebP, which most browsers and chat apps show
magick input.png -quality 80 output.webp
```

`pngquant` exits 99 when it cannot reach the lowest quality asked for and writes nothing. Lower the first number or keep the original.

## Sending the result

Send a finished image to the owner with `sendFile`. Discord shows PNG, JPEG, GIF and WebP inline. Convert HEIC, TIFF and AVIF to one of those first.

## What is not here

There is no OCR, no background removal and no image generation. Ask the owner before you install something for those.
