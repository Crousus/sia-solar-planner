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
// migrateLocalStorage + sign-out hygiene (ADR-016 #9).
//
// The legacy `solar-planner-project` key held the LAST project opened in
// this browser by any user. These tests pin down that it is (a) wiped on
// sign-out and on a user switch, (b) never imported when the server-era
// marker says it isn't a pre-auth draft, and (c) only imported after the
// user confirms.
// ────────────────────────────────────────────────────────────────────────

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { maybeImportLocalStorage, markServerEra } from './migrateLocalStorage';
import { installAuthUserGuard, pb, signOutUser } from './pb';
import type { Project } from '../types';

const KEY = 'solar-planner-project';

function draft(): Project {
  return {
    name: 'Customer Müller',
    panelType: { id: 'pt', name: 'x', widthM: 1, heightM: 1, wattPeak: 100 },
    roofs: [{ id: 'r1', name: 'Roof', polygon: [{ x: 0, y: 0 }], tiltDeg: 30, panelOrientation: 'portrait' }],
    panels: [],
    strings: [],
    inverters: [],
    mapState: { locked: false, centerLat: 0, centerLng: 0, zoom: 1, metersPerPixel: 0.1, mapProvider: 'esri' },
  } as Project;
}

function writeBlob() {
  localStorage.setItem(KEY, JSON.stringify({ state: { project: draft() }, version: 0 }));
}

function installFakes() {
  const create = vi.fn().mockImplementation(async (data: { name?: string }) => ({ id: data.name ? 'newproj' : 'team1' }));
  const getList = vi.fn().mockResolvedValue({ totalItems: 0, items: [] });
  const getFullList = vi.fn().mockResolvedValue([]);
  vi.spyOn(pb, 'collection').mockImplementation(((name: string) => ({
    create: name === 'projects' ? vi.fn().mockResolvedValue({ id: 'newproj' }) : create,
    getList,
    getFullList,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  })) as any);
  return { getList };
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  pb.authStore.save('tok', { id: 'userA', name: 'A', email: 'a@x' } as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  pb.authStore.clear();
  localStorage.clear();
});

describe('maybeImportLocalStorage', () => {
  it('discards a server-era blob without importing', async () => {
    writeBlob();
    markServerEra();
    const { getList } = installFakes();
    const confirm = vi.fn().mockReturnValue(true);
    await expect(maybeImportLocalStorage(confirm)).resolves.toBeNull();
    expect(confirm).not.toHaveBeenCalled();
    expect(getList).not.toHaveBeenCalled();
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('asks before importing and deletes the blob when declined', async () => {
    writeBlob();
    installFakes();
    const confirm = vi.fn().mockReturnValue(false);
    await expect(maybeImportLocalStorage(confirm)).resolves.toBeNull();
    expect(confirm).toHaveBeenCalledWith({ name: 'Customer Müller', roofs: 1, panels: 0 });
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('imports after confirmation', async () => {
    writeBlob();
    installFakes();
    await expect(maybeImportLocalStorage(() => true)).resolves.toBe('newproj');
    expect(localStorage.getItem(KEY)).toBeNull();
  });
});

describe('sign-out hygiene', () => {
  it('signOutUser clears app keys and auth but keeps unrelated keys', () => {
    writeBlob();
    localStorage.setItem('solar-planner-server-era', '1');
    localStorage.setItem('i18nextLng', 'de');
    signOutUser();
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(localStorage.getItem('solar-planner-server-era')).toBeNull();
    expect(localStorage.getItem('i18nextLng')).toBe('de');
    expect(pb.authStore.record).toBeNull();
  });

  it('auth guard wipes app data when a different user signs in', () => {
    const unsub = installAuthUserGuard(); // records userA
    writeBlob();
    // Session expires without an explicit sign-out…
    pb.authStore.clear();
    expect(localStorage.getItem(KEY)).not.toBeNull();
    // …and user B signs in on the same browser.
    pb.authStore.save('tok2', { id: 'userB' } as never);
    expect(localStorage.getItem(KEY)).toBeNull();
    unsub();
  });

  it('auth guard keeps data when the same user signs back in', () => {
    const unsub = installAuthUserGuard();
    writeBlob();
    pb.authStore.clear();
    pb.authStore.save('tok3', { id: 'userA' } as never);
    expect(localStorage.getItem(KEY)).not.toBeNull();
    unsub();
  });
});
