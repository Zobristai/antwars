# Stable 3D queen-framing fixture

`queen-framing-3d.bin` preserves the offline central-lake founding scene used by the 3D queen-framing capture at source `8a1815bec17decf53d5c161e437bf1d85879d6f0`.

- SHA-256: `ef3dd104456106c2677c98fa8c26633a2e558cc3bdec9dfeb03e8126579ff753`
- Original fixture: `startBoxFixture('central-lake')`, seed 7001, 128×96 fine tiles, grid scale 2, eight starting queens and no agents. Arranged normal founding at tile [26,0] adds the ninth queen.
- Only message ticks were shifted from 0/1 to 100/101; embedded event timestamps are unchanged. This separates founding from the tick-zero opening transition.
- The original unshifted bytes have SHA-256 `13a9fa1a32dacd66a8341326993256309f88dca11ca37db9e9c6cc968c3addf6`.

These bytes were reproduced and hash-checked before the candidate changed simulation baselines, then retained exactly. The capture reads the frozen file, not the current simulator: subsequent simulation fixes must not silently change the comparison scene. This is a synthetic offline recording, not evidence of a live match or an agent join.
