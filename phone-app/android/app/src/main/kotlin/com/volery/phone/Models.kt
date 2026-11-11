package com.volery.phone

import org.json.JSONArray
import org.json.JSONObject

/**
 * The shapes the JNI envelopes flatten into, and the reads that make them.
 *
 * The wire vocabulary is the wall's, not the phone's: a roster row and the
 * cards snapshot ride through `phone-ffi` as one opaque JSON value per wall,
 * so this file is where a string becomes something the screens can draw. The
 * reads are deliberately tolerant — `opt*` and a null check everywhere — for
 * the same reason `readSnapshot` on the desktop is: a field another wall did
 * not send reads as unknown, never as a crash, and a card with no id is
 * dropped rather than drawn.
 */

data class RosterRow(
    val host: String,
    val version: Long,
    val cardsLive: Int,
    val cardsWorking: Int,
    val accepting: Boolean,
    val build: String,
    val ageMs: Long,
)

data class CardDigest(
    val id: String,
    val title: String,
    val project: String,
    val tier: String,
    val working: Boolean,
    val dormant: Boolean,
    val aside: Boolean,
    val doing: String,
    val said: String,
    val jobs: Int,
    val model: String?,
    val ctx: Double?,
    val ctxTokens: Long?,
    val turns: Long?,
    val costUsd: Double?,
    val asks: Int,
    val notices: Int,
)

data class CardsSnapshot(
    val host: String,
    val version: Long,
    val ageMs: Long,
    val cards: List<CardDigest>,
    /** The whole `cards` object exactly as the wall sent it, so the prompt
     *  reader (`phone-ffi`'s `prompts`) can compose what waits on a person from
     *  the same snapshot without this file re-reading every field. */
    val json: String,
)

data class Sighting(
    /** The wall that answered, which after a walk may not be the one asked.
     *  Every later call (a fetch, a spoken plan, an answer) addresses it. */
    val host: String,
    val roster: List<RosterRow>,
    val cards: CardsSnapshot?,
)

/** What one `fetch` came back with, flattened out of the envelope. `data` is
 *  base64 either way — a picture's pixels or a file's bytes — `size` a
 *  picture's pixel box (null for a file), and `full` where a file is on its
 *  owning wall in that wall's spelling. */
data class FetchedMedia(
    val name: String,
    val data: String,
    val bytes: Long,
    val sizeWidth: Int?,
    val sizeHeight: Int?,
    val tooLarge: Boolean,
    val full: String,
)

fun parseSighting(ok: JSONObject): Sighting {
    val rosterArr = ok.optJSONArray("roster") ?: JSONArray()
    val roster = (0 until rosterArr.length()).mapNotNull { i ->
        val w = rosterArr.optJSONObject(i) ?: return@mapNotNull null
        RosterRow(
            host = w.optString("host"),
            version = w.optLong("version"),
            cardsLive = w.optInt("cards_live"),
            cardsWorking = w.optInt("cards_working"),
            accepting = w.optBoolean("accepting"),
            build = w.optString("build"),
            ageMs = w.optLong("age_ms"),
        )
    }
    val cardsObj = ok.optJSONObject("cards")
    val cards = if (cardsObj == null) {
        null
    } else {
        val snap = cardsObj.optJSONObject("snapshot") ?: JSONObject()
        val cardsArr = snap.optJSONArray("cards") ?: JSONArray()
        CardsSnapshot(
            host = cardsObj.optString("host"),
            version = cardsObj.optLong("version"),
            ageMs = cardsObj.optLong("age_ms"),
            cards = (0 until cardsArr.length()).mapNotNull { i -> readCard(cardsArr.optJSONObject(i)) },
            json = cardsObj.toString(),
        )
    }
    return Sighting(host = ok.optString("host"), roster = roster, cards = cards)
}

private fun readCard(c: JSONObject?): CardDigest? {
    if (c == null) return null
    val id = c.optString("id")
    // The same guard the desktop's readSnapshot keeps: a card with no id is
    // not a card, and drawing one would be drawing a row nothing can address.
    if (id.isEmpty()) return null
    return CardDigest(
        id = id,
        title = c.optString("title"),
        project = c.optString("project"),
        tier = c.optString("tier", "rest"),
        working = c.optBoolean("working"),
        dormant = c.optBoolean("dormant"),
        aside = c.optBoolean("aside"),
        doing = c.optString("doing"),
        said = c.optString("said"),
        jobs = c.optInt("jobs"),
        model = stringOrNull(c, "model"),
        ctx = numOrNull(c, "ctx"),
        ctxTokens = longOrNull(c, "ctxTokens"),
        turns = longOrNull(c, "turns"),
        costUsd = numOrNull(c, "costUsd"),
        asks = c.optJSONArray("asks")?.length() ?: 0,
        notices = c.optJSONArray("notices")?.length() ?: 0,
    )
}

/**
 * A string that is genuinely absent, as null.
 *
 * `optString` on a JSON `null` returns the four characters `"null"`, not an
 * empty string — so `optString(k).ifEmpty { null }` reads *absent* as the
 * literal word. It cost twice on the way in: every prompt looked
 * acknowledgeable (its `ack` was "null"), and an ask with no parked id armed
 * the ears for an answer to the ask id `"null"`, which no wall holds.
 */
private fun stringOrNull(o: JSONObject, key: String): String? =
    if (o.has(key) && !o.isNull(key)) o.optString(key).ifEmpty { null } else null

/** A number that was never measured is null, never zero — the desktop's
 *  "unknown is null, drawn —" rule, kept so a wall from before a field does
 *  not draw a false figure. */
private fun numOrNull(o: JSONObject, key: String): Double? =
    if (o.has(key) && !o.isNull(key)) o.optDouble(key) else null

