# DeepSeek's effort, and what the wall actually applies

Probed 2026-11-13 from a DeepSeek provider card with the wall's own environment
(CLI 2.1.323), using `tools/probe-deepseek-effort.ts`. The raw rows are in the
card's scratch (`deepseek-effort.json` and `deepseek-effort-repeat.json`); this
is the reading they give.

## The provider's own dial works

`output_config.effort` is DeepSeek's depth control. On the "100 trailing zeros"
prompt, flash's median output tokens were **314 at low, 544 at high, 772 at max**,
all correct, with thinking rising alongside. The dial is real and monotonic.

Pro on the same prompt was nearly flat: medians **346 / 348 / 383** at none / high /
max. On this task Pro's effort bought almost nothing.

The provider API's model names are `deepseek-flash` and **`deepseek-v4-pro`**;
`deepseek-v4-pro-0813` is refused with a 400.

## The wall's `--effort` does not reach it

The CLI at the same prompt across `none`, `low`, `medium`, `high`, `xhigh`, `max`
produced **244 / 172 / 321 / 243 / 222 / 199** output tokens and **729 / 419 / 935 /
675 / 519 / 587** thinking characters: no monotonic effect, against a direct-API
spread of 314 to 772. The CLI translates `--effort` into Claude's thinking budget,
and DeepSeek ignores `thinking.budget_tokens`; its control is `output_config.effort`,
which the card path never sends. DeepSeek's own names are `low` (50), `high` (75)
and `max` (100); `medium` and `xhigh` both map to `high`.

So every effort label on a DeepSeek preset is cosmetic today. The honest preset is
`flash` with no effort claim. To make the levels real, the wall would have to pass
`output_config.effort` through a provider-specific path rather than the CLI's
`--effort`.

## Thinking is not off

`MAX_THINKING_TOKENS=0` is set on every provider card, and it does not suppress
DeepSeek's reasoning: at high, one prompt produced **692 thinking characters with
the variable at 0** and 821 with it unset. The DeepSeek card sessions likewise
carry thinking blocks on their turns. The setting is the CLI's Claude-side budget,
not a switch on the provider's model; the provider comment that calls it "thinking
off" is wrong about what the card does. The CLI strips thinking from the outgoing
request anyway (probed 2026-11-04), so the replay concern the comment was written
for does not depend on this variable.

## What people report, and what to do

The community's reading is that flash's sweet spot is **high**: max costs roughly
2.5–3x the output tokens for a few points, and agentic turns compound the cost
because prior reasoning is re-read. Our direct medians agree in direction (low <
high < max). So, when the wall can actually send the level: flash at high by
default, low for mechanical work, max only for a measured hard problem. Pro's
effort was nearly inert on this task; do not add a Pro preset for it.
