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

// English strings — the type source of truth.
// Every other locale must satisfy `typeof en` (compile-time key completeness).
// Values use literal Unicode chars (…, →, ←, —, ×) rather than HTML entities.
const en = {
  login: {
    signIn: 'Sign in',
    signUp: 'Create account',
    signingIn: 'Signing in…',
    creatingAccount: 'Creating account…',
    nameLabel: 'Name',
    namePlaceholder: 'Your full name',
    emailLabel: 'Email',
    emailPlaceholder: 'you@example.com',
    passwordLabel: 'Password',
    passwordPlaceholderNew: '8+ characters',
    passwordPlaceholderExisting: '••••••••',
    noAccount: 'No account?',
    alreadyRegistered: 'Already registered?',
    createOne: 'Create one →',
    signInLink: 'Sign in →',
  },
  toolbar: {
    lockMap: 'Lock Map',
    mapLocked: 'Map Locked',
    capturing: 'Capturing…',
    backdrop: 'Backdrop',
    export: 'Export',
    undo: 'Undo',
    redo: 'Redo',
    reset: 'Reset',
    modeRoof: 'Roof',
    modePanels: 'Panels',
    modeString: 'String',
    modeDelete: 'Delete',
    lockFirst: 'Lock map first',
    basemapEsri: 'ESRI Satellite',
    basemapBayern: 'Bayern DOP 20cm (WMS)',
    resetConfirm: 'Reset entire project? This cannot be undone.',
    exportFailed: 'Export failed — the map canvas is not mounted.',
    exportFailedGeneral: 'Export failed — see console for details.',
    loadFailed: 'Could not read project file: {{message}}',
    loadFailedGeneral: 'Failed to load project: {{message}}',
  },
  sidebar: {
    // View toggle labels — sit at the top of the sidebar and switch the
    // main editor between the roof plan canvas and the electrical block
    // diagram. Shortened to "Plan" vs "Diagram" in English because the
    // parent toggle is pill-shaped and wider text wraps; the German
    // equivalents ("Dachplan" / "Schaltplan") are already compact.
    viewRoof: 'Roof Plan',
    viewDiagram: 'Block Diagram',
    project: 'Project',
    panelType: 'Panel Type',
    model: 'Model',
    widthM: 'Width (m)',
    heightM: 'Height (m)',
    ratedPower: 'Rated power (Wp)',
    inverters: 'Inverters',
    addInverter: 'Add inverter',
    noInverters: 'No inverters yet.',
    strings: 'Strings',
    newString: 'New string',
    noStrings: 'No strings yet.',
    noInverterOption: '— No inverter —',
    mpptPort: 'MPPT port',
    noMpptPortOption: '— Any port —',
    roof: 'Roof',
    selected: 'selected',
    name: 'Name',
    tilt: 'Tilt',
    orientationGroup: 'Orientation (active group)',
    orientationRoof: 'Orientation (roof default)',
    deleteRoof: 'Delete roof',
    projected: 'Projected',
    sloped: 'Sloped',
    stringUnit_one: 'string',
    stringUnit_other: 'strings',
    inverterUnit_one: 'inverter',
    inverterUnit_other: 'inverters',
    deleteInverterConfirm: 'Delete {{name}}?',
    deleteStringConfirm: 'Delete {{label}}? Panels will become unassigned.',
    deleteRoofConfirm: 'Delete {{name}}?',
    panelResizeConfirm_one:
      '1 placed panel no longer fits under the new dimensions ({{w}} × {{h}} m). Delete it and proceed?',
    panelResizeConfirm_other:
      '{{count}} placed panels no longer fit under the new dimensions ({{w}} × {{h}} m). Delete them and proceed?',
    statPanels: 'Panels',
    statKwp: 'kWp',
    orientationPortrait: 'portrait',
    orientationLandscape: 'landscape',
  },
  sync: {
    synced: 'Synced',
    syncing: 'Syncing…',
    offline: 'Offline — changes saved locally',
    conflict: 'Conflict',
  },
  conflict: {
    title: 'Changes conflict',
    body: "Your edits conflict with someone else's changes to this project. Pick which version to keep.",
    discardMine: 'Discard mine',
    overwriteTheirs: 'Overwrite theirs',
    working: 'Working…',
  },
  team: {
    yourTeams: 'Your teams',
    newTeam: 'New team',
    noTeamsTitle: 'No teams yet',
    noTeamsBody: 'A team is how you share projects. Create one and invite collaborators by email.',
    createFirstTeam: 'Create your first team →',
    allTeams: '← All teams',
    manageMembers: 'Manage members →',
    customers: 'Customers',
    catalog: 'Hardware catalog',
    newProject: 'New project',
    creating: 'Creating…',
    emptyProjectsTitle: 'Start a new layout',
    emptyProjectsBody: 'Each project is a standalone PV plan — its own roof, panels, and wiring.',
    deleteProject: 'Delete',
    deleteProjectConfirm: 'Delete this project? This cannot be undone.',
    backToTeam: '← Back to team',
    membersTitle: 'Members',
    inviteByEmail: 'Invite by email',
    inviteEmailPlaceholder: 'teammate@example.com',
    inviting: 'Inviting…',
    invite: 'Invite',
    noMembers: 'No members yet.',
    removeMember: 'Remove',
    removeMemberConfirm: 'Remove this member from the team?',
    memberUnit_one: 'member on this team',
    memberUnit_other: 'members on this team',
    projectUnit_one: 'project',
    projectUnit_other: 'projects',
    teamName: 'Team name',
    teamNamePlaceholder: 'e.g. Acme Solar',
    newTeamDesc: "Teams group projects and collaborators. You'll be the first admin.",
    createTeam: 'Create team',
    cancel: 'Cancel',
    noUserWithEmail: 'No user with that email. Ask them to sign up first.',
    alreadyInTeam: 'That user is already in the team.',
    untitledProject: 'Untitled Project',
    settings: 'Settings',
    justNow: 'just now',
    minutesAgo: '{{count}}m ago',
    hoursAgo: '{{count}}h ago',
    daysAgo: '{{count}}d ago',
    revUpdated: 'rev {{rev}} · updated {{stamp}}',
    loading: 'Loading…',
    signOut: 'Sign out',
  },
  pdf: {
    // Small-caps kicker above the project name in the page header.
    // Branding-style label that anchors the sheet as a "solar plan"
    // independent of the project name.
    kicker: 'SOLAR PLAN',
    // Inline labels for the metadata line under the project name.
    // Placed inline ("Client: X · Address: Y") rather than stacked so the
    // header stays compact — `metaSep` is the separator glyph between
    // them so locales can pick a comma, middle dot, or em-dash to match
    // local typographic conventions.
    metaClient: 'Client',
    metaAddress: 'Address',
    metaSep: ' · ',
    notesLabel: 'Notes',
    strings: 'Strings',
    // Subtitle under the "Strings" caption — describes the panel type once
    // for the table instead of repeating it on every row. `{{w}}`/`{{h}}`
    // are already pre-stringified by the caller.
    panelInfo: '{{name}} · {{w}}×{{h}} m · {{wp}} Wp',
    colString: 'String',
    colColor: 'Color',
    colPanels: 'Panels',
    colWp: 'Wp',
    colInverterNum: 'Inverter',
    colMpptPort: 'MPPT port',
    colInverterModel: 'Model',
    // Bottom stat-tile labels (small caps). One label per tile, the value
    // is composed numerically by the caller. Kept separate from the units
    // so the unit can be styled smaller next to the big number.
    statPanels: 'PANELS',
    statPower: 'POWER',
    statScale: 'SCALE',
    unitKwp: 'kWp',
    unitMpp: 'm/px',
    /** Tertiary line under the scale stat — `{{z}}` is the zoom level. */
    scaleZoom: 'zoom {{z}}',
  },
  projectMeta: {
    bootstrapKicker: 'CREATE',
    bootstrapTitle: 'New project',
    bootstrapDesc: 'Give this plan a name and — if you have them — the site address and client details. You can skip the extras and fill them in later.',
    settingsKicker: 'EDIT',
    settingsTitle: 'Project settings',
    backToEditor: 'Back to editor',
    name: 'Project name',
    namePlaceholder: 'e.g. Müller residence, roof study',
    client: 'Client',
    clientPlaceholder: 'Name of the customer (optional)',
    address: 'Site address',
    addressPlaceholder: 'Start typing an address…',
    clearAddress: 'Clear address',
    addressLookupFailed: "Couldn't search addresses — you can still submit without one.",
    selectAddressToPreview: 'Select an address to preview the site',
    street: 'Street',
    housenumber: 'No.',
    postcode: 'ZIP',
    city: 'City',
    notes: 'Notes',
    notesPlaceholder: 'Anything worth remembering about this project (optional)',
    createProject: 'Create project',
    creating: 'Creating…',
    saveChanges: 'Save changes',
    saving: 'Saving…',
    cancel: 'Cancel',
    conflictRetry: 'Another change landed while you were editing. Reload the page and try again.',
  },
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
  catalog: {
    sectionTitle:     'CATALOG',
    pageTitle:        'Hardware catalog',
    pageDesc:         'Manage the panel and inverter models available to all teams. Projects reference entries here so a single edit can fix a typo everywhere it was used.',
    newEntry:         'New entry',
    tabPanels:        'Panels',
    tabInverters:     'Inverters',
    save:             'Save',
    saving:           'Saving…',
    cancel:           'Cancel',
    edit:             'Edit',
    delete:           'Delete',
    emptyPanelsTitle:     'No panel models yet',
    emptyPanelsBody:      'Add a panel model to make it pickable when creating new projects.',
    emptyInvertersTitle:  'No inverter models yet',
    emptyInvertersBody:   'Add an inverter model so projects can link their inverters to real hardware specs.',
    deletePanelConfirm:   'Delete this panel model? Projects linked to it will keep using its stored values, but it will no longer appear in the picker.',
    deleteInverterConfirm: 'Delete this inverter model? Inverters already linked to it will show only their user-editable name.',
    errorRequiredNumbers: 'Please fill in all required numeric fields.',
    importBtn:         'Import from datasheet',
    importing:         'Importing…',
    importOk:          '{{count}} field(s) auto-filled — review before saving',
    importNone:        'No fields found — the PDF may be scanned or the format is unsupported',
    importError:       'Import failed: {{message}}',
    importPickVariant: 'Multiple variants found — pick one:',
  },
  panelModel: {
    sectionLabel:    'Panel model',
    selectPrompt:    '— Select a panel model —',
    emptyAddFirst:   'Add a panel model first →',
    mustSelect:      'Please select a panel model before creating the project.',
    change:          'Change',
    closePicker:     'Close',
    linkToCatalog:   'Link to catalog',
    openDatasheet:   'Open datasheet',
    // Catalog form labels
    manufacturer:        'Manufacturer',
    model:               'Model',
    widthM:              'Width (m)',
    heightM:             'Height (m)',
    wattPeak:            'Rated power (Wp)',
    efficiencyPct:       'Efficiency (%)',
    weightKg:            'Weight (kg)',
    voc:                 'Voc (V)',
    isc:                 'Isc (A)',
    vmpp:                'Vmpp (V)',
    impp:                'Impp (A)',
    tempCoefficientPmax: 'Temp. coefficient Pmax (%/°C)',
    warrantyYears:       'Warranty (years)',
    datasheetUrl:        'Datasheet URL',
  },
  // Electrical block diagram strings. Uses three sub-groups (toolbar,
  // nodes, meta) because those are the three places diagram copy
  // surfaces in the UI; grouping keeps related keys together. The
  // DiagramNodeType labels in `nodes.*` are reused by both the toolbar
  // buttons AND each node component's header band, so one edit updates
  // both places. The Translations type is recursive (see below) so this
  // extra nesting level satisfies the shape check.
  diagram: {
    toolbar: {
      addLabel: '+ Add:',
    },
    nodes: {
      solarGenerator: 'Solar Generator',
      inverter: 'Inverter',
      switch: 'Switch',
      fuse: 'Fuse',
      battery: 'Battery',
      fre: 'FRE Controller',
      gridOutput: 'Grid Output',
    },
    meta: {
      client: 'Client',
      module: 'Module',
      systemSize: 'System Size',
      salesperson: 'Sales',
      planner: 'Planner',
      company: 'Company',
      date: 'Date',
    },
  },
  inverterModel: {
    noModelOption:   '— No model —',
    change:          'Change',
    closePicker:     'Close',
    linkModel:       'Link model',
    openDatasheet:   'Open datasheet',
    // Catalog form labels
    manufacturer:       'Manufacturer',
    model:              'Model',
    maxAcPowerW:        'Max AC power (W)',
    maxDcPowerW:        'Max DC power (W)',
    efficiencyPct:      'Efficiency (%)',
    phases:             'Phases',
    maxStrings:         'Max strings (total)',
    maxInputVoltageV:   'Max input voltage (V)',
    mpptCount:          'MPPT trackers',
    maxDcCurrentA:      'Max DC current per string (A)',
    stringsPerMppt:     'Strings per MPPT',
    datasheetUrl:       'Datasheet URL',
  },
} as const;

export default en;

// `typeof en` is a deep-readonly object whose leaves are *string literal
// types* (e.g. `'Sign in'`), because of `as const`. That's great for
// i18n.ts's type augmentation — it gives full key autocomplete on `t()`.
//
// But for other locales we only care about *shape* completeness: German
// strings must cover every key, not match English literals. So we widen
// the leaves to `string` here. The `satisfies Translations` in de.ts
// then enforces "same keys as en" without demanding "same values".
//
// The inner mapped type recurses so a namespace's value can itself be a
// nested object (e.g. `diagram.toolbar.addLabel` where `diagram.toolbar`
// is a group). Previously the constraint was fixed at two levels which
// forced every locale key into `namespace.leaf` form — too coarse once
// the diagram feature needed `diagram.{toolbar,nodes,meta}.*` sub-groups
// that logically cluster together. Recursion keeps the same "en is the
// source of truth for shape" invariant without capping depth.
type TranslationLeaf<T> = T extends Record<string, unknown>
  ? { readonly [K in keyof T]: TranslationLeaf<T[K]> }
  : string;
export type Translations = {
  readonly [K in keyof typeof en]: TranslationLeaf<(typeof en)[K]>;
};
