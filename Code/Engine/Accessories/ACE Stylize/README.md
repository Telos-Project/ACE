# ACE Stylize

An optional visual pass over any ACE demo's canvas. It changes nothing about
ACE itself — the document, the reconciler, and the simulation run exactly as
they do without this. This only reads pixels the adapter has already drawn
and hands them to one of two backends, then shows what comes back instead.

Two backends, chosen at runtime, never both at once:

- **lucy** — Decart's hosted real-time video API. No local GPU, no install
  beyond a small JS SDK, billed per second while connected.
- **streamdiffusion** — a local server you run yourself, on your own GPU.
  Free to run, needs real hardware, and is the slower of the two to set up.

Both are driven by the same default intent: **enhance what's already on
screen rather than replace it.** The built-in prompt (`AceStylize.DEFAULT_PROMPT`
in `ace-stylize.js`) asks for more detail at the same composition — "as though
every model were re-rendered at maximum polygon count" — and both backends are
configured, by default, to lean toward preserving structure over reinventing
it. A custom style prompt overrides this outright; how far it's allowed to
depart from the source frame is a config value either way, documented below.

## 1 — Using it

Add one script tag after `ace.js` and `aceOperators.js` on any demo page:

```html
<script src="../stylize/ace-stylize.js"></script>
<script>
	AceStylize.attach(document.querySelector("canvas"), {
		backend: "off"   // start idle; switch from the panel, or set this directly
	});
</script>
```

That's it — a small panel appears in the corner where a backend can be picked
and a custom style typed in, live, while the scene runs. Nothing connects and
nothing costs anything until a backend is chosen there, or passed to `attach()`
directly with `autoStart: true`.

```js
AceStylize.attach(canvas, {
	backend: "lucy",
	apiKey: "...",
	autoStart: true,
	panel: false   // no on-screen control, just the pass itself
});
```

`attach()` returns `{ setPrompt(text), detach() }` for driving it from code —
useful if the game itself, rather than a person, should be the one changing
the style (a boss fight shifting the palette, say).

## 2 — Backend: lucy (hosted)

### Install

```bash
npm install @decartai/sdk
```

For a plain `<script>` page with no bundler (which is how every ACE demo is
built), load it from a CDN as an ES module instead and expose it globally,
before `ace-stylize.js`:

```html
<script type="module">
	import { createDecartClient, models } from "https://esm.sh/@decartai/sdk";
	window.decartai = { createDecartClient, models };
</script>
<script src="../stylize/ace-stylize.js"></script>
```

### Get a key

