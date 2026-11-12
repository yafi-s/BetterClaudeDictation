# Benchmark results

Run 2026-11-12 on Windows, Node v24.15.0. 10 sentences of synthetic speech (Windows' built-in voice, 24 kHz), the same audio for every setup; streaming setups send it in real time. Latency includes the network round trip to OpenAI.

| Setup | First word ready (median) | Release → final text (median) | Release → final text (p90) | Word error rate | Tech terms written exactly |
| --- | --- | --- | --- | --- | --- |
| This mod (streaming + hints) | 967 ms | 574 ms | 680 ms | 0.0% (0/114 words) | 11/12 |
| Streaming, no hints | 915 ms | 460 ms | 674 ms | 0.0% (0/114 words) | 10/12 |
| Record, then upload (gpt-transcribe) | only at the end | 459 ms | 675 ms | 0.0% (0/114 words) | 11/12 |

Word error rate ignores case and punctuation. "Tech terms written exactly" counts the vocabulary terms in each sentence (README, Kubernetes, Claude Code, ...) that came back spelled and capitalized exactly. First word ready is counted from the start of the clip, which opens with a short silence.

Opening a stream takes about 245 ms; the mod opens one ahead of time, so a press never waits for it.

## A long dictation

All 10 sentences as one 53-second dictation, with a 900 ms pause between sentences. The mod streams it and finalizes each sentence at its pause, so on release only the last sentence is left; the upload sends and transcribes the whole clip after release.

| Run | This mod: release → full text | Record, then upload: release → full text | Word errors (mod / upload) |
| --- | --- | --- | --- |
| 1 | 405 ms | 1304 ms | 0/114 / 0/114 |
| 2 | 646 ms | 1275 ms | 0/114 / 0/114 |
| 3 | 418 ms | 1416 ms | 0/114 / 0/114 |
| Median | 418 ms | 1304 ms | |

## Opening the microphone

| Capture path | First audio after the press (median) | Runs |
| --- | --- | --- |
| This mod: native WinMM capture (first run is a cold open) | 33 ms | 117, 35, 25, 33, 27 ms |
| ffmpeg DirectShow capture, 20 ms buffer | 797 ms | 797, 798, 700 ms |

Audio that arrives before the mic opens is lost, so this is how much of your first word a press can clip.

## Per sentence

| # | Sentence | Mod | No hints | Upload |
| --- | --- | --- | --- | --- |
| 1 | Refactor the login handler so it returns an error when the token is expired. | 494 ms, 0 err: Refactor the login handler so it returns an error when the token is expired | 473 ms, 0 err: Refactor the login handler so it returns an error when the token is expired. | 675 ms, 0 err: Refactor the login handler so it returns an error when the token is expired. |
| 2 | Run npm install, then run the pytest suite with the verbose flag. | 811 ms, 0 err: Run npm install, then run the pytest suite with the verbose flag. | 651 ms, 0 err: Run npm install, then run the pytest suite with the verbose flag. | 459 ms, 0 err: Run npm install, then run the pytest suite with the verbose flag. |
| 3 | Open the README and add a section about Docker Compose. | 405 ms, 0 err: Open the README and add a section about Docker Compose. | 944 ms, 0 err: Open the readme and add a section about Docker Compose. | 379 ms, 0 err: Open the README and add a section about Docker Compose. |
| 4 | Rename the Kubernetes deployment from web to API gateway. | 577 ms, 0 err: Rename the Kubernetes deployment from web to api-gateway. | 410 ms, 0 err: Rename the Kubernetes deployment from web to api-gateway. | 513 ms, 0 err: Rename the Kubernetes deployment from web to API gateway. |
| 5 | Write a TypeScript function that parses the JSON config and validates every field. | 548 ms, 0 err: Write a TypeScript function that parses the JSON config and validates every field. | 460 ms, 0 err: Write a TypeScript function that parses the JSON config and validates every field. | 404 ms, 0 err: Write a TypeScript function that parses the JSON config and validates every field. |
| 6 | Check why the GitHub Actions workflow fails on the lint step. | 628 ms, 0 err: Check why the GitHub Actions workflow fails on the lint step. | 392 ms, 0 err: Check why the GitHub Actions workflow fails on the lint step. | 904 ms, 0 err: Check why the GitHub Actions workflow fails on the lint step. |
| 7 | Move the database migration into its own commit and push the branch. | 573 ms, 0 err: Move the database migration into its own commit and push the branch. | 403 ms, 0 err: Move the database migration into its own commit and push the branch. | 384 ms, 0 err: Move the database migration into its own commit and push the branch. |
| 8 | Add a React hook that debounces the search input. | 592 ms, 0 err: Add a React hook that debounces the search input. | 674 ms, 0 err: Add a React hook that debounces the search input. | 389 ms, 0 err: Add a React hook that debounces the search input. |
| 9 | Explain what this Python decorator does and whether it leaks memory. | 574 ms, 0 err: Explain what this Python decorator does and whether it leaks memory. | 424 ms, 0 err: Explain what this Python decorator does and whether it leaks memory. | 591 ms, 0 err: Explain what this Python decorator does and whether it leaks memory. |
| 10 | Ask Claude Code to summarize the diff before I open the pull request. | 680 ms, 0 err: Ask Claude Code to summarize the diff before I open the pull request. | 674 ms, 0 err: Ask Claude Code to summarize the diff before I open the pull request. | 619 ms, 0 err: Ask Claude code to summarize the diff before I open the pull request. |
