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
    basemapBayernAlkis: 'Bayern DOP 20cm + ALKIS',
    resetConfirm: 'Reset entire project? This cannot be undone.',
    exportFailed: 'Export failed — the map canvas is not mounted.',
    exportFailedGeneral: 'Export failed — see console for details.',
    loadFailed: 'Could not read project file: {{message}}',
    loadFailedGeneral: 'Failed to load project: {{message}}',
  },
  sidebar: {
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
    colInverter: 'Inverter',
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
export type Translations = {
  readonly [K in keyof typeof en]: {
    readonly [K2 in keyof (typeof en)[K]]: string;
  };
};
