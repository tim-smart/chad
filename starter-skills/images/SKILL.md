---
name: images
description: Read before converting, resizing, cropping, compressing, combining, inspecting, or editing an image, screenshot, photo, SVG, or GIF, or making a thumbnail, contact sheet, or favicon.
---

# Working with images

The image includes ImageMagick 7 (`magick`), `rsvg-convert` for SVGs, and `pngquant`, `jpegoptim`, and `gifsicle` for compression. ImageMagick supports PNG, JPEG, GIF, WebP, TIFF, BMP, HEIC, and AVIF. Installed fonts include Liberation Sans, Serif, and Mono.

Always write to a new file and keep the original. Use `magick` rather than `convert` (the legacy ImageMagick 6 name, which prints a deprecation warning).

## Inspecting an image

```sh
# Format, dimensions, color space, and file size
magick identify input.jpg
# Just width and height, for scripts
magick identify -format '%w %h\n' input.jpg
# Full details, including EXIF metadata
magick identify -verbose input.jpg
# True file type regardless of extension
file input.bin
```

## Common edits

```sh
# Convert format based on the output extension
magick input.heic output.jpg
# Fit inside 1600x1600 without enlarging, preserving aspect ratio
magick input.jpg -resize '1600x1600>' output.jpg
# Resize to 800px wide, scaling height proportionally
magick input.jpg -resize 800x output.jpg
# Square thumbnail: fill 256x256, then center-crop
magick input.jpg -resize 256x256^ -gravity center -extent 256x256 thumb.jpg
# Crop 800x600 starting at (100, 50) and reset the canvas offset
magick input.png -crop 800x600+100+50 +repage output.png
# Apply EXIF orientation and strip metadata (including GPS) before sharing
magick input.jpg -auto-orient -strip output.jpg
# Rotate clockwise
magick input.png -rotate 90 output.png
# Convert to grayscale
magick input.png -colorspace Gray output.png
# Trim a uniform border, then add 20px of white padding
magick input.png -trim +repage -bordercolor white -border 20 output.png
# Flatten transparency onto a white background
magick input.png -background white -alpha remove -alpha off output.jpg
# Set JPEG quality
magick input.png -quality 82 output.jpg
```

Quote any geometry containing `>`, `<`, `^`, or `!` so the shell doesn't interpret it.

## Text, labels, and watermarks

```sh
# Add a caption bar below the image
magick input.png -gravity south -background white -splice 0x60 -font Liberation-Sans -pointsize 32 -annotate +0+12 'Caption' output.png
# Add a semi-transparent corner watermark
magick input.jpg -gravity southeast -fill 'rgba(255,255,255,0.6)' -font Liberation-Sans -pointsize 36 -annotate +20+20 'example.com' output.jpg
```

Run `magick -list font` to see all available font names.

## Combining and batch editing

```sh
# Side by side, then stacked vertically
magick a.png b.png +append row.png
magick a.png b.png -append column.png
# Contact sheet of all JPEGs, 4 across, labeled with filenames
magick montage -label '%f' -font Liberation-Sans *.jpg -tile 4x -geometry 300x300+8+8 sheet.jpg
# Animated GIF from frames (50 centiseconds per frame, looping forever)
magick -delay 50 -loop 0 frame-*.png animation.gif
# Extract each frame of a GIF as a PNG
magick animation.gif -coalesce frame-%03d.png
# Batch resize into a separate directory
mkdir -p small && magick mogrify -path small -resize '1200x1200>' *.jpg
```

Always pass `-path` to `mogrify`; without it, `mogrify` overwrites input files in place.

## Comparing images

```sh
# Count differing pixels and highlight differences in red
magick compare -metric AE a.png b.png diff.png
```

`compare` prints the pixel count to stderr and exits 1 when the images differ, which is expected rather than an error.

## SVGs

```sh
# SVG to PNG at a given width, preserving aspect ratio
rsvg-convert -w 1024 input.svg -o output.png
# SVG to PDF
rsvg-convert -f pdf input.svg -o output.pdf
# Multi-size favicon from an SVG
rsvg-convert -w 256 logo.svg -o logo.png && magick logo.png -define icon:auto-resize=256,64,48,32,16 favicon.ico
```

Always use `rsvg-convert` for SVGs; it renders them much more accurately than ImageMagick.

## Compressing files

```sh
# PNG: lossy palette compression, usually 60-80% smaller
pngquant --quality 65-85 --strip --output output.png input.png
# JPEG: lossless optimization (edits in place, so copy first)
cp input.jpg output.jpg && jpegoptim --strip-all output.jpg
# JPEG: cap quality at 80
cp input.jpg output.jpg && jpegoptim --max=80 --strip-all output.jpg
# GIF
gifsicle -O3 --lossy=80 input.gif -o output.gif
# WebP (widely supported in browsers and chat apps)
magick input.png -quality 80 output.webp
```

`pngquant` exits 99 and writes nothing if it can't meet the minimum quality target. Lower the first quality number or keep the original file.

## Sending the result

Send finished images with `sendFile`. Discord displays PNG, JPEG, GIF, and WebP inline, so convert HEIC, TIFF, or AVIF to one of those first.

## Not installed

There is no OCR, background removal, or image generation in the image. Ask the owner before installing tools for those.