An API key from [platform.decart.ai](https://platform.decart.ai). Nothing
here stores or transmits it anywhere but directly to Decart's connection call.

### Configure

```js
AceStylize.attach(canvas, {
	backend: "lucy",
	apiKey: "sk-...",
	model: "lucy-2.5",   // default. see "models" below
	enhance: true,        // default — see note below
	prompt: null,          // default — the built-in enhance prompt
	fps: 24
});
```

| field | default | meaning |
|---|---|---|
| `apiKey` | — | required |
| `model` | `"lucy-2.5"` | which Decart realtime model to connect to |
| `enhance` | `true` | a real flag in Decart's own API, passed alongside the prompt; it is what most directly matches "better, not different" |
| `prompt` | `null` → `DEFAULT_PROMPT` | the style. Set your own string for a real restyle |
| `fps` | `24` | the rate frames are captured from the canvas and sent |

### Models

Decart ships several realtime models under this API and the lineup moves
fast; check [platform.decart.ai](https://platform.decart.ai) for the current
list before relying on a name. Two worth knowing from what's live as this was
written:

- `lucy-2.5` (default) — targeted edits that preserve the rest of the frame,
  which is the closer fit for "enhance."
- `lucy-restyle-2` — a fuller restyle (their own example prompt is
  `"Cyberpunk city"`); reach for this when the custom style should look like a
  different world, not a sharper version of the same one.

### What it costs

Metered per second of video while connected — check current pricing on
Decart's platform before leaving this running unattended. `detach()` or the
panel's disconnect button ends the session immediately.

## 3 — Backend: streamdiffusion (local)

Runs entirely on your machine. Slower to set up, and needs a real GPU to be
worth using — see hardware below — but nothing about it bills anyone.

### Install

**Step 1 — torch, matched to your GPU, before anything else:**

```bash
# NVIDIA, CUDA 12.1 — the common case
pip install torch==2.1.0 torchvision==0.16.0 --index-url https://download.pytorch.org/whl/cu121

# NVIDIA, CUDA 11.8
pip install torch==2.1.0 torchvision==0.16.0 --index-url https://download.pytorch.org/whl/cu118

# Apple Silicon — StreamDiffusion's own Mac support is community maintained
# and narrower (img2img only, as used here, is the tested path); see
# https://github.com/patrickhartono/StreamDiffusion-Mac if the main install
# below gives you trouble on macOS.
pip install --pre torch torchvision
```

**Step 2 — StreamDiffusion itself, from source (it isn't on PyPI under a
stable name):**

```bash
pip install git+https://github.com/cumulo-autumn/StreamDiffusion.git
```

**Step 3 — everything else:**

```bash
cd stylize/server
pip install -r requirements.txt
```

Optionally, `pip install xformers` matched to your CUDA version for a real
speed gain; the server runs without it, just slower.

### Run it

```bash
cd stylize/server
cp config.example.json config.json   # then edit as you like
python streamdiffusion_server.py --config config.json
```

The first run downloads the model weights (a few GB) and can take a while.
Once you see `listening on ws://localhost:8189/`, it's ready.

### Configure

```js
AceStylize.attach(canvas, {
	backend: "streamdiffusion",
	endpoint: "ws://localhost:8189/stylize",
	prompt: null,   // default — sent to the server as the img2img prompt
	fps: 12,          // lower than lucy's default; see "how fast" below
	quality: 0.82      // JPEG quality for the frames sent to the server
});
```

The heavier tuning knobs live in `config.json` on the server, not in the
browser call, since they're about the model running there:

| field | default | meaning |
|---|---|---|
| `mode` | `"sdxl-turbo"` | `"sdxl-turbo"` (heavier, more detail), `"sd-turbo"` (lighter), or `"lcm"` (any SD1.5 checkpoint + an LCM LoRA) |
| `t_index_fractions` | `[0.68, 0.78, 0.88]` | **the one knob that controls enhance-vs-reinvent.** Fractions of the way through the model's denoising schedule where img2img starts. Higher (closer to 1.0) stays closer to the input frame and costs less; lower lets the model depart further from it and costs more. Move these down for a custom style that should look substantially different |
| `width`, `height` | `512` | the resolution frames are processed at, independent of the canvas's own resolution |
| `device` | `"cuda"` | `"cuda"`, `"mps"`, or `"cpu"` — cpu runs, at a speed that demonstrates why it isn't the default |

### How fast this actually is

Real numbers, on your hardware, are the only ones that matter here — this
wasn't benchmarked on the machine that wrote it, because it has no GPU. As a
starting point: SDXL-Turbo-class single-step img2img pipelines are generally
reported in the few-frames-per-second range on a mid-range consumer GPU (an
RTX 3060–4070 class card), climbing toward real interactive rates on a 4080/
4090. `mode: "sd-turbo"` is the lighter option if `sdxl-turbo` is short of
real time on your card. The server logs a warning per frame that takes longer
than 200ms, which is the fastest way to tell whether you're keeping up.

## 4 — Hardware

**lucy** needs none of your own — Decart's servers do the work.

**streamdiffusion** needs a CUDA GPU to be worth running at all. Roughly:

- **8–12GB VRAM**: `sd-turbo` or `lcm`, modest resolution (384–512px)
- **16GB+ VRAM**: `sdxl-turbo` comfortably at 512px
- **Apple Silicon**: works via the community Mac fork linked above, at
  meaningfully lower speed than CUDA — treat it as a way to confirm the
  pipeline runs, not as a real-time path

None of this is what you'd want for Lucy Edit, which is a different Decart
model entirely (batch clip editing, not a live per-frame filter) — see the
earlier discussion in this project's history if you're deciding between them.

## 5 — What this doesn't verify

Nothing here has been run against a live GPU or a real Decart API key — there
was no GPU available to test against, and no key to spend against. Both
backends are checked for what can be checked without either: the JavaScript
parses, the Python compiles and its config round-trips through JSON, and
every configuration field documented above is one the code actually reads —
none of them are left wired to nothing. Whether the result looks good, and
whether either backend keeps up with a running game in practice, are the
next things to find out on real hardware.
