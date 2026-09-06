import { describe, it, expect } from 'vitest';
import { buildMapSvg } from '../MapSvg';
import { computeLayout } from '../MapLayout';
import type { Project } from '../../types';

const mode = (id: string) => ({
  id, mode: `Mode ${id}`, effect: 'Loss of air supply', cause: 'Inadequate lubrication',
  currentControls: '1- Weekly vibration route', mitigation: '1- Quarterly grease top-up',
  rpn: { s: 8, o: 4, d: 3 }, rpnStatus: 'manual' as const,
});

const project = (): Project => ({
  id: 'p1', name: 'Air Compressor Package', desc: 'Screw compressor package',
  created: 0, updated: 0,
  subsystems: [{
    id: 's1', name: 'Compressor Element', func: 'Compress air to 7 barg', specs: '132 kW',
    imageData: '', imageName: '', imageJson: '', showImageJson: false,
    failures: [{ id: 'f1', desc: 'Unable to deliver rated flow', modes: [mode('m1'), mode('m2')] }],
  }],
} as unknown as Project);

const expandedAll = new Set(['s1', 'f1']);

describe('buildMapSvg', () => {
  it('sizes the SVG to the layout it shares with the on-screen map', () => {
    const { canvasW, canvasH } = computeLayout(project(), expandedAll);
    const { svg, width, height } = buildMapSvg(project(), expandedAll);
    expect(width).toBe(canvasW);
    expect(height).toBe(canvasH);
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain(`viewBox="0 0 ${canvasW} ${canvasH}"`);
    expect(svg.trimEnd().endsWith('</svg>')).toBe(true);
  });

  it('renders every expanded node as real text', () => {
    const { svg } = buildMapSvg(project(), expandedAll);
    expect(svg).toContain('Air Compressor Package');
    expect(svg).toContain('Compressor Element');
    // Card text is wrapped into tspans, so the FF description arrives in pieces.
    expect(svg).toContain('Unable to deliver rated');
    expect(svg).toContain('Mode m1');
    expect(svg).toContain('Mode m2');
    expect(svg).toContain('96');   // RPN 8 x 4 x 3
  });

  it('leaves collapsed branches out, exactly as the map draws them', () => {
    const { svg } = buildMapSvg(project(), new Set());
    expect(svg).toContain('Compressor Element');
    expect(svg).not.toContain('Unable to deliver rated');
    expect(svg).not.toContain('Mode m1');
  });

  it('escapes markup in project text instead of emitting it', () => {
    const p = project();
    p.subsystems[0].func = 'A & B <script>alert(1)</script>';
    const { svg } = buildMapSvg(p, expandedAll);
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&amp;');
    expect(svg).toContain('&lt;');
  });

  it('emits the same document twice for the same project', () => {
    expect(buildMapSvg(project(), expandedAll).svg).toBe(buildMapSvg(project(), expandedAll).svg);
  });
});
