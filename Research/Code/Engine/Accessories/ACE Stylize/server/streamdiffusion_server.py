#!/usr/bin/env python3

"""

	streamdiffusion_server.py — a local, self-hosted backend for
	ace-stylize.js's "streamdiffusion" mode.

		python streamdiffusion_server.py [--config config.json]

	Holds one StreamDiffusion pipeline in memory and answers a WebSocket per
	browser tab. A tab sends JPEG frames of whatever its ACE canvas drew;
	this runs each one through img2img and sends a JPEG back. Nothing about
	ACE or the document passes through this file at all — it only ever sees
	pixels in and pixels out, which is what keeps it usable with any ACE
	scene without knowing anything about the format.

	Requirements are in requirements.txt beside this file; see
	stylize/README.md for the fuller walkthrough, including why the CUDA
	wheel index has to be chosen for your own machine.

"""

import argparse
import asyncio
import io
import json
import sys
import time

try:
	import torch
	from PIL import Image
	import websockets
except ImportError as error:
	sys.exit(
		"missing a dependency (" + str(error) + ").\n"
		"Run: pip install -r requirements.txt\n"
		"See stylize/README.md for the CUDA-specific torch install first."
	)


DEFAULT_CONFIG = {
	# "sdxl-turbo" (heavier, higher fidelity) or "sd-turbo" / "lcm" (lighter,
	# faster — better for a modest GPU). See README.md for the tradeoff.
	"mode": "sdxl-turbo",

	# How much the output is allowed to depart from the input frame is set by
	# where img2img starts in the denoising schedule, below — there is no
	# separate strength number: t_index_fractions is the one knob that
	# actually reaches the pipeline, so nothing here can look configured and
	# quietly do nothing.
	#
	# Where in the denoising schedule img2img starts, expressed as fractions
	# of the model's total steps. Fewer, later entries means less change per
	# frame and less GPU work; more, earlier entries means more creative
	# freedom and more work. These are read as fractions and scaled to
	# whatever step count the chosen mode actually uses.
	"t_index_fractions": [0.68, 0.78, 0.88],

	"width": 512,
	"height": 512,
	"guidance_scale": 1.0,
	"seed": 2,

	"host": "localhost",
	"port": 8189,

	# cuda | mps | cpu. cpu will run, at a speed that makes the point of
	# this exercise, which is why it is not the default.
	"device": "cuda",
	"dtype": "float16"
}

MODELS = {
	"sdxl-turbo": {
		"checkpoint": "stabilityai/sdxl-turbo",
		"lcm": False,
		"steps": 4,
		"vae": "madebyollin/taesdxl"
	},
	"sd-turbo": {
		"checkpoint": "stabilityai/sd-turbo",
		"lcm": False,
		"steps": 4,
		"vae": "madebyollin/taesd"
	},
	"lcm": {
		# A general SD1.5 checkpoint with the LCM LoRA fused in, per
		# StreamDiffusion's own recipe. Swap "checkpoint" for any SD1.5
		# model this way.
		"checkpoint": "runwayml/stable-diffusion-v1-5",
		"lcm": True,
		"steps": 50,
		"vae": "madebyollin/taesd"
	}
}


def load_config(path):

	config = dict(DEFAULT_CONFIG)

	if path is not None:
		with open(path) as file:
			config.update(json.load(file))

	return config


