# Customer Database Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a team-scoped customer database with a CRUD page, a customer picker in the project creation and settings forms, and a filter-by-customer dropdown in the team project list.

**Architecture:** New `customers` PocketBase collection (team-scoped; any member can create/edit, admin-only delete). Projects get a top-level `customer` relation field outside the `doc` JSON blob so it can be filtered server-side without parsing blobs. A dedicated `/api/sp/set-customer` Go endpoint handles setting/unsetting the relation on existing projects (the default `projects` update endpoint is locked to null). The frontend adds a `CustomerPicker` component (select existing or inline-create), a `CustomersPage` CRUD view, and a customer filter in `TeamView`.

**Tech Stack:** PocketBase JS migrations · Go (PocketBase SDK) · React + TypeScript · react-router-dom v7 · PocketBase JS SDK · i18next · Vitest

---

### Task 1: Backend

**Files:**
- Create: `server/pb_migrations/1712346300_customers.js`
- Create: `server/handlers/set_customer.go`
- Modify: `server/handlers/patch.go` (register new route in `RegisterRoutes`)

---

- [ ] **Step 1.1: Create the PocketBase migration**

Create `server/pb_migrations/1712346300_customers.js`:

```js
/// <reference path="../pb_data/types.d.ts" />

// Adds the `customers` collection (team-scoped contact data) and a
// `customer` relation field on `projects`.
//
// Why `customer` lives on the projects collection (not inside doc.meta):
//   Top-level PocketBase columns are SQL-filterable; JSON blob fields are
//   not. Keeping it as a proper relation lets the server filter
//   projects-by-customer without a full table scan, and lets PocketBase's
//   expand mechanism return the customer record in a single query.
//
// Why cascadeDelete: false on projects.customer:
//   Deleting a customer should NOT cascade-delete their projects. The
//   relation is simply nulled. Deleting the customer is admin-gated anyway.

migrate((app) => {
  const teams = app.findCollectionByNameOrId('teams');

  // ── customers ──────────────────────────────────────────────────────
  // Rules mirror the `projects` pattern: any team member can list/view/
  // create/update; only admins can delete (same policy as project delete).
  const customers = new Collection({
    type: 'base',
    name: 'customers',
    listRule:   "@request.auth.id != '' && @collection.team_members.team = team && @collection.team_members.user = @request.auth.id",
    viewRule:   "@request.auth.id != '' && @collection.team_members.team = team && @collection.team_members.user = @request.auth.id",
    createRule: "@request.auth.id != '' && @collection.team_members.team = team && @collection.team_members.user = @request.auth.id",
    updateRule: "@request.auth.id != '' && @collection.team_members.team = team && @collection.team_members.user = @request.auth.id",
    deleteRule: "@request.auth.id != '' && @collection.team_members.team = team && @collection.team_members.user = @request.auth.id && @collection.team_members.role = 'admin'",
    fields: [
      { name: 'team',        type: 'relation', required: true,  collectionId: teams.id, cascadeDelete: true, maxSelect: 1 },
      { name: 'name',        type: 'text',     required: true,  min: 1, max: 200 },
      { name: 'street',      type: 'text',     required: false, max: 200 },
      { name: 'housenumber', type: 'text',     required: false, max: 20  },
      { name: 'city',        type: 'text',     required: false, max: 100 },
      { name: 'postcode',    type: 'text',     required: false, max: 20  },
      { name: 'country',     type: 'text',     required: false, max: 100 },
      { name: 'phone',       type: 'text',     required: false, max: 50  },
      { name: 'email',       type: 'email',    required: false },
      { name: 'notes',       type: 'text',     required: false, max: 5000 },
      { name: 'created',     type: 'autodate', onCreate: true,  onUpdate: false },
      { name: 'updated',     type: 'autodate', onCreate: true,  onUpdate: true  },
    ],
  });
  app.save(customers);

  // ── projects.customer ───────────────────────────────────────────────
  // Optional relation — null means "no customer linked". cascadeDelete:
  // false so deleting a customer doesn't cascade-delete their projects.
  const projects = app.findCollectionByNameOrId('projects');
  projects.fields.add(new RelationField({
    name: 'customer',
    collectionId: customers.id,
    cascadeDelete: false,
    required: false,
    maxSelect: 1,
  }));
  app.save(projects);
}, (app) => {
  // Down: remove field first (FK constraint), then drop the collection.
  const projects = app.findCollectionByNameOrId('projects');
  projects.fields.removeByName('customer');
  app.save(projects);
  app.delete(app.findCollectionByNameOrId('customers'));
});
```

