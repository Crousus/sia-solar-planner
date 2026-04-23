// ────────────────────────────────────────────────────────────────────────
// NewProjectPage — /teams/:teamId/projects/new
//
// Dedicated page for bootstrapping a project with metadata (name, client,
// address, notes) BEFORE the user lands in the editor. Replaces the old
// one-click path from TeamView, which created an "Untitled Project" row
// and dropped the user on a blank map.
//
// Why a page (not a modal):
//   The address autocomplete dropdown needs vertical room, and the live
//   map preview benefits from breathing space. A modal would either clip
//   one or the other. Pages also give us a deep-linkable URL, which
//   matches the pattern already established by NewTeamPage.
//
// Server write path:
//   On submit we POST directly to the PocketBase `projects` collection
//   (same approach as the previous TeamView.createProject). The row's
//   top-level `name` column mirrors doc.name so team-list queries don't
//   have to parse the JSON blob. `doc` is a full initialProject with
//   the user-provided name + meta merged in — identical shape to what
//   the editor / sync client expect.
// ────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { pb } from '../backend/pb';
import type { ProjectRecord, TeamRecord, TeamMemberRecord } from '../backend/types';
import type { Project } from '../types';
import { initialProject } from '../store/projectStore';
import { useAuthUser } from './AppShell';
import { PageShell } from './PageShell';
import ProjectMetaForm from './ProjectMetaForm';

export default function NewProjectPage() {
  const { t } = useTranslation();
  const { teamId } = useParams<{ teamId: string }>();
  const user = useAuthUser();
  const navigate = useNavigate();

  // We fetch the team + the caller's membership row to (a) confirm the
  // team exists and the user can see it, (b) render the breadcrumb.
  // Parallel with Promise.all so there's no two-stage loading flicker.
  // Not fetching the project list here because this page doesn't show
  // one — a caller who clicked "New project" from TeamView already saw
  // the list there.
  const [team, setTeam] = useState<TeamRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!teamId || !user) return;
    let cancelled = false;
    Promise.all([
      pb.collection('teams').getOne<TeamRecord>(teamId),
      // Membership check — we don't *use* the role here (admins and
      // members can both create projects), but the lookup doubles as
      // an authorization probe: if the user isn't a member, this
      // throws 404 and we bounce them.
      pb.collection('team_members').getFirstListItem<TeamMemberRecord>(
        `team="${teamId}" && user="${user.id}"`
      ),
    ])
      .then(([teamRec]) => {
        if (cancelled) return;
        setTeam(teamRec);
      })
      .catch((err) => {
        if (cancelled) return;
        // 404 either means the team doesn't exist or the caller isn't a
        // member of it. Either way: bounce to home. `replace: true` so
        // the Back button doesn't loop them right back into the failing
        // URL. Unknown errors surface inline so the user isn't left
        // confused on a blank page.
        if (err?.status === 404 || err?.status === 403) {
          navigate('/', { replace: true });
          return;
        }
        setError(err?.message ?? 'Failed to load team');
      });
    return () => { cancelled = true; };
  }, [teamId, user, navigate]);

  async function signOut() {
    pb.authStore.clear();
    navigate('/login', { replace: true });
  }

  async function handleSubmit({ name, meta }: { name: string; meta: Project['meta'] }) {
    if (!teamId) return;
    setBusy(true);
    setError(null);
    try {
      // Build the doc by merging user input into initialProject. This
      // keeps the exact byte-identical starting shape the store + sync
      // client expect, plus the user's metadata. Spread order matters:
      // initialProject's own `name` (and future meta, if any) must be
      // overridden by the user's values, not the other way around.
      const doc: Project = {
        ...initialProject,
        name,
        // Only include meta if the user provided at least one field —
        // ProjectMetaForm already strips empty strings, but an all-
        // empty-string submission still produces {} which we'd rather
        // not persist (see the Project.meta type comment).
        ...(meta && Object.keys(meta).length > 0 ? { meta } : {}),
      };
      const created = await pb.collection('projects').create<ProjectRecord>({
        team: teamId,
        name,
        doc,
        revision: 0,
      });
      navigate(`/p/${created.id}`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Create failed.');
      setBusy(false); // reset ONLY on failure — on success we're already navigating away
    }
  }

  return (
    <PageShell
      label="FIG_04 · NEW PROJECT"
      userEmail={user?.email}
      onSignOut={signOut}
      width="default"
    >
      <div className="mb-6 flex items-center gap-2">
        <Link
          to={teamId ? `/teams/${teamId}` : '/'}
          className="font-mono text-[11px] text-ink-400 hover:text-ink-200 transition-colors"
        >
          {team ? `← ${team.name}` : t('team.allTeams')}
        </Link>
      </div>

      <div className="mb-8">
        <span className="tech-label">{t('projectMeta.bootstrapKicker')}</span>
        <h1 className="mt-1 font-editorial text-[44px] leading-[1.05] tracking-tight text-ink-50">
          {t('projectMeta.bootstrapTitle')}
        </h1>
        <p className="mt-3 text-ink-300 text-[14px] max-w-sm">
          {t('projectMeta.bootstrapDesc')}
        </p>
      </div>

      <ProjectMetaForm
        initialValue={{ name: '', meta: {} }}
        onSubmit={handleSubmit}
        cancelHref={teamId ? `/teams/${teamId}` : '/'}
        busy={busy}
        error={error}
        submitLabel={t('projectMeta.createProject')}
        submitBusyLabel={t('projectMeta.creating')}
      />
    </PageShell>
  );
}
