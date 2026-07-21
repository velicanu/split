// Copy a split from a past expense onto a new one — the cheap first cut of
// saved splits (plan discussion, "Tier 0"). Every expense already stores its
// recipe (mode + weights + participants); this surfaces the distinct ones
// already in the ledger so a new expense can reuse a ratio without retyping it.
//
// Stamped by value at pick time: the picked recipe is copied into the form and
// resolved against the new amount by the same submit path any split uses, so
// there is no new event, no pointer to a template, and no balance impact. Edit
// the source expense later and copies made from it do not move — they froze
// their own recipe, like everything in the log.

// Only ratio splits generalise to a different amount. A receipt-item split is
// tied to one receipt's lines; there is no ratio to carry. So `items` (and any
// future exact-cents mode) is never offered.
const RATIO_MODES = new Set(['equal', 'percentage', 'shares'])
const MODE_LABEL = { equal: 'equally', percentage: 'by percentage', shares: 'by shares' }

// The mode of an expense if it is a stampable ratio, else null. A missing mode
// is the historic default, equal.
function ratioMode(x) {
  const m = x.split?.mode || 'equal'
  return RATIO_MODES.has(m) ? m : null
}

// A stable key for "the same split", so twenty equal-among-everyone expenses
// collapse to one option. Ids sorted numerically; weights folded in for the
// ratio modes.
function canonical(mode, ids, weights) {
  const sorted = [...ids].sort((a, b) => a - b)
  const w = mode === 'equal' ? '' : sorted.map((id) => `${id}:${weights?.[id] ?? 0}`).join(',')
  return `${mode}|${sorted.join(',')}|${w}`
}

/** The distinct ratio splits already in the ledger, newest first, each labelled
 *  by a representative expense. `members` are the current live members; a
 *  participant who is no longer among them is dropped from the option, and an
 *  option with nobody left is omitted. `excludeId` skips one expense (the one
 *  being edited, so it can't copy from itself). */
export function splitOptions(ledger, members, { excludeId } = {}) {
  const live = new Set(members.map((m) => m.id))
  const seen = new Set()
  const options = []
  for (const x of ledger) {
    if (x.deleted || x.expense_id === excludeId) continue
    const mode = ratioMode(x)
    if (!mode) continue
    const participantIds = (x.splits || [])
      .map((s) => s.user_id)
      .filter((id) => live.has(id))
    if (!participantIds.length) continue
    const weights = mode === 'equal' ? null : x.split?.weights || null
    // A ratio with no positive weight left has nothing to stamp.
    if (mode !== 'equal' && !participantIds.some((id) => (weights?.[id] ?? 0) > 0)) {
      continue
    }
    const key = canonical(mode, participantIds, weights)
    if (seen.has(key)) continue
    seen.add(key)
    options.push({
      id: x.expense_id,
      label: `${x.description?.trim() || 'Untitled'} · ${MODE_LABEL[mode]}`,
      mode,
      participantIds,
      weights,
    })
  }
  return options
}

/** Turn a chosen option into the three pieces of form state a split is made of:
 *  the mode, the per-member weights (as strings, as the form holds them), and
 *  who is excluded. Feeding these to the form is the whole of "stamping". */
export function applyOption(option, members) {
  const live = members.map((m) => m.id)
  const participants = option.participantIds.filter((id) => live.includes(id))
  const inSplit = new Set(participants)
  return {
    mode: option.mode,
    weights:
      option.mode === 'equal'
        ? {}
        : Object.fromEntries(
            participants.map((id) => [id, String(option.weights?.[id] ?? 0)])
          ),
    excluded: live.filter((id) => !inSplit.has(id)),
  }
}
