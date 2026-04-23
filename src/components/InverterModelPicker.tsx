// ────────────────────────────────────────────────────────────────────────
// InverterModelPicker — <select>-based catalog picker for inverter
// models, used by Sidebar to link/unlink an inverter to a catalog entry.
//
// Differs from PanelModelPicker in two ways:
//   (1) Unlink is a first-class option. The "— No model —" entry passes
//       null through onChange, which the store's `linkInverterModel`
//       translates to "clear the FK". Panel model picker doesn't need
//       this because panel_model is effectively always set once a
//       project is bootstrapped.
//   (2) No empty-catalog Link affordance. Sidebar's flow is "you're
//       already deep in a project and just want to associate a model"
//       — sending the user away to /catalog mid-edit is more disruptive
//       than useful. If the catalog is empty we just show the select
//       with only the "No model" option; the user can navigate to
//       /catalog from the sidebar hardware link if they need.
// ────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { pb } from '../backend/pb';
import type { InverterModelRecord } from '../backend/types';

interface Props {
  /** Currently linked inverter_models id, or null for unlinked. */
  value: string | null;
  /** Called when the user picks. Passes (null, null) for the "No
   *  model" unlink case so the store can clear both the doc field and
   *  any cache entry it keeps. */
  onChange: (id: string | null, record: InverterModelRecord | null) => void;
}

export default function InverterModelPicker({ value, onChange }: Props) {
  const { t } = useTranslation();
  const [models, setModels] = useState<InverterModelRecord[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    pb.collection('inverter_models')
      .getFullList<InverterModelRecord>({
        filter: 'deleted=false',
        sort: 'manufacturer,model',
      })
      .then((recs) => { if (!cancelled) setModels(recs); })
      .catch(() => { if (!cancelled) setModels([]); });
    return () => { cancelled = true; };
  }, []);

  function handleChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const id = e.target.value;
    if (!id) {
      // Unlink — explicit null pair lets the store clear the doc field.
      onChange(null, null);
      return;
    }
    const rec = (models ?? []).find((m) => m.id === id);
    if (!rec) return;
    onChange(id, rec);
  }

  return (
    <select
      className="input"
      style={{ fontSize: 11 }}
      value={value ?? ''}
      onChange={handleChange}
      disabled={models === null}
    >
      <option value="">{t('inverterModel.noModelOption')}</option>
      {(models ?? []).map((m) => (
        <option key={m.id} value={m.id}>
          {`${m.manufacturer} ${m.model} — ${m.maxAcPowerW} W`}
        </option>
      ))}
    </select>
  );
}
