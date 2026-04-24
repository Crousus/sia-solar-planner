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

// ────────────────────────────────────────────────────────────────────────
// PanelModelPicker — <select>-based catalog picker for panel models.
//
// Used by:
//   - NewProjectPage's bootstrap flow (required field)
//   - Sidebar's "Change panel model" inline toggle
//
// What it does:
//   - On mount, fetches all non-deleted panel_models records sorted by
//     manufacturer+model so the dropdown reads alphabetically.
//   - Renders a native <select> because it needs no custom interaction
//     beyond "pick one from a list of ~dozens" — a full combobox would
//     be over-engineering, especially since we already style native
//     controls via .input.
//   - Empty state: if the catalog is empty the caller (NewProjectPage)
//     renders a link to /catalog rather than leaving the user stuck
//     with "nothing to pick". We surface the empty case via customers===[]
//     in the parent rather than in this component so the parent can
//     place the link within its own layout.
//
// Why value is just `string | null` (not the full record):
//   The parent usually only needs the id for a FK write. When the user
//   actually picks a new option we pass BOTH id + record to onChange so
//   the parent can also use the full record for display (see
//   setPanelModelFromCatalog in projectStore, which builds a PanelType
//   from the record without a follow-up fetch).
// ────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { pb } from '../backend/pb';
import type { PanelModelRecord } from '../backend/types';

interface Props {
  /** Currently selected panel_model record id, or null for unselected. */
  value: string | null;
  /** Called when the user picks a different entry. Receives both the
   *  id (for FK writes) and the full record (for local state hydration). */
  onChange: (id: string, record: PanelModelRecord) => void;
}

export default function PanelModelPicker({ value, onChange }: Props) {
  const { t } = useTranslation();
  // `null` = still loading. Empty array = loaded, catalog is empty.
  // Distinguishing these lets us render three separate states: spinner,
  // "add your first" link, or the dropdown.
  const [models, setModels] = useState<PanelModelRecord[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    pb.collection('panel_models')
      .getFullList<PanelModelRecord>({
        // Soft-deleted entries stay in the DB so existing FK references
        // don't break, but we hide them from the picker — the user
        // shouldn't be able to pick something flagged as removed.
        filter: 'deleted=false',
        sort: 'manufacturer,model',
      })
      .then((recs) => { if (!cancelled) setModels(recs); })
      .catch(() => { if (!cancelled) setModels([]); });
    return () => { cancelled = true; };
  }, []);

  function handleChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const id = e.target.value;
    if (!id) return; // blank option → ignore (we don't support "unselect" here)
    const rec = (models ?? []).find((m) => m.id === id);
    if (!rec) return;
    onChange(id, rec);
  }

  // Empty catalog — steer the user to /catalog to add one. Rendered
  // as a tiny inline link rather than a full empty-state card because
  // the picker lives inside larger forms (bootstrap, sidebar) and a
  // card would visually dominate.
  if (models !== null && models.length === 0) {
    return (
      <div className="text-[12.5px] text-ink-300 mt-1">
        <Link to="/catalog" className="underline hover:text-sun-300">
          {t('panelModel.emptyAddFirst')}
        </Link>
      </div>
    );
  }

  return (
    <select
      className="input mt-1"
      value={value ?? ''}
      onChange={handleChange}
      // Disabled while loading — prevents the brief "select shows 'Select a
      // panel model' but has no options" flicker between mount and fetch.
      disabled={models === null}
    >
      <option value="">{t('panelModel.selectPrompt')}</option>
      {(models ?? []).map((m) => (
        <option key={m.id} value={m.id}>
          {`${m.manufacturer} ${m.model} — ${m.wattPeak} Wp`}
        </option>
      ))}
    </select>
  );
}
