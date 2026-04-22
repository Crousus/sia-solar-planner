// ────────────────────────────────────────────────────────────────────────
// migrateLocalStorage — one-shot import of a pre-backend local project.
//
// Runs on login. If the user's localStorage carries any user-generated
// content (roofs/panels/strings/inverters) AND they have no server
// projects anywhere, we silently materialise it as their first team
// project and redirect into it.
//
// After import we clear the localStorage key so the user doesn't get
// re-imported on subsequent sign-ins. The project record on the server
// is now authoritative.
//
// Why "no server projects" gate, not "first team login"? A user may
// join someone else's team first (via invite) and already have server
// projects; we don't want to dump their local draft into that team.
//
// Why silent (no prompt)? Per spec Q8c: the pre-backend user never
// explicitly "saved" — their draft was just the persisted UI state.
// Asking "do you want to import?" on first login leaks an implementation
// detail (that localStorage existed) and creates a decision the user
// didn't sign up for. If they had meaningful content locally and no
// server content, the only reasonable default is to bring it forward.
// ────────────────────────────────────────────────────────────────────────

import { pb } from './pb';
import type { Project } from '../types';
import type { ProjectRecord, TeamRecord, UserRecord } from './types';
import { migrateProject } from '../utils/projectSerializer';

// Must match `persist`'s `name` in src/store/projectStore.ts. If that
// key ever changes, this import will silently no-op for everyone — the
// mitigation is that the store defines the canonical constant and this
// module is the only other place it's referenced, so changing one
// should prompt grepping the other. We intentionally don't `import`
// the constant from the store module because doing so would pull the
// entire zustand store (and its deep transitive geometry/diff imports)
// into the login bundle for a single string.
const STORAGE_KEY = 'solar-planner-project';

/**
 * Inspect localStorage and, if conditions are right, create a server
 * project seeded from the local draft.
 *
 * Returns the new project id if import happened, else null. Callers
 * (LoginPage) use the return value to decide whether to redirect into
 * the newly-created project or fall through to the default post-login
 * destination.
 *
 * Intentionally does NOT throw on the common "no local data" paths —
 * those are normal (the user never opened the app offline, or already
 * imported on a prior login). Only network/permission errors from the
 * PB calls bubble up; LoginPage wraps this in `.catch(() => null)` so a
 * failed import doesn't block login.
 */
export async function maybeImportLocalStorage(): Promise<string | null> {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;

  // The persisted value is Zustand's `persist` wrapper:
  //   { state: { project }, version }
  // We dig into `.state.project` rather than trusting the whole blob
  // because future schema revs might add siblings (e.g. a settings
  // slice) that we don't want to feed into the Project shape migrator.
  let project: Project;
  try {
    const parsed = JSON.parse(raw);
    const inner = parsed?.state?.project;
    if (!inner) return null;
    // migrateProject fills in Panel.orientation and similar defaults on
    // legacy drafts — same migrator the store's onRehydrateStorage uses,
    // so an imported project matches what the user would see if they
    // had just refreshed the pre-backend app.
    project = migrateProject(inner);
  } catch {
    // Corrupt JSON: bail out silently. Leaving the bad blob in
    // localStorage is fine — the store's own rehydrate path also
    // tolerates it, and the user is about to get a fresh server-backed
    // editor anyway so there's nothing they'd lose by our giving up here.
    return null;
  }

  // Non-empty check: at least one of the user-content collections has
  // items. panelType always exists (default is seeded at store init)
  // and mapState always exists (default = unlocked Munich), so those
  // two fields can't tell us "did the user DO anything." Roofs/panels/
  // strings/inverters are the only real signals of user intent.
  const isEmpty =
    project.roofs.length === 0 &&
    project.panels.length === 0 &&
    project.strings.length === 0 &&
    project.inverters.length === 0;
  if (isEmpty) return null;

  // No-server-projects gate. If the user already has any project (own
  // team or joined via invite), skip import — see module header. We
  // request perPage=1 because we only need the count, which PB returns
  // in totalItems regardless of how many records we actually fetch.
  const existing = await pb
    .collection('projects')
    .getList<ProjectRecord>(1, 1);
  if (existing.totalItems > 0) return null;

  // Current user. pb.authStore.record is the SDK's current accessor
  // (the previously-common .model is deprecated). LoginPage only calls
  // us after authWithPassword resolves, so `.record` should always be
  // populated, but we defend anyway — a future refactor that calls this
  // pre-auth would otherwise silently create records with no owner.
  const user = pb.authStore.record as UserRecord | null;
  if (!user) return null;

  // Find or create a team to host the project.
  //
  // Pick the user's own team (by created_by) if one already exists,
  // otherwise spin up a fresh one. We don't want to silently drop a
  // personal draft into a team the user merely joined — they may have
  // member-level permissions that prevent them from managing the
  // result (e.g. renaming or deleting the imported project). The
  // `-created` sort is still useful here so that, if the user somehow
  // owns multiple teams already, we land on the most recent one —
  // mirroring the team-picker's default selection logic.
  //
  // Note: getFullList here returns *all* teams visible to the user,
  // which via the collection's list rule includes teams they were
  // merely invited into. That's why the `created_by === user.id`
  // check matters — `teams[0]` is emphatically NOT guaranteed to be
  // the user's own team.
  const teams = await pb
    .collection('teams')
    .getFullList<TeamRecord>({ sort: '-created' });
  const ownTeam = teams.find((t) => t.created_by === user.id);
  let teamId: string;
  if (ownTeam) {
    teamId = ownTeam.id;
  } else {
    // Create a default team. The server-side auto-admin hook (see
    // server/pb_migrations/*.js) inserts a team_members admin row for
    // the creator atomically, so we don't need a follow-up call here.
    const newTeam = await pb.collection('teams').create<TeamRecord>({
      // `user.name` is declared required in UserRecord; fall back
      // defensively anyway in case a legacy user record lacks it.
      name: `${user.name || 'My'} Team`,
      created_by: user.id,
    });
    teamId = newTeam.id;
  }

  // Create the project record. Revision starts at 0: the next edit
  // the user makes will POST a patch from revision 0 → 1 via the
  // normal sync flow, so this row enters the patch timeline cleanly.
  const created = await pb.collection('projects').create<ProjectRecord>({
    team: teamId,
    name: project.name || 'Imported Project',
    doc: project,
    revision: 0,
  });

  // Clear the local blob so subsequent sign-ins don't re-import. The
  // server record is authoritative from here on; the editor for this
  // project will rehydrate from the server, not localStorage.
  //
  // We intentionally remove ONLY after the project create succeeds —
  // if the create threw, we want the blob preserved so a retry (next
  // sign-in) has another shot rather than silently losing the draft.
  localStorage.removeItem(STORAGE_KEY);

  return created.id;
}