- [ ] **Step 1.2: Verify the server compiles**

```bash
cd /home/johannes/projects/solar-planner/server && go build ./...
```

Expected: no output (clean build). If the migration file has a JS syntax error, this doesn't catch it — migration errors surface at runtime.

- [ ] **Step 1.3: Create the set-customer handler**

Create `server/handlers/set_customer.go`:

```go
package handlers

import (
	"net/http"

	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/core"
)

// setCustomerRequest is the body parsed from POST /api/sp/set-customer.
type setCustomerRequest struct {
	ProjectID  string `json:"projectId"`
	// CustomerID is the ID of the customer to link. Empty string unlinks.
	CustomerID string `json:"customerId"`
}

// handleSetCustomer sets or clears the `customer` relation field on a project.
//
// Why a dedicated endpoint (not the default collection PATCH):
//   projects.updateRule is null — all project mutations go through custom
//   endpoints. /api/sp/patch owns doc+revision updates; this endpoint owns
//   the single customer relation field, keeping both concerns separate and
//   the patch endpoint free of non-OCC logic.
//
// No transaction needed: we're updating one field with no concurrent-write
// conflict risk (two users simultaneously picking a different customer is
// a "last write wins" scenario that's acceptable for a relation field).
func handleSetCustomer(app *pocketbase.PocketBase, re *core.RequestEvent) error {
	if re.Auth == nil || re.Auth.Collection().Name != "users" {
		return re.UnauthorizedError("sign-in required", nil)
	}

	body := setCustomerRequest{}
	if err := re.BindBody(&body); err != nil {
		return re.BadRequestError("invalid JSON body", err)
	}
	if body.ProjectID == "" {
		return re.BadRequestError("projectId required", nil)
	}

	project, err := app.FindRecordById("projects", body.ProjectID)
	if err != nil {
		return re.NotFoundError("project not found", nil)
	}

	// Verify the caller is a member of this project's team.
	teamID := project.GetString("team")
	members, err := app.FindRecordsByFilter(
		"team_members",
		"team = {:team} && user = {:user}",
		"", 1, 0,
		map[string]any{"team": teamID, "user": re.Auth.Id},
	)
	if err != nil || len(members) == 0 {
		return re.ForbiddenError("not a member of this project's team", nil)
	}

	if body.CustomerID != "" {
		// Verify the customer belongs to the same team as the project,
		// so a member cannot link a project to another team's customer.
		customer, err := app.FindRecordById("customers", body.CustomerID)
		if err != nil {
			return re.NotFoundError("customer not found", nil)
		}
		if customer.GetString("team") != teamID {
			return re.ForbiddenError("customer does not belong to this project's team", nil)
		}
		project.Set("customer", body.CustomerID)
	} else {
		// Empty string clears the relation field in PocketBase.
		project.Set("customer", "")
	}

	if err := app.Save(project); err != nil {
		return re.InternalServerError("save project failed", err)
	}

	return re.JSON(http.StatusOK, map[string]string{"ok": "true"})
}
```

- [ ] **Step 1.4: Register the new route in `RegisterRoutes`**

In `server/handlers/patch.go`, find the `RegisterRoutes` function:

```go
func RegisterRoutes(app *pocketbase.PocketBase, e *core.ServeEvent) {
	e.Router.POST("/api/sp/patch", func(re *core.RequestEvent) error {
		return handlePatch(app, re)
	})
}
```

