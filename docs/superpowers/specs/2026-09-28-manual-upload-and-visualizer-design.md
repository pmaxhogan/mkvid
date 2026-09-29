# Manual upload flow and a richer visualizer

Date: 2026-09-28. Status: Part B (visualizer) approved and being built on the
local branch `visualizer`. Nothing is deployed until the 1001tracklists track
name problem is solved.

Owner decisions, 2026-09-28:

- **Part A (manual upload) is cancelled.** The quota measurements showed it
  saves nothing. It stays in this document as a record only.
- **The automatic upload cap goes to 30 a day** (tracked, local branch
  `mkvid-cap-and-tracks`, not deployed).
- Build order below no longer applies.

## What the owner asked for

1. A page where finished videos can be downloaded, uploaded to YouTube by hand
   as private videos, and then handed back by pasting the `youtu.be` link and
   clicking save. The service then does everything else: title, description,
   unlisted, playlists.
2. A few dozen videos already rendered and waiting on that page, so a download
   never waits on a music download plus a render.
3. A button on that page that opens YouTube's upload page in a new tab.
4. A much more interesting visualizer. Render time does not matter (it runs
   overnight). Files of several GB, even dozens of GB, are fine. Per-track
   titles and per-track artwork on screen if at all possible. GPU shaders or a
   custom frame-by-frame renderer are both acceptable.

## Facts this design rests on

Measured on 2026-09-28:

- tracked has 478 sets pending, 114 done, and completes exactly 9 a day. The
  daily claim cap is the only throttle: no quota error is recorded in either
  service, and all recent uploads came back `unlisted` as requested.
- NAS: Ryzen 5 2600X (12 threads), GTX 1650 SUPER (4 GB), 1.1 TB free on the
  apps dataset. The container's ffmpeg has `drawtext`, `showcqt`, `libplacebo`
  and the CUDA filters. No fontconfig; fonts must be bundled.
- mkvid deletes every rendered file when its job ends and wipes `work/` at boot.
- mkvid has no `videos.update` call and no file download route today.
- tracked adds playlists itself when mkvid reports a video id, and requires the
  YouTube title to equal the set title cut to 100 characters.

From Google's documentation, read 2026-09-28, not yet confirmed in the Cloud
console for these two projects:

- `videos.insert` no longer costs 1,600 units. It was cut to about 100 in
  December 2025 and moved to its own bucket of 100 calls a day in June 2026.
- `videos.update` and `playlistItems.insert` cost 50 units each.
- YouTube caps uploads per channel per 24 hours across Studio and the API. The
  number is not published.

Consequence: the manual flow no longer saves quota. Its value is that it is a
second, independent way to get videos up. See "Open decision" below.

## Part A: manual upload

### States

mkvid gains two job statuses:

- `ready`: rendered, file kept, waiting for the owner. Not a running state. It
  is not marked `interrupted` at boot and does not hold the queue slot.
- `finalizing`: a link was saved and the service is applying metadata.

tracked gains one request status, `parked`: claimed for the manual backlog. A
parked request never expires on the 3 hour claim TTL and does not count against
the daily claim cap. It leaves `parked` through the existing `/mkvid/complete`
and `/mkvid/fail` routes, or through a new `/mkvid/release` that returns it to
`pending` when the owner discards a backlog video.

### Backlog filling

- Setting `MANUAL_BACKLOG_TARGET` (default 24, 0 turns the feature off).
- The poller keeps its current behaviour first: automatic uploads up to the
  daily cap. When tracked answers that the cap is reached and the queue is
  empty, mkvid asks for a claim with `mode: "manual"` while the count of
  `ready` jobs is below the target.
- A manual-mode job runs download and render, then moves the file to
  `$DATA_DIR/ready/<jobId>/out.mp4` and becomes `ready`. The boot-time wipe
  covers `work/` only.
- Disk guard: filling pauses when free space on the data volume falls below
  `MANUAL_MIN_FREE_GB` (default 100).

### Page

`GET /manual`, behind the same Cloudflare Access gate as the rest of mkvid. One
row per `ready` job, oldest first:

- title (with a copy button), artist, duration, file size, render date
- **Download**: `GET /api/manual/:id/file`, streamed from disk with Range
  support and a `Content-Disposition` filename built from the title
- **Open YouTube upload**: opens `https://www.youtube.com/upload` in a new tab
- a link field and **Save**
- **Discard**: deletes the file and releases the set in tracked

Rows in `finalizing` or with a failed save show their state and the error.

### Save

1. Parse the video id from the pasted text. Accepted: a bare 11 character id,
   `youtu.be/ID`, `/watch?v=ID`, `/shorts/ID`, `/live/ID`, `/embed/ID`,
   `studio.youtube.com/video/ID/...`. Anything else is rejected with a message.
