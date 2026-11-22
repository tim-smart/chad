---
name: video
description: Read before inspecting, trimming, shrinking, or converting a video or audio file, extracting frames or audio, or downloading a video from YouTube or another site.
---

# Working with video and audio

The image includes `ffmpeg` for processing video and audio and `ffprobe` for inspecting files. For downloading videos, install `yt-dlp` as shown below. To edit extracted frames, read the `images` skill.

Always write to a new file and keep the original. Pass `-nostdin` to every `ffmpeg` command so it doesn't hang waiting on stdin, and `-y` when overwriting an output file is intended.

## Inspecting a file

```sh
# Duration and each stream's codec, resolution, frame rate, sample rate, and channels
ffprobe -hide_banner input.mp4
# Duration in seconds, for scripts
ffprobe -v error -show_entries format=duration -of csv=p=0 input.mp4
# Full format and stream metadata as JSON
ffprobe -v error -show_format -show_streams -of json input.mp4
```

## Extracting frames

```sh
# One frame every 10 seconds, capped at 1280px wide (frame-0001.jpg, ...)
mkdir -p frames && ffmpeg -nostdin -v error -i input.mp4 -vf "fps=1/10,scale='min(1280,iw)':-2" -q:v 3 frames/frame-%04d.jpg
# Single frame at 00:01:23
ffmpeg -nostdin -v error -y -ss 00:01:23 -i input.mp4 -frames:v 1 -q:v 2 frame.jpg
# First frame of each scene change (useful for long videos)
mkdir -p scenes && ffmpeg -nostdin -v error -i input.mp4 -vf "select='gt(scene,0.3)',scale='min(1280,iw)':-2" -fps_mode vfr -q:v 3 scenes/scene-%04d.jpg
# Combine frames into a contact sheet, 4 across
magick montage frames/frame-*.jpg -tile 4x -geometry 480x+4+4 sheet.jpg
```

To see what happens in a video, extract frames and look at them. Scale the sampling interval to the video's length (every few seconds for a short clip, once a minute for a long one); a few dozen frames is usually plenty. Placing `-ss` before `-i` seeks directly to the timestamp.

## Extracting audio

```sh
# 16 kHz mono WAV (standard format for speech tools)
ffmpeg -nostdin -v error -y -i input.mp4 -vn -ac 1 -ar 16000 audio.wav
# MP3
ffmpeg -nostdin -v error -y -i input.mp4 -vn -q:a 4 audio.mp3
# Copy the audio stream without re-encoding (check codec with ffprobe: aac -> .m4a, opus -> .opus)
ffmpeg -nostdin -v error -y -i input.mp4 -vn -c:a copy audio.m4a
```

There is no transcription tool preinstalled. Ask the owner before installing one.

## Trimming and shrinking

```sh
# Cut 1:00 to 1:30 without re-encoding (snaps to the nearest keyframe before 1:00)
ffmpeg -nostdin -v error -y -ss 00:01:00 -to 00:01:30 -i input.mp4 -c copy clip.mp4
# Frame-accurate cut (re-encodes to H.264 + AAC for .mp4)
ffmpeg -nostdin -v error -y -ss 00:01:00 -to 00:01:30 -i input.mp4 clip.mp4
# Shrink to at most 720p H.264 for wide compatibility
ffmpeg -nostdin -v error -y -i input.mp4 -vf "scale=-2:'min(720,ih)'" -crf 28 -preset veryfast -b:a 96k -movflags +faststart small.mp4
# Short GIF: 480px wide, 10 fps
ffmpeg -nostdin -v error -y -ss 5 -t 4 -i input.mp4 -vf "fps=10,scale=480:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse" clip.gif
```

## Downloading with yt-dlp

`yt-dlp` downloads from YouTube and many other sites. It isn't baked into the image because YouTube frequently breaks older versions. Install it once on the volume so it persists across restarts and image updates:

```sh
command -v yt-dlp || uv tool install 'yt-dlp[default]'
```

```sh
# Inspect title, duration, and available formats without downloading
yt-dlp --js-runtimes node --no-playlist --print '%(title)s %(duration)ss' -F 'URL'
# Download video, preferring 720p MP4 or the closest available match
yt-dlp --js-runtimes node --no-playlist -S 'res:720,ext:mp4:m4a' -o 'video.%(ext)s' 'URL'
# Audio only in its native format (add --audio-format mp3 if MP3 is needed)
yt-dlp --js-runtimes node --no-playlist -x -o 'audio.%(ext)s' 'URL'
# Subtitles only when available (faster than downloading audio)
yt-dlp --js-runtimes node --no-playlist --skip-download --write-subs --write-auto-subs --sub-langs 'en.*' --convert-subs srt -o 'subs' 'URL'
```

Always pass `--js-runtimes node`. YouTube requires a JavaScript runtime, and `yt-dlp` only looks for Deno unless you point it at the image's Node.

If a download fails with an extraction error, run `uv tool upgrade yt-dlp` and retry. If YouTube responds with `"Sign in to confirm you're not a bot"`, it has blocked this server's IP. Tell the owner, and don't try to bypass it with a proxy or another account's cookies.

## Sending the result

`sendFile` supports files up to 10 MB. Send frames as JPEGs, and shrink or trim clips before sending. For long videos, send a summary with a handful of frames rather than the whole video.
