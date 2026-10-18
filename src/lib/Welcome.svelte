<script lang="ts">
  /* The first launch (`docs/chat-mode.md` §6.9): which view to start in, asked
     once, on an install that has never held a conversation (`viewmode.ts::opening`
     decides when). Approved by Lyss as drawn — the words included, which were
     checked against the humanizer's pattern list, so change none of them
     without the same check.

     Neither way is pre-selected: the bright button follows the pointer or the
     keyboard, ← or → and then Enter. Nothing behind it answers a key while it is
     up — the keydown stops here — and it takes the focus when it opens, because
     there is nothing else on the window to be doing. */
  import type { View } from "./viewmode";
  import Icon from "./Icon.svelte";
  import WindowControls from "./WindowControls.svelte";

  let { onchoose }: { onchoose: (to: View) => void } = $props();

  let root = $state<HTMLElement>();
  let chatBtn = $state<HTMLButtonElement>();
  let wallBtn = $state<HTMLButtonElement>();

  $effect(() => {
    root?.focus();
  });

  function onKey(e: KeyboardEvent) {
    e.stopPropagation();
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      chatBtn?.focus();
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      wallBtn?.focus();
    } else if (e.key === "Enter") {
      /* Taken here rather than left to the button's own activation, so it
         means the same whichever element the focus is really on: with neither
         chosen yet, Enter does nothing — nothing is pre-selected (§6.9). */
      const on = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>("[data-way]")?.dataset.way;
      e.preventDefault();
      if (on === "chat" || on === "wall") onchoose(on);
    }
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div class="first" role="dialog" aria-modal="true" aria-labelledby="first-q" tabindex="-1" bind:this={root} onkeydown={onKey}>
  <header class="wbar" data-tauri-drag-region>
    <svg class="mark" viewBox="0 0 24 24" aria-hidden="true">
      <defs>
        <linearGradient id="first-markg" x1="0.15" y1="0.95" x2="0.9" y2="0.1">
          <stop offset="0" stop-color="var(--st-work)" />
          <stop offset="1" stop-color="var(--st-ask)" />
        </linearGradient>
      </defs>
      <circle cx="12" cy="12" r="8.2" fill="none" stroke="var(--edge)" stroke-width="3.4" />
      <path d="M12 3.8a8.2 8.2 0 1 1-8 6.4" fill="none" stroke="url(#first-markg)" stroke-width="3.4" stroke-linecap="round" />
    </svg>
    <span class="word" data-tauri-drag-region>volery</span>
    <span class="grow" data-tauri-drag-region></span>
    <span class="winctl"><WindowControls /></span>
  </header>

  <div class="welcome">
    <h1 id="first-q">how would you like to see your conversations?</h1>
    <p class="lede">Both run the same agents on this computer, and you can switch whenever you like.</p>

    <div class="pair">
      <button type="button" class="way" data-way="chat" bind:this={chatBtn} onclick={() => onchoose("chat")}>
        <div class="art" aria-hidden="true">
          <div class="mini-chat">
            <div class="mc-side">
              <div class="mc-row a"><i></i><b></b></div>
              <div class="mc-gap"></div>
              <div class="mc-row w on"><i></i><b></b></div>
              <div class="mc-row w"><i></i><b></b></div>
              <div class="mc-gap"></div>
              <div class="mc-row"><i></i><b></b></div>
              <div class="mc-row"><i></i><b style="width:60%;flex:none"></b></div>
              <div class="mc-row"><i></i><b></b></div>
              <div class="mc-row"><i></i><b style="width:50%;flex:none"></b></div>
            </div>
            <div class="mc-sheet">
              <div class="mc-col">
                <div class="mc-you"></div>
                <div class="mc-line" style="width:96%"></div>
                <div class="mc-line" style="width:88%"></div>
                <div class="mc-line" style="width:62%"></div>
                <div class="mc-tool"></div>
                <div class="mc-line" style="width:92%"></div>
                <div class="mc-line" style="width:70%"></div>
              </div>
              <div class="mc-comp"></div>
            </div>
          </div>
        </div>
        <h2>chat</h2>
        <p class="one">One conversation in front of you, the others down the side.</p>
        <dl class="facts">
          <dt>good at</dt>
          <dd>
            Feeling familiar from the first minute if you've used ChatGPT or Claude. When an agent needs an answer,
            its conversation moves to the top of the list.
          </dd>
          <dt>the cost</dt>
          <dd>You only see the conversation you're in. With a lot running at once, you'll click between them to see how each is doing.</dd>
        </dl>
        <div class="go"><span class="btn">start in chat</span><span class="k"><kbd>←</kbd> then <kbd>enter</kbd></span></div>
      </button>

      <button type="button" class="way" data-way="wall" bind:this={wallBtn} onclick={() => onchoose("wall")}>
        <div class="art" aria-hidden="true">
          <div class="mini-wall">
            <div class="plate"><i></i><i></i><i class="on"></i><i class="t"></i></div>
            <div class="terr" style="left:14px;top:34px;width:180px;height:132px"><span>portfolio</span></div>
            <div class="cd w" style="left:24px;top:46px"></div>
            <div class="cd a" style="left:108px;top:46px"><b></b><i></i><i style="width:60%"></i></div>
            <div class="cd" style="left:24px;top:104px"><b></b><i></i><i style="width:70%"></i></div>
            <div class="cd r" style="left:108px;top:104px"><b></b><i></i></div>
            <div class="terr" style="left:208px;top:34px;width:180px;height:74px"><span>paperwork</span></div>
            <div class="cd w" style="left:218px;top:46px"><b></b><i></i><i style="width:50%"></i></div>
            <div class="cd r" style="left:302px;top:46px"><b></b><i></i></div>
            <div class="terr" style="left:208px;top:122px;width:96px;height:60px"><span>chat</span></div>
            <div class="cd" style="left:218px;top:130px;height:44px"><b></b><i></i></div>
            <div class="mw-panel">
              <i style="width:80%"></i><i></i><i style="width:90%"></i><i style="width:60%"></i><i></i><i style="width:75%"></i>
            </div>
            <div class="mw-dock"></div>
          </div>
        </div>
        <h2>the wall</h2>
        <p class="one">Every conversation laid out on one surface that you pan and zoom.</p>
        <dl class="facts">
          <dt>good at</dt>
          <dd>
            Running many agents at once. You can tell which are working, which are waiting on you and which have finished
            without opening any of them.
          </dd>
          <dt>the cost</dt>
          <dd>More to learn before it feels natural: territories, the dock, keyboard chords, and a lot on screen at once.</dd>
        </dl>
        <div class="go"><span class="btn">start on the wall</span><span class="k"><kbd>→</kbd> then <kbd>enter</kbd></span></div>
      </button>
    </div>

    <p class="foot2">
      <Icon name="wall" small />The switch lives in the title bar. <kbd>space</kbd><kbd>w</kbd><kbd>v</kbd> flips it from the keyboard.
    </p>
  </div>
