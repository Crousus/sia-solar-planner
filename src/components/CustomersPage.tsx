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
// CustomersPage — /teams/:teamId/customers
//
// CRUD page for the team's customer database. Any member can create and
// edit; admin-only delete (mirroring how project delete works in TeamView).
//
// Layout:
//   - Header with breadcrumb + "New customer" button
//   - Create/edit form panel (shown when editing !== null)
//   - Customer list with edit + delete actions per row
//
// PocketBase calls:
//   - list:   GET /api/collections/customers/records?filter=team=X
//   - create: POST /api/collections/customers/records
//   - update: PATCH /api/collections/customers/records/:id
//   - delete: DELETE /api/collections/customers/records/:id
// All are standard PB collection endpoints — no custom handler needed
// because customers.updateRule allows team members directly.
// ────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { pb } from '../backend/pb';
import type { CustomerRecord, TeamRecord, TeamMemberRecord } from '../backend/types';
import type { ProjectAddress } from '../types';
import { useAuthUser } from './AppShell';
import { PageShell } from './PageShell';
import AddressAutocomplete from './AddressAutocomplete';

interface CustomerFormState {
  name: string;
  street: string;
  housenumber: string;
  city: string;
  postcode: string;
  country: string;
  phone: string;
  email: string;
  notes: string;
}

function emptyForm(): CustomerFormState {
  return { name: '', street: '', housenumber: '', city: '', postcode: '', country: '', phone: '', email: '', notes: '' };
}

function recordToForm(c: CustomerRecord): CustomerFormState {
  return {
    name:        c.name ?? '',
    street:      c.street ?? '',
    housenumber: c.housenumber ?? '',
    city:        c.city ?? '',
    postcode:    c.postcode ?? '',
    country:     c.country ?? '',
    phone:       c.phone ?? '',
    email:       c.email ?? '',
    notes:       c.notes ?? '',
  };
}