class Pipeline:

	"""
	One StreamDiffusion instance, built once and reused for every connection.
	A second connection sharing it is fine — frames are processed as they
	arrive, one at a time, same as a single tab would see.
	"""

	def __init__(self, config):

		# Imported here, not at module scope, so that --help and config
		# errors are fast and do not first wait on a CUDA-capable torch to
		# come up.
		from diffusers import AutoencoderTiny, AutoPipelineForImage2Image
		from streamdiffusion import StreamDiffusion
		from streamdiffusion.image_utils import postprocess_image

		self.postprocess_image = postprocess_image
		self.config = config

		spec = MODELS.get(config["mode"])

		if spec is None:
			raise SystemExit(
				'config "mode" must be one of: ' + ", ".join(MODELS)
			)

		device = torch.device(config["device"])
		dtype = getattr(torch, config["dtype"])

		print("[stylize] loading", spec["checkpoint"], "on", config["device"],
			"— first run downloads the weights, which can take a while")

		base = AutoPipelineForImage2Image.from_pretrained(
			spec["checkpoint"], torch_dtype=dtype
		).to(device=device, dtype=dtype)

		total_steps = spec["steps"]

		t_index_list = sorted(set(
			min(total_steps - 1, max(0, round(fraction * total_steps)))
			for fraction in config["t_index_fractions"]
		))

		if not t_index_list:
			t_index_list = [total_steps - 1]

		self.stream = StreamDiffusion(
			base,
			t_index_list=t_index_list,
			torch_dtype=dtype,
			width=config["width"],
			height=config["height"]
		)

		if spec["lcm"]:
			self.stream.load_lcm_lora()
			self.stream.fuse_lora()

		self.stream.vae = AutoencoderTiny.from_pretrained(
			spec["vae"]
		).to(device=device, dtype=dtype)

		try:
			base.enable_xformers_memory_efficient_attention()
		except Exception:
			pass  # optional; absence only costs some speed

		self.prompt = None

		self.set_prompt(config.get("prompt") or (
			"highly detailed, sharp focus, high resolution, refined lighting, "
			"same composition and layout"
		))

		print("[stylize] ready:", config["mode"],
			"steps used", t_index_list, "of", total_steps)

	def set_prompt(self, text):

		if text == self.prompt:
			return

		self.prompt = text

		self.stream.prepare(
			prompt=text,
			guidance_scale=self.config["guidance_scale"],
			seed=self.config["seed"]
		)

		print("[stylize] prompt set:", text[:80] + ("..." if len(text) > 80 else ""))

	def run(self, frame: Image.Image) -> Image.Image:

		sized = frame.convert("RGB").resize(
			(self.config["width"], self.config["height"])
		)

		tensor = self.stream.preprocess_image(sized)
		output = self.stream(tensor)

		return self.postprocess_image(output, output_type="pil")[0]


async def handle(connection, pipeline, lock):

	print("[stylize] client connected")

	try:
		async for message in connection:

			if isinstance(message, str):

				try:
					event = json.loads(message)
				except ValueError:
					continue

				if event.get("type") in ("configure", "prompt") and event.get("prompt"):

					async with lock:
						pipeline.set_prompt(event["prompt"])

				continue

			# A binary message is one JPEG frame.
			started = time.time()

			try:
				frame = Image.open(io.BytesIO(message))
			except Exception:
				continue

			async with lock:
				styled = await asyncio.get_event_loop().run_in_executor(
					None, pipeline.run, frame
				)

			out = io.BytesIO()
			styled.save(out, format="JPEG", quality=85)

			await connection.send(out.getvalue())

			elapsed = time.time() - started

			if elapsed > 0.2:
				print("[stylize] frame took %.2fs — behind real time" % elapsed)

	except Exception as error:
		print("[stylize] connection ended:", error)

	print("[stylize] client disconnected")


async def main(config):

	pipeline = Pipeline(config)
	lock = asyncio.Lock()

	async def handler(connection):
		await handle(connection, pipeline, lock)

	async with websockets.serve(
		handler, config["host"], config["port"], max_size=20_000_000
	):
		print("[stylize] listening on ws://%s:%d/" %
			(config["host"], config["port"]))
		print("[stylize] point ace-stylize.js's streamdiffusion endpoint here")

		await asyncio.Future()


if __name__ == "__main__":

	parser = argparse.ArgumentParser(description=__doc__)
	parser.add_argument("--config", default=None,
		help="path to a JSON file overriding config.example.json's defaults")

	args = parser.parse_args()

	try:
		asyncio.run(main(load_config(args.config)))
	except KeyboardInterrupt:
		pass
