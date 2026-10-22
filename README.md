# Syncora

A desktop application that automatically synchronises multicamera video and external audio recordings, from a
single wedding to a multi-day production with thousands of files. It matches audio and timecode, tells you plainly
which clips are synced and which are not, and exports a timeline XML for DaVinci Resolve, Adobe Premiere Pro and Final
Cut Pro. Original media is never re-encoded, modified or deleted.

Built for wedding filmmakers, event videographers, documentary producers and multicam editors: hours of recorder
audio, hundreds or thousands of interrupted camera clips, mixed frame rates, drifting clocks.

**Stack:** Python (NumPy, SciPy) engine · FFmpeg · SQLite · sherpa-onnx (Whisper, Silero, 3D-Speaker) · Electron +
React desktop app.

Developed by **OrbitOne Studios**.

![Sync results for a generated production](docs/images/results.png)

## Large productions

Version 1.1 processes a production as a background pipeline:

1. Discovery.
2. Metadata.
3. Audio analysis, with fingerprints.
4. Candidate pairs from a fingerprint index, never all pairs.
5. Verification.
6. Extended search.
7. A single sparse solve.

Every step is a task in the project file, so work can be paused, resumed, cancelled, retried or picked up after
a quit or crash. The media browser shows only what is on screen, whatever the project size.

![Analysis of a production, paused: progress by stage with counts, never time estimates](docs/images/analysis.png)

What has been measured, on what hardware and with what results, is in
[SCALABILITY_TEST_REPORT.md](SCALABILITY_TEST_REPORT.md). It includes an end-to-end run of a generated
4,238-file production: 4,000 camera clips, 200 recorder files, and problem files.

## Transcripts, speakers and AI sync

Version 1.2 adds the Analyze stage. Everything runs on your computer with models that ship in the installer; nothing
is uploaded.

* **Transcription** (Whisper): what was said, in 99 languages, detected per sentence. "Transcribe project"
  transcribes each moment once, from its clearest recording (audio recorders first). Cameras synced to that
  recording show its transcript at the same moment.
* **Speakers:** voices are told apart across every recording. Rename a speaker once and every line follows; merge
  two speakers by dragging one onto the other.
* **Markers:** applause, music, laughter, cheering and singing are marked while transcribing. Press **M** to mark a
  moment yourself.
* **Search** (⌘K / Ctrl+K): a phrase someone said, a speaker's name, a marker or a clip name. ↵ opens the moment in
  the player; ⌘↵ marks it.
* **AI sync:** a clip audio fingerprints could not place is looked for by the sentences heard in both recordings,
  the flashes and light changes both cameras saw, its audio compared again at close range, and the camera clocks.
  The evidence is shown lane by lane; a proposal is placed only when you accept it (and Undo takes it back). With
  **Settings → Synchronization → AI visual + speech fallback**, this runs after every sync and proposes clips for
  review.

The larger speech models (Whisper small and turbo) download on demand from Settings → AI. From the command line:
`mcsync transcribe recording.wav`.

## AI first cut

Version 1.4 edits a first version of a synchronised production (the clapperboard in the top bar, or File → Create
AI First Cut…, ⇧⌘E / Ctrl+Shift+E), on your computer, from the cameras' positions, the transcripts and the sound:

* **Wedding: long version.** Every moment the cameras saw, in order, without the waiting in between. The main
  camera holds vows and speeches; other angles come in for variety, cutting on pauses in speech.
* **Podcast or interview.** From the first words to the last with long pauses tightened; each speaker on their
  camera (guessed from which camera microphone hears them, or chosen in the dialog), the wide shot for cross-talk
  and long answers.

The cut is exported as FCP 7 XML or FCPXML like the synchronised timeline: picture on V1, the program sound below
(sound recorders first), chapter markers for long speeches. Sound stays placed to the sample and picture within
half a frame of where synchronisation put it. Clips that need review are left out unless you allow them.

## Exports keep your folders

Exported timelines list every file in bins that mirror the folders you imported (`Wedding / Cam A / CARD1`):
nested bins with one master clip per file in Premiere Pro and DaVinci Resolve (FCP 7 XML), keyword collections in
folders in Final Cut Pro (FCPXML). Settings → Export → Keep my folders as bins turns bins off.

## Synced or not synced

Results come in two words. A clip is **synced** when audio, timecode or your own placement puts it at a position
Syncora is sure of (at or above the review threshold in Settings → Synchronization); every other clip is **not
synced**: placed only by uncertain evidence or a camera clock, not placed at all, or unreadable. In the exported XML,
clips that are not synced carry Premiere Pro's red label (Rose) or, in FCPXML, a "Not synced" keyword. The export
dialog (and Settings → Export) chooses where they go: at the end of the timeline after the synced clips, one after
another on their camera's track (the default); where Syncora put them; or left out.

## Updates

When Syncora opens it asks GitHub for the latest release and, when a newer version is out, shows what's new and a
Download button that opens the release page. Nothing is downloaded or installed without you; Settings → Updates
turns the check off.

