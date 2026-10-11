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
// Block-diagram symbol style (ADR-020).
//
//   'app' — the editor's own look: dark chips with colored accents and the
//           custom switch / FRE / house drawings. Always used while editing.
//   'iec' — standard schematic symbols after IEC 60617 (DIN EN 60617):
//           inverter = box with diagonal and = / ~, fuse = box with line
//           through, battery = cell plates, etc. Chosen per export only.
//
// A render-time choice, not document state: it is provided by DiagramView
// through context and read by every node component, so the same nodes,
// positions and edges render in either style. Nothing is persisted.
// ────────────────────────────────────────────────────────────────────────────

import { createContext, useContext } from 'react';

export type DiagramSymbolStyle = 'app' | 'iec';

export const DiagramSymbolStyleContext = createContext<DiagramSymbolStyle>('app');

export function useDiagramSymbolStyle(): DiagramSymbolStyle {
  return useContext(DiagramSymbolStyleContext);
}
