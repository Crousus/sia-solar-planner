// Solar Planner - Frontend web application for designing and planning rooftop solar panel installations
// Copyright (C) 2026  Johannes Wenz github.com/Crousus
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

// ────────────────────────────────────────────────────────────────────────────
// seed — helpers for seeding test data into a PocketBase integration harness.
//
// Each helper follows the same pattern:
//   - Takes a PocketBase client (caller supplies the right auth level).
//   - Returns the created record (typed loosely as RecordModel to stay
//     independent of hand-maintained type mirrors in backend/types.ts).
//   - Uses random suffixes on emails/names so multiple tests in the same
//     PB instance (e.g., the two tests in sync.integration.test.ts that
//     share one server) don't collide on unique-constraint violations.
//
// Why the harness superuser is needed for some operations:
//   `team_members` has no createRule in the PB migration — regular users
//   can't mint their own memberships (would be a privilege-escalation hole).
//   The `addTeamMember` helper therefore accepts a harness (not a client)
//   so the caller is reminded that this path requires superuser authority.
// ────────────────────────────────────────────────────────────────────────────

import type PocketBase from 'pocketbase';
import type { RecordModel } from 'pocketbase';
import type { PbHarness } from './pbHarness';
import type { Project } from '../../types';
import { initialProject } from '../../store/projectStore';

/** A random 6-char suffix to make generated names/emails collision-free. */
function suffix(): string {
  return Math.random().toString(36).slice(2, 8);
}

/** Result of seedUser: the authenticated client + record + the raw password
 *  (needed by other helpers that may need to re-auth as this user). */
export interface SeedUser {
  client: PocketBase;
  record: RecordModel;
  password: string;
}

/**
 * Create a new user record via the superuser client and return an
 * authenticated PocketBase client for that user.
 *
 * `opts.email` and `opts.password` are optional — sensible random defaults
 * are generated if omitted, which avoids hard-coded credential conflicts
 * when multiple test cases share a single PB instance.
 *
 * The returned `client` has a fresh base URL pointing at the harness server,
 * so it's completely independent of the app's global `pb` singleton.
 */
export async function seedUser(
  h: PbHarness,
  opts?: { email?: string; password?: string; name?: string },
): Promise<SeedUser> {
  const sfx = suffix();
  const email = opts?.email ?? `user-${sfx}@test.local`;
  const password = opts?.password ?? `password-${sfx}-123`;
  const name = opts?.name ?? `User ${sfx}`;

  // Create via superuser to bypass any email-verification gate. The user
  // collection's createRule typically allows self-registration but via
  // superuser we can also skip verify=true requirements.
  const record = await h.superuser.collection('users').create({
    email,
    password,
    passwordConfirm: password,
    name,
  });

  // Build a fresh authenticated client for this user.
  //
  // WHY a unique LocalAuthStore key:
  //   PocketBase's default LocalAuthStore persists tokens to localStorage
  //   under a single key (`pocketbase_auth`). In a jsdom test environment,
  //   localStorage is global — multiple PocketBase instances created in the
  //   same test all read/write the SAME key. The last `authWithPassword` call
  //   overwrites what all previous instances see, so `aliceClient.authStore.record`
  //   would contain Bob's record if Bob authenticates after Alice.
  //
  //   Passing a unique key (tied to the user's email) to `LocalAuthStore`
  //   gives each client its own isolated slot in localStorage, so auth
  //   tokens don't bleed between test users.
  const { default: PocketBase, LocalAuthStore } = await import('pocketbase');
  const client = new PocketBase(h.baseUrl, new LocalAuthStore(`pb-test-${email}`));
  await client.collection('users').authWithPassword(email, password);

  return { client, record, password };
}

/**
 * Create a new team owned by the given authenticated client.
 *
 * PocketBase's `registerTeamAutoAdmin` hook fires on team creation and
 * automatically inserts an admin `team_members` row for the creator —
 * so the returned record is safe to use for `seedProject` immediately.
 *
 * `created_by` is sent explicitly because the `teams` collection defines
 * it as a required relation field. There is no Go hook that auto-stamps
 * it (unlike `projects.created_by`), so the client must supply it.
 * We derive it from `client.authStore.record.id` — the authenticated
 * user who is creating the team.
 */
export async function seedTeam(
  client: PocketBase,
  name?: string,
): Promise<RecordModel> {
  const teamName = name ?? `team-${suffix()}`;
  // `authStore.record` is the record of the currently authenticated user.
  // The non-null assertion is safe here: `seedTeam` is only called after
  // `seedUser` (or equivalent auth), so `record` is always present.
  const createdBy = (client.authStore.record as { id: string }).id;
  return client.collection('teams').create({ name: teamName, created_by: createdBy });
}

/**
 * Insert a `team_members` row using the harness superuser.
 *
 * Regular users have no createRule on `team_members` (by design — see
 * migration), so this MUST go through the superuser. The caller decides
 * the role; defaults to 'member'.
 */
export async function addTeamMember(
  h: PbHarness,
  teamId: string,
  userId: string,
  role: 'admin' | 'member' = 'member',
): Promise<RecordModel> {
  return h.superuser.collection('team_members').create({
    user: userId,
    team: teamId,
    role,
  });
}

/**
 * Create a new project record.
 *
 * `doc` defaults to `initialProject` from the store — the same well-formed
 * default that `NewProjectPage` uses — so test assertions against specific
 * fields work without constructing a full Project object by hand.
 *
 * The initial `revision` is always 0 (a brand-new project).
 */
export async function seedProject(
  client: PocketBase,
  teamId: string,
  doc?: Partial<Project>,
): Promise<RecordModel> {
  // Merge the caller's overrides on top of the default initial project so
  // the resulting doc is always a fully-formed Project (not a partial stub
  // that might fail migrateProject or the patch handler's JSON-patch ops).
  const fullDoc: Project = { ...initialProject, ...doc };
  const name = fullDoc.name ?? 'Test Project';

  return client.collection('projects').create({
    team: teamId,
    name,
    doc: fullDoc,
    revision: 0,
  });
}
