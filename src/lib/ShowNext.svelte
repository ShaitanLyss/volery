<script lang="ts">
  /* The last chapter. It is a list of things that are not built yet, said with
   * the same plainness as the things that are, because the room will ask about
   * allowance and about other harnesses and both answers are "here is the
   * direction" rather than "no".
   */
  import { NEXT } from "./showcase";

  let { onclose }: { onclose: () => void } = $props();
</script>

<div class="next">
  <ol class="items">
    {#each NEXT as n, i (n.title)}
      <li class="item">
        <span class="n">{String(i + 1).padStart(2, "0")}</span>
        <div class="words">
          <div class="head">
            <span class="title">{n.title}</span>
            <span class="when" data-tone={n.tone}>{n.when}</span>
          </div>
          <p class="body">{n.body}</p>
        </div>
      </li>
    {/each}
  </ol>

  <div class="start">
    <div class="shead">
      <span class="stitle">try it now</span>
      <span class="shint">the wall is one key away</span>
    </div>
    <div class="steps">
      <div class="step"><kbd>space</kbd><kbd>h</kbd><span>opens this tour again, from anywhere</span></div>
      <div class="step"><kbd>ctrl</kbd><kbd>shift</kbd><kbd>O</kbd><span>a new conversation, empty sheet, nothing spawned until you send</span></div>
      <div class="step"><kbd>space</kbd><kbd>a</kbd><span>which subscriptions the wall spends, and what each has left</span></div>
      <div class="step"><kbd>space</kbd><kbd>v</kbd><kbd>v</kbd><span>how the wall looks, and how the reading is set</span></div>
    </div>
    <div class="last">
      <p>If something you use every day is missing, say so. It is our app, and the person who builds it is in the room.</p>
      <button type="button" class="back" onclick={onclose}>back to the wall</button>
    </div>
  </div>
</div>

<style>
  .next {
    display: grid;
    gap: 18px;
  }
  .items {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 2px;
  }
  .item {
    display: grid;
    grid-template-columns: 30px minmax(0, 1fr);
    gap: 10px;
    padding: 13px 12px;
    border-bottom: 1px solid color-mix(in oklab, var(--edge) 50%, transparent);
  }
  .item:last-child {
    border-bottom: 0;
  }
  .n {
    font-size: 10px;
    font-variant-numeric: tabular-nums;
    color: var(--paper-faint);
    padding-top: 3px;
  }
  .words {
    display: grid;
    gap: 4px;
  }
  .head {
    display: flex;
    align-items: baseline;
    gap: 10px;
  }
  .title {
    font: 400 19px/1.25 var(--display);
    color: var(--paper);
  }
  .when {
    margin-left: auto;
    font-size: 9px;
    letter-spacing: 0.07em;
    text-transform: uppercase;
    color: var(--paper-faint);
    white-space: nowrap;
  }
  .when[data-tone="now"] {
    color: color-mix(in oklab, var(--st-work) 78%, var(--paper-mute));
  }
  .when[data-tone="next"] {
    color: color-mix(in oklab, var(--st-ask) 72%, var(--paper-mute));
  }
  .body {
    margin: 0;
    font: 12.5px/1.62 var(--body);
    color: var(--paper-mute);
    max-width: 78ch;
  }
  .start {
    border-radius: 13px;
    border: 1px solid color-mix(in oklab, var(--edge) 80%, transparent);
    background: linear-gradient(180deg, color-mix(in oklab, var(--surface) 100%, var(--paper) 2%), var(--surface));
    padding: 14px 16px 15px;
    display: grid;
    gap: 12px;
  }
  .shead {
    display: flex;
    align-items: baseline;
    gap: 10px;
  }
  .stitle {
    font: 400 18px/1.2 var(--display);
    color: var(--paper);
  }
  .shint {
    margin-left: auto;
    font-size: 10.5px;
    color: var(--paper-faint);
  }
  .steps {
    display: grid;
    gap: 7px;
  }
  .step {
    display: flex;
    align-items: baseline;
    gap: 6px;
    font-size: 11.5px;
    color: var(--paper-mute);
    flex-wrap: wrap;
  }
  .step span {
    margin-left: 6px;
  }
  kbd {
    font-family: var(--util);
    font-size: 9.5px;
    color: var(--paper-mute);
    padding: 1px 5px;
    border-radius: 4px;
    border: 1px solid var(--edge);
    background: color-mix(in oklab, var(--well) 50%, transparent);
  }
  .last {
    display: flex;
    align-items: center;
    gap: 16px;
    padding-top: 11px;
    border-top: 1px solid color-mix(in oklab, var(--edge) 55%, transparent);
  }
  .last p {
    margin: 0;
    font: 12.5px/1.6 var(--body);
    color: var(--paper-dim);
    max-width: 62ch;
  }
  .back {
    margin-left: auto;
    flex: none;
    height: 31px;
    padding: 0 13px;
    border-radius: 7px;
    border: 1px solid color-mix(in oklab, var(--edge) 70%, var(--paper) 9%);
    background: linear-gradient(180deg, color-mix(in oklab, var(--raised) 100%, var(--paper) 5%), var(--raised));
    color: var(--paper);
    font: inherit;
    font-size: 11.5px;
    cursor: pointer;
  }
  .back:hover {
    border-color: color-mix(in oklab, var(--edge) 45%, var(--paper) 25%);
  }
  @media (max-width: 760px) {
    .last {
      flex-direction: column;
      align-items: flex-start;
    }
    .back {
      margin-left: 0;
    }
  }
</style>