export default function CustomersPage() {
  const { t } = useTranslation();
  const { teamId } = useParams<{ teamId: string }>();
  const user = useAuthUser();
  const navigate = useNavigate();

  const [team, setTeam] = useState<TeamRecord | null>(null);
  const [customers, setCustomers] = useState<CustomerRecord[] | null>(null);
  const [myRole, setMyRole] = useState<'admin' | 'member' | null>(null);
  const [error, setError] = useState<string | null>(null);

  // editingId: null = no form shown, 'new' = create form, string = edit form for that id
  const [editingId, setEditingId] = useState<'new' | string | null>(null);
  const [form, setForm] = useState<CustomerFormState>(emptyForm());
  // addressPick tracks the last autocomplete selection. We don't store
  // lat/lon on customers, so this is only used to drive the autocomplete
  // widget's "committed value" display — the actual address data lives
  // in the flat form fields (street, housenumber, etc.) as editable text.
  const [addressPick, setAddressPick] = useState<ProjectAddress | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function signOut() {
    pb.authStore.clear();
    navigate('/login', { replace: true });
  }

  useEffect(() => {
    if (!teamId || !user) return;
    let cancelled = false;
    Promise.all([
      pb.collection('teams').getOne<TeamRecord>(teamId),
      pb.collection('customers').getFullList<CustomerRecord>({
        filter: `team="${teamId}"`,
        sort: 'name',
      }),
      pb.collection('team_members').getFirstListItem<TeamMemberRecord>(
        `team="${teamId}" && user="${user.id}"`
      ),
    ])
      .then(([teamRec, custs, me]) => {
        if (cancelled) return;
        setTeam(teamRec);
        setCustomers(custs);
        setMyRole(me.role);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err?.status === 404 || err?.status === 403) {
          navigate('/', { replace: true });
          return;
        }
        setError(err?.message ?? 'Failed to load customers');
      });
    return () => { cancelled = true; };
  }, [teamId, user, navigate]);

  function startCreate() {
    setEditingId('new');
    setForm(emptyForm());
    setAddressPick(undefined);
    setFormError(null);
  }

  function startEdit(c: CustomerRecord) {
    setEditingId(c.id);
    setForm(recordToForm(c));
    // We don't store lat/lon, so we can't reconstruct a full ProjectAddress
    // from the record. Start with no committed pick — the user can use the
    // autocomplete to replace the address, or edit the sub-fields directly.
    setAddressPick(undefined);
    setFormError(null);
  }

  function cancelEdit() {
    setEditingId(null);
    setAddressPick(undefined);
    setFormError(null);
  }

  // When the user picks from the address autocomplete, populate all flat
  // address fields so they remain editable after the pick.
  function handleAddressPick(addr: ProjectAddress | undefined) {
    setAddressPick(addr);
    if (addr) {
      setForm((f) => ({
        ...f,
        street:      addr.street      ?? '',
        housenumber: addr.housenumber ?? '',
        city:        addr.city        ?? '',
        postcode:    addr.postcode    ?? '',
        country:     addr.country     ?? '',
      }));
    }
  }

  const ADDRESS_FIELDS = new Set<keyof CustomerFormState>(['street', 'housenumber', 'city', 'postcode', 'country']);

  function field(key: keyof CustomerFormState) {
    return (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setForm((f) => ({ ...f, [key]: e.target.value }));
      // Any manual edit to an address sub-field means the autocomplete's
      // committed pick is no longer accurate — clear it so the widget
      // resets to empty rather than showing a stale formatted label.
      if (ADDRESS_FIELDS.has(key)) setAddressPick(undefined);
    };
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim() || busy) return;
    setBusy(true);
    setFormError(null);
    try {
      if (editingId === 'new') {
        const rec = await pb.collection('customers').create<CustomerRecord>({
          team: teamId,
          name: form.name.trim(),
          // Only include non-empty optional fields on create — omitting them
          // is cleaner than sending empty strings that PB stores as ''.
          ...(form.street.trim()      ? { street:      form.street.trim() }      : {}),
          ...(form.housenumber.trim() ? { housenumber: form.housenumber.trim() } : {}),
          ...(form.city.trim()        ? { city:        form.city.trim() }        : {}),
          ...(form.postcode.trim()    ? { postcode:    form.postcode.trim() }    : {}),
          ...(form.country.trim()     ? { country:     form.country.trim() }     : {}),
          ...(form.phone.trim()       ? { phone:       form.phone.trim() }       : {}),
          ...(form.email.trim()       ? { email:       form.email.trim() }       : {}),
          ...(form.notes.trim()       ? { notes:       form.notes.trim() }       : {}),
        });
        setCustomers((prev) =>
          [...(prev ?? []), rec].sort((a, b) => a.name.localeCompare(b.name))
        );
      } else if (editingId) {
        const rec = await pb.collection('customers').update<CustomerRecord>(editingId, {
          name: form.name.trim(),
          // Explicitly pass null for cleared optional fields so PB removes the stored value.
          // Omitting them would leave stale data; empty string also clears in PB but null is explicit.
          street:      form.street.trim()      || null,
          housenumber: form.housenumber.trim() || null,
          city:        form.city.trim()        || null,
          postcode:    form.postcode.trim()    || null,
          country:     form.country.trim()     || null,
          phone:       form.phone.trim()       || null,
          email:       form.email.trim()       || null,
          notes:       form.notes.trim()       || null,
        });
        setCustomers((prev) =>
          (prev ?? []).map((c) => (c.id === rec.id ? rec : c))
            .sort((a, b) => a.name.localeCompare(b.name))
        );
      }
      setEditingId(null);
    } catch (err: unknown) {
      setFormError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm(t('customer.deleteConfirm'))) return;
    try {
      await pb.collection('customers').delete(id);
      setCustomers((prev) => (prev ?? []).filter((c) => c.id !== id));
      // If we were editing this customer, close the form.
      if (editingId === id) setEditingId(null);
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Delete failed.');
    }
  }

  const loading = !team || !customers || !myRole;

  return (
    <PageShell
      label="FIG_03 · CUSTOMERS"
      userEmail={user?.email}
      onSignOut={signOut}
      width="default"
    >
      {error && (
        <div
          role="alert"
          className="rounded-lg px-3 py-2 text-[12.5px] mb-4"
          style={{
            background: 'rgba(255, 99, 99, 0.08)',
            border: '1px solid rgba(255, 99, 99, 0.35)',
            color: 'var(--sun-200)',
          }}
        >
          {error}
        </div>
      )}

      {loading ? (
        <div>
          <div className="h-6 w-40 rounded bg-white/[0.04] mb-3 animate-pulse" />
          <div className="h-11 w-72 rounded bg-white/[0.04] mb-10 animate-pulse" />
        </div>
      ) : (
        <>
          <header className="mb-8">
            <div className="flex items-center gap-2 mb-3">
              <Link to="/" className="font-mono text-[12.5px] text-ink-400 hover:text-ink-200 transition-colors">
                {t('team.allTeams')}
              </Link>
              <span className="font-mono text-[12.5px] text-ink-500">/</span>
              <Link
                to={`/teams/${team!.id}`}
                className="font-mono text-[12.5px] text-ink-400 hover:text-ink-200 transition-colors"
              >
                {team!.name}
              </Link>
            </div>
            <div className="flex items-end justify-between gap-4">
              <div>
                <span className="tech-label" style={{ fontSize: 12 }}>{t('customer.sectionTitle')}</span>
                <h1 className="mt-1 font-editorial text-[44px] leading-[1.05] tracking-tight text-ink-50">
                  {t('customer.pageTitle')}
                </h1>
                <p className="mt-2 text-ink-300 text-[13.5px] max-w-sm">{t('customer.pageDesc')}</p>
              </div>
              <button
                onClick={startCreate}
                className="btn btn-primary shrink-0"
                style={{ padding: '11px 18px', fontSize: 14 }}
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
                <span>{t('customer.newCustomer')}</span>
              </button>
            </div>
          </header>

          {/* Create / Edit form panel — shown when editingId is set */}
          {editingId !== null && (
            <form
              onSubmit={handleSave}
              className="surface rounded-[14px] p-6 mb-6 space-y-4"
            >
              <div className="grid grid-cols-2 gap-3">
                <label className="col-span-2 block">
                  <span className="field-label">{t('customer.name')}</span>
                  <input className="input" value={form.name} onChange={field('name')} placeholder={t('customer.namePlaceholder')} required maxLength={200} autoFocus />
                </label>
                <label className="block">
                  <span className="field-label">{t('customer.phone')}</span>
                  <input className="input" value={form.phone} onChange={field('phone')} placeholder={t('customer.phonePlaceholder')} maxLength={50} />
                </label>
                <label className="block">
                  <span className="field-label">{t('customer.email')}</span>
                  <input className="input" type="email" value={form.email} onChange={field('email')} placeholder={t('customer.emailPlaceholder')} maxLength={200} />
                </label>
                <div className="col-span-2 block">
                  <span className="field-label">{t('projectMeta.address')}</span>
                  {/*
                    Autocomplete fills the sub-fields below on pick.
                    The widget shows the formatted label of the last committed
                    pick; once the user edits any sub-field directly, addressPick
                    is cleared and the widget resets to empty so there's no
                    stale label floating above hand-edited fields.
                  */}
                  <AddressAutocomplete value={addressPick} onChange={handleAddressPick} />
                  {/* Sub-fields in a 4-col grid matching ProjectMetaForm's address layout. */}
                  <div className="mt-2 grid grid-cols-4 gap-2">
                    <label className="col-span-3 block">
                      <span className="field-label">{t('customer.street')}</span>
                      <input className="input" value={form.street} onChange={field('street')} maxLength={200} />
                    </label>
                    <label className="col-span-1 block">
                      <span className="field-label">{t('customer.housenumber')}</span>
                      <input className="input" value={form.housenumber} onChange={field('housenumber')} maxLength={20} />
                    </label>
                    <label className="col-span-1 block">
                      <span className="field-label">{t('customer.postcode')}</span>
                      <input className="input" value={form.postcode} onChange={field('postcode')} maxLength={20} />
                    </label>
                    <label className="col-span-3 block">
                      <span className="field-label">{t('customer.city')}</span>
                      <input className="input" value={form.city} onChange={field('city')} maxLength={100} />
                    </label>
                    <label className="col-span-4 block">
                      <span className="field-label">{t('customer.country')}</span>
                      <input className="input" value={form.country} onChange={field('country')} maxLength={100} />
                    </label>
                  </div>
                </div>
                <label className="col-span-2 block">
                  <span className="field-label">{t('customer.notes')}</span>
                  <textarea className="input" value={form.notes} onChange={field('notes')} placeholder={t('customer.notesPlaceholder')} maxLength={2000} rows={3} style={{ resize: 'vertical', minHeight: 72 }} />
                </label>
              </div>
              {formError && (
                <div role="alert" className="rounded-lg px-3 py-2 text-[12.5px]" style={{ background: 'rgba(255,99,99,0.08)', border: '1px solid rgba(255,99,99,0.35)', color: 'var(--sun-200)' }}>
                  {formError}
                </div>
              )}
              <div className="flex gap-2 pt-1">
                <button
                  type="submit"
                  disabled={!form.name.trim() || busy}
                  className="btn btn-primary"
                  style={{ padding: '10px 14px', fontSize: 13 }}
                >
                  {busy ? t('customer.saving') : t('customer.save')}
                </button>
                <button type="button" onClick={cancelEdit} className="btn btn-ghost" style={{ padding: '10px 14px', fontSize: 13 }}>
                  {t('customer.cancel')}
                </button>
              </div>
            </form>
          )}

          {/* Customer list */}
          {customers!.length === 0 && editingId === null ? (
            <div className="surface rounded-2xl px-8 py-14 text-center">
              <span className="tech-label" style={{ fontSize: 12 }}>{t('customer.sectionTitle')}</span>
              <h2 className="mt-3 font-editorial text-[34px] text-ink-50 leading-none">{t('customer.emptyTitle')}</h2>
              <p className="mt-3 text-ink-300 text-[15px] max-w-sm mx-auto">{t('customer.emptyBody')}</p>
            </div>
          ) : (
            <ul className="space-y-2">
              {customers!.map((c) => (
                <li key={c.id}>
                  <div
                    className="surface-row group relative flex items-center gap-4 rounded-xl p-4 border"
                    style={{ borderColor: 'var(--hairline)' }}
                  >
                    <div className="flex-1 min-w-0">
                      <span className="block font-medium text-[15px] text-ink-100 truncate">{c.name}</span>
                      {(c.phone || c.email) && (
                        <span className="block font-mono text-[12px] text-ink-400 truncate">
                          {[c.phone, c.email].filter(Boolean).join(' · ')}
                        </span>
                      )}
                      {(c.street || c.city) && (
                        <span className="block text-[12.5px] text-ink-300 truncate">
                          {[
                            c.street && (c.street + (c.housenumber ? ' ' + c.housenumber : '')),
                            c.postcode && c.city ? c.postcode + ' ' + c.city : (c.city || c.postcode),
                          ].filter(Boolean).join(', ')}
                        </span>
                      )}
                    </div>
                    <div className="flex gap-2 shrink-0 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                      <button
                        onClick={() => startEdit(c)}
                        className="btn btn-ghost relative"
                        style={{ padding: '6px 11px', fontSize: 13 }}
                      >
                        {t('customer.edit')}
                      </button>
                      {myRole === 'admin' && (
                        <button
                          onClick={() => handleDelete(c.id)}
                          className="btn btn-danger relative"
                          style={{ padding: '6px 11px', fontSize: 13 }}
                        >
                          {t('customer.deleteCustomer')}
                        </button>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </PageShell>
  );
}
