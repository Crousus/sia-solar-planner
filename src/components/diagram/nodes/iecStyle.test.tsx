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

// ────────────────────────────────────────────────────────────────────────────
// Symbol-style switch (ADR-020): the same chip node renders as the editor
// chip in 'app' style and as an IEC symbol in 'iec' style — with the chip
// kept as an invisible sizer so the node box (and every attached wire)
// stays put. Rendered inside a ReactFlowProvider because the nodes use
// React Flow hooks.
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ReactFlowProvider } from '@xyflow/react';
import '../../../i18n';
import FuseNode from './FuseNode';
import { DiagramSymbolStyleContext, type DiagramSymbolStyle } from '../symbolStyle';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const fuseProps = {
  id: 'f1',
  data: { label: 'DC fuse', sublabel: '15 A gG' },
  selected: false,
} as unknown as ComponentProps<typeof FuseNode>;

function renderFuse(style: DiagramSymbolStyle) {
  act(() =>
    root.render(
      <ReactFlowProvider>
        <DiagramSymbolStyleContext.Provider value={style}>
          <FuseNode {...fuseProps} />
        </DiagramSymbolStyleContext.Provider>
      </ReactFlowProvider>,
    ),
  );
  return container.querySelector('.diagram-node') as HTMLElement;
}

describe('diagram symbol style', () => {
  it("'app' renders the editable chip and no IEC drawing", () => {
    const node = renderFuse('app');
    expect(node.style.background).toContain('linear-gradient');
    expect(node.querySelector('[contenteditable]')?.textContent).toBe('DC fuse');
    expect(node.querySelector('[aria-hidden="true"] svg')).toBeNull();
  });

  it("'iec' draws the fuse symbol and keeps the chip as an invisible sizer", () => {
    const node = renderFuse('iec');
    // No chip paint (the print theme keys a white fill off this gradient).
    expect(node.style.background).toBe('');
    // Same box: the chip content is still laid out, just hidden — so the
    // node's measured size, handle positions and edges don't change.
    const sizer = node.querySelector('[contenteditable]')?.closest('[style*="visibility"]') as HTMLElement;
    expect(sizer?.style.visibility).toBe('hidden');
    // IEC fuse: rectangle with the conductor through it.
    const overlay = node.querySelector('[aria-hidden="true"]') as HTMLElement;
    expect(overlay.querySelector('svg rect')).not.toBeNull();
    expect(overlay.querySelector('svg line')).not.toBeNull();
    // Designation printed next to the symbol.
    expect(overlay.textContent).toContain('DC fuse');
    expect(overlay.textContent).toContain('15 A gG');
    // Handles are still there (edges keep attaching to the same ids).
    expect(node.querySelectorAll('.react-flow__handle')).toHaveLength(4);
  });
});