Replace it with:

```go
func RegisterRoutes(app *pocketbase.PocketBase, e *core.ServeEvent) {
	e.Router.POST("/api/sp/patch", func(re *core.RequestEvent) error {
		return handlePatch(app, re)
	})
	e.Router.POST("/api/sp/set-customer", func(re *core.RequestEvent) error {
		return handleSetCustomer(app, re)
	})
}
```

- [ ] **Step 1.5: Verify the server still compiles**

```bash
cd /home/johannes/projects/solar-planner/server && go build ./...
```

Expected: no output.

- [ ] **Step 1.6: Commit**

```bash
git add server/pb_migrations/1712346300_customers.js server/handlers/set_customer.go server/handlers/patch.go
git commit -m "feat(backend): add customers collection, projects.customer relation, set-customer endpoint"
```

---

### Task 2: Frontend

**Files:**
- Modify: `src/locales/en.ts`
- Modify: `src/locales/de.ts`
- Modify: `src/backend/types.ts`
- Create: `src/components/CustomerPicker.tsx`
- Create: `src/components/CustomersPage.tsx`
- Modify: `src/components/ProjectMetaForm.tsx`
- Modify: `src/components/NewProjectPage.tsx`
- Modify: `src/components/ProjectSettingsPage.tsx`
- Modify: `src/components/TeamView.tsx`
- Modify: `src/components/AppShell.tsx`

---

- [ ] **Step 2.1: Add i18n keys to `src/locales/en.ts`**

In the `team` section of `en.ts`, add `customers` after the `manageMembers` key:

```ts
// existing key:
manageMembers: 'Members',
// add after it:
customers: 'Customers',
```

Also add a brand-new top-level `customer` section at the end of the `en.ts` object, just before `} as const;`:

```ts
  customer: {
    // CustomersPage headers
    sectionTitle:  'CUSTOMERS',
    pageTitle:     'Customer database',
    pageDesc:      'Manage your team\'s customers. Link a customer to a project when creating or editing it.',
    newCustomer:   'New customer',
    emptyTitle:    'No customers yet',
    emptyBody:     'Create your first customer to link them to a project.',
    // Field labels (used in CustomersPage form and CustomerPicker inline-create)
    label:            'Customer',
    name:             'Name',
    namePlaceholder:  'e.g. Müller family',
    phone:            'Phone',
    phonePlaceholder: '+49 89 …',
    email:            'Email',
    emailPlaceholder: 'name@example.com',
    notes:            'Notes',
    notesPlaceholder: 'Any additional information (optional)',
    street:           'Street',
    housenumber:      'No.',
    postcode:         'ZIP',
    city:             'City',
    country:          'Country',
    // Actions
    addCustomer: 'Add customer',
    save:        'Save',
    saving:      'Saving…',
    cancel:      'Cancel',
    edit:        'Edit',
    deleteCustomer:  'Delete',
    deleteConfirm:   'Delete this customer? Projects linked to them will be unlinked.',
    // CustomerPicker dropdown options
    noCustomer:   '— no customer —',
    createNew:    'New customer…',
    allCustomers: 'All customers',
  },
```

- [ ] **Step 2.2: Add the same keys to `src/locales/de.ts`**

In the `team` section of `de.ts`, add `customers` after `manageMembers`:

```ts
customers: 'Kunden',
```

Add the `customer` section at the end of the `de.ts` object, just before `} satisfies Translations;`:

