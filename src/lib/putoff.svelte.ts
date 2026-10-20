/* A question put off, answered or let go — one path, whoever draws it.
 *
 * The pile (`Vigil.svelte`) was the only place a question filed while you were
 * away could be answered, and it held the whole of how: the envelope, the
 * attachments, the claim before the send, the far wall's road. Chat view draws
 * the same question at the foot of the conversation that asked it (Lyss,
 * 2026-10-20: *"the deferred questions could be shown in the chat"*), and a
 * second copy of that sequence would be a second place for the claim-then-send
 * ordering to be got the wrong way round. So it is here, and both surfaces
 * call it; each keeps only its own `sending` and `fault`.
 *
 * Both answer with `null` when it went — or is held for a wall not heard
 * from — and otherwise with the reason in words, the sheet left as it was
 * filled in. */

import { attachedIn, forgetAttachments, turnFrom } from "./attach.svelte";
import { PILE_DROP } from "./afar";
import { clock } from "./conversation.svelte";
import { answerEnvelope, type Deferred } from "./presence";
import type { Presence } from "./presence.svelte";
import { replies } from "./replies.svelte";
import type { Elsewhere } from "./shadows.svelte";
import type { Skein } from "./skein.svelte";

export type PutOff = { presence: Presence; skein: Skein; elsewhere: Elsewhere };

/** A question filed on another wall, answered — or dropped — from here.
 *  `answerFiled` says a reason when nothing went and nothing is held. */
async function afar(w: PutOff, d: Deferred, text: string): Promise<string | null> {
  const s = w.elsewhere.find(d.conversationId);
  const sheet = s?.filed.find((x) => x.askId === d.id);
  if (!s || !sheet) return `that question is no longer on ${d.host ?? "its wall"}`;
  try {
    const why = await w.elsewhere.answerFiled(s, sheet, text);
    if (why) return why;
    forgetAttachments(`ask:${d.id}`);
    return null;
  } catch (err) {
    return String(err);
  }
}

/** Hand one answered sheet to the card that asked for it.
 *
 *  Claimed before it is sent — `later::serve_due`'s ordering and its
 *  reasoning. An interruption between the two loses an answer, where the
 *  other way round hands a card the same decision twice, and a card prompted
 *  twice with the same decision is the worse failure. */
export async function answerPutOff(w: PutOff, d: Deferred): Promise<string | null> {
  const words = answerEnvelope(d.questions, d.answers, clock.t - d.askedAt);
  if (d.host) return afar(w, d, words);
  const conv = w.skein.convs.find((c) => c.id === d.conversationId);
  if (!conv) {
    /* Nothing to hand it to. Taking it off the pile is the only honest move
       left — the question stood for a card that is no longer on the wall. */
    await w.presence.claim(d.id);
    return null;
  }
  try {
    /* What was attached in its answer boxes goes with it, as it would with a
       prompt — made ready before the claim, so a refusal leaves it on the pile
       with the answers on it. */
    const attached = attachedIn(`ask:${d.id}`);
    const turn = attached.length
      ? await turnFrom(words, attached, { chat: conv.kind === "chat", afar: false }, conv.id)
      : undefined;
    if (turn && "refused" in turn) return turn.refused;
    if (!(await w.presence.claim(d.id))) {
      return "that question was answered already — from another wall, or a moment ago here";
    }
    await w.skein.send(conv, turn?.text ?? words, turn);
    forgetAttachments(`ask:${d.id}`);
    return null;
  } catch (err) {
    return String(err);
  }
}

/** Leave one unanswered and gone. The agent was told nothing is decided, so
 *  dropping a question is the user saying it is not worth one — which is a
 *  real answer, and is why it is offered rather than only achievable by
 *  letting it sit for ever. */
export async function dropPutOff(w: PutOff, d: Deferred): Promise<string | null> {
  if (d.host) {
    const why = await afar(w, d, PILE_DROP);
    if (why) return why;
  } else {
    await w.presence.claim(d.id);
  }
  /* And anything half-typed into it, which nothing will draw again. */
  replies.forget(`ask:${d.id}`);
  forgetAttachments(`ask:${d.id}`);
  return null;
}
