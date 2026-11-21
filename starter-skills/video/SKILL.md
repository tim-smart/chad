---
name: video
description: Read before you inspect, cut, shrink or convert a video or an audio file, take frames or the audio out of a video, or download a video from YouTube or another site.
---

# Working with video and audio

The image has `ffmpeg`, which reads and writes video and audio, and `ffprobe`, which describes a file. To download a video, install `yt-dlp` as below. To edit the frames you take out, read the `images` skill.

Write the result to a new file and keep the original. Pass `-nostdin` to every `ffmpeg` command, or it waits on its standard input, and `-y` when it may overwrite the output.

## Look before you change

```sh
# Length, size, codecs and streams, in one line each
ffprobe -v error -show_entries format=duration,size:stream=index,codec_type,codec_name,width,height,r_frame_rate,sample_rate,channels -of compact input.mp4
# The length in seconds, for a script
ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 input.mp4
# Everything, as JSON
ffprobe -v error -show_format -show_streams -of json input.mp4
```

## Frames

```sh
# One frame every 10 seconds, 1280 wide at most: frame-0001.jpg and so on
mkdir -p frames && ffmpeg -nostdin -v error -i input.mp4 -vf "fps=1/10,scale='min(1280,iw)':-2" -q:v 3 frames/frame-%04d.jpg
# One frame at 1 minute 23 seconds
ffmpeg -nostdin -v error -y -ss 00:01:23 -i input.mp4 -frames:v 1 -q:v 2 frame.jpg
# The first frame of each new scene, for a video too long to sample evenly
mkdir -p scenes && ffmpeg -nostdin -v error -i input.mp4 -vf "select='gt(scene,0.3)',scale='min(1280,iw)':-2" -fps_mode vfr -q:v 3 scenes/scene-%04d.jpg
# Many frames as one contact sheet, 4 across
magick montage frames/frame-*.jpg -tile 4x -geometry 480x+4+4 sheet.jpg
```

To read what a video shows, take frames and look at them. Pick the interval from the length: every few seconds for a short clip, one a minute for a long one. A few dozen frames is usually enough. `-ss` before `-i` jumps straight to the time.

## Audio

```sh
# 16 kHz mono WAV, the form speech tools read
ffmpeg -nostdin -v error -y -i input.mp4 -vn -ac 1 -ar 16000 audio.wav
# MP3
ffmpeg -nostdin -v error -y -i input.mp4 -vn -q:a 4 audio.mp3
# The audio stream as it is, with no re-encoding. Check its codec with ffprobe first: aac goes in .m4a, opus in .opus
ffmpeg -nostdin -v error -y -i input.mp4 -vn -c:a copy audio.m4a
```

There is no transcription in the image. Ask the owner before you install something for it.

## Cutting and shrinking

```sh
# From 1:00 to 1:30, with no re-encoding. It starts at the keyframe before 1:00
ffmpeg -nostdin -v error -y -ss 00:01:00 -to 00:01:30 -i input.mp4 -c copy clip.mp4
# The same cut, exact to the frame, re-encoded
ffmpeg -nostdin -v error -y -ss 00:01:00 -to 00:01:30 -i input.mp4 -c:v libx264 -crf 23 -c:a aac clip.mp4
# Smaller: 720 high at most, H.264, plays almost everywhere
ffmpeg -nostdin -v error -y -i input.mp4 -vf "scale=-2:'min(720,ih)'" -c:v libx264 -crf 28 -preset veryfast -c:a aac -b:a 96k -movflags +faststart small.mp4
# A short GIF, 480 wide, 10 frames a second
ffmpeg -nostdin -v error -y -ss 5 -t 4 -i input.mp4 -vf "fps=10,scale=480:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse" clip.gif
```

## Downloading with yt-dlp

`yt-dlp` downloads from YouTube and many other sites. It is not in the image, because YouTube breaks old versions often. Install it on the volume once, where it stays across restarts and image updates:

```sh
command -v yt-dlp || uv tool install 'yt-dlp[default]'
```

```sh
# The title, length and formats, with no download
yt-dlp --js-runtimes node --no-playlist --print '%(title)s %(duration)ss' 'URL'
yt-dlp --js-runtimes node --no-playlist -F 'URL'
# The video, 720 high at most, as MP4
yt-dlp --js-runtimes node --no-playlist -f 'bv*[height<=720]+ba/b[height<=720]/b' --merge-output-format mp4 -o 'video.%(ext)s' 'URL'
# The audio only, as MP3
yt-dlp --js-runtimes node --no-playlist -x --audio-format mp3 -o 'audio.%(ext)s' 'URL'
# The subtitles only, when the video has them, which can save you the audio
yt-dlp --js-runtimes node --no-playlist --skip-download --write-subs --write-auto-subs --sub-langs 'en.*' --convert-subs srt -o 'subs' 'URL'
```

Always pass `--js-runtimes node`. YouTube needs a JavaScript runtime, and `yt-dlp` looks only for deno unless it is told to use the image's Node.

When a download fails with an extraction error, run `uv tool upgrade yt-dlp` and try again. When YouTube answers "Sign in to confirm you're not a bot", it has refused this server's address. Tell the owner, and do not try to get around it with a proxy or another account's cookies.

## Sending the result

`sendFile` takes files up to 10 MB. Send frames as JPEG. Shrink a clip as above or send a short part of it. For a long video, send what you found in it, with a few frames, rather than the video.