</div>

<style>
  .first {
    position: fixed;
    /* `inset: 0` on purpose: while spread over screens the studio root is the
       containing block (CLAUDE.md, `--span-*`), so this covers the home screen
       the way a centred dialog lands there — which is where a question belongs.
       An install that has never held a conversation is not spread anyway. */
    inset: 0;
    z-index: 60;
    display: flex;
    flex-direction: column;
    overflow: hidden auto;
    color: var(--paper);
    font-family: var(--cv-ui, var(--util));
    font-size: 13.5px;
    background:
      var(--cv-grain, none),
      radial-gradient(70% 55% at 50% -10%, color-mix(in oklab, var(--paper) 7%, transparent), transparent 70%),
      var(--cv-ground, var(--well));
    background-blend-mode: soft-light, normal, normal;
    outline: none;
    animation: fade var(--dur-scene, 360ms) var(--ease-out, ease-out) both;
  }
  @keyframes fade {
    from {
      opacity: 0;
    }
  }
  :global(html[data-motion="still"]) .first {
    animation-duration: var(--dur-quick, 160ms);
  }
  .wbar {
    flex: none;
    height: 44px;
    display: flex;
    align-items: center;
    padding-left: 16px;
    gap: 9px;
  }
  .mark {
    width: 20px;
    height: 20px;
  }
  .word {
    font: 400 16px var(--display);
    color: var(--paper);
  }
  .grow {
    flex: 1;
    align-self: stretch;
  }
  .winctl {
    display: flex;
    height: 44px;
  }
  .welcome {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 22px 24px 32px;
  }
  h1 {
    margin: 0;
    font: 400 34px/1.15 var(--display);
    color: var(--paper);
    letter-spacing: -0.005em;
    text-align: center;
  }
  .lede {
    margin: 10px 0 30px;
    font-size: 14.5px;
    color: var(--paper-mute);
    text-align: center;
  }
  .pair {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 520px));
    gap: 28px;
  }
  /* Too narrow for two side by side: one above the other, chat first as on
     the left. */
  @media (max-width: 900px) {
    .pair {
      grid-template-columns: minmax(0, 520px);
    }
  }
  .way {
    position: relative;
    display: flex;
    flex-direction: column;
    border-radius: 20px;
    padding: 12px 12px 20px;
    text-align: left;
    font: inherit;
    color: inherit;
    cursor: pointer;
    background: linear-gradient(180deg, color-mix(in oklab, var(--surface) 100%, var(--paper) 2.5%), var(--surface));
    border: 1px solid color-mix(in oklab, var(--edge) 85%, var(--paper) 4%);
    box-shadow:
      0 1px 0 color-mix(in oklab, var(--paper) 5%, transparent) inset,
      0 26px 50px -30px color-mix(in srgb, var(--shade) 95%, transparent);
    transition:
      transform var(--dur-step, 240ms) var(--ease-out, ease-out),
      border-color var(--dur-quick, 160ms) var(--ease-out, ease-out);
  }
  .way:hover,
  .way:focus-visible {
    transform: translateY(-4px);
    border-color: color-mix(in oklab, var(--edge) 50%, var(--paper) 22%);
  }
  .way:focus-visible {
    outline: 2px solid var(--st-ask);
    outline-offset: 4px;
  }
  :global(html[data-motion="still"]) .way:hover,
  :global(html[data-motion="still"]) .way:focus-visible {
    transform: none;
  }
  @media (prefers-reduced-motion: reduce) {
    .way:hover,
    .way:focus-visible {
      transform: none;
    }
  }
  .art {
    position: relative;
    height: 236px;
    border-radius: 12px;
    overflow: hidden;
    background: var(--well);
    border: 1px solid var(--cv-hair, var(--edge));
  }
  .art::after {
    content: "";
    position: absolute;
    inset: 0;
    background: radial-gradient(80% 60% at 50% 0%, color-mix(in oklab, var(--paper) 5%, transparent), transparent 70%);
    opacity: 0.6;
    transition: opacity var(--dur-step, 240ms) var(--ease-out, ease-out);
    pointer-events: none;
  }
  .way:hover .art::after {
    opacity: 1;
  }
  h2 {
    margin: 18px 8px 4px;
    font: 400 25px/1.2 var(--display);
    color: var(--paper);
  }
  .one {
    margin: 0 8px 16px;
    font: 15px/1.5 var(--body);
    color: var(--paper-dim);
  }
  .facts {
    margin: 0 8px;
    display: grid;
    grid-template-columns: 74px 1fr;
    row-gap: 10px;
    column-gap: 12px;
    font-size: 13px;
    line-height: 1.5;
  }
  .facts dt {
    color: var(--paper-mute);
    padding-top: 1px;
  }
  .facts dd {
    margin: 0;
    color: var(--paper-dim);
  }
  .go {
    margin: auto 8px 0;
    padding-top: 20px;
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .btn {
    display: inline-flex;
    align-items: center;
    height: 36px;
    padding: 0 16px;
    border-radius: 8px;
    font-size: 13.5px;
    color: var(--paper);
    border: 1px solid color-mix(in oklab, var(--edge) 70%, var(--paper) 9%);
    background: linear-gradient(180deg, color-mix(in oklab, var(--raised) 100%, var(--paper) 5%), var(--raised));
    transition:
      background var(--dur-quick, 160ms) var(--ease-out, ease-out),
      color var(--dur-quick, 160ms) var(--ease-out, ease-out);
  }
  .way:hover .btn,
  .way:focus-visible .btn {
    background: var(--paper);
    color: var(--ink);
    border-color: transparent;
  }
  .k {
    font-size: 12px;
    color: var(--cv-note, var(--paper-mute));
  }
  kbd {
    font-family: var(--cv-ui, var(--util));
    font-size: 11px;
    color: var(--paper-mute);
    padding: 1px 5px;
    border-radius: 4px;
    border: 1px solid var(--cv-hair, var(--edge));
    background: color-mix(in oklab, var(--surface) 60%, transparent);
  }
  .foot2 {
    margin: 26px 0 0;
    font-size: 12.5px;
    color: var(--paper-mute);
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
    justify-content: center;
  }

  /* ── chat, in miniature ── */
  .mini-chat {
    position: absolute;
    inset: 0;
    display: grid;
    grid-template-columns: 112px 1fr;
  }
  .mc-side {
    padding: 14px 8px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .mc-row {
    height: 16px;
    border-radius: 5px;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 6px;
  }
  .mc-row i {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--st-rest);
    flex: none;
  }
  .mc-row b {
    height: 4px;
    border-radius: 2px;
    background: var(--rule);
    flex: 1;
  }
  .mc-row.a {
    background: linear-gradient(90deg, color-mix(in oklab, var(--st-ask) 18%, transparent), transparent 80%);
  }
  .mc-row.a i {
    background: var(--st-ask);
  }
  .mc-row.w i {
    background: var(--st-work);
    box-shadow: 0 0 6px color-mix(in oklab, var(--st-work) 70%, transparent);
  }
  .mc-row.on {
    background: var(--raised);
  }
  .mc-gap {
    height: 6px;
  }
  .mc-sheet {
    position: relative;
    margin: 8px 8px 8px 0;
    border-radius: 9px;
    border: 1px solid var(--cv-hair, var(--edge));
    background: radial-gradient(90% 55% at 50% -8%, var(--cv-lamp, transparent), transparent 72%), var(--ink);
    overflow: hidden;
  }
  .mc-sheet::after {
    content: "";
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: 90px;
    background: radial-gradient(55% 90% at 50% 105%, color-mix(in oklab, var(--st-work) 26%, transparent), transparent 72%);
  }
  .mc-col {
    position: absolute;
    left: 50%;
    transform: translateX(-50%);
    width: 72%;
    top: 16px;
    display: flex;
    flex-direction: column;
    gap: 7px;
  }
  .mc-you {
    align-self: flex-end;
    width: 56%;
    height: 18px;
    border-radius: 9px 9px 3px 9px;
    background: var(--raised);
    border: 1px solid var(--cv-hair, var(--edge));
  }
  .mc-line {
    height: 5px;
    border-radius: 3px;
    background: color-mix(in oklab, var(--paper-dim) 55%, transparent);
  }
  .mc-tool {
    height: 20px;
    border-radius: 6px;
    border: 1px solid color-mix(in oklab, var(--st-work) 35%, var(--edge));
    background: color-mix(in oklab, var(--surface) 60%, transparent);
  }
  .mc-comp {
    position: absolute;
    left: 50%;
    transform: translateX(-50%);
    bottom: 12px;
    width: 78%;
    height: 30px;
    border-radius: 11px;
    background: var(--surface);
    border: 1px solid color-mix(in oklab, var(--edge) 70%, var(--paper) 9%);
    z-index: 1;
  }
  .mc-comp::after {
    content: "";
    position: absolute;
    right: 6px;
    top: 7px;
    width: 15px;
    height: 15px;
    border-radius: 50%;
    background: var(--paper);
  }

  /* ── the wall, in miniature ── */
  .mini-wall {
    position: absolute;
    inset: 0;
    background:
      radial-gradient(1px 1px at 10px 10px, color-mix(in oklab, var(--paper) 9%, transparent) 99%, transparent) 0 0 / 22px 22px,
      var(--ink);
  }
  .terr {
    position: absolute;
    border-radius: 10px;
    border: 1px dashed color-mix(in oklab, var(--rule) 80%, transparent);
  }
  .terr span {
    position: absolute;
    top: -8px;
    left: 10px;
    padding: 0 5px;
    font-size: 9.5px;
    color: var(--paper-mute);
    background: var(--ink);
  }
  .cd {
    position: absolute;
    width: 74px;
    height: 50px;
    border-radius: 6px;
    background: var(--surface);
    border: 1px solid var(--edge);
    padding: 6px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .cd b {
    height: 4px;
    width: 70%;
    border-radius: 2px;
    background: color-mix(in oklab, var(--paper) 55%, transparent);
  }
  .cd i {
    height: 3px;
    border-radius: 2px;
    background: var(--rule);
  }
  .cd.w {
    box-shadow:
      0 0 0 1px color-mix(in oklab, var(--st-work) 40%, transparent),
      0 0 18px -2px color-mix(in oklab, var(--st-work) 45%, transparent);
  }
  .cd.a {
    box-shadow:
      0 0 0 1px color-mix(in oklab, var(--st-ask) 55%, transparent),
      0 0 22px -2px color-mix(in oklab, var(--st-ask) 55%, transparent);
  }
  .cd.r {
    background: var(--ink);
    border-style: dashed;
  }
  .cd.r b {
    opacity: 0.5;
  }
  .mw-panel {
    position: absolute;
    top: 8px;
    right: 8px;
    bottom: 44px;
    width: 108px;
    border-radius: 8px;
    background: var(--well);
    border: 1px solid var(--edge);
    padding: 10px 8px;
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
  .mw-panel i {
    height: 4px;
    border-radius: 2px;
    background: color-mix(in oklab, var(--paper-dim) 45%, transparent);
  }
  .mw-dock {
    position: absolute;
    left: 8px;
    right: 8px;
    bottom: 8px;
    height: 28px;
    border-radius: 8px;
    background: var(--surface);
    border: 1px solid color-mix(in oklab, var(--edge) 70%, var(--paper) 9%);
  }
  .mw-dock::before {
    content: "";
    position: absolute;
    left: 10px;
    top: 11px;
    width: 120px;
    height: 5px;
    border-radius: 3px;
    background: color-mix(in oklab, var(--st-ask) 60%, transparent);
  }
  .plate {
    position: absolute;
    top: 10px;
    left: 96px;
    width: 170px;
    height: 14px;
    display: flex;
    align-items: center;
  }
  .plate::before {
    content: "";
    position: absolute;
    left: 4px;
    right: 4px;
    top: 6px;
    height: 1px;
    background: var(--rule);
  }
  .plate i {
    position: relative;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--paper-mute);
    margin-right: 34px;
  }
  .plate i.on {
    background: var(--st-work);
    box-shadow: 0 0 6px var(--st-work);
  }
  .plate i.t {
    background: var(--ink);
    border: 1px solid var(--paper-faint);
  }
</style>
