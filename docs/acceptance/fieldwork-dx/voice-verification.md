# Speech regression evidence

Checked the packed SDK installed in the isolated Fieldwork consumer at
`/tmp/glirastes-dx-consumer`, Chrome headless with synthetic microphone input,
2026-11-15. Original Fieldwork evidence was read only.

- `voice-unit-tests.txt`: 90 tests, 12 files pass, including STT controller,
  capture, recorded adapter, composer lifecycle, permission/retry, draft and server.
- `voice-package-tests.txt`: 7 packed consumer tests pass. The new public asset
  resolves through the installed package and executes registration + actual PCM
  conversion in an AudioWorklet host; all Node API entries still import/typecheck.
- `voice-browser-results.json`: actual missing `/assets/speech.js` yields localized
  error, ends its microphone track and closes its AudioContext. Retry loads the
  restored public asset and completes a real OpenRouter transcription (HTTP 200).
  Final text remains editable, with **zero chat POSTs**. Cancel makes no STT
  request and preserves the prior draft. All observed tracks/contexts close.
- `voice-lifecycle-results.json`: separate run with mocked transcription (no extra
  provider cost), actual Next router navigation to `/team` and creating a new
  session release resources. One microphone stream per recording throughout.
- Reload while recording completed. Its prior document's post-unmount resource
  state cannot be observed from the new document; deterministic unmount tests
  verify cleanup, so reload is not presented as an instrumented cleanup proof.
- `voice-asset-error.png`, `voice-draft.png`: inspected browser screenshots.

Run `voice-dx.cjs` **from the consumer directory**, after copying the original
synthetic `evidence/voice-fixture.wav`. It requires installed Chrome, server 3218,
`FIELDWORK_ORIGIN=http://127.0.0.1:3218`, and the adapter's configured worklet URL
`/assets/speech.js`. `VOICE_FAKE=1` mocks transcription; default uses one real
OpenRouter request. The script temporarily renames only the consumer asset and
restores it in `finally`. Do not run concurrently against the same public asset.

The first browser retry returned 401 because this copied app still configured
its public origin at 3217. Restarting it with 3218 fixed that integration error;
no authorization check was weakened. Playwright page routing did not intercept
AudioWorklet-thread fetches, so the asset failure uses a real missing public file.

The consumer removed its old CSS mic/retry placeholder replacements; these
otherwise duplicate the new SVG icons. The migration guide documents this. The
consumer's explicit newTitle was also removed: the visible default is now the
provider locale's “Neuer Chat”. No physical microphone quality claim is made.
