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
// StringLayer — renders the wiring path lines for PV strings.
//
// Responsibilities:
//   1. Group panels by stringId.
//   2. For each string, sort panels by their assigned `indexInString`.
//   3. Route the wiring path through the center of any off-string panel that
//      sits between two consecutive in-string panels (see stringRouting.ts
//      for why — short version: makes skipped panels visually unambiguous).
//   4. Draw that polyline with the string's color, with a subtle white halo
//      for contrast against aerial imagery.
//
// Rendering order: this layer sits BEHIND the panels but ABOVE the roofs
// (see KonvaOverlay's layer composition) so the lines don't obscure the
// panel number labels but are clearly visible over the roof fill.
// ────────────────────────────────────────────────────────────────────────────

import { Group, Line } from 'react-konva';
import { useMemo } from 'react';
import { useProjectStore } from '../store/projectStore';
import { darkenColor } from '../utils/colors';
import { computeStringPath } from '../utils/stringRouting';

export default function StringLayer() {
  const project = useProjectStore((s) => s.project);

  /**
   * Compute flattened polyline points for every string.
   *
   * Derivation (not stored):
   *   - Group panels by stringId and order by indexInString
   *   - Route through off-string panels via computeStringPath
   *   - Flatten to [x1,y1,x2,y2,...] for Konva.Line.points
   *
   * Memoized on (strings, panels, roofs, panelType, mpp) because all five
   * influence the path. Roofs enter via per-panel panelDisplaySize (tilt +
   * orientation drive the "near the line" tolerance).
   */
  const paths = useMemo(() => {
    const roofsById = new Map(project.roofs.map((r) => [r.id, r]));
    const mpp = project.mapState.metersPerPixel;
    return project.strings
      .map((str) => {
        const stringPanels = project.panels
          .filter((p) => p.stringId === str.id && p.indexInString != null)
          .sort((a, b) => (a.indexInString || 0) - (b.indexInString || 0));

        // "Other" = any panel not in this string. Unassigned panels are
        // included — skipping an unassigned panel between two in-string
        // panels is just as worth visualizing as skipping a differently-
        // assigned one.
        const otherPanels = project.panels.filter((p) => p.stringId !== str.id);

        const pathPoints = computeStringPath(
          stringPanels,
          otherPanels,
          roofsById,
          project.panelType,
          mpp,
        );

        return {
          id: str.id,
          points: pathPoints.flatMap((p) => [p.x, p.y]),
          color: str.color,
          // Darker shade keeps the line visible both over bright satellite
          // imagery and over the panels themselves (which are drawn in the
          // string color at a lighter shade — see PanelLayer).
          darkColor: darkenColor(str.color, 0.45),
        };
      })
      .filter((p) => p.points.length >= 4); // need ≥ 2 points for a line
  }, [
    project.strings,
    project.panels,
    project.roofs,
    project.panelType,
    project.mapState.metersPerPixel,
  ]);

  return (
    <Group listening={false}>
      {paths.map((p) => (
        <Group key={p.id}>
          {/* Thin white outline to make the dark line visible on dark imagery.
              Drawn first so the colored line sits on top. */}
          <Line
            points={p.points}
            stroke="white"
            strokeWidth={5}
            lineCap="round"
            lineJoin="round"
            opacity={0.3}
          />
          <Line
            points={p.points}
            stroke={p.darkColor}
            strokeWidth={3}
            lineCap="round"
            lineJoin="round"
            opacity={1}
            shadowColor="black"
            shadowBlur={2}
            shadowOpacity={0.5}
          />
        </Group>
      ))}
    </Group>
  );
}
