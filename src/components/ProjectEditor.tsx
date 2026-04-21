// ────────────────────────────────────────────────────────────────────────
// ProjectEditor — mounted at /p/:projectId.
//
// Lifecycle:
//   1. On mount, fetch the project record from the server.
//   2. Call store.loadProject(record.doc) to hand it to the existing
//      Zustand store. The editor (<App/>) doesn't know or care that
//      the project came from the server — it just reads the store like
//      it always has. Keeping the editor server-agnostic is what makes
//      it possible to develop the canvas in isolation.
//   3. On unmount, call store.resetProject() so the next /p/:id load
//      starts from a clean slate. Without this, navigating from project
//      A to project B would briefly flash A's roofs/panels because the
//      next mount's fetch is async.
//
// Task 12/13 adds the syncClient subscription here (outbound diff + POST
// of patches, inbound SSE for collaborator changes). This task stops
// short of that — opening a project works but nothing is synced back
// to the server yet. Edits made here will be lost on refresh until
// Task 12 wires the patch stream.
//
// Error handling:
//   404 (project deleted) and 403 (caller is not a team member) are
//   treated as "you can't see this project" — we redirect to the home
//   page rather than show a scary error. Any other error surfaces with
//   a Back link.
// ────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { pb } from '../backend/pb';
import type { ProjectRecord } from '../backend/types';
import { useProjectStore } from '../store/projectStore';
import App from '../App';

export default function ProjectEditor() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  // `loaded` gates rendering of <App/>. We can't render it until the
  // store has a real project doc — otherwise the canvas would render
  // briefly with whatever stale state was in the store from a previous
  // session (or the default initialProject, which would look like a
  // half-loaded blank project to the user).
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!projectId) return;
    // `cancelled` prevents a race when the user navigates away mid-fetch:
    // the in-flight Promise still resolves, but we ignore its result so
    // we don't loadProject() into an unmounted/unrelated tree. Without
    // this flag a fast back-button press could overwrite the next page's
    // state with this page's late-arriving doc.
    let cancelled = false;
    pb.collection('projects')
      .getOne<ProjectRecord>(projectId)
      .then((record) => {
        if (cancelled) return;
        // We use getState() rather than a hook subscription because
        // loadProject is an action we just want to fire once — no need
        // to re-render this component when other store fields change.
        useProjectStore.getState().loadProject(record.doc);
        setLoaded(true);
      })
      .catch((err) => {
        if (cancelled) return;
        // 404 (project deleted/renamed) and 403 (not a member) both mean
        // the user can't see this project — bounce to the home page rather
        // than surface a scary error. `replace: true` so the back button
        // doesn't loop them straight back into the failing /p/:id URL.
        if (err?.status === 404 || err?.status === 403) {
          navigate('/', { replace: true });
          return;
        }
        setError(err?.message ?? 'Failed to load project');
      });
    return () => {
      cancelled = true;
      // Clear the store on unmount so the next project load starts clean.
      // See header comment for why this matters across project navigation.
      useProjectStore.getState().resetProject();
    };
  }, [projectId, navigate]);

  if (error) {
    return (
      <div className="min-h-screen bg-zinc-900 text-zinc-100 p-6">
        <p className="text-red-400">Failed to open project: {error}</p>
        <Link className="underline mt-3 inline-block" to="/">← Back</Link>
      </div>
    );
  }
  if (!loaded) {
    return (
      <div className="min-h-screen bg-zinc-900 text-zinc-100 p-6">
        Loading…
      </div>
    );
  }
  return <App />;
}
