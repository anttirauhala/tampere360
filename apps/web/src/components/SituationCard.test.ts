import { describe, expect, it } from 'vitest';

import { shouldShowMunicipality } from './SituationCard';

describe('shouldShowMunicipality', () => {
  it('ei näytä paikkakuntaa joukkoliikenteen kortilla', () => {
    // Nysse-tiedotteille normalisoija asettaa aina 'Tampere', joten kortilla
    // se olisi pelkkää toistoa (lähde ei kerro kuntaa).
    expect(shouldShowMunicipality({ category: 'PUBLIC_TRANSPORT', municipality: 'Tampere' })).toBe(
      false,
    );
  });

  it('näyttää paikkakunnan liikennekortilla', () => {
    // Liikennetiedotteen kunta tulee lähteestä ja tuo lisätietoa.
    expect(shouldShowMunicipality({ category: 'TRAFFIC', municipality: 'Tampere' })).toBe(true);
    expect(shouldShowMunicipality({ category: 'TRAFFIC', municipality: 'Sastamala' })).toBe(true);
  });

  it('ei näytä paikkakuntaa, jos sitä ei ole tiedossa', () => {
    expect(shouldShowMunicipality({ category: 'TRAFFIC', municipality: null })).toBe(false);
    expect(shouldShowMunicipality({ category: 'POLICE' })).toBe(false);
    expect(shouldShowMunicipality({ category: 'WEATHER', municipality: null })).toBe(false);
    expect(shouldShowMunicipality({ category: 'PUBLIC_TRANSPORT' })).toBe(false);
  });
});