```ts
  customer: {
    sectionTitle:  'KUNDEN',
    pageTitle:     'Kundendatenbank',
    pageDesc:      'Verwalten Sie die Kunden Ihres Teams. Verknüpfen Sie beim Erstellen oder Bearbeiten eines Projekts einen Kunden.',
    newCustomer:   'Neuer Kunde',
    emptyTitle:    'Noch keine Kunden',
    emptyBody:     'Erstellen Sie Ihren ersten Kunden, um ihn mit einem Projekt zu verknüpfen.',
    label:            'Kunde',
    name:             'Name',
    namePlaceholder:  'z. B. Familie Müller',
    phone:            'Telefon',
    phonePlaceholder: '+49 89 …',
    email:            'E-Mail',
    emailPlaceholder: 'name@example.de',
    notes:            'Notizen',
    notesPlaceholder: 'Weitere Informationen (optional)',
    street:           'Straße',
    housenumber:      'Nr.',
    postcode:         'PLZ',
    city:             'Ort',
    country:          'Land',
    addCustomer: 'Kunden hinzufügen',
    save:        'Speichern',
    saving:      'Speichern…',
    cancel:      'Abbrechen',
    edit:        'Bearbeiten',
    deleteCustomer:  'Löschen',
    deleteConfirm:   'Diesen Kunden löschen? Verknüpfte Projekte werden entknüpft.',
    noCustomer:   '— kein Kunde —',
    createNew:    'Neuer Kunde…',
    allCustomers: 'Alle Kunden',
  },
```

- [ ] **Step 2.3: Verify the locales test passes**

```bash
cd /home/johannes/projects/solar-planner && npx vitest run src/locales/locales.test.ts
```

Expected: all tests pass. If any key is missing from `de.ts`, the test will name it.

- [ ] **Step 2.4: Update `src/backend/types.ts`**

Add `CustomerRecord` and update `ProjectRecord`. Find the existing `ProjectRecord` definition and replace it:

```ts
// After PatchRecord at the bottom of types.ts, add:

export interface CustomerRecord extends BaseRecord {
  team: string;        // team ID
  name: string;
  street?: string;
  housenumber?: string;
  city?: string;
  postcode?: string;
  country?: string;
  phone?: string;
  email?: string;
  notes?: string;
}
```

And replace the existing `ProjectRecord`:

```ts
export interface ProjectRecord extends BaseRecord {
  team: string;
  name: string;
  // `doc` is OUR Project type. Typed loosely here because the server
  // treats it as opaque JSON; we trust it because only our client ever
  // writes it (via patches whose ops are generated by our own diff util).
  doc: Project;
  revision: number;
  // customer relation — empty string when not linked, customer ID when linked.
  // When fetched with expand: 'customer', the record lives at expand?.customer.
  customer: string;
  expand?: {
    customer?: CustomerRecord;
  };
}
```

- [ ] **Step 2.5: Create `src/components/CustomerPicker.tsx`**

```tsx
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
      .catch(() => { if (!cancelled) setCustomers([]); });
    return () => { cancelled = true; };
  }, [teamId]);

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
      setCreateError(err instanceof Error ? err.message : 'Create failed');
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
```

- [ ] **Step 2.6: Update `src/components/ProjectMetaForm.tsx`**

**2.6a** — Update the `ProjectMetaFormValue` interface (add `customerId`):

Find:
```ts
export interface ProjectMetaFormValue {
  name: string;
  meta: ProjectMeta;
}
```

Replace with:
```ts
export interface ProjectMetaFormValue {
  name: string;
  meta: ProjectMeta;
  customerId: string | null;
}
```

**2.6b** — Add `teamId` to the `Props` interface:

Find:
```ts
interface Props {
  /** Initial values for the form. For new projects, pass name='' and
   *  meta={}; for settings, pass the existing record values. */
  initialValue: ProjectMetaFormValue;
```

Replace with:
```ts
interface Props {
  /** Team ID — passed to CustomerPicker so it can scope the customer list. */
  teamId: string;
  /** Initial values for the form. For new projects, pass name='' and
   *  meta={}; for settings, pass the existing record values. */
  initialValue: ProjectMetaFormValue;
```

**2.6c** — Add `CustomerPicker` import and `customerId` state. Find the import block at the top of the file:

```ts
import AddressAutocomplete from './AddressAutocomplete';
```

Replace with:
```ts
import AddressAutocomplete from './AddressAutocomplete';
import CustomerPicker from './CustomerPicker';
```

**2.6d** — Add `teamId` to the destructured props:

