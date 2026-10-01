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

// Space-held (pan modifier) keyboard behaviour of useViewport:
//   - must not trigger (or preventDefault) while typing in contentEditable
//   - must reset when the window loses focus mid-press (keyup never arrives)

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { act, createRef, type RefObject } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type Konva from 'konva';
import { useViewport } from './useViewport';

// React 18 act() support flag for non-RTL test setups.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(() => {
  // jsdom has no ResizeObserver; useViewport only needs construct/observe/disconnect.
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      disconnect() {}
    };
  }
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function mountViewport(): { current: () => boolean } {
  const latest = { current: () => false };
  const stageRef = createRef<Konva.Stage>() as RefObject<Konva.Stage | null>;
  const containerRef = createRef<HTMLDivElement>();
  function Probe() {
    const vp = useViewport({ stageRef, containerRef, locked: true });
    latest.current = () => vp.spaceHeld;
    return null;
  }
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<Probe />));
  return latest;
}

const space = (type: 'keydown' | 'keyup', target: EventTarget = window) => {
  const ev = new KeyboardEvent(type, { key: ' ', code: 'Space', bubbles: true, cancelable: true });
  act(() => {
    target.dispatchEvent(ev);
  });
  return ev;
};

describe('useViewport space modifier', () => {
  it('sets and clears spaceHeld on keydown/keyup', () => {
    const held = mountViewport();
    space('keydown');
    expect(held.current()).toBe(true);
    space('keyup');
    expect(held.current()).toBe(false);
  });

  it('resets spaceHeld when the window loses focus mid-press', () => {
    const held = mountViewport();
    space('keydown');
    expect(held.current()).toBe(true);
    act(() => {
      window.dispatchEvent(new Event('blur'));
    });
    expect(held.current()).toBe(false);
  });

  it('ignores Space typed into a contentEditable label (and does not preventDefault it)', () => {
    const held = mountViewport();
    const label = document.createElement('div');
    label.setAttribute('contenteditable', 'true');
    document.body.appendChild(label);
    const ev = space('keydown', label);
    expect(held.current()).toBe(false);
    expect(ev.defaultPrevented).toBe(false);
    label.remove();
  });
});
