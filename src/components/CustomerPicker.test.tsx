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

// Inline "New customer…" flow of CustomerPicker when it sits inside another
// <form> (ProjectMetaForm on the new-project and settings pages). It used to
// render its own nested <form>; browsers drop nested form tags, so "Add
// customer" and Enter submitted the OUTER project form and no customer was
// ever created. These tests pin the fixed behaviour.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const getFullList = vi.fn();
const create = vi.fn();
vi.mock('../backend/pb', () => ({
  pb: { collection: () => ({ getFullList, create }) },
}));

import CustomerPicker from './CustomerPicker';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let outerSubmit: ReturnType<typeof vi.fn<() => void>>;
let onChange: ReturnType<typeof vi.fn<(id: string | null) => void>>;

// React's onChange for controlled inputs listens to the native `input`
// event; set the value through the prototype setter so React notices.
function typeInto(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

async function renderInOuterForm() {
  await act(async () => {
    root.render(
      <form
        onSubmit={(e) => {
          e.preventDefault();
          outerSubmit();
        }}
      >
        <CustomerPicker teamId="team1" value={null} onChange={onChange} />
      </form>,
    );
  });
  // Switch the select into create mode.
  const select = container.querySelector('select')!;
  await act(async () => {
    select.value = '__create__';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const nameInput = container.querySelector('input')!;
  await act(async () => typeInto(nameInput, 'Müller GmbH'));
  return nameInput;
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  outerSubmit = vi.fn<() => void>();
  onChange = vi.fn<(id: string | null) => void>();
  getFullList.mockResolvedValue([]);
  create.mockResolvedValue({ id: 'c1', name: 'Müller GmbH', team: 'team1' });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe('CustomerPicker inline create inside an outer form', () => {
  it('renders no nested <form>', async () => {
    await renderInOuterForm();
    expect(container.querySelectorAll('form form')).toHaveLength(0);
  });

  it('"Add customer" creates the customer and does not submit the outer form', async () => {
    await renderInOuterForm();
    const addButton = [...container.querySelectorAll('button')].find(
      (b) => !b.disabled && b.getAttribute('type') === 'button' && !/cancel/i.test(b.textContent ?? ''),
    )!;
    await act(async () => addButton.click());

    expect(create).toHaveBeenCalledWith({ team: 'team1', name: 'Müller GmbH' });
    expect(onChange).toHaveBeenCalledWith('c1');
    expect(outerSubmit).not.toHaveBeenCalled();
  });

  it('Enter in the name field creates the customer instead of submitting the project', async () => {
    const nameInput = await renderInOuterForm();
    await act(async () => {
      nameInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });

    expect(create).toHaveBeenCalledTimes(1);
    expect(outerSubmit).not.toHaveBeenCalled();
  });
});
