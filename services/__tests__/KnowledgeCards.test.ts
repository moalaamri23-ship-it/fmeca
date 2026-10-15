import { describe, it, expect } from 'vitest';
import { parseKnowledgeCards, cleanCards, cardToSubsystem, subsystemsFromKnowledge, keepFunction } from '../KnowledgeCards';

const FILE = `SECTION 1 - SYSTEM
==================
Name: Water Package [S1 p.1]

SECTION 2 - SUBSYSTEM LIST
==========================
1 | Centrifugal Pump (A/B) | casing, impeller, seal | 2 x 100%

SECTION 3/1 - SUBSYSTEM: Centrifugal Pump (A/B)
===============================================
Items: Pump casing | P-201A / P-201B | 4471 | 2 | develops head [S1 p.3]
Delivers: 120 m3/h at 6.5 barg to Discharge Header [S1 p.5]
Functions:
- primary: deliver water at 120 m3/h and 6.5 barg [S1 p.5]
- containment: hold process water within casing and seal 11-PT-201234 [S2 p.14]
- protection: relieve casing overpressure through the casing PSV [S1 p.6]
- support: eject motor heat through the canopy vents [S1 p.7]
Specifications: Rated speed 2950 rpm [S1 p.5]
Specifications: Casing design pressure 16 barg [S1 p.6]
Limits: Bearing temperature | 11-TT-201100 | NOT STATED | NOT STATED | NOT STATED | 85 | 95 | deg C | 5 s | trip | Control Panel | yes | [S3 p.9]

SECTION 3/2 - SUBSYSTEM: Pump Drive Motor (A/B)
===============================================
Functions:
- primary: convert electrical power to shaft power at 90 kW [S1 p.8]
- containment: NOT STATED [S1 p.8]
- protection: be monitored for winding temperature through MCC elements [S1 p.9]
Specifications: Power 90 kW [S1 p.8]

SECTION 3/3 - SUBSYSTEM: Package Skid, Access and Enclosures
============================================================
Functions:
- primary: support the package equipment on a common skid [S1 p.12]

SECTION 4 - CONTROL DUTIES
==========================
- primary: this line is outside any subsystem block
`;

describe('knowledge cards', () => {
    it('parses every subsystem block and stops at the next section', () => {
        const cards = parseKnowledgeCards(FILE);
        expect(cards.map(c => c.name)).toEqual(['Centrifugal Pump (A/B)', 'Pump Drive Motor (A/B)', 'Package Skid, Access and Enclosures']);
        expect(cards[0].functions).toHaveLength(4);
        expect(cards[0].specs).toHaveLength(2);
    });

    it('drops structure subsystems and non-functions', () => {
        const cleaned = cleanCards(parseKnowledgeCards(FILE));
        expect(cleaned.map(c => c.name)).toEqual(['Centrifugal Pump (A/B)', 'Pump Drive Motor (A/B)']);
        expect(cleaned[0].functions.map(f => f.cls)).toEqual(['primary', 'containment', 'protection']);
        expect(cleaned[1].functions.map(f => f.cls)).toEqual(['primary']);
    });

    it('keeps a protective action that also mentions a measurement', () => {
        expect(keepFunction({ cls: 'protection', text: 'be able to stop the motor on high measured winding temperature' })).toBe(true);
        expect(keepFunction({ cls: 'protection', text: 'provide bearing temperature measurements to the MCC' })).toBe(false);
    });

    it('writes the function description and specs without refs or tags', () => {
        const sub = cardToSubsystem(cleanCards(parseKnowledgeCards(FILE))[0]);
        expect(sub.func).toBe('Deliver water at 120 m3/h and 6.5 barg. Hold process water within casing and seal. Relieve casing overpressure through the casing PSV.');
        expect(sub.specs).toBe('Rated speed 2950 rpm; Casing design pressure 16 barg; Bearing temperature: high alarm 85 deg C, high trip 95 deg C');
        expect(sub.func).not.toMatch(/\[S\d|\d{2}-[A-Z]+-\d{3,}/);
    });

    it('returns nothing for a file without the card layout', () => {
        expect(subsystemsFromKnowledge('SECTION 5 - BREAKDOWN\n- Pump P-101 [S1 p.3]')).toEqual([]);
        expect(subsystemsFromKnowledge(FILE)).toHaveLength(2);
    });
});
