# de-thorsten.wav

Test audio for the local speech recognition smoke test
(`scripts/stt-local-smoke.mjs`). Synthetic speech, no real person's recording.

- File: `de-thorsten.wav`, PCM16, mono, 16 000 Hz, 6.06 s, 193 978 bytes
  (44-byte header)
- sha256: `bee93b18ab11b4e84d6b208734e13762b9f6dc0ff30566b25071d83593df2a46`
- Text spoken: `Guten Morgen, bitte lege eine neue Aufgabe für Donnerstag an und erinnere mich um neun Uhr an das Kundengespräch.`

## Voice

- Piper voice `de_DE-thorsten-medium` (quality medium, 22 050 Hz, one speaker),
  from `rhasspy/piper-voices` at commit `e9c8a39444359388adaa94255becb37a5a2b8e51`
- Model card: <https://huggingface.co/rhasspy/piper-voices/blob/e9c8a39444359388adaa94255becb37a5a2b8e51/de/de_DE/thorsten/medium/MODEL_CARD>
  ("Dataset … License: CC0"; finetuned from the rdh base model, also CC0)
- Voice repository licence: MIT (`rhasspy/piper-voices`)
- Model file sha256: `de_DE-thorsten-medium.onnx`
  `fd270eb3d1ebf91d763f8a0f949b1b1bebdfefaea18c3aaf8577dd34536e064f`,
  `de_DE-thorsten-medium.onnx.json`
  `e5bb7410dcbbcc0be6f4544f6bc66612b315ab5cb3099ec44bb46d860bc7cca9`

## Dataset licence

Thorsten-Voice by Thorsten Müller, CC0 1.0 Universal (public domain dedication):

- <https://github.com/thorstenMueller/Thorsten-Voice> (`LICENSE`: CC0 1.0 Universal)
- Zenodo records <https://doi.org/10.5281/zenodo.5525342> (Thorsten-Voice
  Dataset 2021.02) and <https://doi.org/10.5281/zenodo.7265581> (2022.10), both
  licensed `cc-zero`

The voice and its dataset carry no conditions that committing synthesized audio
to this Apache-2.0 repository could not meet. Credit to Thorsten Müller
(Thorsten-Voice) is given here as the author asks.

## How it was made

- Synthesis: `piper-tts` 1.8.0 (Python package, `PiperVoice.synthesize_wav`,
  default inference settings), checked 2026-11-21. The synthesizer's own
  licence does not apply to its output.
- Conversion: ffmpeg 8.0.1,
  `ffmpeg -i raw.wav -ar 16000 -ac 1 -c:a pcm_s16le -map_metadata -1 -fflags +bitexact -flags:a +bitexact de-thorsten.wav`
