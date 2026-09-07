import type { TeamRole } from "../../lib/authClient"

/**
 * The name to show for an account. `auth.users` carries an id and an email
 * and nothing else -- there is no profile row and no link from a user to a
 * `players` record -- so the local part of the address is the best identity
 * available without adding a fetch to the app shell. The full address still
 * exists, one click away inside the account menu; what this replaces is the
 * raw address sitting in the navigation as though it were a label.
 *
 * Guest sessions are anonymous and have no email at all.
 */
export function accountName(email: string | null | undefined): string {
  if (!email) return "Guest"
  const local = email.split("@")[0]
  return local || email
}

/**
 * One or two letters for an avatar/monogram tile. Splits on the separators
 * people actually put in team names and email locals (space, dot, underscore,
 * hyphen) so "JAM Summer 2026" gives "JS" and "first.last" gives "FL", and
 * falls back to the first two characters when there is only one word.
 */
export function initials(text: string): string {
  const words = text.split(/[\s._-]+/).filter(Boolean)
  if (words.length >= 2) return (words[0]![0]! + words[1]![0]!).toUpperCase()
  const single = words[0] ?? text
  return single.slice(0, 2).toUpperCase()
}

/**
 * The line under an account name: which seat this person holds on the team
 * they are currently looking at. A guest holds no role anywhere -- that is
 * what being a guest means -- so it says so rather than showing an empty row.
 */
export function accountSubtitle(role: TeamRole | null, isGuest: boolean): string {
  if (isGuest) return "Guest session"
  return role ?? "No role"
}
