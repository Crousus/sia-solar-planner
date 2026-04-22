/// <reference path="../pb_data/types.d.ts" />

// Add `device_id` to `patches` so same-user multi-tab sync works.
//
// Problem: the client's SSE self-filter previously discarded any patch
// whose `author` matched the current user id. That prevented doubling
// of an operation when the authoring tab received its own patch back
// over SSE — but it ALSO silenced every other tab signed in as the
// same user, because they all share the same author id. Result: a user
// with two tabs on the same project sees nothing update between them.
//
// Fix: each tab generates a sessionStorage-backed `deviceId` on first
// load. The client includes it on every `/api/sp/patch` POST; the
// server mirrors it onto the patches row; the SSE handler discards
// only patches whose `device_id` equals the receiver's own — which is
// uniquely "this exact tab" rather than "any tab of this user."
//
// Why nullable / not required:
//   - Legacy `patches` rows (any already in the DB before this field
//     existed) have no device_id; we can't invent one. Keeping the
//     field optional lets the server keep writing them at request
//     time without migrating history.
//   - The TTL cron already evicts patches every hour, so the legacy
//     window is bounded.
//   - The client's fallback filter (`author === me && !device_id`)
//     preserves the old behavior for pre-field patches.

migrate((app) => {
  const patches = app.findCollectionByNameOrId('patches');
  if (!patches.fields.getByName('device_id')) {
    patches.fields.add(new TextField({
      name: 'device_id',
      // Not required — legacy rows and any server-internal writes that
      // don't supply a device continue to work.
      required: false,
      // 64 is comfortably larger than a UUID v4 (36 chars) so any
      // future identifier scheme (opaque tokens, device fingerprints)
      // still fits without a schema change.
      max: 64,
    }));
    app.save(patches);
  }
}, (app) => {
  const patches = app.findCollectionByNameOrId('patches');
  if (patches.fields.getByName('device_id')) {
    patches.fields.removeByName('device_id');
    app.save(patches);
  }
});