2. Reject an id already attached to another job.
3. `videos.list` for the id. Reject when nothing comes back or when the channel
   is not the connected channel.
4. Wrong-video guard: when YouTube reports a duration, it must be within 5
   seconds of the rendered file's. When the duration is not available yet, the
   job waits in `finalizing` and checks again.
5. `videos.update` using list, merge, update: the fetched snippet and status
   are kept, and only title, description, category and privacy are replaced.
   Title and description come from the same code the upload path uses.
6. Record the id, mark the job `done`, report to tracked through the existing
   path. tracked adds the playlists.
7. Delete the kept file.

Refactor that makes this possible: the steps after upload in `runJob` move into
one function that takes a video id, used by both paths.

Failures leave the job `ready` with the error shown, so the link can be pasted
again. Processing delays are retried in the background with backoff.
`forbiddenPrivacySetting` is reported in plain words: the video must be set to
unlisted by hand in Studio, then saved again.

Cost per video: about 52 units in mkvid's project, plus tracked's playlist
inserts, which it pays today as well.

### Not included

Custom thumbnails. mkvid has never set one, and YouTube picks a frame from the
new visualizer.

## Part B: visualizer

### Approach

A frame-by-frame renderer in Node, drawing with `@napi-rs/canvas` (Skia, no
system packages needed) and handing raw frames to ffmpeg for NVENC encoding.
Chosen over GPU shaders because the requested content is mostly text and
artwork composition, which a canvas does directly and a shader does badly, and
because it needs no change to the container's GPU capabilities. The heavy
effects are written so a shader pass can replace them later without touching
the rest.

Output: 1920x1080, 30 fps, H.264 through NVENC at a quality setting high enough
for moving content, audio handled as today.

### Pipeline

1. **Analyse.** Decode the audio once to mono PCM. Compute per-frame spectrum
   bands, overall energy, bass energy and beat onsets. Store as a binary file
   in the work directory.
2. **Gather assets.** Track list from tracked, artwork downloaded and cached
   per track, set artwork from the source page as the fallback.
3. **Render in segments.** The timeline is cut into 60 second segments. A pool
   of worker threads renders segments in parallel, each to its own video file.
   A finished segment is never rendered again.
4. **Assemble.** Concatenate the segments and add the audio.

Segments give both speed (all cores) and restart safety. A container restart
costs at most the segments in flight. At boot, a job interrupted while
rendering goes back on the queue and resumes, instead of being reported failed.

### What is on screen

- Background: the current track's artwork, heavily blurred, slowly drifting and
  zooming, tinted by the artwork's dominant colours, brightness following the
  music's energy.
- Centre: the current track's artwork as a card that pulses on beats, inside a
  circular spectrum that reacts to the music.
- Particles that drift outward and surge with the bass.
- Current track: artist and title, large. Crossfades at each cue, with the
  artwork changing at the same moment.
- Header: set title and artist.
- Footer: a timeline of the whole set with a marker at every cue, the played
  portion filled, elapsed and total time.
- Unidentified tracks show as `ID`, with the set artwork.

### Track data

tracked's claim response gains `tracks`: cue seconds, artist, title, artwork
URL, and whether the names can be trusted.

This matters because 1001tracklists has been serving randomized track names
since about 2026-09-22, while cue times and artwork stay real. A track list
scraped from a page the decoy detector flagged is marked untrusted. For an
untrusted list the video shows artwork, cue markers and the timeline, and no
track names. A video with wrong names burned in cannot be corrected later, so
showing none is the safe failure.

Sets with no track list at all render with the set artwork only.

### Supporting pieces

- Fonts: Inter, bundled in the repository and registered with the canvas.
- Preview command: renders a chosen 20 seconds of a local audio file to an mp4
  and a few PNG stills. This is how the look gets reviewed and tuned before any
  overnight render.
- The two existing styles stay as they are. The new style becomes the default
  for tracked jobs through a setting, so it can be switched back.
- Tests: analysis on synthetic audio (a known tone lands in the right band, a
  click track yields the right onsets), cue lookup, segment planning and
  resume, the id parser, the save flow against a mocked YouTube client, the
  Range download route. The drawing itself is checked through the preview.

## Order of work

1. Visualizer, reviewed through previews.
2. Manual flow in both services, with the backlog target at 0.
3. One real video through the manual flow end to end.
4. Backlog target raised, so every pregenerated video has the new look.

Steps 1 and 2 touch different files and can be built at the same time.

## Open decision

Whether to also raise the automatic upload cap. If Google's new pricing applies
to these projects, the 9 a day limit is about ten times lower than it needs to
be, and raising it is a settings change. It should be raised in steps, because
the unpublished per-channel upload cap is the next limit and it applies to
manual uploads too.
