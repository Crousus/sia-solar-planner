// ────────────────────────────────────────────────────────────────────────
// ProjectSettingsPage — /p/:projectId/settings
//
// Edit an existing project's bootstrap metadata (name, client, address,
// notes) outside the full editor. Reuses ProjectMetaForm; the difference
// vs NewProjectPage is the submit path: instead of creating a record,
// we compute a JSON Patch against the server's current doc and POST it
// through the same /api/sp/patch endpoint the live editor uses.
//
// Why not mount the editor + store + syncClient here:
//   That would pull in Leaflet, Konva, and the entire canvas. A settings
//   form doesn't need any of it. Using the patch endpoint directly also
//   side-steps the question of "does a settings edit go through the
//   undo stack" — answer: no, settings aren't part of the editor's
//   undo-able timeline, and routing around the store makes that implicit
//   without special-casing.
//
// Concurrency:
//   We send our `fromRevision` along with the ops. If another tab (or
//   collaborator) has advanced the revision since we fetched, the server
//   returns 409. We surface that as "Another change landed while you
//   were editing. Reload and try again." — honest, and cheap for the
//   settings page because we don't have any merge UX to fall back on.
// ────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { pb } from '../backend/pb';
import type { ProjectRecord } from '../backend/types';
import type { Project } from '../types';
import { diffProjects } from '../backend/diff';
import { useAuthUser } from './AppShell';
import { PageShell } from './PageShell';
import ProjectMetaForm from './ProjectMetaForm';

export default function ProjectSettingsPage() {
  const { t } = useTranslation();
  const { projectId } = useParams<{ projectId: string }>();
  const user = useAuthUser();
  const navigate = useNavigate();

  const [record, setRecord] = useState<ProjectRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    pb.collection('projects')
      .getOne<ProjectRecord>(projectId)
      .then((rec) => {
        if (!cancelled) setRecord(rec);
      })
      .catch((err) => {
        if (cancelled) return;
        // 404/403 → bounce home (same policy as ProjectEditor).
        if (err?.status === 404 || err?.status === 403) {
          navigate('/', { replace: true });
          return;
        }
        setError(err?.message ?? 'Failed to load project');
      });
    return () => { cancelled = true; };
  }, [projectId, navigate]);

  async function signOut() {
    pb.authStore.clear();
    navigate('/login', { replace: true });
  }

  async function handleSubmit({ name, meta }: { name: string; meta: Project['meta'] }) {
    if (!record) return;
    setBusy(true);
    setError(null);
    try {
      // Build the target doc. Only name + meta differ from the server's
      // current view; every other field is carried through as-is so the
      // diff is minimal (ideally 1-2 ops).
      const nextDoc: Project = { ...record.doc, name };
      if (meta && Object.keys(meta).length > 0) {
        nextDoc.meta = meta;
      } else {
        // User cleared every optional field → remove `meta` entirely
        // (rather than persisting {}), consistent with our data-model
        // rule that meta is either absent or non-empty.
        delete nextDoc.meta;
      }

      const ops = diffProjects(record.doc, nextDoc);
      if (ops.length === 0) {
        // Nothing to save — still navigate back so the user's "Save"
        // click isn't a dead end. Doesn't happen often in practice
        // (users clicking Save usually changed something) but worth
        // handling cleanly.
        navigate(`/p/${record.id}`);
        return;
      }

      const res = await fetch('/api/sp/patch', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${pb.authStore.token}`,
        },
        body: JSON.stringify({
          projectId: record.id,
          fromRevision: record.revision,
          ops,
          // A fresh random device id is safe here: this page doesn't
          // subscribe to the SSE stream, so the server's self-filter
          // logic (which keys off device_id) has nothing to match.
          // An editor tab open in parallel will see this patch as
          // coming from "another device" and apply it normally.
          deviceId: crypto.randomUUID(),
        }),
      });

      if (res.status === 200) {
        // Server accepted. We don't need the newRevision locally (this
        // page is about to unmount); just navigate back to the editor.
        navigate(`/p/${record.id}`);
        return;
      }
      if (res.status === 409) {
        setError(t('projectMeta.conflictRetry'));
        setBusy(false);
        return;
      }
      // Any other status is unexpected — surface the response text so
      // the user sees something diagnostic rather than a silent failure.
      const text = await res.text().catch(() => '');
      setError(text || `Save failed (${res.status}).`);
      setBusy(false);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Save failed.');
      setBusy(false);
    }
  }

  return (
    <PageShell
      label="FIG_05 · PROJECT SETTINGS"
      userEmail={user?.email}
      onSignOut={signOut}
      width="default"
    >
      <div className="mb-6 flex items-center gap-2">
        <Link
          to={record ? `/p/${record.id}` : '/'}
          className="font-mono text-[11px] text-ink-400 hover:text-ink-200 transition-colors"
        >
          ← {t('projectMeta.backToEditor')}
        </Link>
      </div>

      <div className="mb-8">
        <span className="tech-label">{t('projectMeta.settingsKicker')}</span>
        <h1 className="mt-1 font-editorial text-[44px] leading-[1.05] tracking-tight text-ink-50">
          {t('projectMeta.settingsTitle')}
        </h1>
      </div>

      {!record ? (
        // Skeleton card kept in the same grid slot as the form so the
        // layout doesn't shift when the fetch resolves. Same pattern
        // TeamView uses.
        <div
          className="surface rounded-[14px] p-6"
          style={{ minHeight: 420 }}
          aria-hidden
        >
          <div className="h-3 w-24 rounded bg-white/[0.04] mb-3 animate-pulse" />
          <div className="h-9 w-full rounded bg-white/[0.04] mb-5 animate-pulse" />
          <div className="h-3 w-24 rounded bg-white/[0.04] mb-3 animate-pulse" />
          <div className="h-9 w-full rounded bg-white/[0.04] mb-5 animate-pulse" />
          <div className="h-56 w-full rounded bg-white/[0.04] animate-pulse" />
        </div>
      ) : (
        <ProjectMetaForm
          initialValue={{
            name: record.doc.name ?? '',
            meta: record.doc.meta ?? {},
          }}
          onSubmit={handleSubmit}
          cancelHref={`/p/${record.id}`}
          busy={busy}
          error={error}
          submitLabel={t('projectMeta.saveChanges')}
          submitBusyLabel={t('projectMeta.saving')}
        />
      )}
    </PageShell>
  );
}