private fun longOrNull(o: JSONObject, key: String): Long? =
    if (o.has(key) && !o.isNull(key)) o.optLong(key) else null

/** One spoken line, as `phone-ffi`'s `narrate` flattens it: the brain's stable
 *  kind word, the card id a later answer is addressed to, the sentence, and —
 *  for an `ask` line — the parked question's id (`askId`), which an answer is
 *  sent against. Null for every other kind. */
data class NarrationLine(
    val kind: String,
    val card: String,
    val text: String,
    val askId: String?,
)

/** What `narrate` came back with: the lines to speak, and whether anything
 *  needs Lyss right now (computed at every chatty level, for music ducking). */
data class Narration(
    val lines: List<NarrationLine>,
    val needsYou: Boolean,
)

fun parseNarration(ok: JSONObject): Narration {
    val linesArr = ok.optJSONArray("lines") ?: JSONArray()
    val lines = (0 until linesArr.length()).mapNotNull { i ->
        val l = linesArr.optJSONObject(i) ?: return@mapNotNull null
        NarrationLine(
            kind = l.optString("kind"),
            card = l.optString("card"),
            text = l.optString("text"),
            askId = stringOrNull(l, "askId"),
        )
    }
    return Narration(lines = lines, needsYou = ok.optBoolean("needsYou"))
}

/* ── what waits on a person ─────────────────────────────────────────────── */

/** One option a wall's own question offers. `detail` is the cost or the risk,
 *  empty when the question gave none. */
data class PromptChoice(val label: String, val detail: String)

/** One question on a prompt: its header, its words, and what may be chosen.
 *  No options means the answer is a sentence. */
data class PromptQuestion(
    val header: String,
    val body: String,
    val shows: Boolean,
    val options: List<PromptChoice>,
)

/** One thing waiting on a person, composed by `phone-node`'s prompt reader
 *  from the same digest the wall publishes. `answers` is the exact value the
 *  owning wall reads on the prompt wire: a parked ask's id, a notice behind
 *  `notice:`, or a pile row behind `deferred:`. */
data class PromptRow(
    /** The wall that published it. The answer is dialled there, not to
     *  whatever wall the screen happens to be drawing by the time you tap. */
    val host: String,
    val card: String,
    val title: String,
    val kind: String,
    val answers: String,
    val waitedMs: Long,
    val blocking: Boolean,
    val startsWork: Boolean,
    val questions: List<PromptQuestion>,
    /** For a notice that holds no turn open: the word that takes it down
     *  without saying anything. Empty on everything else. */
    val ack: String,
) {
    /** What the row says when there is room for one line. */
    val headline: String
        get() = questions.firstOrNull()?.let { q ->
            q.header.ifEmpty {
                q.body.lineSequence().firstOrNull { it.isNotBlank() }?.trim()?.take(120) ?: ""
            }
        }?.ifEmpty { title } ?: title

    /** Whether it can be answered by picking rather than only by speaking. */
    val pickable: Boolean get() = questions.any { it.options.isNotEmpty() }

    /** The headers a reply of several questions is numbered by. */
    val headers: List<String> get() = questions.map { it.header }
}

fun parsePrompts(ok: JSONObject): List<PromptRow> {
    val arr = ok.optJSONArray("prompts") ?: return emptyList()
    return (0 until arr.length()).mapNotNull { i ->
        val o = arr.optJSONObject(i) ?: return@mapNotNull null
        val answers = o.optString("answers")
        val card = o.optString("card")
        if (answers.isEmpty() || card.isEmpty()) return@mapNotNull null
        val qs = o.optJSONArray("questions") ?: JSONArray()
        PromptRow(
            host = o.optString("host"),
            card = card,
            title = o.optString("title"),
            kind = o.optString("kind", "notice"),
            answers = answers,
            waitedMs = o.optLong("waitedMs"),
            blocking = o.optBoolean("blocking", true),
            startsWork = o.optBoolean("startsWork", true),
            ack = stringOrNull(o, "ack").orEmpty(),
            questions = (0 until qs.length()).mapNotNull { j ->
                val q = qs.optJSONObject(j) ?: return@mapNotNull null
                val opts = q.optJSONArray("options") ?: JSONArray()
                PromptQuestion(
                    header = q.optString("header"),
                    body = q.optString("body"),
                    shows = q.optBoolean("shows"),
                    options = (0 until opts.length()).mapNotNull { k ->
                        val c = opts.optJSONObject(k) ?: return@mapNotNull null
                        val label = c.optString("label")
                        if (label.isEmpty()) null else PromptChoice(label, c.optString("detail"))
                    },
                )
            },
        )
    }
}

/** One prose line of a card's conversation, as `tail` reduces it: whether a
 *  person said it, and the words. Tool calls and results never cross. */
data class Prose(val you: Boolean, val text: String)

fun parseProse(ok: JSONObject): List<Prose> {
    val arr = ok.optJSONArray("lines") ?: return emptyList()
    return (0 until arr.length()).mapNotNull { i ->
        val o = arr.optJSONObject(i) ?: return@mapNotNull null
        val text = o.optString("text")
        if (text.isBlank()) null else Prose(you = o.optBoolean("you"), text = text)
    }
}

fun parseFetched(ok: JSONObject): FetchedMedia {
    val size = ok.optJSONArray("size")
    return FetchedMedia(
        name = ok.optString("name"),
        data = ok.optString("data"),
        bytes = ok.optLong("bytes"),
        sizeWidth = size?.optInt(0),
        sizeHeight = size?.optInt(1),
        tooLarge = ok.optBoolean("tooLarge"),
        full = ok.optString("full"),
    )
}
