package com.volery.phone

import kotlin.math.roundToInt

/**
 * How a wall's digest becomes the page: the roster's three states, the project
 * strip, and the words a card's row and head are made of.
 *
 * This is the phone's reading of `classify.ts`'s vocabulary, and it is kept
 * here rather than in a screen so there is one answer to "what does this card
 * say" instead of one per surface. It is pure: no Compose state, no IO, just
 * the fold from [CardDigest] to what is drawn.
 */

/** The roster's three states, in the order the page reads them: what needs
 *  you, what is working, what has come to rest. A card with a parked question
 *  is "needs you" even while its turn runs — the thing waiting for a person
 *  outranks the thing working. */
data class Groups(
    val needs: List<CardDigest>,
    val working: List<CardDigest>,
    val finished: List<CardDigest>,
) {
    val total: Int get() = needs.size + working.size + finished.size
}

fun groupsOf(cards: List<CardDigest>): Groups {
    val needs = ArrayList<CardDigest>()
    val working = ArrayList<CardDigest>()
    val finished = ArrayList<CardDigest>()
    for (card in cards) {
        when {
            card.asks > 0 || card.notices > 0 -> needs += card
            card.working -> working += card
            else -> finished += card
        }
    }
    return Groups(needs = needs, working = working, finished = finished)
}

/** A project as the strip shows it: its name, how many cards stand in it, and
 *  the one light its dots carry (ask if any card asks, else work, else rest).
 *  A project is a place to go on a phone, not a thing to read, so the strip is
 *  one line and tapping it narrows the roster to it. */
data class ProjectNoun(val name: String, val count: Int, val dot: DotKind)

fun projectsOf(cards: List<CardDigest>): List<ProjectNoun> =
    cards.filter { it.project.isNotEmpty() }
        .groupBy { it.project }
        .map { (name, inIt) ->
            ProjectNoun(
                name = name,
                count = inIt.size,
                dot = when {
                    inIt.any { it.asks > 0 || it.notices > 0 } -> DotKind.Ask
                    inIt.any { it.working } -> DotKind.Work
                    else -> DotKind.Rest
                },
            )
        }
        .sortedWith(compareByDescending<ProjectNoun> { it.count }.thenBy { it.name })

/** What a card is called. A card the wall has not named yet reads as its
 *  project, and one with neither reads as `unnamed` — never blank. */
fun CardDigest.word(): String = title.ifEmpty { project.ifEmpty { "unnamed" } }

/** Where it lives: its project, or `chat` for the card with none. */
fun CardDigest.where(): String = project.ifEmpty { "chat" }

/** The state in a word or two, for a head's sub line. */
fun CardDigest.stateWord(): String = when {
    dormant -> "dormant"
    aside -> "aside"
    else -> tierWord(tier)
}

/** The light a card's dot is: needs-you beats working beats the rest, and a
 *  card with no project is a chat card and reads as the smaller hollow one. */
fun CardDigest.dot(): DotKind = when {
    asks > 0 || notices > 0 -> DotKind.Ask
    working -> DotKind.Work
    tier == "fail" -> DotKind.Fail
    project.isEmpty() -> DotKind.Chat
    else -> DotKind.Done
}

/** The row's second line: what it is doing, what it last said, or why it is
 *  quiet. Never a cut-down copy of the title. */
fun CardDigest.subline(): String = when {
    asks > 0 -> "asks — $asks ${if (asks == 1) "question" else "questions"} waiting"
    notices > 0 -> "a notice is waiting"
    dormant -> "dormant — will wake on send"
    aside -> "set aside"
    working -> doing.ifEmpty { "working" } + if (project.isNotEmpty()) " · $project" else ""
    said.isNotEmpty() -> said
    else -> "at rest"
}

/** The figure a row carries at its trailing edge. The phone has no per-card
 *  timestamp, so this is where it lives rather than how old it is. */
fun CardDigest.trailing(): String = project.ifEmpty { "chat" }

/** A card's head sub line: "portfolio · working · memory 71% full". */
fun CardDigest.headLine(): String {
    val memory = ctx?.let { "${(it * 100).roundToInt()}% full" } ?: "—"
    return "${where()} · ${stateWord()} · memory $memory"
}
