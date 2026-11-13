# pre-frontline-replay.b64

A saved public replay from before frontline foraging, kept as base64 text (76-character lines) so it can be read and
diffed as text. `recordings-across-change.test.ts` decodes it and serves those exact bytes as a stored replay.

The decoded object is 196952 bytes, SHA-256
`ec8016e6db4345a219ee0ed296b59ca1ffc941c538201ce86b6229474cbf7d67` (the test checks both). To check by hand:

```sh
base64 -d test/replays/fixtures/pre-frontline-replay.b64 | sha256sum
```

## How it was made

On main `810fe97148ef600b5b7c802bae3fdee4a8ee5b80`, before ground income was removed:

1. `playScripted({ seed: 6006, config: { ...newMatchConfig(PRE_FRONTLINE_CONFIGS.redesign), matchTicks: 620 },
   agents: 2, ticks: 620, attack: true })` played a 620-tick match on the stored pre-frontline redesign config,
   whose economy still paid held-ground income every 600 ticks.
2. `recordLog(lines)` recorded the match's stream frames; each was re-encoded as a public message with
   `encodePublicMessage(decodeMessage(frame))`.
3. `gzipMessages(frames)` packed them into a gzipped replay object; its gunzip is the same framed bytes the server's
   recorder stores for those frames.
4. The object was base64-encoded with `base64 -w 76`.

At tick 600 both colonies' stores rise with no delivery: the old payout, recorded in the frames. The simulation no
longer has that rule, so the replay plays only from its stored frames.
