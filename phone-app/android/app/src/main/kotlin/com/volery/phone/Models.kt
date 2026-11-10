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
)

data class Sighting(
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
        )
    }
    return Sighting(roster = roster, cards = cards)
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
        model = c.optString("model").ifEmpty { null },
        ctx = numOrNull(c, "ctx"),
        ctxTokens = longOrNull(c, "ctxTokens"),
        turns = longOrNull(c, "turns"),
        costUsd = numOrNull(c, "costUsd"),
        asks = c.optJSONArray("asks")?.length() ?: 0,
        notices = c.optJSONArray("notices")?.length() ?: 0,
    )
}

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
            askId = l.optString("askId").ifEmpty { null },
        )
    }
    return Narration(lines = lines, needsYou = ok.optBoolean("needsYou"))
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
