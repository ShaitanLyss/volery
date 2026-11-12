<script lang="ts">
  /* Dev only, for looking at the worth block in a browser (§22). Not imported
     by anything the app builds. */
  import AccountWorth from "./AccountWorth.svelte";
  import { readingOf, type RateBin, type WindowReading } from "./equivalence";

  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;
  /* Midnight, so a bin built at `since + h * HOUR` really is hour `h`: a span
     starting at 15:00 rotates every cell by fifteen hours, which is a fixture
     that lies about the shape it is there to show. */
  /* Local midnight, because the grid is grouped by the reader's own clock:
     a UTC-anchored span would put the shape eleven hours off in Sydney, which
     is the bug this fixture caught in the component. */
  const since = new Date(2026, 10, 12).getTime();
  const now = new Date(2026, 11, 10).getTime();

  function bins(account: string, kind: string, base: number): RateBin[] {
    const out: RateBin[] = [];
    for (let d = 0; d < 28; d++) {
      const day = new Date(2026, 10, 12 + d);
      const weekday = (day.getDay() + 6) % 7;
      for (let h = 0; h < 24; h++) {
        /* A working day that gets dearer through the morning, and a weekend
           that is mostly quiet: the shape the heatmap is for. */
        const busy = weekday < 5 ? 1 : 0.35;
        const peak = weekday < 5 && h >= 9 && h < 18 ? 1.45 : 1;
        const points = h === 3 && d % 5 === 0 ? 0 : (2 + ((h * 7 + d) % 5)) * busy;
        if (points <= 0) continue;
        const usd = points * base * peak;
        out.push({
          at: new Date(2026, 10, 12 + d, h).getTime(),
          account,
          kind,
          scope: "",
          points,
          usd,
          /* Tokens follow the dollars at the blended price this wall actually runs
           (about $0.31 per million, measured over 28 days of its own facts), so
           the two columns cannot imply different prices. */
          tokens: points * (kind === "session" ? 6_450_000 : 38_700_000),
          mix: { "claude-opus-5-5": 0.35, "claude-sonnet-5-5": 0.6, "claude-haiku-5-5": 0.05 },
        });
      }
    }
    return out;
  }

  const readings: WindowReading[] = [
    readingOf(bins("lyss", "session", 2), "lyss", "session", since, now, 4),
    readingOf(bins("lyss", "weekly_all", 12), "lyss", "weekly_all", since, now, 4),
  ];
</script>

<div class="frame">
  <p class="label">a stand-in for one account's row, as the panel draws it</p>
  {#each readings as reading, i (i)}
    <AccountWorth
      label="lyss"
      kind={i === 0 ? "the 5-hour window" : "the weekly window"}
      {reading}
      spanDays={28}
    />
  {/each}
</div>

<style>
  .frame {
    width: 460px;
    margin: 24px;
    padding: 12px 14px;
    border: 1px solid var(--edge);
    border-radius: 8px;
    background: var(--surface);
  }
  .label {
    margin: 0 0 8px;
    font-size: 10.5px;
    color: var(--paper-mute);
  }
</style>
