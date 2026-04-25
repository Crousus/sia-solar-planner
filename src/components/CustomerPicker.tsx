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
// CustomerPicker — dropdown to select an existing customer or create one
// inline. Used in ProjectMetaForm for both the new-project and settings
// pages.
//
// Two modes:
//   'select' — <select> with existing customers + "New customer…" option
//   'create' — inline mini-form (name, phone, email, notes); on save,
//              POSTs to the customers collection and calls onChange with
//              the new ID.
//
// The component owns its own customer list. Both pages (NewProjectPage
// and ProjectSettingsPage) pass teamId so the picker can scope the list.
// ────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { pb } from '../backend/pb';
import type { CustomerRecord } from '../backend/types';
import { formatErrorForUser } from '../utils/errorClassify';
import { pushToast } from '../store/toastStore';

interface Props {
  teamId: string;
  value: string | null; // currently selected customer ID, null = none
  onChange: (id: string | null) => void;
}

export default function CustomerPicker({ teamId, value, onChange }: Props) {
  const { t } = useTranslation();
  const [customers, setCustomers] = useState<CustomerRecord[] | null>(null);
  const [mode, setMode] = useState<'select' | 'create'>('select');
  const [newName, setNewName] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newNotes, setNewNotes] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  useEffect(() => {
    if (!teamId) return;
    let cancelled = false;
    pb.collection('customers')
      .getFullList<CustomerRecord>({ filter: `team="${teamId}"`, sort: 'name' })
      .then((recs) => { if (!cancelled) setCustomers(recs); })
      .catch((err) => {
        if (cancelled) return;
        // Previously this swallowed silently and left the picker
        // showing "no customers". The user couldn't tell whether they
        // genuinely had no customers or whether the fetch failed.
        // We now toast the failure (so it's visible) AND set an empty
        // list (so the picker still renders the "create new" option).
        // eslint-disable-next-line no-console
        console.error('[CustomerPicker] fetch failed', err);
        pushToast('error', formatErrorForUser(err, t), {
          dedupeKey: 'customer-picker-fetch',
        });
        setCustomers([]);
      });
    return () => { cancelled = true; };
  }, [teamId, t]);

  function handleSelectChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const v = e.target.value;
    if (v === '__create__') {
      setMode('create');
      return;
    }
    onChange(v === '' ? null : v);
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!newName.trim() || creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      const rec = await pb.collection('customers').create<CustomerRecord>({
        team: teamId,
        name: newName.trim(),
        ...(newPhone.trim() ? { phone: newPhone.trim() } : {}),
        ...(newEmail.trim() ? { email: newEmail.trim() } : {}),
        ...(newNotes.trim() ? { notes: newNotes.trim() } : {}),
      });
      // Insert the new record into the local list (sorted by name) so
      // subsequent opens of the picker reflect it without a refetch.
      setCustomers((prev) =>
        [...(prev ?? []), rec].sort((a, b) => a.name.localeCompare(b.name))
      );
      onChange(rec.id);
      setMode('select');
      setNewName(''); setNewPhone(''); setNewEmail(''); setNewNotes('');
    } catch (err: unknown) {
      // eslint-disable-next-line no-console
      console.error('[CustomerPicker] create failed', err);
      setCreateError(formatErrorForUser(err, t));
    } finally {
      setCreating(false);
    }
  }

  function cancelCreate() {
    setMode('select');
    setNewName(''); setNewPhone(''); setNewEmail(''); setNewNotes('');
    setCreateError(null);
  }

  if (mode === 'create') {
    return (
      <div
        className="rounded-lg p-3 space-y-2 mt-1"
        style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid var(--hairline)' }}
      >
        <form onSubmit={handleCreate} className="space-y-2">
          <label className="block">
            <span className="field-label">{t('customer.name')}</span>
            <input
              className="input"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder={t('customer.namePlaceholder')}
              required
              maxLength={200}
              autoFocus
            />
          </label>
          <label className="block">
            <span className="field-label">{t('customer.phone')}</span>
            <input
              className="input"
              value={newPhone}
              onChange={(e) => setNewPhone(e.target.value)}
              placeholder={t('customer.phonePlaceholder')}
              maxLength={50}
            />
          </label>
          <label className="block">
            <span className="field-label">{t('customer.email')}</span>
            <input
              className="input"
              type="email"
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              placeholder={t('customer.emailPlaceholder')}
              maxLength={200}
            />
          </label>
          <label className="block">
            <span className="field-label">{t('customer.notes')}</span>
            <textarea
              className="input"
              value={newNotes}
              onChange={(e) => setNewNotes(e.target.value)}
              placeholder={t('customer.notesPlaceholder')}
              maxLength={2000}
              rows={2}
              style={{ resize: 'vertical', minHeight: 56 }}
            />
          </label>
          {createError && (
            <div
              role="alert"
              className="rounded-lg px-3 py-2 text-[12.5px]"
              style={{
                background: 'rgba(255, 99, 99, 0.08)',
                border: '1px solid rgba(255, 99, 99, 0.35)',
                color: 'var(--sun-200)',
              }}
            >
              {createError}
            </div>
          )}
          <div className="flex gap-2 pt-1">
            <button
              type="submit"
              disabled={!newName.trim() || creating}
              className="btn btn-primary"
              style={{ padding: '8px 14px', fontSize: 13 }}
            >
              {creating ? t('customer.saving') : t('customer.addCustomer')}
            </button>
            <button
              type="button"
              onClick={cancelCreate}
              className="btn btn-ghost"
              style={{ padding: '8px 14px', fontSize: 13 }}
            >
              {t('customer.cancel')}
            </button>
          </div>
        </form>
      </div>
    );
  }

  return (
    <select
      className="input mt-1"
      value={value ?? ''}
      onChange={handleSelectChange}
      disabled={customers === null}
    >
      <option value="">{t('customer.noCustomer')}</option>
      {(customers ?? []).map((c) => (
        <option key={c.id} value={c.id}>{c.name}</option>
      ))}
      <option value="__create__">{t('customer.createNew')}</option>
    </select>
  );
}