Find:
```ts
export default function ProjectMetaForm({
  initialValue,
  onSubmit,
  cancelHref,
  busy = false,
  error,
  submitLabel,
  submitBusyLabel,
}: Props) {
```

Replace with:
```ts
export default function ProjectMetaForm({
  teamId,
  initialValue,
  onSubmit,
  cancelHref,
  busy = false,
  error,
  submitLabel,
  submitBusyLabel,
}: Props) {
```

**2.6e** — Add `customerId` local state. Find the `client` state line:

```ts
  const [client, setClient] = useState(initialValue.meta.client ?? '');
```

Replace it with:
```ts
  const [customerId, setCustomerId] = useState<string | null>(initialValue.customerId ?? null);
```

**2.6f** — Update the `handleSubmit` to include `customerId` and remove `meta.client`:

Find:
```ts
    const meta: ProjectMeta = {};
    const cTrim = client.trim();
    if (cTrim) meta.client = cTrim;
    if (address) meta.address = address;
    const nTrim = notes.trim();
    if (nTrim) meta.notes = nTrim;

    await onSubmit({ name: name.trim(), meta });
```

Replace with:
```ts
    const meta: ProjectMeta = {};
    if (address) meta.address = address;
    const nTrim = notes.trim();
    if (nTrim) meta.notes = nTrim;

    await onSubmit({ name: name.trim(), meta, customerId });
```

**2.6g** — Replace the `client` text input with `CustomerPicker`. Find:

```tsx
      <label className="block">
        <span className="field-label">{t('projectMeta.client')}</span>
        <input
          className="input"
          value={client}
          onChange={(e) => setClient(e.target.value)}
          placeholder={t('projectMeta.clientPlaceholder')}
          maxLength={120}
        />
      </label>
```

Replace with:
```tsx
      <div className="block">
        <span className="field-label">{t('customer.label')}</span>
        <CustomerPicker teamId={teamId} value={customerId} onChange={setCustomerId} />
      </div>
```

- [ ] **Step 2.7: Update `src/components/NewProjectPage.tsx`**

**2.7a** — Add `customerId` to the submit handler signature. Find:

```ts
  async function handleSubmit({ name, meta }: { name: string; meta: Project['meta'] }) {
```

Replace with:
```ts
  async function handleSubmit({ name, meta, customerId }: { name: string; meta: Project['meta']; customerId: string | null }) {
```

**2.7b** — Include `customer` in the PocketBase create call. Find:

```ts
      const created = await pb.collection('projects').create<ProjectRecord>({
        team: teamId,
        name,
        doc,
        revision: 0,
      });
```

Replace with:
```ts
      const created = await pb.collection('projects').create<ProjectRecord>({
        team: teamId,
        name,
        doc,
        revision: 0,
        // Only include customer when set — empty string would still pass
        // the optional relation check but a conditional omission is cleaner.
        ...(customerId ? { customer: customerId } : {}),
      });
```

**2.7c** — Pass `teamId` and updated `initialValue` to `ProjectMetaForm`. Find:

```tsx
      <ProjectMetaForm
        initialValue={{ name: '', meta: {} }}
        onSubmit={handleSubmit}
        cancelHref={teamId ? `/teams/${teamId}` : '/'}
        busy={busy}
        error={error}
        submitLabel={t('projectMeta.createProject')}
        submitBusyLabel={t('projectMeta.creating')}
      />
```

Replace with:
```tsx
      <ProjectMetaForm
        teamId={teamId ?? ''}
        initialValue={{ name: '', meta: {}, customerId: null }}
        onSubmit={handleSubmit}
        cancelHref={teamId ? `/teams/${teamId}` : '/'}
        busy={busy}
        error={error}
        submitLabel={t('projectMeta.createProject')}
        submitBusyLabel={t('projectMeta.creating')}
      />
```

- [ ] **Step 2.8: Update `src/components/ProjectSettingsPage.tsx`**

**2.8a** — Update the submit handler. Find:

```ts
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
```

Replace with:
```ts
  async function handleSubmit({ name, meta, customerId }: { name: string; meta: Project['meta']; customerId: string | null }) {
    if (!record) return;
    setBusy(true);
    setError(null);
    try {
      // 1. Update customer relation if it changed. This is a separate
      //    server-side field (not part of the doc blob) so it gets its
      //    own endpoint call, independent of the doc patch below.
      const currentCustomer = record.customer || null;
      if (customerId !== currentCustomer) {
        await pb.send('/api/sp/set-customer', {
          method: 'POST',
          body: { projectId: record.id, customerId: customerId ?? '' },
        });
      }

      // 2. Build the target doc. Preserve any legacy meta.client that may
      //    exist on old projects (the form no longer writes it, but we
      //    carry it through so the diff doesn't emit a spurious remove op).
      const nextDoc: Project = { ...record.doc, name };
      const mergedMeta: Project['meta'] = {};
      if (record.doc.meta?.client) mergedMeta.client = record.doc.meta.client;
      if (meta?.address) mergedMeta.address = meta.address;
      if (meta?.notes) mergedMeta.notes = meta.notes;
      if (Object.keys(mergedMeta).length > 0) {
        nextDoc.meta = mergedMeta;
      } else {
        delete nextDoc.meta;
      }
```

**2.8b** — Pass `teamId` and `customerId` to `ProjectMetaForm`. Find:

```tsx
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
```

Replace with:
```tsx
        <ProjectMetaForm
          teamId={record.team}
          initialValue={{
            name: record.doc.name ?? '',
            meta: record.doc.meta ?? {},
            customerId: record.customer || null,
          }}
          onSubmit={handleSubmit}
          cancelHref={`/p/${record.id}`}
          busy={busy}
          error={error}
          submitLabel={t('projectMeta.saveChanges')}
          submitBusyLabel={t('projectMeta.saving')}
        />
```

- [ ] **Step 2.9: Create `src/components/CustomersPage.tsx`**

```tsx
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
import { useAuthUser } from './AppShell';
import { PageShell } from './PageShell';

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

  // editingId: null = no form shown, 'new' = create form, string = edit form
  const [editingId, setEditingId] = useState<'new' | string | null>(null);
  const [form, setForm] = useState<CustomerFormState>(emptyForm());
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
    setFormError(null);
  }

  function startEdit(c: CustomerRecord) {
    setEditingId(c.id);
    setForm(recordToForm(c));
    setFormError(null);
  }

  function cancelEdit() {
    setEditingId(null);
    setFormError(null);
  }

  function field(key: keyof CustomerFormState) {
    return (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setForm((f) => ({ ...f, [key]: e.target.value }));
  }

  // Build the PB payload — omit blank optional fields so we don't persist ''.
  function formPayload() {
    return {
      ...(form.street.trim()      ? { street:      form.street.trim() }      : {}),
      ...(form.housenumber.trim() ? { housenumber: form.housenumber.trim() } : {}),
      ...(form.city.trim()        ? { city:        form.city.trim() }        : {}),
      ...(form.postcode.trim()    ? { postcode:    form.postcode.trim() }    : {}),
      ...(form.country.trim()     ? { country:     form.country.trim() }     : {}),
      ...(form.phone.trim()       ? { phone:       form.phone.trim() }       : {}),
      ...(form.email.trim()       ? { email:       form.email.trim() }       : {}),
      ...(form.notes.trim()       ? { notes:       form.notes.trim() }       : {}),
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
          ...formPayload(),
        });
        setCustomers((prev) =>
          [...(prev ?? []), rec].sort((a, b) => a.name.localeCompare(b.name))
        );
      } else if (editingId) {
        const rec = await pb.collection('customers').update<CustomerRecord>(editingId, {
          name: form.name.trim(),
          // Explicitly set all optional fields (including empty strings) so
          // clearing a field in the form actually removes the stored value.
          street: form.street.trim() || null,
          housenumber: form.housenumber.trim() || null,
          city: form.city.trim() || null,
          postcode: form.postcode.trim() || null,
          country: form.country.trim() || null,
          phone: form.phone.trim() || null,
          email: form.email.trim() || null,
          notes: form.notes.trim() || null,
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

          {/* Create / Edit form panel */}
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
                <label className="col-span-2 block">
                  <span className="field-label">{t('customer.street')} / {t('customer.housenumber')}</span>
                  <div className="flex gap-2">
                    <input className="input flex-1" value={form.street} onChange={field('street')} maxLength={200} />
                    <input className="input w-20" value={form.housenumber} onChange={field('housenumber')} maxLength={20} />
                  </div>
                </label>
                <label className="block">
                  <span className="field-label">{t('customer.postcode')}</span>
                  <input className="input" value={form.postcode} onChange={field('postcode')} maxLength={20} />
                </label>
                <label className="block">
                  <span className="field-label">{t('customer.city')}</span>
                  <input className="input" value={form.city} onChange={field('city')} maxLength={100} />
                </label>
                <label className="col-span-2 block">
                  <span className="field-label">{t('customer.country')}</span>
                  <input className="input" value={form.country} onChange={field('country')} maxLength={100} />
                </label>
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
                          {[c.street && (c.street + (c.housenumber ? ' ' + c.housenumber : '')), c.postcode && c.city ? c.postcode + ' ' + c.city : (c.city || c.postcode)].filter(Boolean).join(', ')}
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
```