## Installing

Installers for Windows 10/11 (64-bit) and macOS 12+ (Apple Silicon and Intel) are built and tested by the
[release workflow](.github/workflows/release.yml):

* `Syncora-Setup-1.3.0.exe`
* `Syncora-1.3.0-macOS-arm64.dmg`
* `Syncora-1.3.0-macOS-x64.dmg`

Download them from the repository's Releases page, or from the workflow run's artifacts.

The builds are not signed with a paid certificate yet, so the system asks once before the first launch:

* **Windows:** "Windows protected your PC" → **More info** → **Run anyway**.
* **macOS:** open the DMG and drag Syncora to Applications. The first launch is blocked: open
  **System Settings → Privacy & Security** and click **Open Anyway**.

Projects are `.syncora` files. Projects from Multicam Sync (`.mcsync`) open and are upgraded.

## Documentation

* [Architecture](docs/ARCHITECTURE.md): processes, key decisions, the pipeline, IPC contract, repository structure.
* [Technical specification](docs/TECHNICAL_SPEC.md): requirements, media and metadata, cache, timecode, timeline,
  corrections, export, SQLite schema, targets.
* [Synchronisation engine](docs/SYNC_ENGINE.md): the DSP and placement algorithms, candidate search, confidence
  model, measured accuracy and speed, limitations.
* [Scalability test report](SCALABILITY_TEST_REPORT.md): stress, accuracy and database benchmarks.
* [Changelog](CHANGELOG.md): what changed in each version.
* [Design decisions](DESIGN_DECISIONS.md): how the interface follows the Syncora design handoff, and what is not
  implemented yet.
* [Milestones](docs/MILESTONES.md): delivery plan with exit criteria.

## Engine quick start

```bash
cd engine
python -m pip install -e ".[dev]"
python scripts/fetch_models.py        # the speech models into engine/models (transcription tests, the app)
python -m pytest -m "not slow"        # unit, synthetic-offset, pipeline and end-to-end tests
python -m pytest -m slow              # hour-long recordings with clock drift
python scripts/benchmark_sync.py      # speed on 10 min / 1 h / 3 h references

# Synchronise real footage from the command line (needs FFmpeg on PATH)
mcsync sync /path/to/card_dumps --project wedding.syncora --jam-synced

# What is said in a recording, with speakers, on this computer
mcsync transcribe ZOOM0001.WAV --language en

# Write the timeline for Premiere Pro / Resolve (.xml) or Resolve / Final Cut Pro (.fcpxml)
mcsync export wedding.syncora wedding.xml
mcsync export wedding.syncora wedding.fcpxml --rate 25 --start-tc 01:00:00:00

# An AI first cut of the synchronised project (wedding long version or podcast), as XML
mcsync cut wedding.syncora "wedding first cut.xml" --style wedding

# Benchmarks behind SCALABILITY_TEST_REPORT.md
python -m mcsync.testing.dbbench --media 5000 10000
python -m mcsync.testing.accuracy
python -m mcsync.testing.production FESTIVAL      # the 4,238-file test production (about 3 GB)
python -m mcsync.testing.stress FESTIVAL WORK --out report.json
```

```python
from mcsync.sync import ClipInput, SyncEngine, SyncOptions, prepare_signal

clips = [
    ClipInput("recorder", audio=prepare_signal(recorder_pcm, 48000), device_id="zoom"),
    ClipInput("camA_0001", audio=prepare_signal(cam_pcm, 48000), device_id="camA"),
]
result = SyncEngine(SyncOptions(reference_clip_id="recorder")).run(clips)
placement = result.placements["camA_0001"]
placement.start_s, placement.status, placement.confidence, placement.flags
```

## Desktop app quick start

Needs Node.js 22.12 or newer, Python 3.11 or newer, and FFmpeg on `PATH`.

```bash
python -m pip install -e engine           # the app runs the engine from source during development
python engine/scripts/fetch_models.py     # the speech models (Analyze stage)
cd app
npm ci
npm start                                 # build and launch
npm run dev                               # or: hot-reloading renderer

npm run typecheck && npm test             # unit tests
npm run build && npm run e2e              # the real app end to end (see app/e2e/README.md)
```

## Building the installers

Each installer is built on its own platform (what the release workflow does):

```bash
engine/packaging/build_ffmpeg.sh engine/dist/ffmpeg   # pinned, decode-only LGPL FFmpeg (needs nasm)
engine/packaging/build_engine.sh                      # frozen engine in engine/dist/mcsync-engine
cd app && npm ci && npm run build
npx electron-builder --win nsis --x64                 # or: --mac dmg --arm64 / --x64
pwsh scripts/installed-app.ps1 install                # or: scripts/installed-app.sh install arm64 (prints the path)
MCSYNC_E2E_APP="<installed Syncora executable>" npx playwright test e2e/app.spec.ts e2e/production.spec.ts
```