- [ ] **Step 2.10: Update `src/components/TeamView.tsx`**

**2.10a** — Add `CustomerRecord` import. Find:

```ts
import type { ProjectRecord, TeamRecord, TeamMemberRecord } from '../backend/types';
```

Replace with:

```ts
import type { ProjectRecord, TeamRecord, TeamMemberRecord, CustomerRecord } from '../backend/types';
```

**2.10b** — Add `customers` and `customerFilter` state. Find:

```ts
  const [myRole, setMyRole] = useState<'admin' | 'member' | null>(null);
  const [error, setError] = useState<string | null>(null);
```

Replace with:

```ts
  const [myRole, setMyRole] = useState<'admin' | 'member' | null>(null);
  const [customers, setCustomers] = useState<CustomerRecord[]>([]);
  const [customerFilter, setCustomerFilter] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
```

**2.10c** — Add customers fetch and expand to the Promise.all. Find:

```ts
    Promise.all([
      pb.collection('teams').getOne<TeamRecord>(teamId),
      pb.collection('projects').getFullList<ProjectRecord>({
        filter: `team="${teamId}"`,
        sort: '-updated',
      }),
      pb.collection('team_members').getFirstListItem<TeamMemberRecord>(
        `team="${teamId}" && user="${user.id}"`
      ),
    ])
      .then(([teamRec, projs, me]) => {
        if (cancelled) return;
        setTeam(teamRec);
        setProjects(projs);
        setMyRole(me.role);
      })
```

Replace with:

```ts
    Promise.all([
      pb.collection('teams').getOne<TeamRecord>(teamId),
      pb.collection('projects').getFullList<ProjectRecord>({
        filter: `team="${teamId}"`,
        sort: '-updated',
        // Expand the customer relation so the project row can display the
        // customer name without a separate fetch per row.
        expand: 'customer',
      }),
      pb.collection('team_members').getFirstListItem<TeamMemberRecord>(
        `team="${teamId}" && user="${user.id}"`
      ),
      pb.collection('customers').getFullList<CustomerRecord>({
        filter: `team="${teamId}"`,
        sort: 'name',
      }),
    ])
      .then(([teamRec, projs, me, custs]) => {
        if (cancelled) return;
        setTeam(teamRec);
        setProjects(projs);
        setMyRole(me.role);
        setCustomers(custs);
      })
```

**2.10d** — Add "Customers" nav link in the header. Find:

```tsx
                  {myRole === 'admin' && (
                    <Link
                      to={`/teams/${team!.id}/members`}
                      className="hover:text-ink-200 transition-colors"
                    >
                      {t('team.manageMembers')}
                    </Link>
                  )}
```

Replace with:

```tsx
                  {myRole === 'admin' && (
                    <Link
                      to={`/teams/${team!.id}/members`}
                      className="hover:text-ink-200 transition-colors"
                    >
                      {t('team.manageMembers')}
                    </Link>
                  )}
                  <Link
                    to={`/teams/${team!.id}/customers`}
                    className="hover:text-ink-200 transition-colors"
                  >
                    {t('team.customers')}
                  </Link>
```

**2.10e** — Add customer filter dropdown. Find the block that opens the project list (it starts right after the `</header>` closing tag):

```tsx
          {projects!.length === 0 ? (
```

Insert before it:

```tsx
          {customers.length > 0 && (
            <div className="mb-4 flex items-center gap-2">
              <select
                className="input"
                value={customerFilter ?? ''}
                onChange={(e) => setCustomerFilter(e.target.value || null)}
                style={{ maxWidth: 240, padding: '6px 10px', fontSize: 13 }}
              >
                <option value="">{t('customer.allCustomers')}</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>
          )}
          {/* Compute filtered list here so the empty-state logic below uses it. */}
```

Then, at the start of the project list render section, add a computed variable. Find the line:

```tsx
              {projects!.map((p, i) => {
```

Just before it (still inside the `<ul>...</ul>` block), we need the filtered list. Change the `projects!.map(...)` approach by first computing the display list. Replace:

```tsx
            <ul className="space-y-2">
              {projects!.map((p, i) => {
```

With:

```tsx
            <ul className="space-y-2">
              {(customerFilter
                ? projects!.filter((p) => p.customer === customerFilter)
                : projects!
              ).map((p, i) => {
```

**2.10f** — Update the customer name display in each project row. Find:

```tsx
                const meta = p.doc?.meta;
                const client = meta?.client?.trim();
                const addressLabel = meta?.address?.formatted;
```

Replace with:

```tsx
                const meta = p.doc?.meta;
                // Prefer the expanded customer name; fall back to legacy
                // meta.client for projects created before the customer DB.
                const client = p.expand?.customer?.name ?? meta?.client?.trim();
                const addressLabel = meta?.address?.formatted;
```

- [ ] **Step 2.11: Update `src/components/AppShell.tsx`**

Add `CustomersPage` import and route. Find:

```ts
import NewProjectPage from './NewProjectPage';
import ProjectSettingsPage from './ProjectSettingsPage';
```

Replace with:

```ts
import NewProjectPage from './NewProjectPage';
import ProjectSettingsPage from './ProjectSettingsPage';
import CustomersPage from './CustomersPage';
```

Find the last route before the closing `</Routes>`:

```tsx
        <Route path="/p/:projectId/settings" element={<AuthGuard><ProjectSettingsPage /></AuthGuard>} />
```

Add after it:

```tsx
        <Route path="/teams/:teamId/customers" element={<AuthGuard><CustomersPage /></AuthGuard>} />
```

- [ ] **Step 2.12: Run TypeScript check**

```bash
cd /home/johannes/projects/solar-planner && npx tsc --noEmit
```

Expected: no errors. Fix any type errors before committing.

- [ ] **Step 2.13: Run locales test again to confirm no regressions**

```bash
cd /home/johannes/projects/solar-planner && npx vitest run src/locales/locales.test.ts
```

Expected: all tests pass.

- [ ] **Step 2.14: Commit**

```bash
git add src/locales/en.ts src/locales/de.ts src/backend/types.ts \
        src/components/CustomerPicker.tsx src/components/CustomersPage.tsx \
        src/components/ProjectMetaForm.tsx src/components/NewProjectPage.tsx \
        src/components/ProjectSettingsPage.tsx src/components/TeamView.tsx \
        src/components/AppShell.tsx
git commit -m "feat(frontend): customer database — picker, CRUD page, project filter"
```
